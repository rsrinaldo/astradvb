#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "astra-pes-validation.h"

static struct astra_pes_validation state;
static uint8_t video[188], audio[188], continuation[188], pcr[188], other[188], short_pes[188], pair[376];
static void packet(uint8_t *data, uint16_t pid, uint8_t id) {
    memset(data, 0xff, 188); data[0] = 0x47; data[1] = 0x40 | (pid >> 8); data[2] = pid; data[3] = 0x10;
    const uint8_t header[] = {0, 0, 1, id, 0, 0, 0x80, 0, 0}; memcpy(data + 4, header, sizeof(header));
}
static unsigned int frame(const uint8_t *data, size_t size, int expected_blocked) {
    int blocked = -1; unsigned int result = astra_pes_frame(&state, data, size, 1, &blocked);
    assert(blocked == expected_blocked); return result;
}
static void configure(void) {
    astra_pes_update_begin(&state);
    astra_pes_update_pid(&state, 256, 0x1b); astra_pes_update_pid(&state, 257, 0x04);
    astra_pes_update_pid(&state, 7500, 0x05); /* Private sections, not PES. */
    astra_pes_update_end(&state);
}
/* Original pinned output predicate required 14 bytes even without PTS, and
 * equated a 500ms absence of such a header with encrypted output. */
