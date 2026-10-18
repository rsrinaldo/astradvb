#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE
#include <assert.h>
#include <errno.h>
#include <poll.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/socket.h>
#include <stdio.h>
static size_t accepted; static int mode, calls;
static ssize_t fake_send(int fd, const void *data, size_t n, int flags) {
    (void)fd; assert(flags & MSG_DONTWAIT); ++calls;
    if(mode==1 && calls==1) { errno=EINTR; return -1; }
    if(mode==1 && calls==2) { errno=EAGAIN; return -1; }
    if(mode==2 && calls>1) { errno=EPIPE; return -1; }
    if(mode==3) { errno=EAGAIN; return -1; }
    size_t count=n>2?2:n;
    for(size_t i=0;i<count;i++) assert(((const uint8_t *)data)[i]==(uint8_t)(accepted+i));
    accepted+=count; return (ssize_t)count;
}
static int fake_poll(struct pollfd *p,nfds_t n,int ms) {
    assert(n==1 && p->events==POLLOUT && ms>0 && ms<=2000);
    return mode==3?0:1;
}
#define ASTRA_NEWCAMD_SEND fake_send
#define ASTRA_NEWCAMD_POLL fake_poll
#include "astra-newcamd-io.h"
int main(void) {
    uint8_t message[32]; for(size_t i=0;i<sizeof message;i++) message[i]=(uint8_t)i;
    mode=1; assert(astra_newcamd_write_exact(1,message,sizeof message)==sizeof message);
    assert(accepted==sizeof message && calls==18);
    accepted=calls=0; mode=2;
    assert(astra_newcamd_write_exact(1,message,sizeof message)==-1 && errno==EPIPE);
    assert(accepted==2 && calls==2); /* no whole-frame replay */
    accepted=calls=0; mode=3;
    assert(astra_newcamd_write_exact(1,message,sizeof message)==-1 && errno==EAGAIN);
    assert(accepted==0 && calls==1);
    puts("PASS: direct writes preserve partial progress, EINTR/backpressure and bounded failure without replay");
}
