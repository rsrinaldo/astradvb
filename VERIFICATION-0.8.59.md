# v0.8.59 — independent request and transport deadlines

Deployed and live-verified on 19 October 2026; publication follows verification.
The final eight-second-default local regression passed 545 tests (502 passes,
43 platform/opt-in skips, no failures/cancellations). Linux regression passed
545 tests (511 passes, 34 opt-in skips, no failures/cancellations).

The managed caller timeout stays at eight seconds. Semantic policy 6
keeps dispatched wire-ID retention and shared response/silence recovery at eight
seconds. Original caller deadlines still control acceptance; matched late replies
can prove transport progress but cannot fabricate a useful key for an expired
caller. They cannot be delivered to a different request. Outstanding IDs stay
reserved until complete reply, safe retirement or real transport closure.

The new policy is mandatory in native manifests/installers/Docker. An older
semantic-policy-5 binary is rejected rather than silently recouple the shared
reset threshold to the caller timeout. Direct policy 4, decoder policy 11,
ciphertext hold/cap, CAS budgets, original pacing and request/inflight limits
remain unchanged.

Shorter caller deadlines deliberately give slow or queued work less time to
complete. Tests must account for expired requests, not call them successful or
relax key equality. Healthy media must remain byte-exact; expired/late replies
must not close healthy shared sessions or bypass durable reconnect limits.

Measured availability tradeoff: with 40 simultaneous requests and four-second
fake-provider replies, 32 completed and eight expired under the five-second
caller deadline. All 40 fresh requests subsequently recovered on the same
provider connection; the previous eight-second caller deadline completed all
40 initial requests. The user approved keeping eight seconds in production and
deploying the separation only. Five-second expiry is now an explicit test-only
fixture option, not a production configuration switch.

Completed isolated gates with the final eight-second production default:
20 native protocol/recovery cases, an additional
closed-caller/7.5-second-late-reply case, 18 sanitizer-enabled wrapper/model tests,
both native ASan/UBSan models, and byte-exact media recovery after a three-second
ciphertext backlog with a 3.5-second key reply. Five-second caller expiry neither
reset a healthy shared socket nor advanced eight-second true-silence recovery.
The 85-decoder load gate also passed: all 85 generated A/V outputs were
byte-exact over a 120-second measured media interval, one shared provider
connection, 1,105 unique requests/replies, no duplicates, no protocol errors,
and a peak of 19 requests/second. This is synthetic transport/native-output
evidence, not an end-user playback or production packet-loss guarantee.

All fault/load tests use fake loopback peers with inaccessible production data.
No provider fault injection, budget reset, CAS pause or live change is authorized
by a test result alone; activation follows completed release gates with rollback.

Final production-configuration protocol/load gates passed after restoring
the eight-second caller default. The production-default
40-request/four-second-reply test completed all 40 on one provider connection,
peaking at 20 requests/second. Earlier five-second results above remain
comparative evidence. All nine isolated Linux gate units exited successfully.

## Live activation

The matching application and semantic-policy-6 OSCam were activated with one
normal service restart at approximately 11:54 UTC. The decoder binary and its
policy-11 manifest were unchanged. Hash checks confirmed preservation of saved
configuration, authentication, environment, published EPG, media policy, native
DVB/TCP helpers and the service unit; the durable budget lock inode was preserved.
No pause or budget reset was performed. A matching application/native rollback
pair and complete patched native source were retained on the server.

All 84 configured channels returned to running through paced decoder admission.
The service remained enabled at boot, management returned 401 without a login,
and health returned 200. OSCam alone held the account budget lock and one
provider-port socket; Node held no provider-port sockets. The generated managed
request timeout remained 8000 ms and the independent native response window
was verified at 8000 ms.

The 60.002-second steady-state interval ending 11:56:43 UTC had 456 useful key
results, zero CAS timeouts/rejections, provider reconnects, decoder restarts,
decoder protocol errors, native/Node queue overflows, ciphertext timeout/capacity
drops and worker dropped bytes. All 84 channels remained running. Input
continuity/TEI/sync/malformed and output TEI/sync/malformed deltas were zero.

This is not a zero-packet-loss claim: output continuity increased by 13 counts
alongside 25 intentionally suppressed ancillary packets. Subsequent per-PID
observations showed MTV counts on 3210/3211 and two Top Channel counts
on PAT/data PIDs 0/7500. Similar MTV ancillary-associated counts were documented
before this release; these observations do not prove every visible glitch is
resolved. No media allowlist was bypassed for local playback testing.
