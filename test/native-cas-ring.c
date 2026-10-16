/* Test the pinned libfuncs ring's actual ownership contract, not a mock. */
#include <assert.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "cbuf.h"
void LOGf(const char *format, ...) { (void)format; }

static void fill_packets(CBUF *ring, uint8_t value, unsigned int count) {
    uint8_t packet[188]; memset(packet, value, sizeof(packet));
    for (unsigned int i = 0; i < count; i++) assert(cbuf_fill(ring, packet, sizeof(packet)) == 0);
}
int main(void) {
    CBUF *ring = cbuf_init(188 * 14, "ownership-regression");
    uint8_t next[188 * 7]; memset(next, 'B', sizeof(next));
    fill_packets(ring, 'A', 13);
    int bytes;
    uint8_t *owned = cbuf_peek(ring, 188 * 7, &bytes);
    assert(bytes == 188 * 7);
    /* Peek keeps data occupied: a wrapping producer cannot overwrite it. */
    assert(cbuf_fill(ring, next, sizeof(next)) == -1);
    for (int i = 0; i < bytes; i++) assert(owned[i] == 'A');
    cbuf_get(ring, bytes, &bytes); /* Consume only after processing has ended. */
    /* Match production's aligned 188-byte writes. The legacy ring's bulk
     * wrapping-fill implementation has an unrelated recursive-unlock bug. */
    fill_packets(ring, 'B', 7);
    /* Demonstrate why the previous get-before-processing order was unsafe:
     * that same borrowed pointer is now overwritten by the producer. */
    assert(owned[0] == 'B');
    unsigned int remainingA = 0, remainingB = 0;
    while ((owned = cbuf_peek(ring, 188, &bytes))) {
        assert(bytes == 188);
        if (owned[0] == 'A') remainingA++; else { assert(owned[0] == 'B'); remainingB++; }
        cbuf_get(ring, bytes, &bytes);
    }
    assert(remainingA == 6 && remainingB == 7);
    cbuf_free(&ring);
    puts("PASS: retained ring ownership prevents producer overwrite during consumer work");
}
