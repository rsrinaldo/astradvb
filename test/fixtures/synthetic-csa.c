/* Test-only encryptor: generated video and public deterministic synthetic CWs. */
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <openssl/sha.h>
#include <dvbcsa/dvbcsa.h>
static void word_for_epoch(unsigned int channel, long epoch, uint8_t word[8])
{
    char seed[128]; uint8_t digest[SHA256_DIGEST_LENGTH];
    int length = snprintf(seed, sizeof(seed), "astra-synthetic-cw-v1:%u:%ld", channel, epoch);
    assert(length > 0 && length < (int)sizeof(seed)); SHA256((uint8_t *)seed, (size_t)length, digest);
    for(unsigned int group = 0; group < 2; group++) {
        for(unsigned int j = 0; j < 3; j++) word[group * 4 + j] = digest[group * 3 + j];
        word[group * 4 + 3] = (word[group * 4] + word[group * 4 + 1] + word[group * 4 + 2]) & 255;
    }
}
int main(int argc, char **argv)
{
    assert(argc == 3 || argc == 4); unsigned int channel = (unsigned int)strtoul(argv[1], NULL, 10);
    unsigned long epoch_packets = strtoul(argv[2], NULL, 10); assert(channel > 0 && channel <= 65535 && epoch_packets > 0);
    unsigned long key_epoch_modulus = argc == 4 ? strtoul(argv[3], NULL, 10) : 0;
    assert(argc == 3 || key_epoch_modulus == 2);
    struct dvbcsa_key_s *key = dvbcsa_key_alloc(); assert(key);
    uint8_t packet[188], word[8]; long last_epoch = -1; unsigned long packet_index = 0; size_t length;
    while((length = fread(packet, 1, sizeof(packet), stdin)) != 0) {
        assert(length == sizeof(packet) && packet[0] == 0x47);
        long epoch = (long)(packet_index++ / epoch_packets);
        long key_epoch = key_epoch_modulus ? epoch % (long)key_epoch_modulus : epoch;
        if(key_epoch != last_epoch) { word_for_epoch(channel, key_epoch, word); dvbcsa_key_set(word, key); last_epoch = key_epoch; }
        unsigned int pid = ((packet[1] & 31) << 8) | packet[2];
        if((pid == 256 || pid == 257) && (packet[3] & 0x10)) {
            unsigned int offset = packet[3] & 0x20 ? 5 + packet[4] : 4; assert(offset <= 188);
            if(offset < 188) { dvbcsa_encrypt(key, packet + offset, 188 - offset); packet[3] = (packet[3] & 0x3f) | (epoch & 1 ? 0xc0 : 0x80); }
        }
        assert(fwrite(packet, 1, sizeof(packet), stdout) == sizeof(packet));
    }
    assert(!ferror(stdin) && fflush(stdout) == 0); dvbcsa_key_free(key); return 0;
}
