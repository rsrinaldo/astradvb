# Isolated CAS simulation contract

All fixtures use generated media, public deterministic test words, disposable
credentials and loopback sockets. Actual native tests require explicit binary
paths, verified manifests and `ASTRA_CAS_LAB=1`. They must run in an isolated
network namespace without access to live configuration, credentials or DVB
devices. Experimental native manifests are accepted only by the lab verifier.

## Safety and compatibility tests

The ordinary fault and compatibility laboratories retain strict media oracles:

- On-time playback must preserve every A/V byte, packet order and continuity.
- Announced but delayed/missing replies must publish no wrong A/V bytes and
  recover at least 95% exact A/V coverage over the final two-second interval.
- Fixed or inverted ECM table IDs do not determine the CSA parity.
- A valid selected CW half must preserve healthy playback; an absent selected
  half may suppress output but must not publish corrupted media.
- A valid unchanged pair can cover repeated physical parity transitions.

The protected model assumes that a changed physical key is announced by a
timely changed ECM identity, and that a successful matching provider response
contains the correct words for that identity. Late or absent replies to a
properly announced ECM are tested separately and remain strict safety cases.

## Rejected key-epoch prototype: per-PID gaps

The older experimental key-epoch 252 model depends on observing each selected PID's physical
parity transitions. `native-key-epoch-gaps.test.mjs` reproduces stale helper
key selection when a PID disappears through an entire even/odd cycle and
returns with the same parity, despite timely changed ECMs and correct replies.
This is not covered by the two announcement/provider assumptions above.
Its passing diagnostic is labeled **UNPROTECTED**, not a safety success.
That prototype remains unfit for normal installation and is excluded from
production build paths. Policy 5 uses the separate bounded ciphertext/PES
revalidation design below, not a promotion of 252. Its two strict whole-cycle
gap gates cover exact PUSI return and fail-closed ambiguous continuation.
Blindly selecting the latest prefetched pair is not a valid fix.

## Strict whole-cycle gap fixtures

The compatibility suite now includes two additive, explicitly selected source
transforms. Ordinary generated fixtures and their exact healthy oracles are
unchanged:

- `whole-cycle-pid-gap-pusi` omits video payload across the entire odd crypto
  period, then resumes in the following even period at a PES start. Another
  selected PID continues throughout the gap. Every retained source A/V packet
  must be reproduced exactly, in order, with zero introduced continuity errors.
- `whole-cycle-pid-gap-continuation` resumes at a verified headerless video
  continuation with at least 14 continuation payload packets before its next
  PES start. This is an ambiguity/safety test, not an `UNPROTECTED` success:
  uncertain prefix may be withheld, but wrong published packets must be zero,
  suppression is counted, and final two-second exact coverage must be at least
  95%. The separate no-gap `on-time-continuation` remains a healthy exact-byte
  test; it must not be reclassified to permit suppression.

The transform leaves the transport byte clock and packet count unchanged.
Removed video packets become null packets; PCR/OPCR-bearing packets instead
become adaptation-only packets at the same original positions with identical
clock fields. Retained video continuity is renumbered, and the other PID remains
byte-identical. Metadata proves the original and resumed media have the same
scrambling parity despite the intervening physical period. This intentionally
omits source media; an omitted/truncated source picture is not evidence of a
decoder corruption. Any source decoding warning must be checked against the
clear transformed reference, without relaxing the unmodified healthy tests.

Both cases are included by default in `ASTRA_CAS_LAB_SUITE=compatibility`, or
can be requested explicitly as the launcher's comma-separated scenario list.

The additive `pmt-version-only` case also keeps one unchanged ECM identity and
full CW pair through at least six source PMT versions. Service/PMT PID/CAID/ECM
PID remain unchanged. Every A/V byte and continuity counter must remain exact,
with no output pauses and exactly one true semantic ECM identity. A PMT version
or unrelated descriptor update must not force an unnecessary key refetch or
leave the existing channel keyless.

## Normal policy 7 ciphertext safety

Policy 7 additionally refuses shared-FIFO ownership to unanchored encrypted
continuations explicitly marked by valid subtitle/teletext descriptors. Private
AC-3 audio, unknown private PES and malformed/conflicting descriptor lists keep
their original behavior. Marked ancillary parity does not invalidate A/V runs.
Immediate ancillary discards are counted separately from key timeouts; neither
ciphertext output nor an extra buffer is allowed. New regressions check A/V
progress without waiting two seconds, valid/split private PES, late keys and
descriptor exclusion. The actual native media fixture inserts a subtitle PMT
entry and real-CSA continuation before A/V, requires output within 1.5 seconds
with stdin still open, and then checks every ordered A/V byte. An old-binary
failure is a reproduction, not a passed release gate.

