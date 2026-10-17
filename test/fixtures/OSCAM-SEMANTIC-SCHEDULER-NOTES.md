# OSCam semantic policy v2

The normal release patch is `patches/oscam-semantic-scheduler.patch`, enabled
only on guarded Newcamd readers with `astra_ecm_scheduler = 1`. The manifest
records policyVersion2, semanticPolicyVersion2 and both patch hashes. It uses
128 bounded local storage slots, not 128 simultaneous provider requests.

## Dispatch and identity

Unique ECM work is queued before Newcamd ID assignment. Existing cache/pending
coalescing remains; aliases retain their original deadlines. Actual dispatch
is spaced at least50ms apart, with no catch-up, and at most32 requests remain
unanswered. Expired queued work is never dispatched. A sent ID stays reserved
until its matching complete reply or whole-transport retirement, even after
the original client times out. Sent work is never replayed after retirement.

## Recovery

Only complete parsed ECM replies matching a retained SENT ID advance progress;
positive, negative and late matched replies all count. Login/card data, cache,
partial bytes, zero/unmatched IDs and stale-generation replies do not count.
The soft silence deadline is the greater of the oldest original SENT deadline
and last matched progress plus cfg.ctimeout (8s in the normal configuration).

At least16 expired SENT entries plus live queued demand retire a partially
stuck transport despite progress elsewhere. Any unanswered SENT exchange has
a hard age of4*cfg.ctimeout from dispatch (32s normally). An already-readable
reply gets at most250ms soft grace; junk cannot postpone recovery forever,
and hard age is never extended. One missing request with healthy replies for
11s and a matching late9.5s reply must not reset a healthy transport.

Recovery runs on the existing worker after its selected action. Due readable
replies take priority over new ECM jobs. The scheduler mutex is released before
transport close; close retires generation IDs, and normal idle jobs reconnect
through the same account guard. The durable3-attempt/60s budget is never reset
by a local timeout, process restart or login.

## Ownership and observations

Parent GC detaches scheduler references under the existing lifetime/metadata
locks. Reader cleanup owns scheduler destruction. No scheduler lock is held
during send, receive, idle connect or transport close. The independent C model
and actual protocol tests cover original deadlines, ID lifetime, late aliases,
closed callers and fresh-generation recovery.

Numeric-only status/reset lines are emitted at most every5s while active or
changed, plus reset events. They include queued/alias/sent/peak/dispatched/
matched/coalesced/expired/rejected/reset/abandoned/close counts and oldest age.
resetReason is0 initially,1 silence,2 expired-slot pressure,3 hard orphan age.
No credentials, ECM/CW payloads, request digests or remote endpoints are logged.

## Required release gates

Actual Linux tests use a fake provider in a private network namespace, never
the commercial line. Gates include85 simultaneous delayed correct keys,
85 silent callers followed by bounded reconnect and a fresh successful epoch,
partial loss with continuing progress, hard orphan age, matched negative/late
progress, unmatched-ID noise, read stalls, parent GC and account restart budgets.
Media tests retain exact A/V bytes, packet order, continuity and EOF tail checks.

Earlier b6 experimental results established bounded in-flight work but left
full silence saturated indefinitely. They are not recovery evidence for this
release. Likewise the separate experimental tsdecrypt key-epoch patch is not
included in this release and its unresolved per-PID-gap limitation remains.

Internal limits and passing synthetic tests do not establish a commercial
provider's allowed rate/capacity, prove the original live trigger, guarantee
timely keys, or guarantee uninterrupted playback. Preserve private numeric
history for any subsequent operational incident.
