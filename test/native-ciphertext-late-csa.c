/* Provider-free real-CSA regression. These words and packets are disposable. */
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <dvbcsa/dvbcsa.h>
#include "astra-ciphertext-safety.h"
#include "astra-ciphertext-probe.h"

static const uint8_t words[3][8] = {{1,2,3,6,4,5,6,15}, {9,10,11,30,12,13,14,39}, {17,18,19,54,20,21,22,63}};
struct fixture { struct astra_ciphertext_probe *probe; dvbcsa_key_t *encryptor; uint8_t expected[8][188]; unsigned int fed, emitted; };
static int decrypt(void *opaque, const uint8_t word[8], const uint8_t raw[188], uint8_t clear[188]) {
    struct fixture *f = opaque; return astra_ciphertext_probe_decrypt(f->probe, word, raw, clear);
}
static int emit(void *opaque, const uint8_t clear[188]) {
    struct fixture *f = opaque; assert(f->emitted < f->fed);
    assert(!memcmp(clear, f->expected[f->emitted++], 188)); return 1;
}
static void push(struct astra_ciphertext *s, struct fixture *f, unsigned int cc, int pusi, unsigned int parity, unsigned int key, uint64_t now) {
    uint8_t raw[188], *plain = f->expected[f->fed++]; assert(f->fed <= 8);
    memset(plain, (int)(cc + 40), 188); plain[0]=0x47; plain[1]=1 | (pusi ? 0x40 : 0); plain[2]=0; plain[3]=0x10 | cc;
    if (pusi) { const uint8_t pes[14]={0,0,1,0xe0,0,0,0x80,0x80,5,0x21,0,1,0,1}; memcpy(plain+4,pes,sizeof(pes)); }
    memcpy(raw,plain,188); dvbcsa_key_set(words[key],f->encryptor); dvbcsa_encrypt(f->encryptor,raw+4,184); raw[3] |= parity ? 0xc0 : 0x80;
    assert(memcmp(raw+4,plain+4,184)); assert(astra_ciphertext_push(s,raw,now));
}
int main(void) {
    // Test a new late half, then an irrelevant half followed by the right half.
    for (unsigned int wrong_first=0; wrong_first<2; wrong_first++) {
        struct fixture f={0}; f.probe=astra_ciphertext_probe_alloc(); f.encryptor=dvbcsa_key_alloc(); assert(f.probe && f.encryptor);
        struct astra_ciphertext *s=astra_ciphertext_create(ASTRA_CT_MAX_BYTES,2000,decrypt,emit,&f); assert(s);
        astra_ciphertext_context(s,1); astra_ciphertext_pid(s,256,0x1b);
        assert(astra_ciphertext_word(s,1,0,words[0],0)); push(s,&f,0,1,0,0,0);
        push(s,&f,1,0,1,1,10); assert(f.emitted==1);
        assert(astra_ciphertext_word(s,1,1,words[wrong_first ? 2 : 1],20));
        push(s,&f,2,0,1,1,21); assert(f.emitted==1 && s->stats.packets_dropped==0);
        push(s,&f,3,1,1,1,22);
        if (wrong_first) {
            assert(f.emitted==1 && s->stats.packets_dropped==0);
            assert(astra_ciphertext_word(s,1,1,words[1],100)); assert(astra_ciphertext_pump(s,100,0));
        }
        assert(astra_ciphertext_finish(s,101)); assert(f.emitted==f.fed && s->stats.packets_dropped==0);
        astra_ciphertext_destroy(s); astra_ciphertext_probe_free(&f.probe); dvbcsa_key_free(f.encryptor);
    }
    for (unsigned int arrival=3000; arrival<=4999; arrival+=1999) {
        struct fixture f={0}; f.probe=astra_ciphertext_probe_alloc(); f.encryptor=dvbcsa_key_alloc(); assert(f.probe && f.encryptor);
        struct astra_ciphertext *s=astra_ciphertext_create(ASTRA_CT_MAX_BYTES,5000,decrypt,emit,&f); assert(s);
        astra_ciphertext_context(s,1); astra_ciphertext_pid(s,256,0x1b);
        assert(astra_ciphertext_word(s,1,0,words[0],0)); push(s,&f,0,1,0,0,0);
        assert(f.emitted==1);
        push(s,&f,1,0,1,1,10);
        assert(astra_ciphertext_word(s,1,1,words[2],20));
        push(s,&f,2,1,1,1,22); assert(astra_ciphertext_pump(s,arrival-1,0));
        assert(f.emitted==1 && !s->stats.packets_dropped);
        assert(astra_ciphertext_word(s,1,1,words[1],arrival)); assert(astra_ciphertext_pump(s,arrival,0));
        assert(astra_ciphertext_finish(s,arrival+1)); assert(f.emitted==f.fed && !s->stats.packets_dropped);
        astra_ciphertext_destroy(s); astra_ciphertext_probe_free(&f.probe); dvbcsa_key_free(f.encryptor);
    }
    puts("PASS: real CSA late-key prefix recovery is byte-exact through 4999 ms and wrong candidates remain withheld"); return 0;
}
