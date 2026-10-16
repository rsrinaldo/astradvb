#define _GNU_SOURCE
#include <assert.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <linux/dvb/dmx.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#ifdef ASTRA_DVB_BUFFER_ABI_MOCK
static int calls;
static int fake_open(const char *p,int flags) { assert(!strcmp(p,"/dev/dvb/adapter1/dvr0"));assert(flags==O_RDONLY);return 42; }
int open(const char *p,int flags,...) { return fake_open(p,flags); }
int open64(const char *p,int flags,...) { return fake_open(p,flags); }
int __open_2(const char *p,int flags) { return fake_open(p,flags); }
int __open64_2(const char *p,int flags) { return fake_open(p,flags); }
int ioctl(int fd,unsigned long op,...) {
    assert(fd==42&&op==DMX_SET_BUFFER_SIZE);
    va_list a;va_start(a,op);assert(va_arg(a,unsigned long)==16777216);va_end(a);calls++;return 0;
}
int astra_test_ioctl_count(void) { return calls; }
#else
int main(void) {
    const char *names[]={"open","open64","__open_2","__open64_2"};
    for(int i=0;i<4;i++) { int (*fn)(const char*,int,...)=dlsym(RTLD_DEFAULT,names[i]);assert(fn);assert(fn("/dev/dvb/adapter1/dvr0",O_RDONLY)==42); }
    int (*count)(void)=dlsym(RTLD_DEFAULT,"astra_test_ioctl_count");assert(count&&count()==4);
    puts("PASS: all four open ABIs resize DVR before returning; mock only, no hardware access");
}
#endif
