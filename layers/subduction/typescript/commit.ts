// A change as a commit (SYNC.tex, Documents and commits; Names,
// order and time): the first experiment, writes to one node's value only.
//
// The blob is the change in deterministic CBOR (cbor.ts), a map of:
//
//   kind     "write"
//   node     the node's id
//   patches  the write's patches, each without fields left undefined
//   agent    who made it, its pids qualified
//   process  the process that made it, qualified, only if one did
//   cause    why it was made, its sites trimmed, only if it has one
//   parents  the hashes of the changes it was made on, as 32-byte byte
//            strings, sorted bytewise, none repeated: the heads of the
//            node's value when it was made, [] for the first
//   lamport  1 + the highest of its parents' Lamport numbers, 1 with none
//   base     only with two parents or more: the parent whose value the
//            patches apply to (the side the writing graph held)
//   merge    opt-in, only "rebase": the node's concurrent writes are merged
//            (rebase.ts), and the patches apply to the merge of the parents,
//            so a commit with two parents or more names no base. Left out,
//            the blob is as it was, and so is its hash.
//
// Never its time, which is the graph's own, nor ephemeral, since ephemeral
// changes are never commits.
//
// Made shareable first (SYNC.tex, Making a change shareable):
// every pid, the change's process and that of each step of its agent's code,
// is qualified, the pid, "/" and the device's key in hex, unless it has a "/"
// already; and every site in the cause, a map with a string file and a
// number line, has a local file (from "/", a drive letter or "file://") made
// relative to the nearest root given, or its last part under none. So no
// local path is hashed, and two devices' pids never meet. Without a device,
// a change with a pid not yet qualified has no commit. The codec sorts the map's keys, writes every
// number as its shortest float and accepts on decoding only what it would
// write, so a blob has one form and the same change has one hash everywhere.
//
// The hash is BLAKE3 (32 bytes) of the blob, as Subduction's digests are
// (core/graph/typescript/hash.ts).

import { decode, encode, type Value } from "../../../core/graph/typescript/cbor.ts";
import { define, whole } from "../../../core/graph/typescript/patch.ts";
import type { Change, Id, Json, Patch } from "../../../core/graph/typescript/types.ts";
import { digest, type Hash, hex } from "../../../core/graph/typescript/hash.ts";

/** A commit as it would cross the wire: its hash and its blob. */
export type Commit = { readonly hash: Hash; readonly blob: Uint8Array };

/** What a commit's blob says. */
export type Body = {
  kind: "write";
  node: Id;
  patches: Patch[];
  agent: Json;
  process?: Id;
  cause?: Json;
  /** sorted, none repeated */
  parents: Hash[];
  lamport: number;
  /** with two parents or more: the parent the patches apply to */
  base?: Hash;
  /** opt-in: the patches apply to the merge of the parents (rebase.ts) */
  merge?: "rebase";
};

/** A blob that is not a commit's, or a hash that is not its blob's. */
export class CommitError extends Error {
  override name = "CommitError";
}

const KEYS = new Set([
  "kind",
  "node",
  "patches",
  "agent",
  "process",
  "cause",
  "parents",
  "lamport",
  "base",
  "merge",
]);

function unhex(h: Hash): ArrayBuffer {
  if (!/^[0-9a-f]{64}$/.test(h)) throw new CommitError(`${h} is not a hash`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out.buffer;
}

/** A patch without the fields it leaves undefined, which CBOR cannot hold. */
function plain(patch: Patch): Value {
  const out: { [k: string]: Value } = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = v as Value;
  return out;
}

/** The device a commit is made on: its key in hex, and the source roots its sites are trimmed to. */
export type Maker = { device?: string; roots?: readonly string[] };

/** A pid, qualified by the device's key; one with a "/" already is kept. */
export function qualify(pid: Id, device: string | undefined): Id {
  if (pid.includes("/")) return pid;
  if (device === undefined) throw new CommitError(`the pid ${pid} needs a device to qualify it`);
  return `${pid}/${device}`;
}

/** A path of a local file, with "/" between its parts; undefined for any other file. */
function local(file: string): string | undefined {
  if (file.startsWith("file://")) {
    let path = decodeURIComponent(new URL(file).pathname);
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    return path;
  }
  if (file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file)) return file.replaceAll("\\", "/");
  return undefined;
}

/** A site's file, trimmed: relative to the nearest root it is under, else its last part. */
export function trim(file: string, roots: readonly string[] = []): string {
  const path = local(file);
  if (path === undefined) return file;
  let best: string | undefined;
  for (const r of roots) {
    const root = (local(r) ?? r).replace(/\/+$/, "");
    if (path.startsWith(root + "/") && (best === undefined || root.length > best.length)) {
      best = root;
    }
  }
  if (best !== undefined) return path.slice(best.length + 1);
  return path.split("/").filter((p) => p !== "").at(-1) ?? path;
}

/** A cause with every site in it trimmed. */
function trimmed(cause: Json, roots: readonly string[]): Json {
  if (Array.isArray(cause)) return cause.map((c) => trimmed(c, roots));
  if (!isMap(cause)) return cause;
  const out: { [k: string]: Json } = {};
  for (const [k, v] of Object.entries(cause as { [k: string]: Json })) {
    define(out, k, trimmed(v, roots));
  }
  if (typeof out.file === "string" && typeof out.line === "number") {
    out.file = trim(out.file, roots);
  }
  return out;
}

