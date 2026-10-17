#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <errno.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

static size_t max_read = 0;
static int interrupted_reads = 0, interrupted_polls = 0;
static ssize_t fixture_recv(int fd, void *buffer, size_t length, int flags)
{
    if(interrupted_reads) { interrupted_reads--; errno = EINTR; return -1; }
    return recv(fd, buffer, max_read && length > max_read ? max_read : length, flags);
}
static int fixture_poll(struct pollfd *fds, nfds_t count, int timeout)
{
    if(interrupted_polls) { interrupted_polls--; errno = EINTR; return -1; }
    return poll(fds, count, timeout);
}
#define ASTRA_NEWCAMD_RECV fixture_recv
#define ASTRA_NEWCAMD_POLL fixture_poll
#include "astra-newcamd-io.h"

static void wait_ms(unsigned int milliseconds)
{
    struct timespec delay = { milliseconds / 1000, (long)(milliseconds % 1000) * 1000000 };
    while(nanosleep(&delay, &delay) && errno == EINTR) {}
}
static void socket_pair(int pair[2], unsigned int timeout_ms)
{
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0);
    struct timeval timeout = { timeout_ms / 1000, (int)(timeout_ms % 1000) * 1000 };
    assert(setsockopt(pair[0], SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) == 0);
}
struct writer { int fd; const uint8_t *data; size_t length, chunk; unsigned int delay_ms; };
static void *write_fragments(void *value)
{
    struct writer *writer = value;
    for(size_t sent = 0; sent < writer->length;)
    {
        size_t count = writer->length - sent;
        if(count > writer->chunk) { count = writer->chunk; }
        ssize_t result = write(writer->fd, writer->data + sent, count);
        if(result < 0 && errno == EINTR) { continue; }
        if(result <= 0) { break; }
        sent += (size_t)result;
        if(writer->delay_ms) { wait_ms(writer->delay_ms); }
    }
    close(writer->fd);
    return NULL;
}
int main(void)
{
    assert(ASTRA_OSCAM_STREAM_IO_POLICY_VERSION == 1);
    signal(SIGPIPE, SIG_IGN);
    int pair[2]; uint8_t received[128], protocol[14 + 2 + 19];
    for(size_t i = 0; i < sizeof(protocol); i++) { protocol[i] = (uint8_t)(i * 7 + 3); }
    protocol[14] = 0; protocol[15] = 19;

    /* A single peer write still permits a short recv. The old header contract
     * rejects this; the exact reader must preserve all framing boundaries. */
    socket_pair(pair, 1000); max_read = 1;
    assert(write(pair[1], protocol, sizeof(protocol)) == sizeof(protocol));
    assert(fixture_recv(pair[0], received, 2, 0) == 1);
    close(pair[0]); close(pair[1]);
    socket_pair(pair, 1000);
    struct writer writer = { pair[1], protocol, sizeof(protocol), 1, 1 };
    pthread_t thread; assert(pthread_create(&thread, NULL, write_fragments, &writer) == 0);
    assert(astra_newcamd_read_exact(pair[0], received, 14) == 14);
    assert(memcmp(received, protocol, 14) == 0);
    assert(astra_newcamd_read_exact(pair[0], received, 2) == 2);
    assert(received[0] == 0 && received[1] == 19);
    assert(astra_newcamd_read_exact(pair[0], received, 19) == 19);
    assert(memcmp(received, protocol + 16, 19) == 0);
    assert(astra_newcamd_read_exact(pair[0], received, 2) == 0);
    close(pair[0]); assert(pthread_join(thread, NULL) == 0);

    socket_pair(pair, 1000); max_read = 3; interrupted_reads = 2; interrupted_polls = 2;
    assert(write(pair[1], protocol, sizeof(protocol)) == sizeof(protocol));
    assert(astra_newcamd_read_exact(pair[0], received, sizeof(protocol)) == sizeof(protocol));
    assert(memcmp(received, protocol, sizeof(protocol)) == 0);
    assert(!interrupted_reads && !interrupted_polls);
    close(pair[0]); close(pair[1]); max_read = 0;

    /* EOF cannot release a partial header/body as a complete protocol frame. */
    socket_pair(pair, 1000); assert(write(pair[1], protocol, 1) == 1); close(pair[1]);
    assert(astra_newcamd_read_exact(pair[0], received, 2) == 1); close(pair[0]);
    socket_pair(pair, 1000); assert(write(pair[1], protocol + 16, 5) == 5); close(pair[1]);
    assert(astra_newcamd_read_exact(pair[0], received, 19) == 5);
    assert(memcmp(received, protocol + 16, 5) == 0); close(pair[0]);

    socket_pair(pair, 60);
    int64_t started = astra_newcamd_now_ms(); errno = 0;
    assert(astra_newcamd_read_exact(pair[0], received, 2) == -1);
    assert(errno == EAGAIN || errno == EWOULDBLOCK);
    int64_t elapsed = astra_newcamd_now_ms() - started;
    assert(elapsed >= 20 && elapsed < 500); close(pair[0]); close(pair[1]);

    /* A slow trickle cannot restart the receive timeout once per byte. */
    socket_pair(pair, 80); writer = (struct writer){ pair[1], protocol, sizeof(protocol), 1, 20 };
    assert(pthread_create(&thread, NULL, write_fragments, &writer) == 0);
    started = astra_newcamd_now_ms();
    ssize_t count = astra_newcamd_read_exact(pair[0], received, sizeof(protocol));
    elapsed = astra_newcamd_now_ms() - started;
    assert(count > 0 && count < (ssize_t)sizeof(protocol));
    assert(memcmp(received, protocol, (size_t)count) == 0);
    assert(elapsed >= 20 && elapsed < 500);
    close(pair[0]); assert(pthread_join(thread, NULL) == 0);

    assert(astra_newcamd_read_exact(-1, received, 2) == -1 && errno == EBADF);
    assert(astra_newcamd_read_exact(-1, NULL, 1) == -1 && errno == EINVAL);
    assert(astra_newcamd_read_exact(-1, NULL, 0) == 0);
    puts("PASS: OSCam exact receive preserves fragmented greeting/header/body and bounds EOF/timeout/EINTR handling");
    return 0;
}
