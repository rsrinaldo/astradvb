/* Actual libdvbcsa test only: public disposable words, no provider or files. */
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <dvbcsa/dvbcsa.h>
#include "astra-ciphertext-probe.h"

static const uint8_t a[8] = {1, 2, 3, 6, 4, 5, 6, 15};
static const uint8_t b[8] = {9, 10, 11, 30, 12, 13, 14, 39};
static unsigned int plain_packet(uint8_t out[188], unsigned int payload, unsigned int counter) {
    assert(payload > 0 && payload <= 184); memset(out, 0xff, 188);
    out[0] = 0x47; out[1] = 0x41; out[2] = 0; out[3] = (payload == 184 ? 0x10 : 0x30) | (counter & 15);
    unsigned int offset = 188 - payload;
    if (payload != 184) { out[4] = offset - 5; if (out[4]) out[5] = 0; }
    for (unsigned int i = offset; i < 188; i++) out[i] = (uint8_t)(i * 13 + payload + counter);
    return offset;
}
static void encrypted_packet(dvbcsa_key_t *key, const uint8_t word[8], const uint8_t clear[188], unsigned int offset, unsigned int parity, uint8_t raw[188]) {
    assert(parity < 2); memcpy(raw, clear, 188); dvbcsa_key_set(word, key);
    dvbcsa_encrypt(key, raw + offset, 188 - offset); raw[3] |= parity ? 0xc0 : 0x80;
}
static void unchanged_failure(struct astra_ciphertext_probe *probe, const uint8_t raw[188]) {
    uint8_t output[188], sentinel[188]; memset(output, 0xa5, sizeof(output)); memcpy(sentinel, output, sizeof(output));
    assert(!astra_ciphertext_probe_decrypt(probe, a, raw, output)); assert(!memcmp(output, sentinel, sizeof(output)));
}
int main(void) {
    struct astra_ciphertext_probe *probe = astra_ciphertext_probe_alloc(), *other = astra_ciphertext_probe_alloc();
    dvbcsa_key_t *encryptor = dvbcsa_key_alloc(); assert(probe && other && encryptor);
    uint8_t clear[188], raw[188], original[188], decoded[188];
    static const unsigned int payloads[] = {184, 183, 171, 19, 9, 8, 7, 1};
    for (unsigned int repeat = 0; repeat < 3; repeat++) for (unsigned int parity = 0; parity < 2; parity++) {
        const uint8_t *word = repeat == 1 ? b : a;
        for (unsigned int index = 0; index < sizeof(payloads) / sizeof(payloads[0]); index++) {
            unsigned int offset = plain_packet(clear, payloads[index], index + repeat);
            encrypted_packet(encryptor, word, clear, offset, parity, raw); memcpy(original, raw, sizeof(raw));
            assert(astra_ciphertext_probe_decrypt(probe, word, raw, decoded));
            assert(!memcmp(decoded, clear, sizeof(clear))); assert(!memcmp(raw, original, sizeof(raw)));
            assert(astra_ciphertext_probe_decrypt(other, word, raw, decoded)); assert(!memcmp(decoded, clear, sizeof(clear)));
        }
    }
    unsigned int offset = plain_packet(clear, 184, 3); encrypted_packet(encryptor, a, clear, offset, 0, raw); memcpy(original, raw, sizeof(raw));
    assert(memcmp(raw + offset, clear + offset, 188 - offset) && "the real CSA fixture must not be an identity transform");
    assert(astra_ciphertext_probe_decrypt(probe, b, raw, decoded)); assert(memcmp(decoded, clear, sizeof(clear)));
    assert(astra_ciphertext_probe_decrypt(probe, a, raw, decoded)); assert(!memcmp(decoded, clear, sizeof(clear)));
    assert(!memcmp(raw, original, sizeof(raw)));
    assert(!astra_ciphertext_probe_decrypt(NULL, a, raw, decoded));
    assert(!astra_ciphertext_probe_decrypt(probe, NULL, raw, decoded));
    assert(!astra_ciphertext_probe_decrypt(probe, a, NULL, decoded));
    assert(!astra_ciphertext_probe_decrypt(probe, a, raw, NULL));
    for (unsigned int invalid = 0; invalid < 8; invalid++) {
        memcpy(raw, original, sizeof(raw));
        if (invalid == 0) raw[0] = 0;
        if (invalid == 1) raw[1] |= 0x80;
        if (invalid == 2) raw[3] &= 0x3f;
        if (invalid == 3) raw[3] = (raw[3] & 0x3f) | 0x40;
        if (invalid == 4) raw[3] = 0x80;
        if (invalid == 5) { raw[3] = 0xa0; raw[4] = 183; }
        if (invalid == 6) { raw[3] = 0xb0; raw[4] = 183; }
        if (invalid == 7) { raw[3] = 0xb0; raw[4] = 255; }
        unchanged_failure(probe, raw);
    }
    astra_ciphertext_probe_free(&probe); assert(!probe); astra_ciphertext_probe_free(&probe); astra_ciphertext_probe_free(NULL);
    astra_ciphertext_probe_free(&other); assert(!other); dvbcsa_key_free(encryptor);
    puts("PASS: actual scalar libdvbcsa A/B/A, independent caches, even/odd, short/adaptation payloads, immutable input and fail-closed malformed scope");
    return 0;
}
