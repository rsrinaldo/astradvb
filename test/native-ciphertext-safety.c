/* Provider-free strict packet oracle for the isolated ciphertext candidate.
 * XOR below is only a deterministic test cipher; actual CSA/media is covered
 * by the separate native compatibility laboratory, never inferred here. */
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "astra-ciphertext-safety.h"

#define ORACLE_PACKETS 4096
struct oracle {
    uint8_t reference[ORACLE_PACKETS][188];
    size_t references, cursor, emitted, bad;
    unsigned int ambiguous, fail_emit, batch_calls, maximum_batch;
    struct astra_ciphertext *engine;
    unsigned int require_idle_owner_release, idle_release_checks;
};
static struct oracle oracle;
static void word(uint8_t key[8], unsigned int n) { for (unsigned int i = 0; i < 8; i++) key[i] = (uint8_t)(n + 1 + i * 3); }
static void packet(uint8_t out[188], unsigned int pid, unsigned int cc, int pusi, uint8_t fill) {
    memset(out, fill, 188); out[0] = 0x47; out[1] = (pid >> 8) | (pusi ? 0x40 : 0); out[2] = pid; out[3] = 0x10 | (cc & 15);
    if (pusi) {
        static const uint8_t pes[14] = {0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1};
        memcpy(out + 4, pes, sizeof(pes));
    }
}
static int decrypt(void *opaque, const uint8_t key[8], const uint8_t raw[188], uint8_t clear[188]) {
    struct oracle *o = opaque; memcpy(clear, raw, 188); unsigned int offset = astra_ct_offset(raw);
    for (unsigned int i = offset; i < 188; i++) clear[i] ^= key[(i - offset) & 7];
    clear[3] &= 0x3f;
    if (o->ambiguous && (raw[1] & 0x40) && (key[0] == 2 || key[0] == 3)) {
        static const uint8_t pes[14] = {0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1};
        memcpy(clear + offset, pes, sizeof(pes));
    }
    return 1;
}
static int emit(void *opaque, const uint8_t clear[188]) {
    struct oracle *o = opaque;
    if (o->fail_emit) return 0;
    if (o->require_idle_owner_release) {
        struct astra_ciphertext *s = o->engine;
        unsigned int pid = ((unsigned int)(clear[1] & 31) << 8) | clear[2];
        assert(s->pids[pid].run == ASTRA_CT_NONE && !s->pids[pid].seen);
        struct astra_ct_packet *queued = &s->queue[s->head]; assert(queued->run != ASTRA_CT_NONE);
        struct astra_ct_run *run = &s->runs[queued->run];
        assert(run->present && run->references == 1 && s->keys[run->key].references >= 1);
        o->idle_release_checks++;
    }
    size_t next = o->cursor;
    while (next < o->references && memcmp(clear, o->reference[next], 188)) next++;
    if (next == o->references) o->bad++;
    else o->cursor = next + 1;
    o->emitted++; return 1;
}
static int decrypt_batch(void *opaque, const uint8_t key[8], const uint8_t (*raw)[188], uint8_t (*clear)[188], size_t count) {
    struct oracle *o = opaque; assert(count > 0 && count <= ASTRA_CT_BATCH_PACKETS);
    o->batch_calls++; if (count > o->maximum_batch) o->maximum_batch = count;
    for (size_t i = 0; i < count; i++) assert(decrypt(opaque, key, raw[i], clear[i]));
    return 1;
}
static struct astra_ciphertext *start(size_t bytes, unsigned int wait_ms) {
    memset(&oracle, 0, sizeof(oracle));
    struct astra_ciphertext *s = astra_ciphertext_create(bytes, wait_ms, decrypt, emit, &oracle); assert(s);
    oracle.engine = s;
    astra_ciphertext_context(s, 1); astra_ciphertext_pid(s, 256, 0x1b); astra_ciphertext_pid(s, 257, 0x1b); return s;
}
static void publish(struct astra_ciphertext *s, unsigned int parity, unsigned int number, uint64_t now) {
    uint8_t key[8]; word(key, number); assert(astra_ciphertext_word(s, 1, parity, key, now));
}
static void push_bytes(struct astra_ciphertext *s, const uint8_t clear[188], unsigned int parity, unsigned int number, uint64_t now) {
    uint8_t raw[188], key[8]; assert(oracle.references < ORACLE_PACKETS);
    memcpy(raw, clear, 188); memcpy(oracle.reference[oracle.references++], clear, 188); word(key, number);
    unsigned int offset = astra_ct_offset(raw);
    for (unsigned int i = offset; i < 188; i++) raw[i] ^= key[(i - offset) & 7];
    raw[3] |= parity ? 0xc0 : 0x80; assert(astra_ciphertext_push(s, raw, now));
}
static void push(struct astra_ciphertext *s, unsigned int pid, unsigned int cc, int pusi, unsigned int parity, unsigned int number, uint64_t now, uint8_t fill) {
    uint8_t clear[188]; packet(clear, pid, cc, pusi, fill); push_bytes(s, clear, parity, number, now);
}
static void exact(struct astra_ciphertext *s, uint64_t now) {
    assert(astra_ciphertext_finish(s, now)); assert(oracle.bad == 0); assert(oracle.emitted == oracle.references); assert(s->count == 0);
    assert(s->stats.packets_dropped == 0); assert(s->stats.allocated_bytes <= ASTRA_CT_MAX_BYTES); astra_ciphertext_destroy(s);
}
static void safe_tail(struct astra_ciphertext *s, uint64_t now, size_t minimum_tail) {
    assert(astra_ciphertext_finish(s, now)); assert(oracle.bad == 0); assert(oracle.cursor == oracle.references);
    assert(oracle.emitted >= minimum_tail); assert(s->count == 0); astra_ciphertext_destroy(s);
}
static void healthy_parity_continuation(void) {
    struct astra_ciphertext *s = start(ASTRA_CT_MAX_BYTES, 2000); publish(s, 0, 1, 0); publish(s, 1, 2, 0);
    push(s, 256, 0, 1, 0, 1, 0, 1);
    for (unsigned int i = 1; i <= 20; i++) push(s, 256, i, 0, 1, 2, i, i + 1);
    assert(oracle.emitted == 1 && "headerless parity prefix must await its independent PES anchor");
    push(s, 256, 21, 1, 1, 2, 21, 23); exact(s, 22);
}
static void delayed_and_missing_words(void) {
    struct astra_ciphertext *s = start(ASTRA_CT_MAX_BYTES, 2000); publish(s, 0, 1, 0);
    push(s, 256, 0, 1, 0, 1, 0, 1);
    for (unsigned int i = 1; i <= 20; i++) push(s, 256, i, 0, 1, 2, i, i + 1);
    push(s, 256, 21, 1, 1, 2, 21, 23); assert(oracle.emitted == 1);
    publish(s, 1, 2, 900); assert(astra_ciphertext_pump(s, 900, 0)); exact(s, 901);
    s = start(ASTRA_CT_MAX_BYTES, 2000); publish(s, 0, 1, 0); push(s, 256, 0, 1, 0, 1, 0, 1);
    push(s, 256, 1, 0, 1, 2, 1, 2); push(s, 256, 2, 1, 1, 2, 2, 3);
    assert(astra_ciphertext_pump(s, 2002, 0)); assert(s->stats.timeout_drops > 0); assert(oracle.bad == 0);
    publish(s, 1, 3, 2003); push(s, 256, 3, 1, 1, 3, 2003, 4);
    for (unsigned int i = 4; i < 24; i++) push(s, 256, i, 0, 1, 3, 2003 + i, i);
    safe_tail(s, 2030, 21);
}
static void prefetched_same_parity_change(void) {
    struct astra_ciphertext *s = start(ASTRA_CT_MAX_BYTES, 2000); publish(s, 0, 1, 0); push(s, 256, 0, 1, 0, 1, 0, 1);
    publish(s, 0, 2, 1); // A future word does not move the physical key boundary.
    push(s, 256, 1, 0, 0, 1, 2, 2); // Still old A; next PES will use B.
    push(s, 256, 2, 1, 0, 2, 3, 3);
    for (unsigned int i = 3; i < 24; i++) push(s, 256, i, 0, 0, 2, i + 1, i);
    assert(oracle.bad == 0 && "new PES must never retroactively decrypt ambiguous old prefix with future CW");
    // Under the stated stable-observed-run contract, prefetched future words
    // cannot invalidate an already certified current word. A valid new PUSI
    // independently anchors the next word without dropping healthy prefix.
    exact(s, 30);
}
static void startup_ambiguous_prefix(void) {
    struct astra_ciphertext *s = start(ASTRA_CT_MAX_BYTES, 2000); publish(s, 0, 1, 0); publish(s, 0, 2, 0);
    push(s, 256, 0, 0, 0, 1, 1, 1); push(s, 256, 1, 1, 0, 2, 2, 2);
    assert(oracle.bad == 0); assert(s->stats.packets_dropped == 1); safe_tail(s, 3, 1);
}
static void pid_whole_cycle_gap(int pusi_resume) {
    struct astra_ciphertext *s = start(ASTRA_CT_MAX_BYTES, 2000); publish(s, 0, 1, 0);
    push(s, 256, 0, 1, 0, 1, 0, 1); push(s, 257, 0, 1, 0, 1, 0, 2);
    publish(s, 1, 2, 1); push(s, 257, 1, 1, 1, 2, 2, 3);
    publish(s, 0, 3, 3); push(s, 257, 2, 1, 0, 3, 4, 4);
    if (!pusi_resume) push(s, 256, 1, 0, 0, 1, 5, 5); // Old key remains a possible prefix after absence.
    push(s, 256, pusi_resume ? 1 : 2, 1, 0, 3, 6, 6);
    if (pusi_resume) exact(s, 7);
    else { assert(oracle.bad == 0); assert(s->stats.packets_dropped > 0); safe_tail(s, 7, 5); }
}
static void unchanged_pairs_and_future_opposite_half(void) {
    struct astra_ciphertext *s = start(ASTRA_CT_MAX_BYTES, 2000); publish(s, 0, 1, 0); publish(s, 1, 2, 0);
    unsigned int cc = 0;
    for (unsigned int epoch = 0; epoch < 30; epoch++) {
        unsigned int parity = epoch & 1;
        push(s, 256, cc++, 1, parity, parity ? 2 : 1, epoch * 20, epoch + 1);
        for (unsigned int i = 1; i < 4; i++) push(s, 256, cc++, 0, parity, parity ? 2 : 1, epoch * 20 + i, epoch + i + 1);
    }
    exact(s, 1000);
    s = start(ASTRA_CT_MAX_BYTES, 2000); publish(s, 0, 1, 0); publish(s, 1, 2, 0); push(s, 256, 0, 1, 0, 1, 0, 1);
    publish(s, 1, 3, 1); // Opposite future half cannot invalidate current even payload.
    push(s, 256, 1, 0, 0, 1, 2, 2); push(s, 256, 2, 1, 0, 1, 3, 3); exact(s, 4);
}
static void marked_same_parity_changes(void) {
    struct astra_ciphertext *s = start(ASTRA_CT_MAX_BYTES, 2000); unsigned int cc = 0;
    for (unsigned int epoch = 0; epoch < 50; epoch++) {
        publish(s, 0, epoch + 1, epoch * 10);
        push(s, 256, cc++, 1, 0, epoch + 1, epoch * 10, epoch + 1);
        for (unsigned int i = 1; i < 5; i++) push(s, 256, cc++, 0, 0, epoch + 1, epoch * 10 + i, epoch + i + 1);
    }
    exact(s, 501);
}
static void ambiguity_context_and_eof(void) {
    struct astra_ciphertext *s = start(ASTRA_CT_MAX_BYTES, 2000); publish(s, 0, 1, 0); publish(s, 0, 2, 0); oracle.ambiguous = 1;
    push(s, 256, 0, 1, 0, 1, 1, 1); assert(oracle.emitted == 0); assert(s->stats.ambiguous_probes > 0);
    assert(astra_ciphertext_finish(s, 2)); assert(oracle.emitted == 0); assert(s->count == 0); astra_ciphertext_destroy(s);
    s = start(ASTRA_CT_MAX_BYTES, 2000); uint8_t zero[8] = {0}, key[8]; word(key, 1);
    assert(!astra_ciphertext_word(s, 1, 0, zero, 0)); assert(!astra_ciphertext_word(s, 2, 0, key, 0));
    publish(s, 0, 1, 0); push(s, 256, 0, 0, 0, 1, 1, 1); // EOF with no anchor cannot invent a certificate.
    astra_ciphertext_context(s, 2); assert(astra_ciphertext_finish(s, 2)); assert(oracle.emitted == 0); assert(s->count == 0); astra_ciphertext_destroy(s);
    s = start(ASTRA_CT_MAX_BYTES, 2000); publish(s, 0, 1, 0); push(s, 256, 0, 1, 0, 1, 0, 1);
    // Exact tail is deliberately not a CSA batch-size multiple.
    for (unsigned int i = 1; i < 38; i++) push(s, 256, i, 0, 0, 1, i, i + 1);
    exact(s, 39);
}
static void bounds_and_output_failure(void) {
    const size_t bytes = sizeof(struct astra_ciphertext) + 32 * sizeof(struct astra_ct_packet);
    assert(!astra_ciphertext_create(bytes - 1, 2000, decrypt, emit, &oracle));
    assert(!astra_ciphertext_create(ASTRA_CT_MAX_BYTES + 1, 2000, decrypt, emit, &oracle));
    assert(!astra_ciphertext_create(bytes, 2001, decrypt, emit, &oracle));
    struct astra_ciphertext *s = start(bytes, 2000);
    for (unsigned int i = 0; i < 1000; i++) push(s, 256, i, 0, i & 1, i & 1, 1, i & 255);
    assert(s->capacity == 32); assert(s->count <= 32); assert(s->stats.allocated_bytes <= bytes); assert(s->stats.capacity_drops > 0);
    assert(oracle.emitted == 0 && oracle.bad == 0); assert(astra_ciphertext_finish(s, 2)); assert(s->count == 0); astra_ciphertext_destroy(s);
    s = start(bytes, 2000); publish(s, 0, 1, 0); oracle.fail_emit = 1;
    uint8_t clear[188], raw[188], key[8]; packet(clear, 256, 0, 1, 1); memcpy(raw, clear, 188); word(key, 1);
    for (unsigned int i = 4; i < 188; i++) raw[i] ^= key[(i - 4) & 7];
    raw[3] |= 0x80;
    assert(!astra_ciphertext_push(s, raw, 1)); assert(s->output_failed); assert(!astra_ciphertext_pump(s, 2, 0)); astra_ciphertext_destroy(s);
}
static void split_pes_prefix_and_cc_gap(void) {
    struct astra_ciphertext *s = start(ASTRA_CT_MAX_BYTES, 2000); publish(s, 0, 1, 0);
    static const uint8_t prefix[19] = {0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1, 6, 7, 8, 9, 10};
    for (unsigned int i = 0; i < sizeof(prefix); i++) {
        uint8_t clear[188]; packet(clear, 256, i, i == 0, 0xff);
        clear[3] |= 0x20; clear[4] = 182; clear[5] = 0; clear[187] = prefix[i];
        push_bytes(s, clear, 0, 1, i);
        if (i < 13) assert(oracle.emitted == 0);
    }
    exact(s, 20);
    s = start(ASTRA_CT_MAX_BYTES, 2000); publish(s, 0, 1, 0); publish(s, 0, 2, 0);
    push(s, 256, 0, 1, 0, 1, 0, 1);
    push(s, 256, 7, 0, 0, 1, 1, 2); // Explicit gap loses the old anchor.
    push(s, 256, 8, 1, 0, 2, 2, 3);
    assert(oracle.bad == 0); assert(s->stats.packets_dropped > 0); safe_tail(s, 3, 2);
}
static void candidate_and_run_exhaustion(void) {
    struct astra_ciphertext *s = start(ASTRA_CT_MAX_BYTES, 2000);
    // One unknown head holds the global ordered FIFO while64 independently
    // certified runs pin all64 immutable words; none may be overwritten.
    astra_ciphertext_pid(s, 3000, 0x1b); push(s, 3000, 0, 1, 1, 200, 0, 1);
    for (unsigned int i = 0; i < ASTRA_CT_KEY_COUNT; i++) {
        unsigned int pid = 1000 + i; astra_ciphertext_pid(s, pid, 0x1b);
        publish(s, 0, i + 1, 1); push(s, pid, 0, 1, 0, i + 1, 1, i + 2);
    }
    uint8_t key[8]; word(key, 100);
    assert(!astra_ciphertext_word(s, 1, 0, key, 2)); assert(s->stats.candidate_overflows == 1);
    assert(oracle.emitted == 0); assert(astra_ciphertext_pump(s, 2002, 0)); assert(oracle.bad == 0);
    astra_ciphertext_context(s, 2); word(key, 101); assert(astra_ciphertext_word(s, 2, 0, key, 2003));
    push(s, 256, 0, 1, 0, 101, 2003, 201); safe_tail(s, 2004, 1);
    s = start(ASTRA_CT_MAX_BYTES, 2000);
    for (unsigned int i = 0; i < ASTRA_CT_RUN_COUNT + 20; i++) {
        unsigned int pid = 1000 + i; astra_ciphertext_pid(s, pid, 0x1b); push(s, pid, 0, 1, 0, 1, 1, i & 255);
    }
    assert(s->stats.run_overflows > 0); assert(oracle.emitted == 0 && oracle.bad == 0);
    assert(s->count <= ASTRA_CT_RUN_COUNT); astra_ciphertext_context(s, 2); assert(astra_ciphertext_finish(s, 2));
    assert(s->count == 0); word(key, 1); assert(astra_ciphertext_word(s, 2, 0, key, 3));
    push(s, 256, 0, 1, 0, 1, 3, 99); safe_tail(s, 4, 1);
}
static void deferred_batches_wrap_and_eof(void) {
    const size_t bytes = sizeof(struct astra_ciphertext) + 128 * sizeof(struct astra_ct_packet);
    struct astra_ciphertext *s = start(bytes, 2000);
    assert(!astra_ciphertext_batch(s, decrypt_batch, ASTRA_CT_BATCH_PACKETS + 1));
    assert(astra_ciphertext_batch(s, decrypt_batch, ASTRA_CT_BATCH_PACKETS)); astra_ciphertext_defer(s, 1);
    for (unsigned int i = 0; i < 3001; i++) {
        unsigned int epoch = i / 37, parity = epoch & 1;
        if (i % 37 == 0) publish(s, parity, epoch + 1, i);
        push(s, 256, i, i % 37 == 0, parity, epoch + 1, i, i & 255);
        if (i % 70 == 69) assert(astra_ciphertext_pump(s, i, 0));
        assert(s->count <= s->capacity && s->stats.allocated_bytes <= bytes);
    }
    assert(s->count > 0 && "finish must actually exercise a deferred partial batch");
    assert(astra_ciphertext_finish(s, 3002)); assert(oracle.bad == 0); assert(oracle.emitted == oracle.references);
    assert(oracle.batch_calls > 1 && oracle.maximum_batch > 1); assert(s->stats.packets_dropped == 0);
    assert(s->count == 0); astra_ciphertext_destroy(s);
}
static void expired_reply_and_ambiguity_eviction(void) {
    struct astra_ciphertext *s = start(ASTRA_CT_MAX_BYTES, 2000);
    publish(s, 0, 1, 0); push(s, 256, 0, 1, 0, 1, 0, 1);
    push(s, 256, 1, 0, 1, 2, 1, 2); push(s, 256, 2, 1, 1, 2, 2, 3);
    publish(s, 1, 2, 2500); assert(astra_ciphertext_pump(s, 2500, 0));
    assert(oracle.emitted == 1 && "a late timer/key cannot resurrect ciphertext after its original hold deadline");
    assert(s->stats.timeout_drops >= 2); push(s, 256, 3, 1, 1, 2, 2501, 4); safe_tail(s, 2502, 2);
    s = start(ASTRA_CT_MAX_BYTES, 2000); publish(s, 0, 1, 0); publish(s, 0, 2, 0); oracle.ambiguous = 1;
    push(s, 256, 0, 1, 0, 1, 0, 1); assert(oracle.emitted == 0);
    for (unsigned int i = 3; i <= 65; i++) publish(s, 0, i, 1);
    assert(astra_ciphertext_pump(s, 1, 0));
    assert(oracle.emitted == 0 && oracle.bad == 0 && "candidate eviction is not evidence resolving an earlier multi-key PES ambiguity");
    assert(astra_ciphertext_finish(s, 2)); assert(s->count == 0); astra_ciphertext_destroy(s);
}
static void malformed_selected_and_clear_transition(void) {
    struct astra_ciphertext *s = start(ASTRA_CT_MAX_BYTES, 2000); publish(s, 0, 1, 0);
    uint8_t raw[188];
    for (unsigned int kind = 0; kind < 5; kind++) {
        packet(raw, 256, kind, 0, 1);
        if (kind == 0) { raw[1] |= 0x80; raw[3] |= 0x80; }
        if (kind == 1) raw[3] |= 0x40;
        if (kind == 2) raw[3] = 0x80;
        if (kind == 3) { raw[3] |= 0xa0; raw[4] = 250; }
        if (kind == 4) raw[3] = 0;
        assert(astra_ciphertext_push(s, raw, kind));
    }
    assert(oracle.emitted == 0); assert(s->stats.packets_dropped == 5);
    packet(raw, 256, 5, 1, 1); memcpy(oracle.reference[oracle.references++], raw, 188); assert(astra_ciphertext_push(s, raw, 6));
    push(s, 256, 6, 0, 0, 1, 7, 2); push(s, 256, 7, 1, 0, 1, 8, 3);
    assert(oracle.bad == 0); safe_tail(s, 9, 2);
}
static void complete_ecm_identity(void) {
    uint8_t first[24] = {0x80, 0x70, 21}, changed[24];
    for (unsigned int i = 3; i < sizeof(first); i++) first[i] = (uint8_t)(i * 7);
    memcpy(changed, first, sizeof(first));
    assert(astra_ciphertext_same_ecm(first, sizeof(first), changed, sizeof(changed)));
    for (unsigned int index = sizeof(first) - 3; index < sizeof(first); index++) {
        memcpy(changed, first, sizeof(first)); changed[index] ^= 1;
        assert(!memcmp(first, changed, sizeof(first) - 3));
        assert(!astra_ciphertext_same_ecm(first, sizeof(first), changed, sizeof(changed)));
    }
    assert(!astra_ciphertext_same_ecm(first, sizeof(first), first, sizeof(first) - 1));
    assert(!astra_ciphertext_same_ecm(NULL, sizeof(first), first, sizeof(first)));
    assert(!astra_ciphertext_same_ecm(first, sizeof(first), NULL, sizeof(first)));
    assert(!astra_ciphertext_same_ecm(first, 0, first, 0));
}
static void idle_component_pid_churn(void) {
    struct astra_ciphertext *s = start(ASTRA_CT_MAX_BYTES, 2000);
    for (unsigned int i = 0; i < 400; i++) {
        uint64_t now = (uint64_t)i * 2101 + 1;
        assert(astra_ciphertext_pump(s, now, 0));
        unsigned int pid = 1000 + i; astra_ciphertext_pid(s, pid, 0x1b);
        publish(s, 0, i + 1, now); push(s, pid, 0, 1, 0, i + 1, now, i & 255);
        assert(s->stats.candidate_overflows == 0 && s->stats.run_overflows == 0);
        assert(s->stats.allocated_bytes <= ASTRA_CT_MAX_BYTES && oracle.bad == 0);
    }
    uint64_t now = UINT64_C(400) * 2101 + 1;
    assert(astra_ciphertext_pump(s, now, 0));
    unsigned int owned_runs = 0, key_references = 0;
    for (unsigned int i = 0; i < ASTRA_CT_RUN_COUNT; i++) owned_runs += s->runs[i].present;
    for (unsigned int i = 0; i < ASTRA_CT_KEY_COUNT; i++) key_references += s->keys[i].references;
    assert(owned_runs == 0 && key_references == 0 && "removed component PIDs cannot pin run/key ownership forever");
    publish(s, 0, 401, now + 1); push(s, 1000, 1, 1, 0, 401, now + 1, 99);
    exact(s, now + 2);
}
static void idle_certificate_gc_preserves_queued_ownership(void) {
    struct astra_ciphertext *s = start(ASTRA_CT_MAX_BYTES, 2000); publish(s, 0, 1, 0);
    astra_ciphertext_defer(s, 1); push(s, 256, 0, 1, 0, 1, 0, 1);
    assert(s->count == 1 && oracle.emitted == 0);
    assert(s->runs[s->pids[256].run].references == 2);
    oracle.require_idle_owner_release = 1;
    assert(astra_ciphertext_pump(s, 2500, 0)); assert(oracle.idle_release_checks == 1);
    exact(s, 2501);
}
static void valid_unknown_candidate_eviction(void) {
    struct astra_ciphertext *s = start(ASTRA_CT_MAX_BYTES, 2000);
    uint8_t correct[8], false_valid[8]; word(correct, 1); memcpy(false_valid, correct, 8); false_valid[7] ^= 0xc0;
    assert(astra_ciphertext_word(s, 1, 0, correct, 0)); assert(astra_ciphertext_word(s, 1, 0, false_valid, 0));
    static const uint8_t pes[19] = {0, 0, 1, 0xe0, 0, 0, 0x80, 0xc0, 10, 0x31, 0, 1, 0, 1, 0x11, 0, 1, 0, 1};
    uint8_t clear[188], decoded[188]; packet(clear, 256, 0, 1, 0xff);
    clear[3] |= 0x20; clear[4] = 174; clear[5] = 0; memcpy(clear + 179, pes, 9);
    push_bytes(s, clear, 0, 1, 0); assert(oracle.emitted == 0);
    struct astra_ct_packet *held = &s->queue[s->head];
    assert(decrypt(&oracle, correct, held->bytes, decoded)); assert(astra_pes_header(decoded + 179, 9, 0x1b) == ASTRA_PES_UNKNOWN);
    assert(decrypt(&oracle, false_valid, held->bytes, decoded)); assert(astra_pes_header(decoded + 179, 9, 0x1b) == ASTRA_PES_VALID);
    for (unsigned int i = 3; i <= 65; i++) publish(s, 0, i, 1);
    assert(astra_ciphertext_pump(s, 1, 0));
    if (oracle.emitted || oracle.bad) fprintf(stderr, "VALID_UNKNOWN_EVICTION emitted=%zu wrong=%zu\n", oracle.emitted, oracle.bad);
    assert(oracle.emitted == 0 && oracle.bad == 0 && "a VALID-plus-UNKNOWN set must pin the undecided true word against eviction");
    packet(clear, 256, 1, 0, 0xff); clear[3] |= 0x20; clear[4] = 173; clear[5] = 0; memcpy(clear + 178, pes + 9, 10);
    push_bytes(s, clear, 0, 1, 2); assert(oracle.emitted == 0 && oracle.bad == 0);
    // This fresh PTS-only anchor rejects the false no-PTS candidate. Previously
    // uncertain bytes may be dropped, but exact fresh output must recover.
    push(s, 256, 2, 1, 0, 1, 3, 3); safe_tail(s, 4, 1);
}
static void unknown_only_candidate_eviction(void) {
    struct astra_ciphertext *s = start(ASTRA_CT_MAX_BYTES, 2000);
    uint8_t correct[8], false_valid[8]; word(correct, 1); memcpy(false_valid, correct, 8); false_valid[7] ^= 0xc0;
    assert(astra_ciphertext_word(s, 1, 0, correct, 0)); assert(astra_ciphertext_word(s, 1, 0, false_valid, 0));
    static const uint8_t pes[19] = {0, 0, 1, 0xe0, 0, 0, 0x80, 0xc0, 10, 0x31, 0, 1, 0, 1, 0x11, 0, 1, 0, 1};
    uint8_t clear[188], decoded[188]; packet(clear, 256, 0, 1, 0xff);
    clear[3] |= 0x20; clear[4] = 182; clear[5] = 0; clear[187] = pes[0];
    push_bytes(s, clear, 0, 1, 0); assert(oracle.emitted == 0);
    struct astra_ct_packet *held = &s->queue[s->head];
    assert(decrypt(&oracle, correct, held->bytes, decoded)); assert(astra_pes_header(decoded + 187, 1, 0x1b) == ASTRA_PES_UNKNOWN);
    assert(decrypt(&oracle, false_valid, held->bytes, decoded)); assert(astra_pes_header(decoded + 187, 1, 0x1b) == ASTRA_PES_UNKNOWN);
    // Opposite-half publications can evict this even candidate without
    // changing the selected-half revision of the unfinished even PES run.
    for (unsigned int i = 3; i <= 65; i++) publish(s, 1, i, 1);
    assert(astra_ciphertext_pump(s, 1, 0)); assert(oracle.emitted == 0);
    packet(clear, 256, 1, 0, 0xff); clear[3] |= 0x20; clear[4] = 165; clear[5] = 0; memcpy(clear + 170, pes + 1, 18);
    push_bytes(s, clear, 0, 1, 2);
    if (oracle.emitted || oracle.bad) fprintf(stderr, "UNKNOWN_ONLY_EVICTION emitted=%zu wrong=%zu\n", oracle.emitted, oracle.bad);
    assert(oracle.emitted == 0 && oracle.bad == 0 && "partial UNKNOWN candidates must survive eviction until they can be explicitly ruled out");
    push(s, 256, 2, 1, 0, 1, 3, 3); safe_tail(s, 4, 1);
}
static unsigned int candidate_index(struct astra_ciphertext *s, const uint8_t key[8]) {
    for (unsigned int i = 0; i < ASTRA_CT_KEY_COUNT; i++) if (s->keys[i].present && s->keys[i].context == 1 && s->keys[i].parity == 0 && !memcmp(s->keys[i].word, key, 8)) return i;
    assert(0 && "expected retained candidate must exist"); return 0;
}
static void late_new_candidate_and_exact_retention_references(void) {
    struct astra_ciphertext *s = start(ASTRA_CT_MAX_BYTES, 2000);
    uint8_t correct[8], initially_unknown[8]; word(correct, 1); memcpy(initially_unknown, correct, 8); initially_unknown[7] ^= 0xc0;
    assert(astra_ciphertext_word(s, 1, 0, initially_unknown, 0));
    static const uint8_t prefix[9] = {0, 0, 1, 0xe0, 0, 0, 0x80, 0, 10};
    uint8_t clear[188]; packet(clear, 256, 0, 1, 0xff);
    clear[3] |= 0x20; clear[4] = 174; clear[5] = 0; memcpy(clear + 179, prefix, 9);
    push_bytes(s, clear, 0, 1, 0);
    struct astra_ct_run *run = &s->runs[s->pids[256].run];
    unsigned int old = candidate_index(s, initially_unknown);
    assert(run->ambiguous_mask == 0 && run->retained_mask == (UINT64_C(1) << old));
    assert(s->keys[old].references == 1);
    assert(astra_ciphertext_word(s, 1, 0, correct, 1)); assert(astra_ciphertext_pump(s, 1, 0));
    unsigned int added = candidate_index(s, correct); uint64_t both = (UINT64_C(1) << old) | (UINT64_C(1) << added);
    assert(run->retained_mask == both && run->ambiguous_mask == both);
    assert(s->keys[old].references == 1 && s->keys[added].references == 1 && oracle.emitted == 0);
    for (unsigned int i = 0; i < 20; i++) assert(astra_ciphertext_pump(s, 1, 0));
    assert(s->keys[old].references == 1 && s->keys[added].references == 1 && "reprobes cannot duplicate retention references");
    push(s, 256, 1, 1, 0, 1, 2, 2);
    assert(astra_ciphertext_pump(s, 2001, 0));
    assert(oracle.bad == 0 && oracle.emitted == 1 && oracle.cursor == oracle.references);
    assert(s->keys[old].references == 0 && s->keys[added].references == 1 && "timeout releases old possibility pins while fresh certificate owns exactly one reference");
    assert(astra_ciphertext_pump(s, 3002, 0)); assert(s->keys[added].references == 0);
    safe_tail(s, 3003, 1);
}
int main(void) {
    healthy_parity_continuation(); delayed_and_missing_words(); prefetched_same_parity_change(); startup_ambiguous_prefix();
    pid_whole_cycle_gap(1); pid_whole_cycle_gap(0); unchanged_pairs_and_future_opposite_half(); marked_same_parity_changes(); ambiguity_context_and_eof(); bounds_and_output_failure();
    split_pes_prefix_and_cc_gap(); candidate_and_run_exhaustion(); deferred_batches_wrap_and_eof();
    expired_reply_and_ambiguity_eviction(); malformed_selected_and_clear_transition(); complete_ecm_identity(); idle_component_pid_churn();
    idle_certificate_gc_preserves_queued_ownership();
    unknown_only_candidate_eviction(); valid_unknown_candidate_eviction(); late_new_candidate_and_exact_retention_references();
    puts("PASS: strict ordered ciphertext safety, early-future ambiguity, PID-cycle gaps, delayed/missing keys, exact healthy continuations and bounded EOF ownership");
    return 0;
}