/** An agent with the process of each step of its code qualified. */
function qualified(agent: Json, device: string | undefined): Json {
  if (!isMap(agent) || !Array.isArray(agent.code)) return agent;
  const out: { [k: string]: Json } = {};
  for (const [k, v] of Object.entries(agent as { [k: string]: Json })) define(out, k, v);
  out.code = (agent.code as Json[]).map((step) => {
    if (!isMap(step) || typeof step.process !== "string") return step;
    const s: { [k: string]: Json } = {};
    for (const [k, v] of Object.entries(step as { [k: string]: Json })) define(s, k, v);
    s.process = qualify(step.process, device);
    return s;
  });
  return out;
}

/**
 * The commit of a write to a node's value, made on the parents given, with
 * its Lamport number given (1 + the parents' highest), and its base when it
 * has two parents or more; or, with merge "rebase", made on the merge of
 * the parents, and with no base. Its pids are qualified by the maker's
 * device, and its sites trimmed to the maker's roots, before it is hashed.
 */
export function commit(
  change: Change & { kind: "write" },
  parents: readonly Hash[],
  lamport: number,
  base?: Hash,
  merge?: "rebase",
  maker: Maker = {},
): Commit {
  const sorted = [...new Set(parents)].sort();
  if (merge === "rebase") {
    if (base !== undefined) throw new CommitError("a rebased commit names no base");
  } else if (sorted.length > 1 && (base === undefined || !sorted.includes(base))) {
    throw new CommitError("a commit with two parents or more names its base among them");
  }
  const body: { [k: string]: Value } = {
    kind: "write",
    node: change.node,
    patches: change.patches.map(plain),
    agent: qualified(change.agent, maker.device) as Value,
    parents: sorted.map(unhex),
    lamport,
  };
  if (change.process !== undefined) body.process = qualify(change.process, maker.device);
  if (change.cause !== undefined) body.cause = trimmed(change.cause, maker.roots ?? []) as Value;
  if (sorted.length > 1 && merge !== "rebase") body.base = unhex(base!);
  if (merge === "rebase") body.merge = "rebase";
  const blob = encode(body);
  return { hash: digest(blob), blob };
}

const isMap = (x: unknown): x is { [k: string]: unknown } =>
  typeof x === "object" && x !== null && !Array.isArray(x) && !ArrayBuffer.isView(x) &&
  !(x instanceof ArrayBuffer);

const isHash = (x: unknown): x is ArrayBuffer => x instanceof ArrayBuffer && x.byteLength === 32;

/**
 * What a commit says, once its hash is checked against its blob and its
 * blob is checked to be one: it does not check the patches apply, nor the
 * Lamport number against the parents, which needs them.
 */
export function open(c: Commit): Body {
  if (!(c.blob instanceof Uint8Array) || digest(c.blob) !== c.hash) {
    throw new CommitError("the hash is not the blob's");
  }
  const b = decode(c.blob) as unknown;
  if (!isMap(b)) throw new CommitError("a blob is a map");
  for (const k of Object.keys(b)) if (!KEYS.has(k)) throw new CommitError(`an unknown field ${k}`);
  if (b.kind !== "write") throw new CommitError("only writes are commits yet");
  if (typeof b.node !== "string") throw new CommitError("node is an id");
  if (!Array.isArray(b.patches) || !b.patches.every(isMap)) {
    throw new CommitError("patches are a list of patches");
  }
  if (!("agent" in b)) throw new CommitError("a commit says its agent");
  if (b.process !== undefined && typeof b.process !== "string") {
    throw new CommitError("process is an id");
  }
  if (!Array.isArray(b.parents) || !b.parents.every(isHash)) {
    throw new CommitError("parents are hashes");
  }
  const parents = b.parents.map((p) => hex(new Uint8Array(p)));
  for (let i = 1; i < parents.length; i++) {
    if (parents[i - 1] >= parents[i]) throw new CommitError("parents are sorted, none repeated");
  }
  if (!whole(b.lamport) || (b.lamport as number) < 1) {
    throw new CommitError("lamport is a whole number from 1");
  }
  if (b.merge !== undefined && b.merge !== "rebase") {
    throw new CommitError(`no merge is called ${JSON.stringify(b.merge)}`);
  }
  let base: Hash | undefined;
  if (b.merge === "rebase") {
    if (b.base !== undefined) throw new CommitError("a rebased commit names no base");
  } else if (parents.length > 1) {
    if (!isHash(b.base)) throw new CommitError("a commit with two parents or more names its base");
    base = hex(new Uint8Array(b.base));
    if (!parents.includes(base)) throw new CommitError("the base is one of the parents");
  } else if (b.base !== undefined) throw new CommitError("only a merge names its base");
  const body: Body = {
    kind: "write",
    node: b.node,
    patches: b.patches as Patch[],
    agent: b.agent as Json,
    parents,
    lamport: b.lamport as number,
  };
  if (b.process !== undefined) body.process = b.process as Id;
  if (b.cause !== undefined) body.cause = b.cause as Json;
  if (base !== undefined) body.base = base;
  if (b.merge === "rebase") body.merge = "rebase";
  return body;
}

/**
 * The agreed order of heads, the same on every device: the highest Lamport
 * number first, then the greater hash first.
 */
export function agreed(a: { lamport: number; hash: Hash }, b: { lamport: number; hash: Hash }) {
  return b.lamport - a.lamport || (a.hash < b.hash ? 1 : a.hash > b.hash ? -1 : 0);
}
