# v0.8.48 — sparse private-PES queue safety

Deployed on 17 October 2026 at 18:02:03 UTC, application PID 731218, with
one controlled restart and the normal paced decoder startup. All 80 channels
and 77 decoders were running at 18:03:29 UTC. This release fixes the captured
subtitle-tail case, but live observation identified a separate orphan-run
stall; it is not a claim that the whole lineup is free of freezes/timeouts.

Policy 7 retains the source pins and seven normal patches. It drops only
unanchored encrypted subtitle/teletext continuations before admitting them to
the shared FIFO, and excludes these marked ancillary parity changes from the
A/V phase clock. Valid type-0x06 descriptor lists must explicitly identify DVB
subtitles or teletext, with no audio/registration/extension descriptors.
Generic private PES and private AC-3 audio retain existing behavior. These
discards are distinct numeric `ancillary` counts, not key timeouts. No extra
buffer, provider request, retry, connection, or runtime package is introduced.
Complete/split private PES anchors and bounded late-key recovery are unchanged.
Valid emitted packets retain input order. Missing ancillary tails may lose
private/subtitle data; this does not promise lossless ancillary output or fix
all possible timeouts. Anchored missing-key cases retain existing waits.

The new portable regression failed against policy 6 at the assertion that an
unanchored private-PES tail must not own the shared FIFO; it passes with the
candidate. The full local suite passed 474/493 tests, zero failures and 19
platform/explicit-opt-in skips. The helper includes immediate A/V progress
across sparse private parity changes, recovery on a complete private PES,
split 19-packet private PES and late-key recovery. A generated real-CSA media
fixture additionally requires A/V output before EOF and before the old
two-second hold, then exact full ordered A/V bytes. The installed policy-6
binary failed this fixture with the explicit early-output timeout; the new
binary passed, including exact ordered A/V, wrong-key suppression, fragmented
stdin, slow output, real EOF and ordinary decode checks.

Isolated actual-Linux gates passed: full suite 494/500, six explicit opt-in
skips (includes the seven operator rollback tests staged at its root); native
faults 24/24; interoperability 21/21; 85 actual decoders 17/17; CPU 1/1;
ASan/UBSan helper/scalar-probe checks 3/3; rollback alone 7/7. These overlapping
counts are not added together. All 85 native decoders preserved exact A/V;
maximum feed lateness 59.731 ms, backpressure wait 0 ms and A/V output chunk
gap 273.746 ms. One synthetic provider connection carried 1,105 requests and
replies, with peak 19 encrypted frame writes/s and no guard reset. This is
synthetic capacity evidence, not an end-user playback guarantee.

Same-host generated-media CPU/byte ratios versus policy 6 were 1.0341 and
1.0377 for the two fixture patterns (about 3–4% higher, not a CPU-saving claim).
The code adds an 8-KiB input-only descriptor map per decoder and no additional
media queue. The existing adaptive 8-MiB envelope is unchanged. Docker manifest
generation/syntax were tested; no Docker image or replacement OSCam was built.

Native binary SHA-256:
`2f4ff386838f7a5fbce4e2f5d22c00dfebfff6859aea9fb23dd4d28e759c75a5`.
Safety patch SHA-256:
`0b0d030bf01da51c29fb7b5f2ac08b7509055418c23a6de752fa4f4078f17ee1`.
Corresponding source retained at
`/usr/local/src/tsdecrypt-astra-0.8.48-verified-LSETt5`; matching prior app/native
pair retained at `/opt/astra-linux-retained-0.8.47-gh6zgK`.

At 18:06:24 UTC, all 77 native processes mapped the new executable inode.
Configuration, authentication, published EPG, allowlists, environment, unit,
OSCam, DVB/TCP helpers and provider scheduling modules were unchanged, as was
the durable owner-lock inode. No CAS budget was reset or restored. Host CPU
was 10.9% across 40 logical CPUs; warm Node RSS 3,767,713,792 bytes, PSS
3,733,265,408 bytes and HLS payload cache 2,145,426,860 bytes. These are samples,
not capacity/RAM ceilings or another product comparison.

Live PMT metadata confirmed the affected MTV PIDs 3210/3211 carry DVB subtitle
descriptor 0x59. They accumulated explicit ancillary discards without the old
anchorless-subtitle hold. However, later output/key timeouts remained: a short
observer aborted on a transient non-running state and the next snapshot had
already recovered. That failed observation is not an uninterrupted-success
claim. A subsequent bounded, numeric-only expiry probe caught seven replaced
video runs, including Film Aksion PID 1501, with zero anchor bytes and no PID
owner still pointing at the queued run. These unreachable runs still held
the FIFO to its two-second deadline. This distinct mechanism requires a
follow-up fix; simply enlarging the timeout or requesting more keys cannot
give a retired, headerless run a future PES anchor.

No live CW, ECM, media or credential contents are part of this report.
