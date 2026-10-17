# v0.8.49 — retired headerless-run safety

Deployed 17 October 2026 at 18:27:52 UTC, application PID 739727. All 80
channels/77 native decoders were running at 18:29:22 UTC, after normal paced
startup. The interim v0.8.48 deployment and its remaining orphan-run issue are
documented separately; its results are not substituted for this artifact.

The live policy-7 expiry trace identified seven headerless video runs whose PID
owner had already moved to a different run. These queued runs could never gain
a new PES anchor but still blocked the shared output FIFO for two seconds.
Film Aksion PID 1501 was among the captured cases. Provider requests/replies and
local word handoff were healthy; increasing ECM rate cannot supply an anchor
to an unreachable retired run.

Policy 8 retires only unconfirmed, nonfailed, headerless runs that have no PID
owner, counting their discarded packets separately as `ciphertext.orphan`.
Anchored work and still-owned headerless work retain ordinary bounded late-key
recovery. No key assumption, request limit, buffer, timer or FIFO order is
relaxed. The subtitle/teletext descriptor-scoped fix from v0.8.48 remains.
Unverifiable prefixes are still discarded, not recovered or sent as clear;
this does not promise zero packet loss or solve every possible missing-key
case. No provider credentials, CWs, ECMs or live media are recorded here.

The new helper regression first failed against policy 7 at its immediate A/V
progress assertion, then passed with the change. A complementary test proves
that retired anchored work still recovers with a genuinely late key. The
capacity-pressure fixture now uses a live anchored missing-key run, rather
than retired headerless work which correctly no longer fills the buffer; it
still requires actual capacity discards and the same strict memory bound.

## Release gates

| Gate | Result |
| --- | --- |
| Local full suite | 475/494 passed; 19 platform/explicit-opt-in skips |
| Isolated actual-Linux full suite | 495/501 passed; six explicit-opt-in skips |
| Native provider fault matrix | 24/24 passed |
| Full-pair/interoperability matrix | 21/21 passed |
| 85 actual native decoders | 17/17 passed; all 85 exact A/V |
| Generated-media CPU comparison | 1/1 passed |
| ASan/UBSan helper and real scalar CSA probe | 3/3 passed |
| Transactional operator rollback | 7/7 passed locally and on Linux |

The Linux full-suite count includes the seven operator rollback tests staged
at its root; the ordinary source suite has 494 tests. These overlapping counts
are not additive. The final real-CSA fixture deliberately inserts a headerless
video tail and synthetic CC gap to retire that run. The installed policy-7
binary fails its early-output deadline with `Retired headerless video blocked
A/V before EOF`; policy 8 passes, then preserves every original A/V byte in
order. The injected undecidable prefix is deliberately not reference A/V.
The existing subtitle-tail fixture, wrong-key suppression, fragmented input,
slow output, real EOF and FFmpeg decode checks also pass.

The 85-decoder gate used a six-core/8-GiB isolated unit. Maximum source-feed
lateness was 26.497 ms, backpressure wait 0 ms and native A/V chunk gap
276.292 ms. One synthetic provider connection carried 1,105 requests/replies,
peak 19 encrypted frame writes/s, with no guard reset. The run took 396.561 s
including fixture preparation. These are synthetic results, not final-player
or provider-capacity guarantees.

Same-host CPU/byte ratios versus policy 7 were 0.99096 (both-encrypted fixture)
and 1.01687 (encrypted video/clear audio/control fixture), approximately -0.9%
and +1.7%, respectively. This is effectively comparable within a short run,
not a universal CPU saving or product-parity claim. Policy 8 adds no media
queue, process or buffer; existing wait/memory limits and SIMD batching remain.
No Docker image was built; installer/Docker manifest generation and syntax
were tested. OSCam was not rebuilt or replaced in this deployment.

## Live verification and remaining packet loss

From 18:29:52.821 to 18:32:52.844 UTC, five-second observations recorded:

