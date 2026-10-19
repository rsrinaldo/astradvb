#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE
#include <assert.h>
#include <sys/wait.h>
#include <signal.h>
#include "astra-provider-budget.h"

static const char *id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
static const char *boot = "12345678-1234-1234-1234-123456789abc";
static void remove_files(const char *path) {
    char p[1024];
    snprintf(p,sizeof p,"%s/%s.health.json",path,id); unlink(p);
    for(unsigned i=0;i<3;i++) {
        snprintf(p,sizeof p,"%s/%s%s",path,i==2?"owner":id,i==0?".json":".lock"); unlink(p);
    }
    rmdir(path);
}
int main(int argc, char **argv) {
    if(argc == 6) {
        struct astra_provider_budget b;
        uint64_t up=strtoull(argv[4],NULL,10), wall=strtoull(argv[5],NULL,10);
        assert(astra_provider_open(&b,argv[1],argv[2],argv[3],up,wall));
        int allowed=astra_provider_reserve(&b,up,wall);
        printf("{\"allowed\":%d,\"attempts\":%llu,\"failures\":%llu}\n",allowed,(unsigned long long)b.count,(unsigned long long)b.failures);
        astra_provider_close(&b); return 0;
    }
    assert(argc==1);
    char directory[] = "/tmp/astra-native-budget-XXXXXX";
    assert(mkdtemp(directory)); assert(chmod(directory,0700)==0);
    struct astra_provider_budget b, duplicate;
    uint64_t now=100000, wall=1000000000;
    assert(astra_provider_open(&b,directory,id,boot,now,wall));
    assert(!astra_provider_open(&duplicate,directory,id,boot,now,wall));
    assert(astra_provider_reserve(&b,now,wall));
    assert(!astra_provider_reserve(&b,now,wall)); /* one active account */
    assert(!astra_provider_take_frame(&b,now));
    assert(astra_provider_take_frame(&b,now+1000));
    assert(!astra_provider_take_frame(&b,now+1049));
    assert(astra_provider_take_frame(&b,now+1050));
    assert(astra_provider_take_frame(&b,now+5000)); /* no catch-up credit */
    assert(!astra_provider_take_frame(&b,now+5000));
    astra_provider_failed(&b,now+5100,wall+5100);
    astra_provider_failed(&b,now+5100,wall+5100);
    assert(b.failures==1 && b.closes==1);
    assert(!astra_provider_reserve(&b,now+6099,wall+6099));
    assert(astra_provider_reserve(&b,now+6100,wall+6100));
    astra_provider_failed(&b,now+6200,wall+6200);
    assert(astra_provider_reserve(&b,now+8200,wall+8200));
    astra_provider_failed(&b,now+8300,wall+8300);
    assert(b.count==3 && b.failures==3);
    assert(!astra_provider_reserve(&b,now+50000,wall+50000));
    astra_provider_close(&b);
    assert(astra_provider_open(&b,directory,id,boot,now+50000,wall+50000));
    assert(b.count==3 && b.failures==3);
    assert(!astra_provider_reserve(&b,now+60999,wall+60999));
    assert(astra_provider_reserve(&b,now+61000,wall+61000));
    assert(b.count==3); /* restart never erases the attempt window */
    b.ready=1;
    astra_provider_positive(&b,now+61010,wall+61010);
    astra_provider_positive(&b,now+76010,wall+76010);
    assert(b.failures==3);
    astra_provider_positive(&b,now+91010,wall+91010);
    assert(b.failures==0 && b.stable_recoveries==1);
    astra_provider_close(&b);

    /* Legacy Node's global exclusive lock and native's shared lock exclude one another. */
    char path[1024]; snprintf(path,sizeof path,"%s/owner.lock",directory);
    int lockfd=open(path,O_RDWR); assert(lockfd>=0); assert(flock(lockfd,LOCK_EX|LOCK_NB)==0);
    assert(!astra_provider_open(&b,directory,id,boot,now+92000,wall+92000)); close(lockfd);

    /* Invalid state cannot reset the budget; the safety hold survives reopening. */
    snprintf(path,sizeof path,"%s/%s.json",directory,id);
    int fd=open(path,O_WRONLY|O_TRUNC); assert(fd>=0); assert(write(fd,"{}",2)==2); close(fd);
    assert(astra_provider_open(&b,directory,id,boot,now+92000,wall+92000));
    assert(astra_provider_delay(&b,now+92000)==60000);
    astra_provider_close(&b);
    assert(astra_provider_open(&b,directory,id,boot,now+93000,wall+93000));
    assert(astra_provider_delay(&b,now+93000)==59000);
    astra_provider_close(&b);

    /* A replaced permanent account lock fails closed, even on an active transport. */
    assert(astra_provider_open(&b,directory,id,boot,now+153000,wall+153000));
    assert(astra_provider_reserve(&b,now+153000,wall+153000));
    snprintf(path,sizeof path,"%s/%s.lock",directory,id); assert(unlink(path)==0);
    fd=open(path,O_RDWR|O_CREAT|O_EXCL,0600); assert(fd>=0); close(fd);
    assert(!astra_provider_take_frame(&b,now+154001));
    astra_provider_close(&b);
    remove_files(directory);
    char crash_directory[]="/tmp/astra-native-crash-XXXXXX";
    assert(mkdtemp(crash_directory)); assert(chmod(crash_directory,0700)==0);
    pid_t child=fork(); assert(child>=0);
    if(child==0) {
        struct astra_provider_budget c;
        assert(astra_provider_open(&c,crash_directory,id,boot,now,wall));
        assert(astra_provider_reserve(&c,now,wall));
        kill(getpid(),SIGKILL); _exit(4);
    }
    int status; assert(waitpid(child,&status,0)==child && WIFSIGNALED(status) && WTERMSIG(status)==SIGKILL);
    assert(astra_provider_open(&b,crash_directory,id,boot,now+100,wall+100));
    assert(b.count==1); /* process death releases locks, never durable attempt credit */
    astra_provider_close(&b); remove_files(crash_directory);
    char storage_directory[]="/tmp/astra-native-storage-XXXXXX";
    assert(mkdtemp(storage_directory)); assert(chmod(storage_directory,0700)==0);
    assert(astra_provider_open(&b,storage_directory,id,boot,now,wall));
    for(unsigned i=1;i<=8;i++) {
        snprintf(path,sizeof path,"%s/.direct-%s-%ld-%u.tmp",storage_directory,id,(long)getpid(),i);
        fd=open(path,O_WRONLY|O_CREAT|O_EXCL,0600); assert(fd>=0); close(fd);
    }
    assert(!astra_provider_reserve(&b,now,wall));
    assert(!b.attempted && b.connections==0 && b.count==1);
    assert(!astra_provider_reserve(&b,now+4999,wall+4999));
    assert(astra_provider_reserve(&b,now+5000,wall+5000));
    assert(b.connections==1 && b.count==2);
    for(unsigned i=1;i<=8;i++) {
        snprintf(path,sizeof path,"%s/.direct-%s-%ld-%u.tmp",storage_directory,id,(long)getpid(),i); assert(unlink(path)==0);
    }
    astra_provider_close(&b); remove_files(storage_directory);

    char health_directory[]="/tmp/astra-native-health-XXXXXX";
    assert(mkdtemp(health_directory)); assert(chmod(health_directory,0700)==0);
    now=100000; wall=1000000000;
    assert(astra_provider_open(&b,health_directory,id,boot,now,wall));
    astra_health_open(&b,now);
    /* Slow/delayed startup and isolated NOKs cannot trip a healthy account. */
    for(unsigned i=0;i<2000;i++) {
        now+=100;
        assert(astra_health_allowed(&b,now)); astra_health_sent(&b,now);
        astra_health_result(&b,now,i%10==0,i%10==0);
    }
    assert(b.health_mode==0 && b.health_entries==0);
    /* Idle time creates no failures and no stored catch-up send credit. */
    now+=3600000; astra_health_tick(&b,now); assert(b.health_mode==0);
    uint64_t began=now;
    for(unsigned i=0;i<32;i++) {
        now+=100; assert(astra_health_allowed(&b,now)); astra_health_sent(&b,now);
        astra_health_result(&b,now,0,0);
    }
    astra_health_tick(&b,began+14999); assert(b.health_mode==0);
    now=began+15200; astra_health_tick(&b,now);
    assert(b.health_mode==1 && b.health_limited==1 && b.health_entries==1 && !b.health_dirty);
    assert(!astra_health_allowed(&b,now));
    /* One day of failed fresh probes is bounded, fair selection lives in the
     * scheduler. Neither failures nor late positives grant full-rate credit. */
    uint64_t probes=0, last=0;
    for(uint64_t elapsed=0;elapsed<86400000;elapsed+=250) {
        uint64_t t=now+elapsed;
        if(!astra_health_allowed(&b,t)) { continue; }
        if(last) { assert(t-last>=2000); }
        last=t; ++probes; astra_health_sent(&b,t);
        astra_health_result(&b,t,0,probes%2);
    }
    assert(probes<5780 && b.health_mode==1 && b.health_recoveries==0);
    assert(b.writes==1); /* no per-key disk writes */
    now+=86400000;
    astra_provider_close(&b);
    assert(astra_provider_open(&b,health_directory,id,boot,now,wall+now-100000));
    astra_health_open(&b,now);
    assert(b.health_mode==1 && !astra_health_allowed(&b,now+14999));
    assert(astra_health_allowed(&b,now+15000));
    now+=15000; astra_health_sent(&b,now); astra_health_result(&b,now,1,1);
    assert(b.health_mode==2 && !astra_health_allowed(&b,now+250));
    /* Restart in tentative recovery must remain limited. */
    astra_provider_close(&b);
    assert(astra_provider_open(&b,health_directory,id,boot,now,wall+now-100000));
    astra_health_open(&b,now); assert(b.health_mode==1);
    now+=15000; assert(astra_health_allowed(&b,now));
    astra_health_sent(&b,now); astra_health_result(&b,now,1,1);
    uint64_t recovery=now;
    for(unsigned i=1;i<=130;i++) {
        now=recovery+i*251;
        assert(astra_health_allowed(&b,now)); astra_health_sent(&b,now);
        astra_health_result(&b,now,1,1);
    }
    assert(b.health_mode==0 && b.health_limited==0 && b.health_recoveries==1 && b.writes==1);
    astra_provider_close(&b);
    assert(astra_provider_open(&b,health_directory,id,boot,now,wall+now-100000));
    astra_health_open(&b,now); assert(b.health_mode==0);
    astra_provider_close(&b);
    /* Corruption and symlinks never restore full-rate traffic. */
    snprintf(path,sizeof path,"%s/%s.health.json",health_directory,id);
    fd=open(path,O_WRONLY|O_TRUNC); assert(fd>=0); assert(write(fd,"{}",2)==2); close(fd);
    assert(astra_provider_open(&b,health_directory,id,boot,now,wall+now-100000));
    astra_health_open(&b,now); assert(b.health_mode==1 && !b.health_dirty);
    astra_provider_close(&b);
    assert(unlink(path)==0); assert(symlink("/nonexistent/astra-health",path)==0);
    assert(astra_provider_open(&b,health_directory,id,boot,now,wall+now-100000));
    astra_health_open(&b,now); assert(b.health_mode==1);
    astra_provider_close(&b); remove_files(health_directory);
    puts("PASS: durable native attempt budget, mutual exclusion, pacing, health, corruption hold and ownership checks");
    return 0;
}
