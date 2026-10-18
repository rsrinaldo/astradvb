# v0.8.55 — shared local CAS admission

## Scope and ownership

Direct mode is `tsdecrypt → Node local admission → local OSCam → provider`.
Equivalent account profiles share one ingress object and frame budget. The
ingress class accepts only a numeric OSCam port and connects to literal loopback;
it has no provider endpoint, credentials, native process or reset operation.
OSCam retains the verified v0.8.54 executable, native semantic dispatch and durable
retry policy. The application does not restore Node to the WAN provider path.

All client frames, including initialization/keepalive/cache-hit traffic, use one
at-least-51-ms admission interval by default. Local connection creation has a
separate, equally spaced budget. Neither accumulates catch-up credit. Queue
dispatch is round robin across sessions. Replies bypass request admission.
Limits: 256 local sessions; 128 queued frames; 512 KiB combined pending/queued
payload; 16 queued frames and 64 KiB per session; five-second queue/partial-frame
age. Reply backpressure is bounded as well. Expiry/overflow/protocol failures
retire the affected local session, never silently discard/reorder/replay a frame
or call a reader reset. There is no new fixed media buffer. Key requests can be
delayed under load, and safety closures can interrupt the affected channel.

The component **can close local sockets**. Its separation from the WAN socket
does not mean a full service/configuration restart or genuine native TCP/protocol
failure can never close that provider connection. The native 32-unanswered limit
and three-attempt/61-second durable budget remain in force. Existing guarded
transport behavior is unchanged. Numeric local ingress and upstream counters are
stored separately in private diagnostics/history, without payloads or keys.

## Completed verification before activation

- Final macOS regression: 527 total, 498 passed, 29 platform/opt-in skips, zero
  failures. Local sockets were explicitly permitted.
- Final isolated Linux regression: 527 total, 507 passed, 20 opt-in skips, zero
  failures.
- Real encrypted 90-channel fixture: every key correct, one provider connection,
  receiver-observed peak 20 requests/second. Local admission peak also at most
  20 frames/second; minimum observed admission spacing at least 51 ms.
- Negative-reply immediate-retry/churn fixture: shared local admission bounded
  the retry loop, one provider connection, fresh correct key after recovery.
- Forty channels with four-second delayed replies: all forty correct keys, one
  provider connection, no local capacity/expiry/transport closures.
- Node local guard stopped/replaced while work was in flight: the native
  provider connection stayed open; a fresh correct key was obtained through a
  replacement local guard without opening a second provider connection.
- Native injected TCP resets still obeyed the durable attempt window: fourth
  connection waited approximately sixty seconds from the first.
- One actual native decoder preserved all 1,396,088 expected A/V bytes with zero
  continuity errors and successful decoding.
- The longer actual-native soak passed with a peak of 85 simultaneous decoders,
  120 seconds of generated media per channel, exact expected A/V bytes for every
  channel, and one provider connection. No extra fixed native/packet delay was
  configured. The 23-test isolated ingress/direct/native gate completed with
  23 passes, zero failures or skips; the final in-flight local-guard replacement
  test passed separately. The full gate took about 533 seconds, including source
  generation, paced startup, fault-window waits and the media run. Its 4-GiB peak
  includes generated-file page cache, not just application RSS; no OOM/kill was
  observed. This is not a live CPU/RAM or end-user latency benchmark.
- Local framing tests cover fragmented/coalesced messages, unchanged replies,
  aggregate pacing, round-robin fairness, no event-loop-stall catch-up, local
  reconnect budget continuity, peer flood isolation, partial-frame expiry,
  malformed frames, session capacity and socket/timer cleanup.
- Manager tests verify shared aliases, separate native reporting/listener ports,
  stable repeated reconciliation and no Node WAN guard or budget-store owner.
- Existing installer rollback tests pass without restoring protected application
  data or consumed provider attempts.

The native encrypted fixtures ran as nobody inside disposable loopback-only
systemd network namespaces, with live configuration, secrets, adapters and the
installed application inaccessible. Explicit pinned native executable/manifest
paths were verified. No real provider test connection or fault injection was
made. The larger media test has its own four-core/4-GiB resource ceiling; source
fixture files and file cache count against that ceiling.

## Production activation

- Activated 18 October 2026 at 20:37:06 UTC / 22:37:06 Tirana using the standard
  staged native installer. One planned service restart; automatic restarts zero.
- Main PID 882463, OSCam PID 882490. Boot enablement and health endpoint passed;
  unauthenticated management correctly returned HTTP 401.
- Pre/post SHA-256 checks matched configuration, authentication, saved guide,
  media-delivery settings, environment, systemd unit, both native CAS binaries
  and manifests, DVB preload and HTTP TCP helper. Budget owner-lock device/inode,
  ownership and mode also matched. No consumed attempts were reset or restored.
- All 85 saved streams remain. At 20:37:41 UTC, eight clear streams ran; 77
  encrypted streams remained scrambled with 77 paced decoder starts queued.
  The provider was still unavailable: native readiness false, no active upstream
  socket, no Node socket to the configured provider port, zero post-restart
  forwarded provider/local frames and no decoder processes started prematurely.
- The local ingress listener was ready with empty queues and no local failures.
  Existing `ASTRA_CAS_PROVIDER_PAUSED=0` and direct mode were preserved; the line
  was not re-enabled or silently paused. OSCam continues its bounded connection
  attempts. Real-provider key recovery cannot be certified while the line is
  unavailable; the encrypted/media verification above is isolated synthetic work.
- Previous application/unit retained by the installer at
  `/opt/astra-linux-install-retained-puyJaB`. Rollback must keep current protected
  data and the latest provider-budget directory, not restore historical budgets.

## Incident limitations

The 18 October 22:14 Tirana incident showed a reply backlog of 32 unanswered
requests before recorded connection closes. Retained five-second upstream
admission averages were around 6–9 frames/second, while local failures briefly
increased by thousands. These are different measurements. No contemporaneous
packet capture/provider log was available to establish actual receiver timing or
the provider's reason for disabling the line. This release adds local overload
protection; it does not establish that incident's cause, prove an undocumented
provider limit, or guarantee uninterrupted key delivery.