| Measurement | Increase/result |
| --- | ---: |
| Input CC errors / input TEI | 0 / 0 |
| Ciphertext timeout / capacity discards | 0 / 0 |
| Retired headerless-run discards (`orphan`) | 5,049 packets |
| Unanchored marked ancillary discards | 163 packets |
| Other unsafe-prefix discards | 116 packets |
| Output CC errors | 106 |
| Decoder restarts / PID changes / native or input queue overflow | 0 / 0 / 0 |
| Packet-worker dropped bytes | 0 |
| Non-running state observations | 0 |
| Successful CAS results / local CAS timeouts / rejections | 1,386 / 0 / 0 |
| Encrypted frame writes / replies | 1,386 / 1,386 |
| Provider connections / semantic resets / transport resets | 1 / 0 / 0 |

**The output is not lossless.** The new counters expose packets that cannot be
certified under the safety contract, rather than hiding them behind a zero
timeout count. They are discarded promptly, not decrypted with a guessed key
or recovered. Film Aksion had 495 orphan discards and three video-PID CC errors;
its maximum observed application output gap was 323 ms. MTV had 163 ancillary
discards and 50 CC errors confined to subtitle PIDs 3210/3211; its maximum
application output gap was 331 ms. Neither target had timeout discards in this
window. This removes the two confirmed avoidable two-second waits, not every
possible source/key/player failure or residual pixelation from lost prefixes.

A separate 120-second kernel write-call observation recorded 41,629 native
stdout writes for Film Aksion and 42,316 for MTV, maximum gaps 197 and 328 ms,
respectively, and zero gaps >=500 ms. It captured syscall timing/counts only,
not media, keys, TCP delivery or end-user playback. The two observations have
different windows/measurement points and are not interchangeable.

Host CPU peaked at 11.2% across 40 logical CPUs in the three-minute samples;
main-loop maximum was 131.66 ms. At 18:33:46 UTC, host CPU was 9.7%, Node RSS
3,746,107,392 bytes and PSS 3,711,626,240 bytes. The HLS payload cache was
2,111,474,812 bytes, excluding heaps, worker-current media, HTTP writes and
native processes. No long-term ceiling, leak-free guarantee, or comparison
with Cesbo is established by these short measurements.

## Provenance and protected state

Native binary SHA-256:
`3e04e34952b1ab522fb0c87751c49e7316b574782376bb680146ce115cf93352`.
Safety patch SHA-256:
`1822135ad33313315376aebbf55827ea5e5bc752086171c099a1e2690fd9ecd7`.
Portable strict fixture SHA-256:
`0be6af9c4657ca584b634665009655d8a8309b111b197df93c10beea25bd6a1d`.
The pinned decoder source remains
`f4876e84cf1866645f84b93f830af67193c85f69`, with the same seven normal patches
and FFdecsa 128-bit SSE2 backend. Corresponding source is retained at
`/usr/local/src/tsdecrypt-astra-0.8.49-verified-GzFGCd`; the previous matching
app/native pair is retained at `/opt/astra-linux-retained-0.8.48-hCnFjk`.

At 18:33:46 UTC, all 77 native processes mapped the verified policy-8 binary
inode. Configuration, authentication, published EPG, allowlists, environment,
systemd unit, OSCam binary/manifest, DVB/TCP helpers and provider scheduling
modules matched their retained copies. The durable owner-lock inode was
unchanged, and no connection budget was rewound or reset. CAS remained
unpaused, with the same 20-frame-write/s, 32 unanswered semantic slots,
persistent three-attempt/rolling-minute and paced-start protections. Frame
admission is not a provider receipt-rate allowance. Autostart was enabled and
automatic service restart count zero.

Temporary timing probes were bounded and detached. Test units were isolated
from production configuration, devices and external networks. No recurring
monitor was installed. Full long-term reliability and genuinely late/wrong
provider keys remain separate concerns; PES syntax is not cryptographic
authentication, and unknown ciphertext is never intentionally emitted.
