/* AstraDVB additions, GPL-3.0-or-later. No credentials, ECMs or keys retained. */
#ifndef ASTRA_PROVIDER_BUDGET_H
#define ASTRA_PROVIDER_BUDGET_H
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

#define ASTRA_DIRECT_TRANSPORT_POLICY_VERSION 2
#define ASTRA_PROVIDER_WINDOW 60000ULL
struct astra_provider_budget {
    int dirfd, ownerfd, accountfd, dirty, ready, attempted;
    char id[65], boot[37];
    uint64_t attempts[3], count, failures, backoff, quarantine, next_frame;
    uint64_t retry_at, positive_since, last_positive, positives;
    uint64_t connections, frames, closes, stable_recoveries;
    uint64_t saved_up, saved_wall, writes;
    uint32_t frame_interval_ms;
    /* ECM admission is independent of TCP pacing. A responsive NOK is NOT a
     * useful key, but must not close an otherwise healthy shared connection. */
    unsigned health_mode, health_limited, health_dirty, health_opened;
    uint64_t health_retry, health_next, health_anchor, health_last_good, health_last_sent;
    uint64_t health_since_good, health_ramp_since, health_ramp_good, health_probes;
    uint64_t health_good, health_negative, health_late, health_entries;
    uint64_t health_probe_sent, health_recoveries;
};
static inline int astra_provider_literal(const char **p, const char *literal) {
    size_t n = strlen(literal);
    if(strncmp(*p, literal, n)) { return 0; }
    *p += n; return 1;
}
static inline int astra_provider_number(const char **p, uint64_t *out) {
    if(**p < '0' || **p > '9') { return 0; }
    char *end; errno = 0; double n = strtod(*p, &end);
    if(errno || end == *p || !(n >= 0 && n <= 9007199254740991.0)) { return 0; }
    *out = (uint64_t)n;
    if((double)*out < n) { ++*out; } /* conservative fractional legacy uptime */
    *p = end; return 1;
}
/* Strict canonical v1 JSON also written by the previous Node budget store.
 * Other encodings/schema changes get a durable safety hold, not fresh credit. */
