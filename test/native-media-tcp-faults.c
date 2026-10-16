/* Inject syscall failures into the actual optional addon's C core. Real TCP
 * changes remain on a disposable accepted loopback socket and use no BBR. */
#define _GNU_SOURCE
#include <sys/socket.h>
#include <netinet/in.h>
#include <errno.h>
#ifdef __linux__
#include <linux/tcp.h>
static int armed, sets, fail_read, fail_restore, reject_first;
static int test_getsockopt(int fd, int level, int option, void *value, socklen_t *size) {
    if (level == IPPROTO_TCP && option == TCP_CONGESTION && fail_read) { fail_read--; errno = EIO; return -1; }
    return getsockopt(fd, level, option, value, size);
}
static int test_setsockopt(int fd, int level, int option, const void *value, socklen_t size) {
    if (armed && level == IPPROTO_TCP && option == TCP_CONGESTION) {
        sets++;
        if ((reject_first && sets == 1) || (fail_restore && sets == 2)) { errno = EPERM; return -1; }
        int result = setsockopt(fd, level, option, value, size);
        if (!result && sets == 1) fail_read = 1;
        return result;
    }
    return setsockopt(fd, level, option, value, size);
}
#define MEDIA_TCP_GETSOCKOPT test_getsockopt
#define MEDIA_TCP_SETSOCKOPT test_setsockopt
#endif
#define ASTRA_MEDIA_TCP_TEST
#include "../bin/media-tcp.c"
#include <assert.h>
#include <stdio.h>
#include <unistd.h>
int main(void) {
#ifndef __linux__
    struct media_tcp_result result;
    assert(media_tcp_inspect(-1, 8000, &result) != 0);
    assert(media_tcp_configure(-1, 8000, "cubic", &result) != 0);
    puts("PASS: unsupported-platform control paths fail safely");
#else
    struct sockaddr_in address;
    memset(&address, 0, sizeof(address)); address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    int listener = socket(AF_INET, SOCK_STREAM, 0); assert(listener >= 0);
    assert(bind(listener, (struct sockaddr *)&address, sizeof(address)) == 0 && listen(listener, 1) == 0);
    socklen_t size = sizeof(address); assert(getsockname(listener, (struct sockaddr *)&address, &size) == 0);
    unsigned int port = ntohs(address.sin_port);
    int client = socket(AF_INET, SOCK_STREAM, 0); assert(client >= 0 && connect(client, (struct sockaddr *)&address, sizeof(address)) == 0);
    int accepted = accept(listener, NULL, NULL); assert(accepted >= 0);
    struct media_tcp_result result;
    assert(media_tcp_configure(accepted, port, "cubic", &result) == 0);
    armed = 1; sets = 0;
    assert(media_tcp_configure(accepted, port, "reno", &result) == EIO);
    assert(!result.changed && !result.restore_failed && !strcmp(result.algorithm, "cubic"));
    assert(sets == 2); /* Set succeeded, verification failed, baseline restored. */
    sets = 0; reject_first = 1;
    assert(media_tcp_configure(accepted, port, "reno", &result) == EPERM);
    assert(!result.changed && !result.restore_failed && !strcmp(result.algorithm, "cubic"));
    reject_first = 0; sets = 0; fail_restore = 1;
    assert(media_tcp_configure(accepted, port, "reno", &result) == EPERM);
    assert(result.changed && result.restore_failed && !result.algorithm[0] && !result.info_available);
    armed = 0; fail_restore = 0;
    assert(media_tcp_inspect(accepted, port, &result) == 0 && !strcmp(result.algorithm, "reno"));
    assert(media_tcp_configure(accepted, port, "cubic", &result) == 0);
    assert(write(accepted, "safe", 4) == 4); char bytes[4]; assert(read(client, bytes, 4) == 4 && !memcmp(bytes, "safe", 4));
    close(accepted); close(client); close(listener);
    puts("PASS: kernel denial preserves baseline, failed post-set verification restores it, failed restore is explicitly unsafe");
#endif
    return 0;
}
