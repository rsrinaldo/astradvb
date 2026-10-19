# TVHeadend-only candidate verification — 0.9.0-dev.2

Status: **not approved for live activation**. Checked 19 October 2026.

## Implemented architecture

The clean artifact physically excludes local OSCam, tsdecrypt and the Node CAS
proxy/guard modules. Native TVHeadend CWC connects directly to the configured
authorised provider and owns ECMs, keys and DVB-CSA. Node retains the existing
management interface and public playback/playlist/EPG endpoints. Node's clean
service has no DVB device access; TVHeadend owns tuner operations.

TVHeadend source is pinned to `8837853a69aa822b0203eb3909c5912dc831312e`.
The stock lab executable SHA-256 was
`75829ac60992900505b6af04a09fcfee2680380baba7c23f112a888adf4d69d9`.
It was built with bundled web assets, without libav/FFmpeg transcoding,
external scan-file downloads or trace logging. Native DVB scanning stays enabled.

No live service was restarted, replaced or uninstalled. No real provider was
contacted by these tests, and no production credentials, configuration or retry
budgets were imported into the lab. Experimental source copies are separate
from both the pinned stock binary and the installer.

## Passing checks

- Full local suite: 576 tests, 531 passed, 45 skipped, no failures/cancellations.
- Full isolated Linux suite: 576 tests, 540 passed, 36 skipped, no failures or
  cancellations. Skips are explicit platform/opt-in cases, not completed tests.
- Final focused Linux controls, packaging and HTTP suite: all 22 passed.
- Physically clean artifact starts without the omitted legacy modules. HTTP
  tests cover management authentication, password changes, private catalogue,
  scan/duplicate metadata, public TS/HLS, playlist formats and Unicode XML/JSON
  EPG. These use deterministic backend fixtures, not real tuner reception.
- Real pinned TVHeadend single-channel synthetic test passed native CWC login,
  service discovery, decryption and payload-reference matching. It used one
  shared connection; recreating the management backend did not reconnect it.
- Real TVHeadend schema accepted the tested S2X modulation/FEC/low-rolloff,
  MIS and PLS values using Linux's shared S2 delivery-system encoding. This is
  schema validation, not a TBS6909X V2 reception test.
- Six-channel stock baseline, ten-second synthetic key periods: all 37,085
  emitted A/V packets per channel matched the clear reference (37,269 source
  packets). One provider connection; peak six requests in a rolling second;
  zero fixture protocol errors. Startup omission means this is not lossless
  end-to-end delivery.
- Six-channel fast-key baseline, two-second periods with a test-only 2,000 ms
  CAID hint: all emitted A/V payloads matched. One connection; peak six requests
  per second; zero fixture protocol errors.

## Release-blocking native recovery failure

With the same six-channel ten-second fixture, the synthetic provider closes
its shared socket once, on channel 4's epoch-3 request. Stock TVHeadend makes
two connections total and peaks at six requests per second: this bounded test
does **not** reproduce a request storm. However, channels 4 and 5 each emit
37,085 A/V packets of which only 31,427 match the clear reference. The other
four channels match all emitted payloads. The exact-payload assertion fails.

The two-second reset case and the ten-second mixed late/negative/reset case
also fail payload correctness. Those failures are not counted as passes above.
Healthy baseline success is insufficient to deploy the candidate.

An upstream-source audit found a possible reconnect-cache problem: the session
restart flushes the transport ECM-table cache, while the card client's sent-ECM
cache can still suppress an identical request whose reply was lost on the old
socket. This is a hypothesis under isolated testing, not proof that the real
provider's historical outages had this cause. A diagnostic-only native patch is
not part of this candidate's installation path.

## Still required

Resolve and repeat native recovery tests without weakening payload assertions;
then verify representative channel count, request rates under repeated outages,
actual DVB tuner/LNB/DiSEqC/MIS/PLS reception, scan while streaming, profile
selection, Flussonic playback, daily EPG, access lists, reboot recovery and an
overnight soak. Browser visual QA and hardware behaviour remain unverified.

Removing OSCam also removes its custom provider rate/retry-budget controls.
Stock TVHeadend must not be represented as preserving those controls or as
guaranteeing provider safety, uninterrupted recovery or years-long operation.