The helper is embedded in `patches/tsdecrypt-ciphertext-safety.patch`, the seventh
normal native patch in the installer/Docker policy 7 bundle. It retains the
policy-5 safety contract while gathering immutable-key cohorts across the
bounded READY prefix and caching unchanged waiting-anchor evidence. Exact FIFO,
uncertainty boundaries, candidate pins, terminal failures and the existing
two-second/8-MiB limits remain mandatory. The separate
experimental helper copies are no longer needed. This is not promotion of the
older key-epoch prototype. The decoder retains bounded
original-order ciphertext, immutable candidate CW halves, and per-PID PES syntax
evidence. ECM table IDs are never treated as CSA parity. A directly observed
same-PID parity transition may permit retrospective continuation release after
an independent uniquely decoded PES anchor. Startup, whole-cycle gaps,
unconfirmed same-parity word changes and discontinuities do not authenticate a preceding
headerless prefix; ambiguous prefixes must be suppressed, not decrypted using
the latest word. Multiple matching candidates must remain pinned/ambiguous;
cache eviction cannot itself create a valid certificate. Candidates with too
little PES prefix to decide remain pinned too; retaining those unknown words
must not prevent a genuinely late correct word from being considered.

Within the explicit stable-key/observed-TSC-run contract, merely receiving a
prefetched future word does not revoke a previously certified current word.
Healthy continuation stays on that certificate until an observed boundary or
a newly validated PES reanchors it. Gap, context, continuity and silence
invalidations still lose the certificate; a future word cannot repair their
unanchored prefix by itself. This preserves the strict current/next and
two-period-pair healthy byte oracles without inferring parity from ECM IDs.
Idle PID certificate owners retire after the existing two-second silence
threshold so removed PMT components cannot pin keys/runs for years. Already
queued packet references remain immutable and pinned until consumed/dropped;
a returning PID must independently reanchor.

The retention engine's hard limits are 8 MiB per decoder including fixed state
and queue metadata, 2000 ms of unresolved retention, 64 immutable candidate halves
and 256 runs. Those are decoder memory/latency bounds, not provider quotas.
At 85 decoders the configured maximum alone can be about 680 MiB in addition
to existing application/native queues. The native integration reserves ordinary
ring-sidecar/word-queue/work-key overhead within that envelope. The pre-existing
optional input-delay list has a separate rate-dependent allocation; this is not
an 8 MiB bound on whole-process RSS or an arbitrary high-rate legacy delay queue.
Expired, exhausted or ambiguous work must fail closed without increasing
provider requests. A late timer/key cannot
resurrect ciphertext past its original retention deadline. EOF must drain all
decidable partial batches and release/drop remaining ownership exactly once.

`native-ciphertext-safety.test.mjs` compiles the helper extracted from the actual
normal native safety patch, rather than a separate model source, and uses
the normal PES header extracted from its own patch. Its test cipher is
deterministic XOR, NOT DVB-CSA. It checks packet order/bytes, early future-word ambiguity, same-parity
marked changes, complete PID-cycle gaps, delayed/missing keys, pinned candidate
and run exhaustion, 19-packet PES prefixes, malformed selected packets,
deferred batch wrap, 400-component PID churn, queued references surviving idle
certificate retirement, and non-batch-aligned EOF. Set
`ASTRA_CIPHER_TEST_SANITIZERS=1` to run the same assertions under ASan/UBSan.
Passing this model does not replace actual pinned native/OSCam CSA media,
fault, compatibility, resource and 85-channel tests; all remain release gates.

`native-ciphertext-probe.test.mjs` separately extracts the actual native scalar
probe source and header. On Linux it links real libdvbcsa and checks A/B/A key
changes, independent caches, both physical scrambling parities, short and
adaptation-bearing payloads, immutable input and malformed-packet rejection.
The probe has a private bounded scalar key cache in its own translation unit;
it does not enable a second global backend or change confirmed FFdecsa SIMD
output batches. The same sanitizer flag covers this test. Its portable
source-contract check alone is not a real-CSA round-trip or performance result.

## Passed v7 release gates

