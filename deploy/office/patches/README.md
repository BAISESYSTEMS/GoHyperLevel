# Patches for building an editor from source

Applied in name order by [../build-from-source.sh](../build-from-source.sh) to the upstream checkout of the pinned version
(`git apply`); the prebuilt release files that [../install.sh](../install.sh) installs are used unchanged.

| Patch | Project, version | Why |
|---|---|---|
| `gridcraft-0001-wasm-instant.patch` | Tabellen-Editor (GridCraft) 0.3.0 | The engine times every edit with `std::time::Instant`, which panics in the browser build (`time not implemented on this platform`) – the editor stops at the first cell edit. The patch only takes the time when profiling natively. Checked: applies to `v0.3.0` and compiles for `wasm32-unknown-unknown`. |

Drop a patch here once the upstream release contains the fix (and bump the version in [../versions.env](../versions.env)).
