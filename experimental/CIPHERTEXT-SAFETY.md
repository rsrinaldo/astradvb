# Native ciphertext safety — design baseline and policy 6

The policy-5/v7 review below is the historical safety baseline. Current normal
policy 6 retains that contract and adds bounded READY-prefix cohort gathering
with strict ordered emission and revision-cached waiting-anchor probes. It does
not add a media buffer or relax key evidence/retention. The current patch hash
and measured performance/safety gates are in `../VERIFICATION-0.8.46.md`; the
v7 hash below identifies the prior reviewed baseline, not the current artifact.

This design note describes `patches/tsdecrypt-ciphertext-safety.patch`, included
as the seventh normal native patch by the installer and Docker build. Policy 5
requires its provenance in the native manifest. The tested v7 patch SHA-256 is
`fbda5b6654170f8b7d3015f1c2198cf6eeaf2ae4fe43984ab39de8177d2e3ecd`.
The source/header used by tests is embedded in that patch; the separate
experimental source copies have been removed. The rejected key-epoch 252
prototype remains excluded from normal builds. Normal build promotion does
not by itself confirm deployment of the corresponding executable.

The decoder keeps original encrypted TS packets in one bounded ordered FIFO.
It keeps at most 64 distinct immutable CW halves and 256 live observed runs. A
run is certified only when exactly one available same-context/same-CSA-parity
word decrypts a structurally valid selected PES header. ECM table identifiers
never choose a CSA half. Every still-possible word, including words with only
an incomplete PES prefix, stays pinned; eviction cannot manufacture evidence.
Retention of incomplete words does not exclude a genuinely late new word.

Only a directly observed per-PID physical parity transition permits release
of retained continuation preceding its first validated PES header. Startup,
unconfirmed same-parity candidate changes, discontinuities and missing whole-cycle PID
observations cannot inherit an old certificate or authenticate earlier bytes
using a later header. Those ambiguous prefixes are suppressed. This may lose
otherwise valid unanchored bytes; it does not silently assign the latest CW.
Publishing a future candidate does not revoke an already certified, continuous
same-physical-parity run. Its old word remains immutable until a physical/
context boundary or a new PUSI independently validates a candidate. This is
necessary to preserve current/next prefetch while older media remains queued.

Retention is adaptive, not a fixed input delay. Uncertain runs expire after
at most 2000 ms, with an 8 MiB per-stream allocation envelope including helper
state, candidate/run metadata and raw queue. The native wrapper leaves 256 KiB
of that envelope for its bounded publication queue, input sidecar overhead
and cached output/probe CSA schedules. This is not a cap on total process RSS or an existing
operator-configured input-delay buffer. Overflow fails closed. No decoder
wait, expiry or overflow generates an ECM request or changes provider policy.
The queue preserves TS order. Finite EOF drains every decidable tail and
immediately discards unresolved uncertainty; forced termination is not a
delivery guarantee.

The native wrapper tags packets and CAMD requests with their input CAS
identity. Changed PMT versions alone do not invalidate the identity or force
another provider request. CAMD publishes copied CW pairs through a bounded
mutex-protected queue; only the decoder owns certificates and candidates.
SIMD-sized input batches and same-word decryption groups retain the native
FFdecsa/libdvbcsa batch paths. PES probes use a separate cached libdvbcsa scalar
key, without changing the confirmed-output FFdecsa schedule or enabling both
global backend macros. Probes are triggered by new header evidence or
new candidate words, not a full run scan for every TS packet.
Idle PID-owner certificates are reclaimed with a bounded 256-run scan at most
once per second after the existing 2000 ms silence/reanchor threshold. Queued
references remain pinned. Empty FIFOs reuse their first pages rather than
gradually faulting in the entire retention envelope on healthy traffic.

## Limits of the evidence

CSA has no cryptographic payload authentication. PES syntax is evidence, not
a proof against a malicious or coincidentally plausible wrong CW. Retrospective
release across an observed physical parity boundary assumes that the physical
CW remains constant within that observed same-parity run. An unannounced
same-parity key change inside such a run has no authenticated TS boundary;
neither this helper nor a generic Newcamd CW pair can infer one. Do not claim
universal or 100% descrambling reliability.

## Verified v7 gates

The v7 implementation passed strict portable tests and ASan/UBSan, including
both incomplete-candidate eviction regressions, admission of a genuinely late
word, exact reference counts, deadline/capacity limits and PID-owner cleanup.
Real Linux libdvbcsa probe round-trips and encrypted native-media gates passed:
on-time continuation, delayed/missing/old replies, fixed/inverse ECM table IDs,
current-next/two-period/unchanged pairs, suffix-only changed ECMs, PMT-version
updates, whole-cycle PID gaps and finite EOF tails. Healthy cases require exact
A/V preservation; announced late/missing-key cases require zero wrong published
packets and strict recovery, not uninterrupted output when a key is absent.
The sustained 85-native run also passed the original exact-byte/continuity and
performance gates under the same six-CPU/eight-GiB test limit. These tests use
synthetic media and a fake provider, never the commercial provider or its keys.

The normal packaged binary must still be checked against the tested v7 build
before deployment. Tests do not establish the commercial provider's capacity
or years-long availability. Provider pacing/in-flight limits are safeguards,
not a provider allowance; synchronized demand can exceed the bounded hold.

Numeric diagnostics have this exact shape, emitted at most every 5 seconds and
at EOF, without CWs, ECM bodies, digests or credentials:

```
CT | heldBytes=0 peakBytes=0 dropped=0 timeout=0 capacity=0 prefix=0 recovered=0 allocated=0
```
