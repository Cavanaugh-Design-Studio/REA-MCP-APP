---
name: leanrea
description: Reverse engineer shipped software with plain local CLI tools, no MCP needed. Covers Electron/JS bundles, native Mach-O/ELF/PE, Go/Rust/.NET/Flutter/WASM binaries, APKs, SQLite, pcaps, firmware and websites. Use to explain how a feature works, extract versions/deps, compare builds, or rebuild a feature.
---

# leanrea: fast path

You already know these tools. This file only lists the fastest command for each target, and the traps.

## Rules

- Work on a copy (`cp -c` on APFS is instant). Put each extraction in a new dir under `$TMPDIR/re/<name>`. Reuse an extraction if one exists.
- Route by `file -b T` and the magic bytes first. Run the cheapest inventory next. Only then decompile or read code.
- `rg` skips hidden and ignored files, and bundlers hide code (Electron: `.webpack/`, `.vite/`). Always search extracted trees with `rg -uu`.
- Never `cat` a big or minified file. Slice it: `rg -o '.{0,200}NEEDLE.{0,200}' F | head`. Dump a disassembly once to a file, then grep that file.
- Batch independent probes into ONE shell call with `;` and `echo '--- name'` markers (quoted: zsh expands a bare `==x`). Cap every output with `head` or `-m`.
- Answer from evidence. In the answer, mark each claim as **seen** (cite file:offset, or a symbol/string) or **inferred**. A fact you did not find is **unknown**, not "absent". Static reading is not observed execution.
- A missing tool is not a blocker. Use the fallback in the same row, or `brew install <x>` if the user allows it.
- Turns cost more than bytes. Aim for 2–4 tool calls: one batched recon call, one or two targeted slices, then answer. Stop when every item you were asked has evidence. Do not re-verify what you already saw.

## First move: one call each, paste and run

Native (Mach-O):

```sh
T=./bin; D=$TMPDIR/re/$(basename $T); mkdir -p $D; file $T; lipo -info $T; otool -L $T; echo '--- EXPORTS'; nm -gU $T | head -150; echo '--- IMPORTS'; nm -u $T | rg -v '^__Z|napi_' | tr '\n' ' '; echo; echo '--- STRINGS'; strings -a -n 6 $T | rg -v '^[_$.]' | head -400; otool -tV $T > $D/dis.txt; echo '--- FUNCS'; rg '^[_a-zA-Z].*:$' $D/dis.txt | rg -v '^_?_?Z?N?St3' | head -150
```

Then read one function: `awk '/^FUNC_LABEL:$/{p=1;next} p&&/^[_a-zA-Z].*:$/{exit} p' $D/dis.txt | rg 'bl|b\.|cmp|literal|mov\s+w2'`.

Electron:

```sh
A=./app.asar; X=$TMPDIR/re/asar; rm -rf $X; npx -y @electron/asar extract $A $X && jq '{name,version,main}' $X/package.json; find $X -path '*/node_modules' -prune -o -type f \( -name '*.js' -o -name '*.node' \) -print | head -60; ls ${A}.unpacked/node_modules 2>/dev/null; rg -uu -l --glob '!node_modules' 'exposeInMainWorld' $X
```

Then slice the needle across the bundle: `rg -uu -o --glob '!node_modules' '.{0,250}NEEDLE.{0,250}' $X | head -20`.

Go: `go version -m T` alone usually answers the question.

## Router

