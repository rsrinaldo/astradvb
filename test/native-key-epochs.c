/* Provider-free ownership and packet-order regression for an experimental
 * full-pair binding model. This does not establish universal CAS semantics. */
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "astra-key-epochs.h"

static struct astra_key_epoch *observe(struct astra_key_epochs *state, unsigned int table, unsigned int value) {
    uint8_t section[8] = {0x80 | table, 0x70, 5, 0, 0, 0, 0, 0}; section[3] = value;
    return astra_epoch_observe(state, 0x0b00, 1, 510, section, sizeof(section));
}
static void pair(uint8_t words[16], uint8_t even, uint8_t odd) { memset(words, even, 8); memset(words + 8, odd, 8); }
static void check(struct astra_key_epochs *state, struct astra_key_epoch *epoch, unsigned int parity, uint8_t expected) {
    uint8_t word[8]; assert(astra_epoch_word(state, epoch, parity, word)); for (unsigned int i = 0; i < 8; i++) assert(word[i] == expected);
}
struct concurrent_args { struct astra_key_epochs *state; struct astra_key_epoch *epoch; };
static void *publish_repeats(void *opaque) {
    struct concurrent_args *args = opaque; uint8_t words[16]; pair(words, 7, 8);
    for (unsigned int i = 0; i < 20000; i++) astra_epoch_publish(args->state, args->epoch, words);
    return NULL;
}
int main(void) {
    uint8_t original_ecm[24] = {0x80, 0x70, 21}, suffix_changed[24]; memcpy(suffix_changed, original_ecm, sizeof(original_ecm)); suffix_changed[23] = 1;
    assert(!memcmp(original_ecm, suffix_changed, 21)); /* Old comparison misses it. */
    assert(astra_epoch_ecm_equal(original_ecm, sizeof(original_ecm), original_ecm, sizeof(original_ecm)));
    assert(!astra_epoch_ecm_equal(original_ecm, sizeof(original_ecm), suffix_changed, sizeof(suffix_changed)));
    assert(!astra_epoch_ecm_equal(original_ecm, sizeof(original_ecm), original_ecm, sizeof(original_ecm) - 1));
    struct astra_key_epochs state; assert(astra_epochs_init(&state, 32)); uint8_t words[16];
    struct astra_key_epoch *first = observe(&state, 0, 1); assert(first); pair(words, 1, 2); astra_epoch_publish(&state, first, words);
    struct astra_key_epoch *queued_even = astra_epoch_packet(&state, 256, 0); assert(queued_even == first); check(&state, queued_even, 0, 1);
    struct astra_key_epoch *retry = observe(&state, 0, 1); assert(retry == first); astra_epoch_release(&state, retry);
    /* Fixed0x80 table IDs have no relationship to actual CSA parity. */
    struct astra_key_epoch *second = observe(&state, 0, 2); assert(second != first); pair(words, 1, 3); astra_epoch_publish(&state, second, words);
    struct astra_key_epoch *still_even = astra_epoch_packet(&state, 256, 0); assert(still_even == first); check(&state, still_even, 0, 1);
    struct astra_key_epoch *queued_odd = astra_epoch_packet(&state, 256, 1); assert(queued_odd == second); check(&state, queued_odd, 1, 3);
    struct astra_key_epoch *third = observe(&state, 1, 3); pair(words, 4, 3); astra_epoch_publish(&state, third, words);
    struct astra_key_epoch *still_odd = astra_epoch_packet(&state, 256, 1); assert(still_odd == second);
    struct astra_key_epoch *new_even = astra_epoch_packet(&state, 256, 0); assert(new_even == third); check(&state, new_even, 0, 4);
    /* Future responses and delayed old responses cannot overwrite words pinned
     * to old queued packets or mutate the new generation's pair. */
    check(&state, queued_even, 0, 1); pair(words, 1, 3); astra_epoch_publish(&state, second, words); check(&state, new_even, 0, 4);
    struct astra_key_epoch *missing = observe(&state, 0, 4); assert(missing);
    struct astra_key_epoch *missing_odd = astra_epoch_packet(&state, 256, 1); assert(missing_odd == missing);
    uint8_t word[8]; assert(!astra_epoch_word(&state, missing_odd, 1, word));
    pair(words, 5, 0); astra_epoch_publish(&state, missing, words); assert(!astra_epoch_word(&state, missing_odd, 1, word)); check(&state, missing, 0, 5);
    /* A single acknowledged pair may cover two actual parity periods. */
    struct astra_key_epoch *both_even = astra_epoch_packet(&state, 257, 0), *both_odd = astra_epoch_packet(&state, 257, 1);
    assert(both_even == missing && both_odd == missing); pair(words, 5, 6); astra_epoch_publish(&state, missing, words); check(&state, both_even, 0, 5); check(&state, both_odd, 1, 6);
    /* Ready words are immutable even when a repeated reply conflicts. Only
     * the ambiguous half loses trust; independently known halves remain. */
    pair(words, 9, 2); astra_epoch_publish(&state, first, words); assert(!astra_epoch_word(&state, queued_even, 0, word)); check(&state, first, 1, 2);
    pair(words, 1, 2); astra_epoch_publish(&state, first, words); assert(!astra_epoch_word(&state, first, 0, word)); assert(state.conflicts == 1);
    /* Reset future associations at the actual service/CAID/PID change, before
     * its first complete ECM. Already queued old records stay pinned. */
    astra_epochs_context(&state, 0x0b00, 2, 511); assert(astra_epoch_packet(&state, 256, 0) == NULL); check(&state, new_even, 0, 4);
    struct astra_key_epoch *refs[] = {first, second, third, missing, queued_even, still_even, queued_odd, still_odd, new_even, missing_odd, both_even, both_odd};
    for (unsigned int i = 0; i < sizeof(refs) / sizeof(refs[0]); i++) astra_epoch_release(&state, refs[i]);
    pthread_mutex_lock(&state.lock); astra_epochs_reset_locked(&state); pthread_mutex_unlock(&state.lock); assert(state.used == 0); astra_epochs_destroy(&state);

    /* Legitimate unchanged full pairs can span many physical parity periods.
     * Once a changed ECM exists, absent/conflicted words must NEVER fall back
     * to that old pair, even if it would otherwise be available for reuse. */
    assert(astra_epochs_init(&state, 16)); first = observe(&state, 0, 1); pair(words, 7, 8); astra_epoch_publish(&state, first, words);
    for (unsigned int period = 0; period < 20; period++) {
        struct astra_key_epoch *packet = astra_epoch_packet(&state, 256, period & 1); assert(packet == first); check(&state, packet, period & 1, (period & 1) ? 8 : 7); astra_epoch_release(&state, packet);
    }
    second = observe(&state, 0, 2); queued_even = astra_epoch_packet(&state, 256, 0); assert(queued_even == second); assert(!astra_epoch_word(&state, queued_even, 0, word));
    pair(words, 0, 9); astra_epoch_publish(&state, second, words); assert(!astra_epoch_word(&state, queued_even, 0, word));
    queued_odd = astra_epoch_packet(&state, 256, 1); assert(queued_odd == second); check(&state, queued_odd, 1, 9);
    assert(astra_epoch_packet(&state, 256, 0) == NULL); pair(words, 0, 10); astra_epoch_publish(&state, second, words);
    assert(astra_epoch_packet(&state, 256, 1) == NULL);
    third = observe(&state, 0, 3); pair(words, 11, 12); astra_epoch_publish(&state, third, words);
    new_even = astra_epoch_packet(&state, 256, 0); assert(new_even == third); check(&state, new_even, 0, 11);
    struct astra_key_epoch *reuse_refs[] = {first, second, third, queued_even, queued_odd, new_even};
    for (unsigned int i = 0; i < sizeof(reuse_refs) / sizeof(reuse_refs[0]); i++) astra_epoch_release(&state, reuse_refs[i]);
    pthread_mutex_lock(&state.lock); astra_epochs_reset_locked(&state); pthread_mutex_unlock(&state.lock); assert(state.used == 0); astra_epochs_destroy(&state);

    assert(astra_epochs_init(&state, 2)); first = observe(&state, 0, 1); queued_even = astra_epoch_packet(&state, 256, 0); second = observe(&state, 0, 2);
    assert(observe(&state, 0, 3) == NULL); assert(state.exhausted == 1); assert(state.used == 2);
    assert(astra_epoch_packet(&state, 256, 1) == NULL);
    astra_epoch_release(&state, first); astra_epoch_release(&state, queued_even);
    /* Recovery limitation remains explicit: allocating the same body later
     * does NOT invent a reply when the native request may have been skipped as
     * a duplicate. The new record must remain unready, never borrow stale CWs. */
    struct astra_key_epoch *recovered = observe(&state, 0, 3); assert(recovered);
    struct astra_key_epoch *unacknowledged = astra_epoch_packet(&state, 256, 1); assert(unacknowledged == recovered);
    assert(!astra_epoch_word(&state, unacknowledged, 1, word));
    astra_epoch_release(&state, second); astra_epoch_release(&state, recovered); astra_epoch_release(&state, unacknowledged);
    pthread_mutex_lock(&state.lock); astra_epochs_reset_locked(&state); pthread_mutex_unlock(&state.lock); assert(state.used == 0); astra_epochs_destroy(&state);

    /* Force repeated queue wrap/ownership turnover while producer generations
     * run ahead of old queued packet consumption. */
    assert(astra_epochs_init(&state, 64));
    struct { struct astra_key_epoch *epoch; uint8_t expected; unsigned int parity; } ring[7] = {{0}};
    for (unsigned int i = 0; i < 10000; i++) {
        unsigned int slot = i % 7;
        if (ring[slot].epoch) { check(&state, ring[slot].epoch, ring[slot].parity, ring[slot].expected); astra_epoch_release(&state, ring[slot].epoch); }
        struct astra_key_epoch *request = observe(&state, 0, i & 255); assert(request);
        uint8_t value = i % 250 + 1; pair(words, value, value); astra_epoch_publish(&state, request, words);
        ring[slot].epoch = astra_epoch_packet(&state, 256, i & 1); ring[slot].expected = value; ring[slot].parity = i & 1;
        assert(ring[slot].epoch == request); astra_epoch_release(&state, request);
    }
    for (unsigned int i = 0; i < 7; i++) { check(&state, ring[i].epoch, ring[i].parity, ring[i].expected); astra_epoch_release(&state, ring[i].epoch); }
    assert(state.peak <= 10); pthread_mutex_lock(&state.lock); astra_epochs_reset_locked(&state); pthread_mutex_unlock(&state.lock); assert(state.used == 0); astra_epochs_destroy(&state);

    assert(astra_epochs_init(&state, 8)); first = observe(&state, 1, 1); pair(words, 7, 8); astra_epoch_publish(&state, first, words);
    struct concurrent_args args = {&state, first}; pthread_t publisher; assert(!pthread_create(&publisher, NULL, publish_repeats, &args));
    for (unsigned int i = 0; i < 20000; i++) { check(&state, first, 0, 7); check(&state, first, 1, 8); }
    assert(!pthread_join(publisher, NULL)); astra_epoch_release(&state, first); pthread_mutex_lock(&state.lock); astra_epochs_reset_locked(&state); pthread_mutex_unlock(&state.lock); assert(state.used == 0); astra_epochs_destroy(&state);
    assert(astra_epochs_init(&state, 8));
    first = astra_epoch_observe(&state, 0x0b00, 1, 510, original_ecm, sizeof(original_ecm));
    second = astra_epoch_observe(&state, 0x0b00, 1, 510, suffix_changed, sizeof(suffix_changed));
    assert(first && second && first != second && second->generation > first->generation);
    astra_epoch_release(&state, first); astra_epoch_release(&state, second); pthread_mutex_lock(&state.lock); astra_epochs_reset_locked(&state); pthread_mutex_unlock(&state.lock); assert(state.used == 0); astra_epochs_destroy(&state);
    puts("PASS: bounded full-pair epochs preserve packet ownership, parity independence, late replies and missing-half withholding"); return 0;
}
