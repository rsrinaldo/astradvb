/* Build against the patched pinned tsdecrypt source and libdvbcsa. This uses
 * generated ciphertext only: no provider, tuner, entitlement or captured CW. */
#include <assert.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <dvbcsa/dvbcsa.h>
/* Keep the fixture's real libdvbcsa encryptor in a separate translation unit
 * from csa.c's disabled-libdvbcsa stubs in an FFdecsa-only build. */
typedef void csakey_t;
csakey_t *csa_key_alloc(void);
void csa_key_free(csakey_t **key);
void csa_set_cw(csakey_t *key, uint8_t *cw, int check_validity);
void csa_decrypt_single_packet(csakey_t *key, uint8_t *packet);

static const uint8_t words[2][16] = {
    {0x12,0x34,0x56,0x9c,0x78,0x9a,0xbc,0xce,0x12,0x34,0x56,0x9c,0x78,0x9a,0xbc,0xce},
    {0x23,0x45,0x67,0xcf,0x89,0xab,0xcd,0x01,0x23,0x45,0x67,0xcf,0x89,0xab,0xcd,0x01}
};
static csakey_t *shared_key;
static atomic_int begin;
static void *replace_words(void *unused) {
    (void)unused;
    while (!atomic_load(&begin)) { }
    for (unsigned int i = 0; i < 50000; i++)
        csa_set_cw(shared_key, (uint8_t *)words[i & 1], 0);
    return NULL;
}
int main(void) {
    struct dvbcsa_key_s *encoder = dvbcsa_key_alloc();
    uint8_t packet[188], plain[184], alternative[184], decoded[188];
    for (unsigned int i = 0; i < sizeof(plain); i++) plain[i] = (uint8_t)(i * 13 + 7);
    memset(packet, 0, sizeof(packet));
    packet[0] = 0x47; packet[1] = 0x01; packet[2] = 0x01; packet[3] = 0x90;
    memcpy(packet + 4, plain, sizeof(plain));
    dvbcsa_key_set(words[0], encoder);
    dvbcsa_encrypt(encoder, packet + 4, sizeof(plain));
    memcpy(alternative, packet + 4, sizeof(alternative));
    dvbcsa_key_set(words[1], encoder);
    dvbcsa_decrypt(encoder, alternative, sizeof(alternative));
    shared_key = csa_key_alloc();
    csa_set_cw(shared_key, (uint8_t *)words[0], 0);
    pthread_t writer;
    assert(pthread_create(&writer, NULL, replace_words, NULL) == 0);
    atomic_store(&begin, 1);
    for (unsigned int i = 0; i < 50000; i++) {
        memcpy(decoded, packet, sizeof(packet));
        csa_decrypt_single_packet(shared_key, decoded);
        assert((decoded[3] & 0xc0) == 0);
        /* Either complete schedule is valid for this concurrency test. A
         * partially updated schedule produces neither complete result. */
        assert(memcmp(decoded + 4, plain, sizeof(plain)) == 0 ||
               memcmp(decoded + 4, alternative, sizeof(alternative)) == 0);
    }
    assert(pthread_join(writer, NULL) == 0);
    csa_key_free(&shared_key);
    dvbcsa_key_free(encoder);
    puts("PASS: 50000 concurrent CSA updates never expose a torn key schedule");
    return 0;
}