| Target (detect)                                    | Fastest path                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron app (`*.app/Contents/Resources/app.asar`) | `npx -y @electron/asar extract app.asar X` (also see `app.asar.unpacked/` for `.node` addons). Entry point: `jq .main X/package.json`. Surface: `rg -n -o '.{0,120}(ipcMain\.(handle                                                                                                                                                                                                                                                                                       | handleOnce | on  | once) | ipcRenderer\.(invoke | send | sendSync | on) | contextBridge\.exposeIn(Main | Isolated)World | webPreferences | preload: | nodeIntegration | contextIsolation | sandbox | \.node\b).{0,160}' -uu X --glob '!node_modules'`. App-specific IPC wrappers often hide the channels, so also run `rg -uu -o '"[a-z]+:[a-z0-9:-]+"' X/<main> \| sort -u`. Fuses: `npx -y @electron/fuses read --app A.app`. |
| Web bundle / minified JS                           | Find `sourceMappingURL`. If the map has `sourcesContent`, dump the sources: `jq -r '.sources[]'`. For webpack, grep the module ids, then slice around the hit. For pretty-print: `npx -y prettier --parser babel F > F.pretty.js`, then read with line ranges.                                                                                                                                                                                                             |
| Hermes / bytenode / V8 snapshot                    | Hermes magic is `c6 1f bc 03` (`index.android.bundle`): use `hermes-dec` / `hbc-decompiler`. `.jsc` (bytenode) cannot be decompiled: use strings and runtime hooks.                                                                                                                                                                                                                                                                                                        |
| Mach-O (`file`: Mach-O)                            | `lipo -info` (thin first: `lipo -thin arm64 -o T1 T`). Then: `otool -L` (libs); `xcrun dyld_info -exports -imports`; `nm -gU` (exports) / `nm -u` (imports = the capability map); `strings -a -n 6`; `otool -l \| rg -A3 'LC_(RPATH\|BUILD_VERSION)'`; `codesign -d --entitlements :- T`; `otool -ov` (ObjC classes/methods); `xcrun swift-demangle --compact`.                                                                                                            |
| Native code logic                                  | `otool -tV T > $D/dis.txt` (or `llvm-objdump -d --no-show-raw-insn -C`). Find the function: `rg -n '^_?.*Name.*:$'`. Read the call/string trail: `awk '/^FUNC:/{p=1} p&&/^[_a-zA-Z].*:$/&&!/FUNC/{exit} p' dis.txt \| rg 'bl\|call\|literal\|cmp'`. otool labels string literals and stubs inline, which is often enough. Only for real pseudocode: Ghidra `analyzeHeadless $D p -import T -postScript DecompileAll.java -deleteProject` or `r2 -qc 'aaa; pdc @ sym.X' T`. |
| ELF / PE                                           | `readelf -hlSW`, `readelf -dW` (NEEDED), `nm -D --defined-only`, `objdump -d -M intel`. PE: `objdump -x`, `pefile`/`wrestool` for resources. checksec: `pwn checksec`.                                                                                                                                                                                                                                                                                                     |
| Go (`__go_buildinfo`, `.go.buildinfo`)             | `go version -m T` gives the toolchain, path, mod, deps and build flags in one call. Without Go: `strings -a T \| rg -m1 -A200 'Go buildinf' `. Symbols survive stripping: `go tool nm T \| rg main\.`.                                                                                                                                                                                                                                                                     |
| Rust                                               | Deps (cargo-auditable): `cargo audit bin T`, or extract `.dep-v0` / `__DATA,.dep-v0` and zlib-inflate it. Compiler: `strings -a T \| rg -o '/rustc/[0-9a-f]{40}' \| sort -u`. Crates from paths: `strings -a T \| rg -o '[a-z0-9_-]+-[0-9]+\.[0-9]+\.[0-9]+/src' \| sort -u`.                                                                                                                                                                                              |
| .NET (`file`: Mono/.Net)                           | `ilspycmd -p -o X T.dll` (install: `dotnet tool install -g ilspycmd`), then `rg`. P/Invoke: `rg DllImport X`. NativeAOT/IL2CPP are native: use the native rows.                                                                                                                                                                                                                                                                                                            |
| Android APK                                        | `jadx -d X --show-bad-code a.apk` then `rg`. Resources/manifest only: `apktool d --no-src -o X a.apk`. Quick look: `unzip -l a.apk`. `lib/*/libflutter.so` means Flutter (Dart AOT: `blutter`); `libhermes.so` means React Native (Hermes row).                                                                                                                                                                                                                            |
| Flutter snapshot hash                              | In `libapp.so`, find magic `f5 f5 dc dc`; the 32 hex chars at +20 are the snapshot hash. Map it to a Dart version.                                                                                                                                                                                                                                                                                                                                                         |
| WASM                                               | `wasm-objdump -x`, `wasm2wat`, `wasm-decompile` (WABT).                                                                                                                                                                                                                                                                                                                                                                                                                    |
| SQLite                                             | Copy the db, plus the `-wal` file if present. `sqlite3 'file:C?mode=ro' '.schema'`, then `SELECT * FROM t LIMIT 20`.                                                                                                                                                                                                                                                                                                                                                       |
| plist / nib / car                                  | `plutil -p F`. Info.plist holds the bundle id, URL schemes and privacy strings. Asset catalogs: `assetutil --info Assets.car`.                                                                                                                                                                                                                                                                                                                                             |
| pcap / HAR                                         | `tshark -r C -q -z conv,tcp`; `tshark -r C -T fields -e dns.qry.name -e tls.handshake.extensions_server_name -e http.request.full_uri \| sort -u`. HAR: `jq -r '.log.entries[].request \| .method+" "+.url'`.                                                                                                                                                                                                                                                              |
| Firmware                                           | `binwalk -e F` or `unblob -e X F`. Then route each extracted binary through this table.                                                                                                                                                                                                                                                                                                                                                                                    |
| Website                                            | `curl -sL URL` for the HTML and script srcs, then fetch the JS and slice it. For runtime behavior, use a headless browser with a network log (Playwright `page.on('request')`) or Chrome `--remote-debugging-port`.                                                                                                                                                                                                                                                        |
| Running app / runtime                              | macOS: `lldb -p PID`, `dtrace`/`fs_usage`/`log stream --predicate 'process=="X"'`. Electron main: `--inspect` (only if the RunAsNode/inspect fuses allow it). Android: `adb logcat`, `frida -U -f pkg -l hook.js`.                                                                                                                                                                                                                                                         |