static inline int astra_provider_parse(struct astra_provider_budget *b, const char *text) {
    const char *p = text; uint64_t version;
    if(!astra_provider_literal(&p, "{\"version\":") || !astra_provider_number(&p, &version) || version != 1 ||
       !astra_provider_literal(&p, ",\"savedWallMs\":") || !astra_provider_number(&p, &b->saved_wall) ||
       !astra_provider_literal(&p, ",\"savedUptimeMs\":") || !astra_provider_number(&p, &b->saved_up) ||
       !astra_provider_literal(&p, ",\"bootId\":\"") || strlen(p) < 37) { return 0; }
    char boot[37]; memcpy(boot, p, 36); boot[36] = 0; p += 36;
    if(strcmp(boot, b->boot) || !astra_provider_literal(&p, "\",\"attemptUptimeMs\":[")) { return 0; }
    b->count = 0;
    if(*p != ']') {
        do {
            if(b->count >= 3 || !astra_provider_number(&p, &b->attempts[b->count])) { return 0; }
            if(b->attempts[b->count] > b->saved_up || (b->count && b->attempts[b->count] < b->attempts[b->count-1])) { return 0; }
            ++b->count;
            if(*p != ',') { break; }
            ++p;
        } while(1);
    }
    if(!astra_provider_literal(&p, "],\"failureCount\":") || !astra_provider_number(&p, &b->failures) || b->failures > 32 ||
       !astra_provider_literal(&p, ",\"backoffUntilUptimeMs\":") || !astra_provider_number(&p, &b->backoff) ||
       !astra_provider_literal(&p, ",\"quarantineUntilUptimeMs\":") || !astra_provider_number(&p, &b->quarantine) ||
       !astra_provider_literal(&p, ",\"frameUntilUptimeMs\":") || !astra_provider_number(&p, &b->next_frame) ||
       !astra_provider_literal(&p, "}")) { return 0; }
    if(*p == '\n') { ++p; }
    return !*p && b->backoff <= b->saved_up + 60000 && b->quarantine <= b->saved_up + 60000 && b->next_frame <= b->saved_up + 1000;
}
static inline int astra_provider_regular(int fd) {
    struct stat st;
    return fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_uid == geteuid() && !(st.st_mode & 077);
}
static inline void astra_provider_close(struct astra_provider_budget *b) {
    if(b->accountfd >= 0) { close(b->accountfd); }
    if(b->ownerfd >= 0) { close(b->ownerfd); }
    if(b->dirfd >= 0) { close(b->dirfd); }
    b->accountfd = b->ownerfd = b->dirfd = -1;
}
static inline int astra_provider_owned(struct astra_provider_budget *b) {
    struct stat a, p; char name[80];
    if(b->dirfd < 0 || b->ownerfd < 0 || b->accountfd < 0) { return 0; }
    if(fstat(b->ownerfd, &a) || fstatat(b->dirfd, "owner.lock", &p, AT_SYMLINK_NOFOLLOW) || a.st_dev != p.st_dev || a.st_ino != p.st_ino) { return 0; }
    snprintf(name, sizeof name, "%s.lock", b->id);
    return fstat(b->accountfd, &a) == 0 && fstatat(b->dirfd, name, &p, AT_SYMLINK_NOFOLLOW) == 0 && a.st_dev == p.st_dev && a.st_ino == p.st_ino;
}
static inline int astra_provider_persist(struct astra_provider_budget *b, uint64_t now, uint64_t wall) {
    char data[2048], attempts[128] = "", name[80], temporary[128]; size_t used = 0;
    if(!astra_provider_owned(b)) { b->retry_at = now + 5000; return 0; }
    for(uint64_t i = 0; i < b->count; ++i) {
        int n = snprintf(attempts + used, sizeof attempts - used, "%s%llu", i ? "," : "", (unsigned long long)b->attempts[i]);
        if(n < 0 || (size_t)n >= sizeof attempts - used) { return 0; } used += (size_t)n;
    }
    int length = snprintf(data, sizeof data,
        "{\"version\":1,\"savedWallMs\":%llu,\"savedUptimeMs\":%llu,\"bootId\":\"%s\",\"attemptUptimeMs\":[%s],\"failureCount\":%llu,\"backoffUntilUptimeMs\":%llu,\"quarantineUntilUptimeMs\":%llu,\"frameUntilUptimeMs\":%llu}\n",
        (unsigned long long)wall, (unsigned long long)now, b->boot, attempts, (unsigned long long)b->failures,
        (unsigned long long)b->backoff, (unsigned long long)b->quarantine, (unsigned long long)b->next_frame);
    if(length <= 0 || (size_t)length >= sizeof data) { return 0; }
    snprintf(name, sizeof name, "%s.json", b->id);
    /* Unique while account lock is held; never reuse/truncate an existing path. */
    int fd = -1;
    for(unsigned retry = 0; retry < 8; ++retry) {
        snprintf(temporary, sizeof temporary, ".direct-%s-%ld-%llu.tmp", b->id, (long)getpid(), (unsigned long long)++b->writes);
        fd = openat(b->dirfd, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
        if(fd >= 0 || errno != EEXIST) { break; }
    }
    int ok = fd >= 0; size_t offset = 0;
    while(ok && offset < (size_t)length) {
        ssize_t n = write(fd, data + offset, (size_t)length - offset);
        if(n < 0 && errno == EINTR) { continue; }
        if(n <= 0) { ok = 0; break; } offset += (size_t)n;
    }
    if(ok) { ok = fsync(fd) == 0; }
    if(fd >= 0 && close(fd)) { ok = 0; }
    if(ok) { ok = astra_provider_owned(b) && renameat(b->dirfd, temporary, b->dirfd, name) == 0; }
    if(ok) { ok = fsync(b->dirfd) == 0; }
    if(fd >= 0) { unlinkat(b->dirfd, temporary, 0); }
    b->dirty = !ok; b->retry_at = ok ? 0 : now + 5000;
    return ok;
}
static inline void astra_provider_trim(struct astra_provider_budget *b, uint64_t now) {
    /* Same extra second as legacy restoration; process restart cannot shorten it. */
    while(b->count && now >= b->attempts[0] && now - b->attempts[0] >= 61000) {
        memmove(b->attempts, b->attempts + 1, (size_t)(--b->count) * sizeof b->attempts[0]);
    }
}
static inline int astra_provider_open(struct astra_provider_budget *b, const char *directory, const char *id, const char *boot, uint64_t now, uint64_t wall) {
    *b = (struct astra_provider_budget){ .dirfd = -1, .ownerfd = -1, .accountfd = -1 };
    if(!directory || directory[0] != '/' || !id || strlen(id) != 64 || !boot || strlen(boot) != 36) { return 0; }
    for(size_t i = 0; i < 64; ++i) { if(!((id[i] >= '0' && id[i] <= '9') || (id[i] >= 'a' && id[i] <= 'f'))) { return 0; } }
    memcpy(b->id, id, 65); memcpy(b->boot, boot, 37);
    b->dirfd = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    struct stat st;
    if(b->dirfd < 0 || fstat(b->dirfd, &st) || st.st_uid != geteuid() || (st.st_mode & 077)) { goto bad; }
    b->ownerfd = openat(b->dirfd, "owner.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0600);
    /* Shared native directory ownership, exclusive per-account ownership.
     * Legacy Node's exclusive owner.lock cannot coexist with this path. */
    if(b->ownerfd < 0 || !astra_provider_regular(b->ownerfd) || flock(b->ownerfd, LOCK_SH | LOCK_NB)) { goto bad; }
    char name[80]; snprintf(name, sizeof name, "%s.lock", id);
    b->accountfd = openat(b->dirfd, name, O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0600);
    if(b->accountfd < 0 || !astra_provider_regular(b->accountfd) || flock(b->accountfd, LOCK_EX | LOCK_NB)) { goto bad; }
    snprintf(name, sizeof name, "%s.json", id);
    int fd = openat(b->dirfd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if(fd < 0) { if(errno != ENOENT) { goto bad; } b->next_frame = now + 1000; return 1; }
    char data[4097]; ssize_t n = read(fd, data, sizeof data - 1);
    int regular = astra_provider_regular(fd); close(fd);
    if(!regular || n < 0) { goto bad; }
    data[n] = 0;
    int valid = n < 4096 && astra_provider_parse(b, data) && now >= b->saved_up &&
        wall + 1000 >= b->saved_wall;
    if(valid) {
        uint64_t up_elapsed = now - b->saved_up, wall_elapsed = wall >= b->saved_wall ? wall - b->saved_wall : 0;
        valid = up_elapsed > wall_elapsed ? up_elapsed - wall_elapsed <= 5000 : wall_elapsed - up_elapsed <= 5000;
    }
    if(!valid) {
        b->count = b->failures = b->backoff = 0; b->quarantine = now + ASTRA_PROVIDER_WINDOW;
        b->next_frame = now + 1000; b->dirty = 1;
        if(!astra_provider_persist(b, now, wall)) { goto bad; }
    } else { b->next_frame = now + 1000; astra_provider_trim(b, now); }
    return 1;
bad:
    astra_provider_close(b); return 0;
}
static inline uint64_t astra_provider_delay(struct astra_provider_budget *b, uint64_t now) {
    if(!astra_provider_owned(b)) { return 5000; }
    astra_provider_trim(b, now);
    uint64_t due = b->retry_at > b->backoff ? b->retry_at : b->backoff;
    if(b->quarantine > due) { due = b->quarantine; }
    if(b->count >= 3 && b->attempts[0] + 61000 > due) { due = b->attempts[0] + 61000; }
    return due > now ? due - now : 0;
}
static inline int astra_provider_reserve(struct astra_provider_budget *b, uint64_t now, uint64_t wall) {
    if(b->attempted || astra_provider_delay(b, now)) { return 0; }
    if(b->dirty && !astra_provider_persist(b, now, wall)) { return 0; }
    b->attempts[b->count++] = now; b->dirty = 1;
    if(!astra_provider_persist(b, now, wall)) { return 0; }
    b->attempted = 1; b->ready = 0; b->positives = 0; b->positive_since = b->last_positive = 0;
    ++b->connections; return 1;
}
static inline void astra_provider_failed(struct astra_provider_budget *b, uint64_t now, uint64_t wall) {
    if(!b->attempted) { return; }
    b->attempted = b->ready = 0; b->positives = 0; ++b->closes;
    if(b->failures < 32) { ++b->failures; }
    uint64_t shift = b->failures > 5 ? 4 : b->failures - 1;
    uint64_t delay = 1000ULL << shift;
    b->backoff = now + (delay > 15000 ? 15000 : delay); b->dirty = 1;
    (void)astra_provider_persist(b, now, wall);
}
static inline void astra_provider_positive(struct astra_provider_budget *b, uint64_t now, uint64_t wall) {
    if(!b->attempted || !b->ready) { return; }
    if(!b->positives || now - b->last_positive > 30000) { b->positive_since = now; b->positives = 0; }
    b->last_positive = now; ++b->positives;
    if(b->failures && b->positives >= 3 && now - b->positive_since >= 30000) {
        b->failures = b->backoff = 0; ++b->stable_recoveries; b->dirty = 1;
        (void)astra_provider_persist(b, now, wall);
    }
}
static inline int astra_provider_take_frame(struct astra_provider_budget *b, uint64_t now) {
    if(!b->attempted || !astra_provider_owned(b) || now < b->next_frame) { return 0; }
    b->next_frame = now + (b->frame_interval_ms >= 50 && b->frame_interval_ms <= 1000 ? b->frame_interval_ms : 50); ++b->frames; return 1;
}

/* A separate, account-locked latch leaves the v1 connection budget compatible.
 * Write only transitions, never every ECM. Restart/reboot of a limited account
 * resumes sparse probes, not full-rate work. No credentials/ECMs/CWs on disk. */
static inline int astra_health_save(struct astra_provider_budget *b, uint64_t now) {
    if(!astra_provider_owned(b)) { b->health_retry = now + 5000; return 0; }
    char name[96], temporary[144];
    snprintf(name, sizeof name, "%s.health.json", b->id);
    snprintf(temporary, sizeof temporary, ".health-%s-%ld-%llu.tmp", b->id, (long)getpid(), (unsigned long long)++b->writes);
    int fd = openat(b->dirfd, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    const char *data = b->health_limited ? "{\"version\":1,\"limited\":1}\n" : "{\"version\":1,\"limited\":0}\n";
    size_t length = strlen(data), offset = 0; int ok = fd >= 0;
    while(ok && offset < length) {
        ssize_t n = write(fd, data + offset, length - offset);
        if(n < 0 && errno == EINTR) { continue; }
        if(n <= 0) { ok = 0; break; } offset += (size_t)n;
    }
    if(ok) { ok = fsync(fd) == 0; }
    if(fd >= 0 && close(fd)) { ok = 0; }
    if(ok) { ok = astra_provider_owned(b) && renameat(b->dirfd, temporary, b->dirfd, name) == 0; }
    if(ok) { ok = fsync(b->dirfd) == 0; }
    if(fd >= 0) { unlinkat(b->dirfd, temporary, 0); }
    b->health_dirty = !ok; b->health_retry = ok ? 0 : now + 5000;
    return ok;
}
static inline void astra_health_open(struct astra_provider_budget *b, uint64_t now) {
    if(b->health_opened) { return; }
    b->health_opened = 1;
    char name[96], data[128]; snprintf(name, sizeof name, "%s.health.json", b->id);
    int fd = openat(b->dirfd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if(fd < 0 && errno == ENOENT) { return; }
    ssize_t n = fd >= 0 ? read(fd, data, sizeof data - 1) : -1;
    int valid = fd >= 0 && astra_provider_regular(fd) && n > 0 && n < (ssize_t)sizeof data - 1;
    if(fd >= 0) { close(fd); }
    if(valid) { data[n] = 0; valid = !strcmp(data, "{\"version\":1,\"limited\":0}\n") || !strcmp(data, "{\"version\":1,\"limited\":1}\n"); }
    if(valid && !strcmp(data, "{\"version\":1,\"limited\":0}\n")) { return; }
    b->health_mode = b->health_limited = 1; b->health_probes = 10;
    b->health_next = now + 15000;
    if(!valid) { b->health_dirty = 1; (void)astra_health_save(b, now); }
}
static inline void astra_health_tick(struct astra_provider_budget *b, uint64_t now) {
    /* Require both enough real upstream work AND a sustained absence of useful
     * keys. Idle periods or one unsupported channel cannot trip an active,
     * otherwise working account. No service blacklist is maintained. */
    if(b->health_mode != 1 && b->health_since_good >= 32 && b->health_anchor &&
       now >= b->health_anchor && now - b->health_anchor >= 15000) {
        b->health_mode = 1; b->health_probes = 0; b->health_next = now + 2000;
        b->health_ramp_good = b->health_ramp_since = 0; ++b->health_entries;
        b->health_limited = b->health_dirty = 1;
    }
    if(b->health_dirty && now >= b->health_retry) { (void)astra_health_save(b, now); }
}
static inline int astra_health_allowed(struct astra_provider_budget *b, uint64_t now) {
    astra_health_tick(b, now);
    return !b->health_dirty && astra_provider_owned(b) && now >= b->health_next;
}
static inline void astra_health_sent(struct astra_provider_budget *b, uint64_t now) {
    if(b->health_since_good < 32 && b->health_last_sent && now - b->health_last_sent >= 15000) { b->health_since_good = 0; }
    b->health_last_sent = now;
    if(!b->health_since_good) { b->health_anchor = now; }
    ++b->health_since_good;
    if(b->health_mode == 1) {
        ++b->health_probe_sent; ++b->health_probes;
        b->health_next = now + (b->health_probes < 5 ? 2000 : b->health_probes < 10 ? 5000 : 15000);
    } else if(b->health_mode >= 2) { b->health_next = now + (b->health_mode == 2 ? 251 : 126); }
}
/* Exactly once per matched upstream reply, not per alias/cache result. 'good'
 * requires a nonzero valid CW AND a live caller within its original deadline. */
static inline void astra_health_result(struct astra_provider_budget *b, uint64_t now, int good, int positive) {
    if(!good) { if(positive) { ++b->health_late; } else { ++b->health_negative; } return; }
    ++b->health_good; b->health_since_good = 0; b->health_anchor = 0;
    if(b->health_last_good && now - b->health_last_good > 15000) { b->health_ramp_since = b->health_ramp_good = 0; }
    b->health_last_good = now;
    if(b->health_mode == 1) {
        b->health_mode = 2; b->health_ramp_since = now; b->health_ramp_good = 0;
        b->health_next = now + 251;
    }
    if(b->health_limited) {
        if(!b->health_ramp_since) { b->health_ramp_since = now; }
        ++b->health_ramp_good;
        if(b->health_mode == 2 && b->health_ramp_good >= 3) { b->health_mode = 3; }
        if(b->health_mode == 3 && b->health_ramp_good >= 8 && now - b->health_ramp_since >= 2000) {
            b->health_mode = 0; ++b->health_recoveries;
        }
        /* Keep the durable latch through the initial ramp. A process crash
         * during tentative recovery must not grant a new full-rate startup. */
        if(b->health_mode == 0 && now - b->health_ramp_since >= 30000) {
            b->health_limited = 0; b->health_dirty = 1;
            (void)astra_health_save(b, now);
        }
    }
}
#endif
