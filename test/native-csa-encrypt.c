/* Generated-test-data encryptor. This fixed synthetic CW is not an entitlement
 * or provider credential. FFmpeg fixtures use elementary PIDs 0x100/0x101. */
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <dvbcsa/dvbcsa.h>
int main(int argc, char **argv) {
    const int video_only = argc == 2 && strcmp(argv[1], "--video-only") == 0;
    const int with_private = argc == 2 && strcmp(argv[1], "--with-private") == 0;
    assert(argc == 1 || video_only || with_private);
    static const uint8_t word[8] = {0x12,0x34,0x56,0x9c,0x78,0x9a,0xbc,0xce};
    struct dvbcsa_key_s *key = dvbcsa_key_alloc();
    dvbcsa_key_set(word, key);
    uint8_t packet[188];
    size_t n;
    while ((n = fread(packet, 1, sizeof(packet), stdin)) != 0) {
        assert(n == sizeof(packet) && packet[0] == 0x47);
        unsigned int pid = ((packet[1] & 0x1f) << 8) | packet[2];
        if ((pid == 0x100 || (pid == 0x101 && !video_only) || (pid == 0x102 && with_private)) && (packet[3] & 0x10)) {
            unsigned int offset = (packet[3] & 0x20) ? 5 + packet[4] : 4;
            assert(offset <= sizeof(packet));
            if (offset < sizeof(packet)) {
                dvbcsa_encrypt(key, packet + offset, sizeof(packet) - offset);
                packet[3] = (packet[3] & 0x3f) | 0x80;
            }
        }
        assert(fwrite(packet, 1, sizeof(packet), stdout) == sizeof(packet));
    }
    assert(!ferror(stdin) && fflush(stdout) == 0);
    dvbcsa_key_free(key);
    return 0;
}