## Speed patterns

- Strings and imports first. On a small binary, `nm -u` + `strings` + the export list usually answer "what does it do" with no disassembly.
- To find who uses a string: get its address from `otool -tV` "literal pool for" comments, or `rg -n 'literal pool for: "X'`. Then find the enclosing function label above that line.
- A C++ name in a `bl` target already tells you the protocol (for example `getpeereid`, `write`, `std::hash`). Read the call sequence, not every instruction.
- For JS, go from the native/JS boundary inward: find the native call, then its caller class, then the IPC registration, then the renderer/preload.
- Comparing versions: diff the inventories (`nm`, the module list, `go version -m`) before you diff any code.
- Rebuilding: write the minimal reimplementation, then test it against the original (same inputs, same outputs).

## Install (only on request)

`brew install jadx apktool radare2 binwalk wabt wireshark ghidra` · `npm i -g @electron/asar` · `dotnet tool install -g ilspycmd` · `cargo install cargo-audit`.

---

## REA MCP App execution supplement (local addition)

The guide above is retained from aicodeking's leanrea. Its upstream macOS
benchmark does not measure this application. This supplement is maintained by
REA MCP App and adds coverage routes; it is not evidence of capability parity.

The internal agents execute the investigation. Do not ask the client agent to
run the analysis. Use the supplied platform, `node_executable`, workspace and
working target. Unix commands above are recipes, not portable argv: on Windows
select installed PowerShell/cmd explicitly when needed. Run `.cmd`/`.bat` tools
through the selected shell. Do not install or upgrade tools. Discover a missing
utility before selecting its fallback; report unavailable coverage explicitly.

### Coverage routes

These are investigation recipes, not additional registered tools. Each route
uses ordinary command/file operations and retains their exact output. An
executable on PATH does not establish that its engine, device, language pack,
license, browser or runtime works.

