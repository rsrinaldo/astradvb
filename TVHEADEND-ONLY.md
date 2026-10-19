# Clean architecture — 0.9.0-dev.6

Our panel → authenticated loopback TVHeadend API → stock TVHeadend.

TVHeadend is the sole tuner, input, scan, channel, native Newcamd/ECM/key and
DVB-CSA backend. Its source, descrambling logic and reconnect behaviour are not
modified. The abandoned recovery experiment is not used or packaged.

## Retained frontend services

Our server supplies management login/password changes, IP access lists,
configuration forms, scan/import with duplicate marking/profile selection,
bulk stream removal, playlist exports, session tracking, host resource/network
statistics and daily XML/JSON serialization of TVHeadend's EPG.

The existing in-memory HLS segmenter and optional HLS audio-compatibility process
are retained by request. They receive TVHeadend channel output only. They cannot
tune devices, read provider credentials, handle ECMs, control keys or reset a
provider reader. MPEG-TS delivery uses standard HTTP stream backpressure.

The former backend modules, packet workers, native tuner/CSA helpers, custom CAS
proxy/guards, OSCam/tsdecrypt installers and patches are removed, not merely
disabled. Git history and the pre-removal recovery archive retain earlier work.
The release builder copies an explicit module allowlist.

## Our panel only

TVHeadend binds 127.0.0.1, not a public interface. Its build disables bundles and
Vue assets; no TVHeadend GUI assets are installed into the application. Its service
cannot read source/system GUI asset directories. Our server has no GUI embedding,
redirect, link or catch-all TVHeadend proxy. Only fixed server-side API operations
are allowed; the private backend password never enters browser responses or URLs.

Unmodified upstream registers GUI and API handlers in the same HTTP service.
Therefore internal GUI handler code still exists; it is not patched out. No
working TVHeadend GUI is delivered as part of this solution.

Non-bundled upstream builds still require stock backend resources, including
default streaming profiles and EPG tables. The installer copies only upstream's
data/ tree into /usr/local/share/astra/tvheadend/data, not src/webui/ or GUI bundles.

## Behaviour and boundaries

- Identical Newcamd account profiles share one native CWC reader, with EMM disabled.
  Unchanged readers are not reconfigured on panel restart or channel CRUD.
- Channel playback uses TVHeadend's native automatic CAID/reader selection.
  A panel profile assignment makes that account available; it is not a custom
  per-channel CAS firewall. Other subscriptions matching an active native reader
  may also use it. We do not invent a channel-level descramble query switch
  unsupported by upstream's channel streaming endpoint.
- Conflicting accounts for the same active CAID are rejected rather than silently
  choosing another reader. Selecting unsupported native policies is not simulated.
- DVB, UDP/RTP input, HTTP-TS and MPEG-TS HLS input use TVHeadend natively. DASH and
  other supported non-native inputs may use TVHeadend's standard pipe ingestion
  with FFmpeg stream-copy. Arbitrary pipe commands are not accepted.
- TVHeadend handles input availability/failover. Old custom timeout/retry controls
  are removed from our form, not displayed as if they still apply.
- Native UDP output is controlled through TVHeadend. RTP output is not silently
  emulated; unsupported output protocols are rejected explicitly.
- S2X uses Linux's shared S2 delivery encoding, with modulation/FEC/low-rolloff,
  MIS and PLS checked against the actual TVHeadend schema. Hardware/driver and real
  transponder compatibility still need verification.
- Basic LNB and DiSEqC ports 1–4 are translated to native TVHeadend configuration.
  Unicable requires existing SCR bindings; unsupported settings fail explicitly.
- Signal units come from TVHeadend; RF lock is not inferred from a subscription.
  Channel rates are TVHeadend subscription rates, not RF multiplex input or sums
  multiplied by the number of viewers. Unavailable counters show as unavailable.
- Status does not invent provider request rates, old guard counters or continuity
  measurements. TVHeadend-reported errors are labelled as backend errors.
- Unmapped historical streams stay visible in our panel, but do not start. Use the
  channel selector or configure/scan/import through our panel; no TVHeadend GUI is
  required. Original public IDs/names and credentials are preserved.
- EPG collection/character decoding belongs to TVHeadend. Our public XML and JSON
  share one daily published snapshot and keep the previous guide across failures.

See INSTALL-UBUNTU.md for the single-script first installation, maintenance and
rollback. The stock backend and panel have been deployed on the existing octa-tuner
server, with channel playback and EPG checked. First-install activation is covered
by isolated command/filesystem tests; a complete installation on a blank Ubuntu VM
has not yet been verified. No replacement of stock TVH's native recovery policy,
custom safety guarantee or years-long reliability claim is implied.

## Provider-free integration check

From the full source checkout, explicitly select a trusted unmodified TVHeadend
binary and run:

```bash
sudo env ASTRA_TVH_LAB_BIN=/usr/local/bin/astra-tvheadend \
  bash bin/run-tvheadend-lab.sh
```

The test uses synthetic credentials/media under PrivateNetwork, PrivateDevices,
PrivateTmp and resource limits. It cannot access production configuration or the
provider. It checks the real API/native CWC integration, not an alternative CAS
implementation. We do not patch or run recovery experiments on TVHeadend.
