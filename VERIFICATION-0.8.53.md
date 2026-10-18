# v0.8.53: shared-provider recovery health

Status: deployed at 2026-10-18 17:31:49 UTC. Recovery fix verified; the original
upstream TCP reset trigger remains unresolved and is not claimed fixed.
Application PID 838342, native OSCam PID 838365. One application-only service
restart was used; native binaries were not replaced.

## Observed incident and scope

On v0.8.52, the upstream guard reported ready-phase TCP errors at
2026-10-18 16:49:07.583, 16:53:43.970 and 17:14:46.496 UTC. The last error
retained ECONNRESET. The older per-incident history did not retain each errno,
so the first two are not independently classified. Before the first and third
events, replies slowed and outstanding work grew. Five-second write-admission
averages remained approximately 7–8 encrypted frames/s before the failures.
There was no scheduler reset, queue overflow, kernel link-down/watchdog/OOM
event or service restart. This does not establish the original TCP reset cause,
exclude a reaction to our request pattern, or establish provider capacity.
Cesbo uses a different provider line, so it is not a controlled same-session
comparison; its remaining unaffected is not dismissed.

One local defect is reproducible: every negative channel result erased
sustained valid-key evidence from other channels sharing the transport. Three
failures separated by working sessions therefore retained failureCount=3 and
backoffs of approximately 1, 2 and 4 seconds. The third transport was ready
again at 17:14:50.715 UTC, 4.219 seconds after its error.

## Changes

Negative results no longer erase positive evidence. Returning to baseline
backoff still requires an authenticated current transport, at least three
fresh positive observations spanning 30 seconds, and no positive gap longer
than 30 seconds. Cache-only answers, all-negative traffic and old buffered
observations without new complete wire replies cannot establish health.
Durable connection attempts are never erased: three per rolling 60 seconds,
one active account lease, existing exponential backoff for genuinely repeated
failures, 20/s encrypted-frame write admission and paced startup are unchanged.

Each reset now freezes its own bounded errno enum (where applicable), connection
age, frame counts, queue age/size, partial reply count, last complete reply age
and write-backpressure evidence before disposal. History remains bounded to
16 incidents and contains no endpoint, raw exception, credentials, frame bytes,
ECM identity or control words.

No native, tuner, HLS, buffer, authentication, media policy, EPG schedule or
provider-protection change is part of this application-only release. A passive,
time/size-bounded metadata-only TCP observation is used for live diagnosis; it
does not inject failures or add requests to the real provider.

## Verification

The mixed-result regressions failed on v0.8.52 and pass on the candidate.
An isolated actual-loopback TCP RST test verifies mixed-result health recovery,
return to baseline backoff, retained rolling attempt limits and no replay.

- Frozen local full suite: 497 tests, 477 passed, 20 platform/opt-in skips,
  zero failures. Normal sandbox denied loopback listeners; the suite was rerun
  with permission for its disposable local sockets.
- Isolated Linux full suite: 501 tests, 495 passed, six opt-in skips, zero
  failures, with the installed matching native sources/binaries. Its preflight
  confirmed loopback-only networking and inaccessible live config/devices.
- Additional isolated native CAS recovery suite: 25/25 passed. It includes
  genuine Newcamd/native OSCam idle TCP RST recovery, 85-client dispatch and
  silent recovery, mixed negative/positive progress, late out-of-order replies,
  four-second read stalls, slow-reply backlogs and fresh work after negatives.
- Exact application rollback function: six synthetic filesystem/service-mock
  scenarios passed; native/config/auth/EPG/budget state is never rewound.

The decoder and OSCam executables are unchanged. The synthetic provider tests
do not establish real-provider capacity or explain the live ECONNRESET trigger.

## Deployment checks

By 17:32:49 UTC the inherited durable failureCount had recovered from three to
zero through actual fresh key replies, despite interleaved negative channel
results. stableRecoveries became one without manually clearing any budget.
All 77 native decoder processes were up by the 17:33:59 check: 78 streams
running and the same two scrambled streams observed before the update.
The service stayed at one upstream connection with zero resets during these
checks. CPU was 9.4% across 40 logical CPUs at 17:33:59 (not a capacity claim).

Read-only verification confirmed unchanged private configuration, admin auth,
daily EPG publication, media policy, environment, systemd unit and budget lock
inode/ownership/mode. HLS remains a three-second target/five-segment window.
Autostart is enabled and automatic service restart count is zero. Native
executables/manifests and DVB/TCP helpers match the retained release exactly.

Rollback application: `/opt/astra-linux-retained-0.8.52-UGh042` (private state
copies retained for comparison, never rewound by the application rollback).
Newly generated macOS archive sidecar metadata was moved into that retained
directory rather than deleted; preexisting files were preserved. Active
source modules and the service were not changed/restarted for this cleanup.

The native idle-RST test recovered in 1060 ms with exactly two origin requests
(one before/one fresh after), two connections and zero duplicate requests.
No real-provider TCP reset, duplicate account connection or replay was injected.

## Steady live checks and investigation limits

From 17:34:29.484 to 17:42:09.498 UTC (460 seconds), all 80 streams had zero
new input CC errors. Film Aksion HD, Top Channel HD and Tring Sport 1 HD had
zero new output CC, ciphertext timeout/orphan/prefix discards or decoder
restarts. The only changed output CC counts were MTV Europe PIDs 3210/3211
(12/19); its ancillary discard count increased by 122, consistent with the
previously investigated ancillary-tail case. This is not a claim that every
packet/component is lossless. The two pre-existing scrambled streams (RTSH
Sport and RTSH 1) continued fail-closed payload timeout discards without keys;
these are not shared CAS request-timeout events.

The provider guard remained one connection, zero transport/semantic resets,
zero CAS request timeouts, zero queued starts and failureCount=0. CPU at the
end was 10.5% across 40 logical CPUs. A read-only check again confirmed the
same native images, protected state and enabled autostart, with no automatic
service restart.

A two-minute metadata-only syscall probe observed 948 native OSCam sends to
the current loopback guard FD: zero failed/short writes, measured syscall
durations 8–256 microseconds. These are local send completions, not provider
receipt or proof of behavior during the old failures. No payload was read.

The longer post-start passive header trace reported 2,427 kernel capture drops
on termination; its packet timing is incomplete and is not used to exclude
network loss/retransmissions. Those are dropped diagnostic observations, not
evidence of stream loss. Guard counters, which are independent of the packet
capture, recorded no recurrence. A separate larger-buffer capture checks
capture quality; it cannot establish the cause of an event that did not recur.

The follow-up 35-second capture used an 8,192-KiB capture buffer without the
earlier diagnostic CPU quota. It observed 1,001 TCP headers, no RST/FIN/SYN,
and its final capture statistics reported zero kernel drops. The application's
reset counter stayed zero. This validates that short observation only; it does
not rehabilitate the incomplete longer trace or explain historical resets.

No extra TCP setting, provider request limit or native protocol change has
been made on speculation. A future actual failure and/or provider-side
termination evidence is still needed to establish whether a remote reset is
triggered by our request pattern, a peer implementation/account condition or
an intervening network device. Cesbo staying unaffected is relevant evidence,
not proof that any particular one of these explanations is correct.
