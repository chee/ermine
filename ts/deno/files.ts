// A keeper's backend on the filesystem, for Deno: one file, "log", in a
// directory. Each write appends one frame, a 4-byte big-endian length then
// the CBOR of a map from key to bytes, or null for a delete, and syncs it. A
// frame cut short by a crash is dropped when the file is read. A whole write,
// and a log grown well past what it holds, is written to "log.tmp", synced,
// and renamed over the log, so a reader finds the old log or the new one.

import { decode, encode, type Value } from "../src/cbor.ts";
import { type Backend, KeepError } from "../src/keeper.ts";

const LOG = "log";
const TMP = "log.tmp";

/** slack: how many bytes past four times what it holds the log may grow before it is rewritten */
export function files(dir: string, { slack = 1 << 20 }: { slack?: number } = {}): Backend {
  const log = `${dir}/${LOG}`;
  const tmp = `${dir}/${TMP}`;
  /** the records, once read; and how many bytes the log has, and how many they take */
  let records: Map<string, Uint8Array> | undefined;
  let size = 0;

  const live = () => {
    let n = 0;
    for (const [k, v] of records!) n += k.length + v.byteLength + 4;
    return n;
  };

  async function readLog(): Promise<Map<string, Uint8Array>> {
    await Deno.mkdir(dir, { recursive: true });
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(log);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      bytes = new Uint8Array();
    }
    const out = new Map<string, Uint8Array>();
    let at = 0;
    while (at < bytes.length) {
      if (at + 4 > bytes.length) break;
      const n = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0);
      if (at + 4 + n > bytes.length) break;
      let frame: unknown;
      try {
        frame = decode(bytes.subarray(at + 4, at + 4 + n));
      } catch {
        break;
      }
      apply(out, frame);
      at += 4 + n;
    }
    if (at < bytes.length) {
      // a frame cut short: what was written before it stands
      await Deno.truncate(log, at);
    }
    size = at;
    return out;
  }

  function apply(out: Map<string, Uint8Array>, frame: unknown) {
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      throw new KeepError("a frame of the log is not a map");
    }
    for (const [k, v] of Object.entries(frame)) {
      if (v === null) out.delete(k);
      else if (v instanceof ArrayBuffer) out.set(k, new Uint8Array(v));
      else throw new KeepError(`record ${JSON.stringify(k)} is not bytes`);
    }
  }

  function frame(batch: Iterable<[string, Uint8Array | null]>): Uint8Array {
    const map: { [k: string]: Value } = {};
    for (const [k, v] of batch) map[k] = v === null ? null : v.slice().buffer;
    const body = encode(map);
    const out = new Uint8Array(4 + body.length);
    new DataView(out.buffer).setUint32(0, body.length);
    out.set(body, 4);
    return out;
  }

  async function rewrite(all: Map<string, Uint8Array>) {
    await Deno.mkdir(dir, { recursive: true });
    const bytes = frame(all);
    const f = await Deno.open(tmp, { write: true, create: true, truncate: true });
    try {
      await writeAll(f, bytes);
      await f.sync();
    } finally {
      f.close();
    }
    await Deno.rename(tmp, log);
    records = all;
    size = bytes.length;
  }

  return {
    async read() {
      records = await readLog();
      return new Map(records);
    },
    async write(batch, whole) {
      if (whole) {
        const all = new Map<string, Uint8Array>();
        for (const [k, v] of batch) if (v !== null) all.set(k, v.slice());
        return await rewrite(all);
      }
      records ??= await readLog();
      const bytes = frame(batch);
      const f = await Deno.open(log, { write: true, create: true, append: true });
      try {
        await writeAll(f, bytes);
        await f.sync();
      } finally {
        f.close();
      }
      size += bytes.length;
      for (const [k, v] of batch) v === null ? records.delete(k) : records.set(k, v.slice());
      if (size > 4 * live() + slack) await rewrite(records);
    },
  };
}

async function writeAll(f: Deno.FsFile, bytes: Uint8Array) {
  let at = 0;
  while (at < bytes.length) at += await f.write(bytes.subarray(at));
}
