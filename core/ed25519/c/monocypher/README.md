# monocypher

Monocypher 4.0.3, as released, unchanged: `monocypher.c`, `monocypher.h` and `LICENCE.md` from
`src/` and the top of the release tarball. Nothing else from it (not `src/optional/`: SHA-512 is
`../sha2.c`).

- source: https://monocypher.org/download/monocypher-4.0.3.tar.gz (the same file as
  https://github.com/LoupVaillant/Monocypher/releases/tag/4.0.3)
- tag: 4.0.3 (2026-06-15)
- tarball SHA-512, as monocypher.org publishes it (`monocypher-4.0.3.tar.gz.sha512`):
  `40904ada5c7ee4f7741733e38b69a30a4b0561cbffba5ffe7c2dce16136d540251ec0d9056ff606510d3b5b708fb8a40db7e0870d4a0b2dc17ba2bfb880f8965`
- tarball SHA-256, as the GitHub release lists it:
  `8cc9bc341a66249016db9bd70e9142d8d0aef9945973744b1ac05dbc55d8ee66`
- licence: BSD-2-Clause OR CC0-1.0, either (`LICENCE.md`; each file's header)

`../ed25519.c` includes `monocypher.c` whole, for its static field and group functions; nothing
builds `monocypher.c` on its own. To update: put a newer release's two files and `LICENCE.md` here,
unchanged, and run the seal, lock and sync conformance (and RFC 8032's vectors) again.
