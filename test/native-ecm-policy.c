#include <assert.h>
#include <stdio.h>
#include "ecm-protection.h"
int main(void) {
    assert(ecm_work_fresh(2000000, 0));
    assert(!ecm_work_fresh(2000001, 0));
    assert(!ecm_work_fresh(0, 1));
    unsigned int requests = 0;
    for (int64_t now = 0; now < 60000000; now += 100000) {
        if (ecm_work_fresh(now, now)) {
            requests++;
        }
    }
    assert(requests == 600);
    assert(ecm_work_fresh(90000000, 90000000));
    assert(ASTRA_NATIVE_CAS_POLICY_VERSION == 3);
    assert(ecm_clock_us() > 0);
    puts("PASS: stale work rejected; fresh ECMs never blocked by a failed-key cooldown");
    return 0;
}
