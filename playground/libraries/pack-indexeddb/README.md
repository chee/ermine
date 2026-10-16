# pack-indexeddb

**Experimental, optional, not part of the plan.** Packs (`ermine/encoding/typescript/pack.ts`) kept
in IndexedDB, so a page can get its table back after a reload. Nothing else depends on it.

- `createStore(database?, {indexedDB?})`: one database, one object store `packs`, a record per name:
  `{bytes, time}`.
- `save(name, entries, options?)`: packs the entries (pack's options, e.g. `{op: false}`) and keeps
  them under name, replacing what was there. A pack that throws keeps nothing.
- `load(name, reading?)`: the entries back (pack's reading, e.g. `{loosyGoosy: true}`); none if
  nothing is kept there. Putting them in a table is the caller's.
- `saved(name)`, `names()`, `remove(name)`, `close()`.

A workspace package, `@ermine/pack-indexeddb`, so the slaygrounds can bundle it (examples/lab-save).
Test: `deno test --allow-read playground/pack-indexeddb/typescript/` (uses `npm:fake-indexeddb`).
