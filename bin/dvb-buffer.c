/* AstraDVB, GPL-2.0-or-later. Applied only to the dvbv5-zap child process. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/dvb/dmx.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>

static unsigned long dvr_buffer_size(const char *value) {
    if (!value || !*value) return 16UL * 1024 * 1024;
    char *end; errno = 0;
    unsigned long n = strtoul(value, &end, 10);
    if (errno || *end || *value == '-' || n < 1024UL * 1024 || n > 64UL * 1024 * 1024)
        return 16UL * 1024 * 1024;
    return n;
}
static int dvr_path(const char *path) {
    const char *prefix = "/dev/dvb/adapter";
    if (!path || strncmp(path, prefix, strlen(prefix))) return 0;
    const char *p = path + strlen(prefix);
    if (*p < '0' || *p > '9') return 0;
    while (*p >= '0' && *p <= '9') p++;
    if (strncmp(p, "/dvr", 4)) return 0;
    p += 4;
    if (*p < '0' || *p > '9') return 0;
    while (*p >= '0' && *p <= '9') p++;
    return *p == '\0';
}
static void configure_dvr_fd(int fd, const char *path) {
    if (fd < 0 || !dvr_path(path)) return;
    int saved = errno;
    unsigned long size = dvr_buffer_size(getenv("ASTRA_DVB_DVR_BUFFER_BYTES"));
    if (ioctl(fd, DMX_SET_BUFFER_SIZE, size) < 0)
        fprintf(stderr, "AstraDVB DVR buffer setup failed: %s\n", strerror(errno));
    else
        fprintf(stderr, "AstraDVB DVR buffer configured: %lu bytes\n", size);
    errno = saved;
}

#ifndef ASTRA_DVB_BUFFER_TEST
typedef int (*open_fn)(const char *, int, ...);
static int needs_mode(int flags) {
    return (flags & O_CREAT) || ((flags & O_TMPFILE) == O_TMPFILE);
}
int open(const char *path, int flags, ...) {
    open_fn next = (open_fn)dlsym(RTLD_NEXT, "open");
    if (!next) { errno = ENOSYS; return -1; }
    mode_t mode = 0;
    if (needs_mode(flags)) { va_list args; va_start(args, flags); mode = va_arg(args, mode_t); va_end(args); }
    int fd = next(path, flags, mode); configure_dvr_fd(fd, path); return fd;
}
int open64(const char *path, int flags, ...) {
    open_fn next = (open_fn)dlsym(RTLD_NEXT, "open64");
    if (!next) { errno = ENOSYS; return -1; }
    mode_t mode = 0;
    if (needs_mode(flags)) { va_list args; va_start(args, flags); mode = va_arg(args, mode_t); va_end(args); }
    int fd = next(path, flags, mode); configure_dvr_fd(fd, path); return fd;
}
/* Ubuntu's fortified libdvbv5 uses these non-variadic entry points. */
typedef int (*open2_fn)(const char *, int);
int __open_2(const char *path, int flags) {
    open2_fn next = (open2_fn)dlsym(RTLD_NEXT, "__open_2");
    if (!next) { errno = ENOSYS; return -1; }
    int fd = next(path, flags); configure_dvr_fd(fd, path); return fd;
}
int __open64_2(const char *path, int flags) {
    open2_fn next = (open2_fn)dlsym(RTLD_NEXT, "__open64_2");
    if (!next) { errno = ENOSYS; return -1; }
    int fd = next(path, flags); configure_dvr_fd(fd, path); return fd;
}
#endif
