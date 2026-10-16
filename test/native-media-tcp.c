/* Real loopback-only sockets; no external hosts, CAS traffic, sysctl writes,
 * module loading or permission changes. Include the same production C core. */
#define ASTRA_MEDIA_TCP_TEST
#include "../bin/media-tcp.c"
#include <assert.h>
#include <stdio.h>
#include <unistd.h>
#include <fcntl.h>

static int already_available(const char *name) {
    FILE *file = fopen("/proc/sys/net/ipv4/tcp_available_congestion_control", "r");
    if (!file) return 0;
    char algorithm[32]; int found = 0;
    while (fscanf(file, "%31s", algorithm) == 1) if (!strcmp(algorithm, name)) found = 1;
    fclose(file); return found;
}
int main(void) {
#ifndef __linux__
    struct media_tcp_result unused;
    assert(media_tcp_inspect(-1, 8000, &unused) != 0);
    assert(media_tcp_configure(-1, 8000, "cubic", &unused) != 0);
    (void)already_available;
    puts("PASS: unsupported platforms fail gracefully without touching sockets");
#else
    struct sockaddr_in address;
    memset(&address, 0, sizeof(address)); address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    int listener = socket(AF_INET, SOCK_STREAM, 0); assert(listener >= 0);
    assert(bind(listener, (struct sockaddr *)&address, sizeof(address)) == 0);
    assert(listen(listener, 1) == 0);
    socklen_t size = sizeof(address); assert(getsockname(listener, (struct sockaddr *)&address, &size) == 0);
    unsigned int port = ntohs(address.sin_port);
    int client = socket(AF_INET, SOCK_STREAM, 0); assert(client >= 0);
    assert(connect(client, (struct sockaddr *)&address, sizeof(address)) == 0);
    int accepted = accept(listener, NULL, NULL); assert(accepted >= 0);
    struct media_tcp_result before, after, rejected;
    assert(media_tcp_inspect(accepted, port, &before) == 0);
    assert(before.info_available && before.state == 1 && before.algorithm[0]);
    assert(media_tcp_configure(accepted, port, "not-an-algorithm", &rejected) == EINVAL);
    assert(media_tcp_configure(listener, port, "cubic", &rejected) == EACCES);
    assert(media_tcp_configure(client, port, "cubic", &rejected) == EACCES);
    assert(media_tcp_configure(accepted, port == 65535 ? port - 1 : port + 1, "cubic", &rejected) == EACCES);
    assert(media_tcp_configure(-1, port, "cubic", &rejected) == EINVAL);
    assert(media_tcp_configure(accepted, 0, "cubic", &rejected) == EINVAL);
    assert(media_tcp_configure(accepted, 65536, "cubic", &rejected) == EINVAL);
    int closed = dup(accepted); assert(closed >= 0); close(closed);
    assert(media_tcp_inspect(closed, port, &rejected) == EBADF);
    int regular = open("/dev/null", O_RDONLY); assert(regular >= 0);
    assert(media_tcp_configure(regular, port, "cubic", &rejected) == ENOTSOCK); close(regular);
    int local[2]; assert(socketpair(AF_UNIX, SOCK_STREAM, 0, local) == 0);
    assert(media_tcp_configure(local[0], port, "cubic", &rejected) == EPROTOTYPE);
    int datagram = socket(AF_INET, SOCK_DGRAM, 0); assert(datagram >= 0);
    assert(media_tcp_configure(datagram, port, "cubic", &rejected) == EPROTOTYPE);
    assert(media_tcp_inspect(accepted, port, &after) == 0 && !strcmp(before.algorithm, after.algorithm));
    char client_algorithm[32], client_after[32]; size = sizeof(client_algorithm);
    assert(getsockopt(client, IPPROTO_TCP, TCP_CONGESTION, client_algorithm, &size) == 0);
    assert(media_tcp_configure(accepted, port, "cubic", &after) == 0 && !strcmp(after.algorithm, "cubic"));
    assert(media_tcp_configure(accepted, port, "reno", &after) == 0 && !strcmp(after.algorithm, "reno"));
    assert(media_tcp_configure(accepted, port, "cubic", &after) == 0 && !strcmp(after.algorithm, "cubic"));
    /* Do not let a privileged test autoload an unapproved kernel module. */
    if (already_available("bbr")) {
        int result = media_tcp_configure(accepted, port, "bbr", &after);
        if (!result) assert(!strcmp(after.algorithm, "bbr"));
        else { assert(!strcmp(after.algorithm, "cubic")); assert(!strcmp(after.reason, "kernel_rejected")); }
        assert(media_tcp_configure(accepted, port, "cubic", &after) == 0);
    }
    size = sizeof(client_after); assert(getsockopt(client, IPPROTO_TCP, TCP_CONGESTION, client_after, &size) == 0);
    assert(!strcmp(client_algorithm, client_after));
    assert(write(accepted, "media", 5) == 5); char bytes[5]; assert(read(client, bytes, sizeof(bytes)) == 5);
    assert(!memcmp(bytes, "media", 5));
    assert(media_tcp_inspect(accepted, port, &after) == 0 && after.info_available);
    close(datagram); close(local[0]); close(local[1]); close(accepted); close(client); close(listener);
    puts("PASS: only connected server-port TCP sockets change; listeners, clients, Unix/UDP sockets stay untouched; TCP_INFO and media delivery work");
#endif
    return 0;
}