The tested v7 normal patch SHA-256 is
`fbda5b6654170f8b7d3015f1c2198cf6eeaf2ae4fe43984ab39de8177d2e3ecd`.
Strict portable helper tests and ASan/UBSan passed, including both VALID/UNKNOWN
and UNKNOWN-only candidate eviction, genuinely late candidate admission, exact
reference cleanup and long component-PID churn. Actual Linux scalar libdvbcsa
round-trips and the native fault/compatibility/EOF matrix passed. The same
six-CPU/eight-GiB 85-native exact-A/V, continuity and performance gate passed
after moving single-packet PES probes to the private scalar cache; confirmed
FFdecsa output retains SIMD batching. Earlier FFdecsa-single-probe resource
failures are not evidence for the corrected v7 implementation.

These are isolated synthetic results, not real-provider validation. Healthy
cases remain exact-byte gates; unavailable-key safety cases permit counted
suppression but never wrong published packets. Normal packaging/build identity
must be verified separately before deployment. The results neither establish
provider capacity nor justify a 100% reliability claim or a claim of years of
operation without interruption.

PES validity is syntax evidence, not cryptographic authenticity. An unannounced
same-parity physical key boundary with no input-order marker, or a genuinely
correlated provider response containing the wrong words, cannot be certified
generically from headerless CSA continuation. These limits must remain explicit;
they cannot be turned into a protected pass by relabeling an unsafe diagnostic.

## Explicitly unprotected diagnostic boundaries

`cas-outside-contract.test.mjs` adds the second explicit opt-in
`ASTRA_CAS_LAB_DIAGNOSTICS=1`. It intentionally violates the model by either
rotating a physical key without changing the announced ECM, or returning an
incorrect checksum-valid pair in a genuinely correlated provider reply.

These diagnostics report `protected:false`, `safetyPass:false`, the bounded
wrong-packet count and the first bad packet's PID/PUSI/continuity metadata.
The older decoder reproduced corruption before a later PES header revealed
it. That is historical, decoder-specific evidence, not a claim that policy 5
reproduces those particular scenarios. A corrected decoder may fail closed
instead; such an outcome requires reassessing this explicit diagnostic's
expected result, not weakening ordinary safety tests or claiming generic CSA
authentication. Reproduced-boundary TAP results are NOT safety passes and must
not be included in claims of protected playback.

DVB-CSA transport payloads do not provide per-packet authenticity through these
fixtures. The lab therefore cannot justify unconditional reliability against
unannounced source changes or incorrect provider words. A future implementation
that contains one of these boundaries requires reevaluating the diagnostic,
not silently weakening or reclassifying the ordinary safety tests.

The optional 2000 ms native input buffer and increased pending/queue capacities
are isolated diagnostic settings. They do not change production defaults, and
finite input must still preserve its entire delayed tail at EOF.

## Initialization and timing evidence

The original baseline writes initialization once, then waits at most 15 seconds
before starting media. Its readiness fact now uses a canonical successful-reply
record, not the evicting 1024-event log or a cloned full snapshot on every poll.
Identity records are bounded at 10000; the ordinary 85-channel/10-second-epoch
fixture is well below that bound. A provider reply records server write admission,
not native CW installation. The native initial-CW-accepted log is reduced to a
counter/timestamp and reported separately, without retaining its raw log.

The explicitly selected `native-buffered-init-repeated` scenario is a separate
liveness comparison: at most 30 seven-packet PSI/ECM-only pulses every 500 ms,
stopping when a reply is observed or the same 15-second deadline expires. It
does not add protocol-client retries, hide semantic duplicates, or relax any
exact A/V check. It must not be substituted silently for the original baseline.

Input milestone times measure the test feeder's pipe writes. Provider request
and reply times use the same process's monotonic clock, but do not establish when
the native worker read the pipe, installed a key, or decoded a packet. First
failed completed-media postmortem comparison runs only after all native feeds
have settled; a zero-input initialization failure cannot consume that comparison.

`native-soak-summary.timing` and the returned soak result now aggregate the
maximum source-feed lateness, maximum pipe-backpressure wait, maximum native
stdout A/V chunk gap, and total feeds at least 250/1000 ms late across completed
per-channel results. Sample counts expose missing observations; maxima are
`null` when unavailable. Rejected runs remain in the separate failure reports.
These are source/pipe/stdout observations, not remote-player receipt or proof of
real-time playback. Eventually exact files can still have unacceptable delay
or throttling; actual load/performance gates must inspect these measurements
alongside all unchanged byte, continuity, recovery and provider safety checks.