| Target family                  | Installed route and fallback                                                                                                                                                       | Required evidence and limits                                                                                                                                                                                                                                                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native Mach-O / ELF / PE / DOS | Format/architecture inventory, LLVM/binutils symbols and disassembly; installed Ghidra headless, IDA headless, Hopper CLI or radare2 for focused decompilation                     | Preserve addresses, slice/bitness, exact input digest and engine diagnostics. Strings/disassembly are not recovered pseudocode. No installed engine means decompilation is unknown. Ghidra projects are ephemeral. Never close or mutate an attached IDA GUI database.                                                            |
| Offline ELF layout             | Caller-installed pwntools or `readelf -hlSW`, `readelf -dW`, `objdump -x`                                                                                                          | Preserve sections, segments, symbols, relocation coordinates and format limitations. Mitigation strings are static candidates, not exploitation results.                                                                                                                                                                          |
| EVM bytecode                   | Caller-installed `evm disasm`, `cast disassemble` or an offline disassembler script written into this workspace                                                                    | Identify raw versus hex carrier first; preserve original byte offsets, PUSH immediate widths and truncated instructions. Selector constants alone do not prove ABI argument types, mutability, control flow or executable dispatch. Do not contact a chain/RPC unless assigned.                                                   |
| Recorded Linux crashes         | Caller-installed pwntools Corefile; offline GDB `--batch` against the selected core and matching executable; `readelf -n` for raw notes                                            | Retain each recorded thread and register/signal coverage; unmatched executables/mappings stay unknown. Never execute or attach to an unrelated live process to fill missing crash facts.                                                                                                                                          |
| JavaScript / Electron          | Read package entrypoints, extract with already-installed ASAR tooling, inspect hidden bundle trees, source maps, imports, preload/IPC literals; installed AST parser when required | Preserve source paths, digest/offsets, unresolved dynamic expressions and unpacked companions. Literal hits are not an AST relationship graph; inert source does not prove runtime registration. Never run a target's bootstrap merely to enumerate it.                                                                           |
| Websites                       | Explicit assigned URL: HTTP source/script reads, or caller-installed browser/CDP tooling for selected runtime behavior                                                             | Distinguish fetched bytes from DOM, accessibility, network and screenshot observations. Record start URL, actions and capture coverage. No browser means runtime behavior remains unknown. Close only owned browser sessions.                                                                                                     |
| Saved network captures         | HAR: workspace Node/Python script parses selected producer ordinals without fetching URLs; pcaps: installed tshark; native mitmproxy: installed mitmdump                           | Preserve capture digest, original record order, source pointers, response status and byte/text encoding. Partial or encrypted payloads stay unknown. Keep credentials out of model context; explicit sensitive values must also be redacted from script output. Ordinary JSON output does not become a canonical browser capture. |
| .NET assemblies                | Caller-installed ILSpy (`ilspycmd`), `ildasm`, or an installed metadata reader; first confirm PE/CLR metadata                                                                      | Preserve assembly/member tokens, CIL offsets, P/Invoke declarations and matching artifact digests. Strings are only discovery hints. NativeAOT/IL2CPP take the native route; decompiled C# is inferred and does not prove ABI parity.                                                                                             |
| Android APK code               | Installed JADX with the caller's JDK; ZIP inventory/manifest facts as a partial fallback                                                                                           | Retain class/method identities, source locations, decoding errors, obfuscation and unresolved references. Inventory is not decompilation. Work on the copied APK.                                                                                                                                                                 |
| Android devices                | Caller-installed adb with an explicitly selected device serial; bounded `devices -l`, `shell pm`, `logcat -d`, `dumpsys`, and explicitly assigned captures/transfers               | Never choose the first device or change app/device state without task authority. Preserve serial/package/process identity, requested command, output and transfer destination. No usable selected device means live coverage is unknown. Place pulled files inside the owned workspace; do not install APKs by default.           |
| JEB projects                   | Caller-selected, already-running JEB endpoint using its negotiated read-only inspection methods; otherwise offline APK/native routes                                               | Confirm server capabilities and selected project/unit first. Preserve returned unit/method IDs, artifact digests and unavailable facets. Do not start/close unrelated projects or forward model/API credentials to the endpoint. No endpoint or matching engine means JEB-specific coverage is unknown.                           |
| Android resources              | Caller-installed Apktool launcher/JDK; ZIP/XML inspection for uncompressed readable resources                                                                                      | Preserve manifest/resource IDs, locale coverage, decode errors and original APK digest. Raw binary XML/string tables require a decoder; absence of a readable string does not prove absence of the resource.                                                                                                                      |
| Firmware                       | Caller-installed binwalk/unblob on supported host; signatures and bounded byte reads as a partial fallback                                                                         | Extract into a fresh workspace directory, retain region offsets/lengths, tool failures and archive limits. Do not execute extracted binaries. Hand off each identified binary through its own native route.                                                                                                                       |
| Packages / Apple resources     | Installed archive tools or workspace scripts for inventories/digests; installed plutil/assetutil for Apple resources                                                               | Preserve paths, symlink/unpacked coverage, metadata and extraction integrity. Binary plist, keyed archive, nib and asset-catalog semantics are not established by a file listing. Never overwrite the original package.                                                                                                           |
| Process behavior               | Owned `run_command` for explicitly assigned noninteractive invocations; caller-installed PTY/capture tooling for interactive scenarios on supported hosts                          | Record argv, cwd, stdout/stderr, exit/signal, deadlines, truncation and cleanup. A piped command is not a PTY, filesystem trace or canonical process scenario. Do not claim interactive/runtime parity from output alone. Drain owned descendants and retain failed owners; never clean up by numeric PID alone.                  |

### Source and verification discipline

- Commands and generated scripts must use the working target, not
  `source_target`. The original caller path remains provenance.
- Directory inventories, byte slices and command output already have canonical
  Evidence. Save bulky output under the workspace, then inspect bounded slices.
  Do not replace exact raw output with a model's summary as the source record.
- Existing canonical imported captures can be inspected and compared through
  their named feature operations. Do not relabel CLI JSON as a trusted capture
  or fabricate a provider identity to satisfy deterministic verification.
- Each report distinguishes observed facts, inferred findings and unknowns.
  Cite the actual assigned Evidence IDs. Unsupported lanes, partial decoding,
  unavailable tools and missing runtime actions remain unknown even when a
  reviewer agrees with the analyst.
- Feature readiness and finite proof belong to the retained deterministic
  services. Model consensus, a successful process exit, a source literal or an
  implementation file cannot mark a feature verified.