static int original_has_pes(const uint8_t *data) {
    unsigned int offset = 4 + ((data[3] & 0x20) ? 1 : 0) + data[4];
    return (data[1] & 0x40) && (data[3] & 0x10) && offset + 14 <= 188 &&
        data[offset] == 0 && data[offset + 1] == 0 && data[offset + 2] == 1 &&
        data[offset + 3] >= 0xbc && data[offset + 3] != 0xbf && (data[offset + 6] & 0xc0) == 0x80;
}
static int original_suppresses(const uint8_t *data, int64_t last_valid, int64_t now) {
    return !original_has_pes(data) && now > last_valid + 500000;
}
int main(void) {
    astra_pes_init(&state); configure();
    packet(video, 256, 0xe0); packet(audio, 257, 0xc0); packet(other, 7500, 0xe0);
    memcpy(continuation, video, 188); continuation[1] &= ~0x40;
    memcpy(pcr, continuation, 188); pcr[3] = 0x20; pcr[4] = 183; pcr[5] = 0x10;
    assert(frame(continuation, 188, 1) == ASTRA_PES_UNKNOWN); /* Wrong-key join cannot trust continuation at startup. */
    assert(frame(pcr, 188, 0) == ASTRA_PES_UNKNOWN);
    assert(frame(other, 188, 0) == ASTRA_PES_UNKNOWN); /* ECM/SI cannot become PES evidence. */
    assert(frame(audio, 188, 0) == ASTRA_PES_VALID);
    assert(frame(continuation, 188, 1) == ASTRA_PES_UNKNOWN); /* Clear audio cannot authenticate startup video. */
    memcpy(pair, continuation, 188); memcpy(pair + 188, video, 188);
    assert(frame(pair, sizeof(pair), 1) == ASTRA_PES_VALID); /* Later PES cannot release earlier unknown bytes. */
    assert(frame(video, 188, 0) == ASTRA_PES_VALID);
    assert(!original_has_pes(continuation));
    assert(original_suppresses(continuation, 1000000, 1600001));
    assert(frame(continuation, 188, 0) == ASTRA_PES_UNKNOWN);
    assert(frame(pcr, 188, 0) == ASTRA_PES_UNKNOWN);
    memcpy(short_pes, video, 188); memset(short_pes + 4, 0xff, 184); short_pes[3] = 0x30;
    short_pes[4] = 174; short_pes[5] = 0; memcpy(short_pes + 179, video + 4, 9);
    assert(!original_has_pes(short_pes)); assert(frame(short_pes, 188, 0) == ASTRA_PES_VALID);

    video[4] = 0xa5; assert(frame(video, 188, 1) == ASTRA_PES_INVALID);
    assert(frame(audio, 188, 1) == ASTRA_PES_VALID); /* Clear audio must not untaint invalid video. */
    assert(frame(continuation, 188, 1) == ASTRA_PES_UNKNOWN);
    packet(video, 256, 0xe0); assert(frame(video, 188, 0) == ASTRA_PES_VALID);
    memcpy(pair, video, 188); memcpy(pair + 188, audio, 188); pair[4] = 0x99;
    assert(frame(pair, sizeof(pair), 1) == (ASTRA_PES_VALID | ASTRA_PES_INVALID));
    assert(frame(video, 188, 0) == ASTRA_PES_VALID);

    video[11] = 0x80; video[12] = 5; /* PTS-only, optional header length 5. */
    video[13] = 0x21; video[14] = 0; video[15] = 1; video[16] = 0; video[17] = 1;
    assert(frame(video, 188, 0) == ASTRA_PES_VALID);
    video[17] = 0; assert(frame(video, 188, 1) == ASTRA_PES_INVALID);
    video[17] = 1; video[12] = 4; assert(frame(video, 188, 1) == ASTRA_PES_INVALID);
    video[12] = 5; assert(frame(video, 188, 0) == ASTRA_PES_VALID);
    video[11] = 0xc0; video[12] = 10; video[13] = 0x31;
    video[18] = 0x11; video[19] = 0; video[20] = 1; video[21] = 0; video[22] = 1;
    assert(frame(video, 188, 0) == ASTRA_PES_VALID);
    video[18] = 0x21; assert(frame(video, 188, 1) == ASTRA_PES_INVALID);
    packet(video, 256, 0xe0); assert(frame(video, 188, 0) == ASTRA_PES_VALID);

    /* A complete PES header may span transport packets. Keep at most its
     * 19-byte validation prefix, bounded separately for each PMT PES PID. */
    memcpy(short_pes, video, 188); memset(short_pes + 4, 0xff, 184); short_pes[3] = 0x30;
    short_pes[4] = 178; short_pes[5] = 0; memcpy(short_pes + 183, video + 4, 5);
    assert(frame(short_pes, 188, 0) == ASTRA_PES_UNKNOWN);
    memcpy(continuation, video, 188); continuation[1] &= ~0x40; continuation[3] = 0x11;
    memcpy(continuation + 4, video + 9, 4);
    assert(frame(continuation, 188, 0) == ASTRA_PES_VALID);
    short_pes[183] = 0xaa; assert(frame(short_pes, 188, 1) == ASTRA_PES_INVALID);
    assert(frame(video, 188, 0) == ASTRA_PES_VALID);
    continuation[3] |= 0x80; assert(frame(continuation, 188, 1) == ASTRA_PES_INVALID);
    continuation[3] &= ~0xc0; assert(frame(video, 188, 0) == ASTRA_PES_VALID);
    continuation[1] |= 0x80; assert(frame(continuation, 188, 1) == ASTRA_PES_INVALID);
    continuation[1] &= ~0x80; assert(frame(video, 188, 0) == ASTRA_PES_VALID);

    /* Removing a damaged PID from a complete PMT must not block forever. */
    video[4] = 0xaa; assert(frame(video, 188, 1) == ASTRA_PES_INVALID);
    astra_pes_update_begin(&state); astra_pes_update_pid(&state, 257, 0x04); astra_pes_update_end(&state);
    assert(frame(audio, 188, 0) == ASTRA_PES_VALID);
    configure();
    continuation[3] = 0x12;
    assert(frame(continuation, 188, 1) == ASTRA_PES_UNKNOWN); /* Re-added PID needs fresh evidence. */
    packet(video, 256, 0xe0); assert(frame(video, 188, 0) == ASTRA_PES_VALID);
    astra_pes_destroy(&state);
    puts("PASS: tri-state PES evidence, short/fragmented headers, sparse continuation, per-PID recovery and bounded timestamps fail closed without false timeout suppression");
}
