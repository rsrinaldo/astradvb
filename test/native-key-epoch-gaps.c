/* Diagnostic only: this proves a known limitation of the frozen prototype.
 * A passing result means the unsafe association was reproduced, not fixed. */
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "astra-key-epochs.h"

static struct astra_key_epoch *observe(struct astra_key_epochs *state, unsigned int number) {
    uint8_t section[4] = {0x80 | (number & 1), 0x70, 1, number};
    return astra_epoch_observe(state, 0x0b00, 1, 510, section, sizeof(section));
}

int main(void) {
    struct astra_key_epochs state;
    uint8_t old_pair[16], middle_pair[16], new_pair[16], word[8];
    memset(old_pair, 0x11, 8); memset(old_pair + 8, 0x44, 8);
    memset(middle_pair, 0x11, 8); memset(middle_pair + 8, 0x22, 8);
    memset(new_pair, 0x33, 8); memset(new_pair + 8, 0x22, 8);
    assert(astra_epochs_init(&state, 16));
    struct astra_key_epoch *old = observe(&state, 0);
    assert(old);
    astra_epoch_publish(&state, old, old_pair);
    struct astra_key_epoch *before = astra_epoch_packet(&state, 256, 0);
    assert(before == old);
    astra_epoch_release(&state, before);
    struct astra_key_epoch *other = astra_epoch_packet(&state, 257, 0);
    assert(other == old);
    astra_epoch_release(&state, other);

    /* Both changed ECM identities and their matching replies arrive. PID256
     * has no media packets during the intervening odd crypto period. */
    struct astra_key_epoch *middle = observe(&state, 1);
    assert(middle);
    astra_epoch_publish(&state, middle, middle_pair);
    other = astra_epoch_packet(&state, 257, 1);
    assert(other == middle);
    astra_epoch_release(&state, other);
    struct astra_key_epoch *latest = observe(&state, 2);
    assert(latest);
    astra_epoch_publish(&state, latest, new_pair);
    other = astra_epoch_packet(&state, 257, 0);
    assert(other == latest);
    astra_epoch_release(&state, other);

    /* Calling the existing context hook does not indicate PID removal,
     * re-addition, input discontinuity, or an absent full parity period. */
    astra_epochs_context(&state, 0x0b00, 1, 510);
    struct astra_key_epoch *after = astra_epoch_packet(&state, 256, 0);
    assert(after == old && after != latest);
    assert(astra_epoch_word(&state, after, 0, word));
    assert(memcmp(word, old_pair, sizeof(word)) == 0);
    assert(memcmp(word, new_pair, sizeof(word)) != 0);

    /* The input observables also permit an early future pair while this PID
     * is legitimately still on its old even word. Blind latest rebinding is
     * therefore not a safe generic repair for the missing-transition case. */
    struct astra_key_epoch *still_old = astra_epoch_packet(&state, 256, 0);
    assert(still_old == old);
    astra_epoch_release(&state, still_old);
    astra_epoch_release(&state, after);
    astra_epoch_release(&state, old);
    astra_epoch_release(&state, middle);
    astra_epoch_release(&state, latest);
    pthread_mutex_lock(&state.lock);
    astra_epochs_reset_locked(&state);
    pthread_mutex_unlock(&state.lock);
    assert(state.used == 0);
    astra_epochs_destroy(&state);
    puts("UNPROTECTED: same-parity PID gap selects stale epoch despite timely changed ECMs; blind latest rebinding is ambiguous");
    return 0;
}
