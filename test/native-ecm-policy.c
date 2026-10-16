#include <assert.h>
#include <stdio.h>
#include "ecm-protection.h"
int main(void) {
    struct ecm_policy p = {0};
    assert(ecm_policy_ready(&p, 2000000, 0));
    assert(!ecm_policy_ready(&p, 2000001, 0));
    assert(!ecm_policy_ready(&p, 0, 1));
    unsigned int requests = 0;
    for (int64_t now = 0; now < 60000000; now += 100000) {
        if (ecm_policy_ready(&p, now, now)) {
            requests++;
            ecm_policy_failure(&p, now, 730);
        }
    }
    assert(requests == 6);
    assert(p.failures == 6);
    ecm_policy_success(&p);
    assert(p.failures == 0 && p.next_attempt_us == 0);
    assert(ecm_policy_ready(&p, 90000000, 90000000));
    assert(ecm_clock_us() > 0);
    puts("PASS: stale work rejected; six failed attempts per simulated minute; success resets backoff");
    return 0;
}
