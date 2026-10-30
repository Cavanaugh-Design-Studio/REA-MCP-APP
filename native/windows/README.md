# Owned Windows command execution

This is the retained REA 6.3.0 Node-API 8 authority component, with its MIT license
at `third_party/rea.LICENSE`. It owns a non-breakaway Job Object before launching
the executable and retains an opaque handle for cleanup of all descendants.
The app validates the component version, platform, ABI, SHA-256 and capabilities.
Its component version is independent of the new application's 0.1.0 identity.

Build application JavaScript first, then `npm run build:windows-native` on an
existing Linux/MinGW-w64 build host. This lane uses the original stable Node-API
headers and verified header downloads. It does not install a compiler or a Node
runtime. The cross-compilation lane itself has not been rerun during this port.

For local Windows verification, the existing verified artifact and manifest were
staged into ignored `native/windows/build`. They are included by the package's
explicit artifact file list, never committed as source. The default loader reads
this package-owned location. `REA_WINDOWS_NATIVE_DIR` can explicitly select a
different matching artifact directory.
