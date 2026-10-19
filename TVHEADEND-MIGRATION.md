# TVHeadend migration

Use [INSTALL-UBUNTU.md](INSTALL-UBUNTU.md) and
[TVHEADEND-ONLY.md](TVHEADEND-ONLY.md) for the current 0.9.0-dev.3 architecture.

The only backend is unmodified TVHeadend. Our original frontend and requested HLS
delivery layer remain. No OSCam, tsdecrypt, native fallback or custom provider
proxy/guard remains. TVHeadend's GUI is not exposed or shipped as our frontend.

Earlier dev.1/dev.2 documents describe retired intermediate work. Their GUI and
CAS migration instructions must not be used for this build.
