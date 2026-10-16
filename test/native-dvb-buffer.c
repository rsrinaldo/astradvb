#define _GNU_SOURCE
#include <assert.h>
#include <stdarg.h>
#include <sys/ioctl.h>
#include <linux/dvb/dmx.h>
static int calls; static unsigned long requested;
static int fake_ioctl(int fd, unsigned long op, ...) {
    assert(fd == 42); assert(op == DMX_SET_BUFFER_SIZE);
    va_list args; va_start(args, op); requested=va_arg(args,unsigned long);va_end(args);calls++;return 0;
}
#define ioctl fake_ioctl
#define ASTRA_DVB_BUFFER_TEST
#include "../bin/dvb-buffer.c"
int main(void) {
    assert(dvr_buffer_size(NULL)==16777216);
    assert(dvr_buffer_size("33554432")==33554432);
    for (const char **p=(const char *[]){"-1","0","garbage","99999999999999999999","67108865",NULL};*p;p++) assert(dvr_buffer_size(*p)==16777216);
    assert(dvr_path("/dev/dvb/adapter12/dvr0"));
    assert(!dvr_path("/dev/dvb/adapter1/frontend0"));
    assert(!dvr_path("/dev/dvb/adapter1/demux0"));
    assert(!dvr_path("/tmp/dvr0"));
    assert(!dvr_path("/dev/dvb/adapter1/dvr0.backup"));
    unsetenv("ASTRA_DVB_DVR_BUFFER_BYTES");
    configure_dvr_fd(42,"/dev/dvb/adapter1/frontend0");assert(calls==0);
    configure_dvr_fd(42,"/dev/dvb/adapter1/dvr0");assert(calls==1&&requested==16777216);
    puts("PASS: DVR-only ioctl, 16 MiB default, bounded override; frontend/demux untouched");
}
