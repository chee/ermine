# Subduction for C

`libsubduction_c.a` (`subduction.h`): Subduction as a static library with a C
ABI, Rust, `no_std` with `alloc`, sans-IO, for newcore's C sync
(`newcore/sync/TRANSPORT.tex`). The crates are pinned exactly to the versions
`@automerge/subduction` 0.23.0 uses (git `2566cbf`). Brought over from
`layers/subduction/c/peer`, without its host (`peer.c`), which ran the old
graph.

**No Rust here.** `.github/workflows/newcore-subduction.yml` builds the library
for each target and puts it on the release `newcore-subduction-c`;
`make fetch` downloads this machine's into `lib/`, then `make` only compiles C.
`make crate` builds it locally instead (slow).

**The library** does no I/O, starts no thread and reads no clock. The host
hands in each message that arrives (`erm_sd_received`), sends each one the
library gives it (SEND events), passes the time to `erm_sd_run`, which runs
the library's own single-threaded executor, and takes answers as events.
What Subduction keeps is in the host's store (`store.h`): memory
(`store_memory.c`) or files (`store_files.c`). Taking in (TRANSPORT.tex)
watches the store's saves.

| file | what |
|---|---|
| subduction.h, src/ | the library and its C ABI |
| store.h, store_memory.c, store_files.c | where Subduction keeps what it holds |
| platform.h, platform_posix.c | the host's hooks: memory, randomness, clock, log, abort |
| transport.h, websocket.c, transport_openssl.c | a WebSocket client (RFC 6455) in portable C over a stream; the desktop stream (POSIX sockets, OpenSSL) |
| smoke.c | the library linked and alive: a commit stored and read back, no network |

**BLAKE3 twice.** The library carries its own BLAKE3, which exports the same
`blake3_*` symbols as `newcore/c/blake3`. A program linking both renames the
C ones (`-Dblake3_hasher_init=ermc_blake3_hasher_init` and the rest, as
`layers/subduction/c/peer/Makefile` did).
