#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "astra-io.h"

static uint8_t input[188 * 11 + 17], output[sizeof(input)];
static size_t read_at, write_at, input_size;
static unsigned int reads, writes;
static int return_zero;
static ssize_t fragmented_read(int fd, void *data, size_t size) {
    (void)fd;
    /* Real stream reads may be split at any byte, with interruptions. */
    if (++reads % 5 == 1) { errno = EINTR; return -1; }
    if (read_at == input_size) return 0;
    size_t n = (reads * 37) % 251 + 1;
    if (n > size) n = size;
    if (n > input_size - read_at) n = input_size - read_at;
    memcpy(data, input + read_at, n); read_at += n;
    return (ssize_t)n;
}
static ssize_t short_write(int fd, const void *data, size_t size) {
    (void)fd;
    if (return_zero) return 0;
    if (++writes % 3 == 1) { errno = EINTR; return -1; }
    size_t n = (writes * 23) % 137 + 1;
    if (n > size) n = size;
    memcpy(output + write_at, data, n); write_at += n;
    return (ssize_t)n;
}
int main(void) {
    int running = 1;
    for (size_t i = 0; i < sizeof(input); i++) input[i] = (uint8_t)(i * 17);
    for (size_t i = 0; i < sizeof(input) / 188; i++) input[i * 188] = 0x47;
    input_size = 188 * 11;
    uint8_t frame[188 * 7];
    size_t actual = 0;
    for (;;) {
        ssize_t n = astra_read_ts_frame(0, frame, sizeof(frame), fragmented_read, &running);
        assert(n >= 0 && n % 188 == 0);
        if (!n) break;
        assert(memcmp(frame, input + actual, (size_t)n) == 0);
        assert(astra_write_all(1, frame, (size_t)n, short_write) == 0);
        actual += (size_t)n;
    }
    assert(actual == input_size && write_at == input_size);
    assert(memcmp(input, output, input_size) == 0);
    /* A truncated EOF packet is never sent to the decoder or read OOB. */
    read_at = 0; input_size = sizeof(input);
    assert(astra_read_ts_frame(0, frame, sizeof(frame), fragmented_read, &running) == 188 * 7);
    assert(astra_read_ts_frame(0, frame, sizeof(frame), fragmented_read, &running) == 188 * 4);
    assert(astra_read_ts_frame(0, frame, sizeof(frame), fragmented_read, &running) == 0);
    running = 0;
    assert(astra_read_ts_frame(0, frame, sizeof(frame), fragmented_read, &running) == 0);
    return_zero = 1;
    assert(astra_write_all(1, frame, 188, short_write) == -1 && errno == EIO);
    puts("PASS: fragmented stream input, short writes and EINTR preserve every complete TS byte");
}
