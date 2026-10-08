// Sharing one node's value as commits (SYNC.tex): the first
// experiment, no network and no Subduction, kept for its rebasing (rebase.ts).
// The sync stack SYNC.tex describes is sync.ts. A wrapper (GRAPH.tex, Running and
// wrapping) over the stack, for one node, known by its id and reached by an
// address, since nothing can write by id.
//
// Local writes. It subscribes to the node beneath itself, so it hears every
// change to the node's value in the order the graph made it, whichever layer
// made it. Each write that is not ephemeral becomes a commit (commit.ts) made
// on the heads, the latest changes no other known change was made on, its
// pids qualified by this device's key and its sites trimmed, and is kept in
// the log; it is then the one head.
//
// Arriving commits. receive(commit, peer?) checks the hash, ignores a commit
// it knows, and holds one whose parents are not all known until they are, so
// commits may come in any order, and twice. Applying one writes it to the
// layer it wraps, with the commit's agent, process and cause and a time
// given here (by the layer below, or by the clock it was given, which must
// be after every time the node has had), so readers are marked as by any
// change.
//
// What waits is bounded and shown (status()). At most so many commits are
// held for the document, and for each peer that sent them; past that, the
// oldest is dropped, and listed as dropped. A commit that fails a check is
// refused and listed; a commit waiting on a refused or stuck one will never
// apply, so it is stuck, listed with the commit it waits on and why. Each
// list keeps as many as the document may hold.
//
// Sides. Each known commit's value is its base's value with its patches
// applied: its one parent's, the base it names if it has several (the first
// of them in the agreed order), the value the node had when sharing began if
// none. So a side is the value of one chain from the common start, replayed
// from the log. The graph holds the side of the first head in the agreed
// order (commit.ts), so two devices with the same commits hold the same
// value. An arriving commit that becomes the first head is written as its
// own patches when its base is the side the graph held, and as a snapshot of
// its side otherwise; one that does not is written as an empty list of
// patches, which marks readers, since there is one more item. With one head,
// the node reads as the graph's item, naming its commit. With several, it
// reads as an item per head in the agreed order, each naming its commit and
// carrying the change that applied it here. A write made here over them has
// every head as a parent and the first as its base, and settles them to
// one. Splices made on different bases are not rebased: each side is the
// whole value its own chain gives.
//
// Rebasing, opt-in (merge: "rebase"; rebase.ts, layers/subduction/eg-walker.org). Every
// commit says merge "rebase", and one that does not is refused, as is one
// that does on a node that is not rebased. A commit's patches apply to the
// merge of its parents, and the graph holds the merge of the heads. A commit
// made on exactly the heads the graph held is written as its own patches;
// any other as a snapshot of the new merge. With several heads the node
// reads as one item, the merge, naming the heads; when the merge dropped a
// patch some head kept, the item lists them, and each such head's own value
// follows it as a side, until a write here settles them. With one head, a
// value is the head's own, kept; the merge of every commit is kept as a
// replay that takes each later commit without replaying the rest, and only
// a head's value is kept beside it.
//
// Subscriptions through the wrapper see the node as reads do: the items an
// event gives, when a change moved its address, show the sides.

import { applyPatches } from "../../../core/graph/typescript/patch.ts";
import {
  type Event,
  history,
  merge,
  type Merged,
  type PatchRef,
  rebase,
  type Rebased,
  Replay,
} from "./rebase.ts";
import {
  type Address,
  type Change,
  type Changed,
  type Event as Heard,
  type Header,
  type Id,
  type Interface,
  type Json,
  ours,
  type Patch,
  type ReadOp,
  type SubscribeOp,
  told,
  type ValueItem,
} from "../../../core/graph/typescript/types.ts";
import { agreed, type Body, type Commit, commit, CommitError, open } from "./commit.ts";
import type { Hash } from "../../../core/graph/typescript/hash.ts";

ours(import.meta.url);

/** An item of the shared node's value, naming the commit it came from. */
export type SideItem = ValueItem & { commit: Hash };

/** A rebased node's item while it has several heads: their merge. */
export type MergedItem = ValueItem & { heads: Hash[]; dropped?: PatchRef[] };

/** A commit applied: its hash, and what writing it here answered. */
export type Applied = { hash: Hash; changed: Changed };

/** A commit held until its parents are known: the peer it came from, and the parents missing. */
export type Held = { hash: Hash; peer?: string; missing: Hash[] };
/** A commit that failed a check: never applied. */
export type Refused = { hash: Hash; peer?: string; reason: string };
/** A commit waiting on a refused or stuck one, so it never applies. */
export type Stuck = { hash: Hash; peer?: string; on: Hash; reason: string };
/** A commit let go: held past a limit, or not written here; sending it again tries it again. */
export type Dropped = { hash: Hash; peer?: string; reason: string };

/** What did not apply, for a host or a person to see: each list oldest first. */
export type Status = { waiting: Held[]; refused: Refused[]; stuck: Stuck[]; dropped: Dropped[] };

export type ShareOptions = {
  /** the shared node's id, its document's */
  id: Id;
  /** where the node is, from the root: arriving commits are written there */
  address: Address;
  /** this device's key, 64 lowercase hex digits: it qualifies the pids of its commits */
  device: string;
  /** the source roots the files of its commits' sites are made relative to */
  roots?: readonly string[];
  /** the agent its own reads and subscription act as; "sync" if not given */
  agent?: Json;
  /** gives arriving changes their time, for a layer below that needs one, as the bare graph does */
  time?: () => number;
  /** how concurrent writes read: as sides (the default), or rebased into one value */
  merge?: "sides" | "rebase";
  /** how many commits may be held for the document (1024), and for one peer (256) */
  hold?: { document?: number; peer?: number };
};

export type Shared = {
  /**
   * Takes in a commit from elsewhere, from the peer named if one is: the
   * commits it let apply, in order; none if known, held or stuck. A commit
   * that fails a check, or cannot be written here, is not applied, and the
   * first such error is thrown once the rest have applied.
   */
  receive(c: Commit, peer?: string): Applied[];
  /** Every commit known here, in the order applied here. */
  commits(): Commit[];
  /** The heads, in the agreed order. */
  heads(): Hash[];
  /** The commits waiting for parents. */
  waiting(): Hash[];
  /** What waits, and what was refused, stuck or dropped. */
  status(): Status;
  /** What a known commit says. */
  body(hash: Hash): Body | undefined;
  /** The commit a change of this graph was, by its time. */
  hashOf(time: number): Hash | undefined;
};

type Entry = { commit: Commit; body: Body; value: Json | undefined; header: Header };

/** A change as an item carries it: without its patches. */
function header(change: Change): Header {
  const { patches: _p, value: _v, ...rest } = change as Change & {
    patches?: unknown;
    value?: unknown;
  };
  return Object.freeze(rest) as Header;
}

const eventOf = (hash: Hash, b: Body): Event => ({
  hash,
  lamport: b.lamport,
  parents: b.parents,
  patches: b.patches,
});

/** Keeps a map to at most n entries, letting the oldest go. */
function bound<K, V>(m: Map<K, V>, n: number) {
  while (m.size > n) m.delete(m.keys().next().value!);
}

/** Shares the node at options.address, whose id is options.id, over api. */
export function share<T extends Interface>(api: T, options: ShareOptions): T & Shared {
  const { id, address, device } = options;
  if (typeof device !== "string" || !/^[0-9a-f]{64}$/.test(device)) {
    throw new CommitError("a device is its key, as 64 lowercase hex digits");
  }
  const maker = { device, roots: options.roots ?? [] };
  const agent = options.agent ?? "sync";
  const at = { agent, address };
  if (api.reach && api.reach(at).node !== id) {
    throw new CommitError(`${JSON.stringify(address)} does not reach ${id}`);
  }
  const [now] = api.read(at);
  const start = now?.value ?? null;
  const limit = {
    document: options.hold?.document ?? 1024,
    peer: options.hold?.peer ?? 256,
  };

  const log = new Map<Hash, Entry>();
  const order: Hash[] = [];
  const byTime = new Map<number, Hash>();
  /** the latest time of a change to the node heard here */
  let latest = now?.change?.time ?? -Infinity;
  let heads: Hash[] = [];
  /** commits waiting, oldest first, and for each missing parent, the commits waiting on it */
  const holding = new Map<Hash, { c: Commit; body: Body; peer?: string; missing: Set<Hash> }>();
  const blocked = new Map<Hash, Set<Hash>>();
  const perPeer = new Map<string, number>();
  const refused = new Map<Hash, Refused>();
  const stuck = new Map<Hash, Stuck>();
  const dropped = new Map<Hash, Dropped>();
  /** the commit being written here, while it is */
  let applying: { c: Commit; body: Body; value: Json } | undefined;

  const sideOf = (h: Hash | undefined): Json => h === undefined ? start : log.get(h)!.value!;
  const lamportOf = (h: Hash) => log.get(h)!.body.lamport;
  /** Heads in the agreed order; one not yet in the log is given with its body. */
  const sorted = (hs: Hash[], extra?: { hash: Hash; body: Body }) => {
    const n = (h: Hash) => h === extra?.hash ? extra.body.lamport : lamportOf(h);
    return hs.sort((a, b) => agreed({ lamport: n(a), hash: a }, { lamport: n(b), hash: b }));
  };

  const rebased = options.merge === "rebase";
  const known = (h: Hash): Event | undefined => {
    const e = log.get(h);
    return e && eventOf(h, e.body);
  };
  /** the merge of every commit in the log, kept, and the commit being applied if it is added */
  let replay: Replay | undefined;
  /** merges of other sets of heads, for the heads as they are; cleared when they change */
  const merges = new Map<string, Rebased>();
  /** the read of the heads as they are, kept until they change */
  let shown: Merged | undefined;

  /** Adds a commit to the replay; one that fails to replay leaves none, to be made again. */
  function grow(e: Event) {
    try {
      replay!.add(e);
    } catch (err) {
      replay = undefined;
      throw err;
    }
  }

  /** The merge of every commit in the log, and of the one given too. */
  function whole(extra?: { hash: Hash; body: Body }): Rebased {
    const want = log.size + (extra && !log.has(extra.hash) ? 1 : 0);
    if (replay && extra && !replay.has(extra.hash) && replay.size === log.size) {
      const e = eventOf(extra.hash, extra.body);
      if (replay.fits(e)) grow(e);
    }
    if (!replay || replay.size !== want || (extra && !replay.has(extra.hash))) {
      const events = [...log.values()].map((e) => eventOf(e.commit.hash, e.body));
      if (extra && !log.has(extra.hash)) events.push(eventOf(extra.hash, extra.body));
      replay = undefined;
      const r = new Replay(start);
      for (const e of events.sort((a, b) => -agreed(a, b))) r.add(e);
      replay = r;
    }
    return replay.result();
  }

  const same = (a: readonly Hash[], b: readonly Hash[]) =>
    a.length === b.length && a.every((h) => b.includes(h));

  /** The merge of the commits of these heads. */
  function mergeOf(hs: readonly Hash[]): Rebased {
    if (same(hs, heads)) return whole();
    const key = [...hs].sort().join();
    let r = merges.get(key);
    if (!r) merges.set(key, r = rebase(start, history(known, hs)));
    return r;
  }

  /** The merged value of the commits of these heads: a head's own, when one. */
  function valueOf(hs: readonly Hash[]): Json {
    if (hs.length === 0) return start;
    if (hs.length === 1) {
      const v = log.get(hs[0])!.value;
      if (v !== undefined) return v;
    }
    return mergeOf(hs).value;
  }

  function take(c: Commit, body: Body, value: Json, change: Change) {
    const e: Entry = { commit: c, body, value, header: header(change) };
    log.set(c.hash, e);
    order.push(c.hash);
    if (!byTime.has(change.time)) byTime.set(change.time, c.hash);
    const parents = new Set(body.parents);
    heads = sorted([...heads.filter((h) => !parents.has(h)), c.hash]);
    merges.clear();
    shown = undefined;
    if (rebased) {
      // the replay takes it, if it can without replaying the rest
      if (replay && !replay.has(c.hash)) {
        const ev = eventOf(c.hash, body);
        if (replay.size !== log.size - 1 || !replay.fits(ev)) replay = undefined;
        else {
          try {
            grow(ev);
          } catch {
            // made again when it is next needed
          }
        }
      }
      // only a head's value is kept: any other is the merge of its commits
      for (const p of parents) log.get(p)!.value = undefined;
    }
  }

  // every change to the node's value, in the order the graph made it
  api.subscribe({
    ...at,
    send(event) {
      if (!("change" in event)) return;
      const change = event.change;
      if (change.node !== id) return;
      if (change.time > latest) latest = change.time;
      if (change.kind !== "write" || change.ephemeral) return;
      if (applying) {
        take(applying.c, applying.body, applying.value, change);
        applying = undefined;
        return;
      }
      // a write made here: on every head, its patches applied to the first side, or to their merge
      const parents = [...heads];
      const lamport = 1 + Math.max(0, ...parents.map(lamportOf));
      if (rebased) {
        const c = commit(change, parents, lamport, undefined, "rebase", maker);
        take(c, open(c), applyPatches(valueOf(parents), change.patches), change);
        return;
      }
      const base = parents.length > 1 ? heads[0] : undefined;
      const c = commit(change, parents, lamport, base, undefined, maker);
      take(c, open(c), applyPatches(sideOf(heads[0]), change.patches), change);
    },
  });

  /** Checks a commit whose parents are known: its value, and the patches that write it here. */
  function check(c: Commit, body: Body): { value: Json; patches: Patch[] } {
    const lamport = 1 + Math.max(0, ...body.parents.map(lamportOf));
    if (body.lamport !== lamport) {
      throw new CommitError(`lamport ${body.lamport} is not one more than its parents' highest`);
    }
    if ((body.merge === "rebase") !== rebased) {
      throw new CommitError(
        rebased
          ? "a commit not rebased, on a rebased node"
          : "a rebased commit, on a node of sides",
      );
    }
    if (rebased) {
      const value = applyPatches(valueOf(body.parents), body.patches);
      if (same(body.parents, heads)) return { value, patches: body.patches };
      return { value, patches: [{ type: "snapshot", value: whole({ hash: c.hash, body }).value }] };
    }
    if (body.parents.length > 1) {
      const first = sorted([...body.parents])[0];
      if (body.base !== first) throw new CommitError(`the base is not ${first}, the first parent`);
    }
    const base = body.base ?? body.parents[0];
    const value = applyPatches(sideOf(base), body.patches);
    const next = sorted([...heads.filter((h) => !body.parents.includes(h)), c.hash], {
      hash: c.hash,
      body,
    });
    // only the first head is written: as its own patches on the side the graph held
    if (next[0] !== c.hash) return { value, patches: [] };
    return { value, patches: base === heads[0] ? body.patches : [{ type: "snapshot", value }] };
  }

  /** Writes a checked commit here. */
  function write(c: Commit, body: Body, value: Json, patches: Patch[]): Applied {
    if (api.reach && api.reach(at).node !== id) {
      throw new CommitError(`${JSON.stringify(address)} no longer reaches ${id}`);
    }
    let time: number | undefined;
    if (options.time) {
      time = options.time();
      if (time <= latest || byTime.has(time)) {
        throw new CommitError(
          `the time ${time} given is not after ${latest}, the node's latest: two clocks disagree`,
        );
      }
    }
    applying = { c, body, value };
    let changed: Changed;
    try {
      changed = api.write({
        agent: body.agent,
        ...(body.process === undefined ? {} : { process: body.process }),
        ...(body.cause === undefined ? {} : { cause: body.cause }),
        ...(time === undefined ? {} : { time }),
        address,
        patches,
      });
    } finally {
      applying = undefined;
      // the replay may have taken it before the write failed
      if (!log.has(c.hash) && replay?.has(c.hash)) replay = undefined;
    }
    if (!log.has(c.hash)) throw new CommitError("the write was made, but not to the shared node");
    if (byTime.get(changed.change.time) !== c.hash) {
      throw new CommitError(`the time ${changed.change.time} names another commit here`);
    }
    return { hash: c.hash, changed };
  }

  const reasonOf = (e: unknown) => e instanceof Error ? e.message : String(e);

  function unhold(h: Hash) {
    const w = holding.get(h)!;
    holding.delete(h);
    for (const p of w.missing) {
      const s = blocked.get(p);
      s?.delete(h);
      if (s?.size === 0) blocked.delete(p);
    }
    if (w.peer !== undefined) {
      const n = perPeer.get(w.peer)! - 1;
      if (n) perPeer.set(w.peer, n);
      else perPeer.delete(w.peer);
    }
    return w;
  }

  function drop(h: Hash, peer: string | undefined, reason: string) {
    dropped.delete(h);
    dropped.set(h, { hash: h, ...(peer === undefined ? {} : { peer }), reason });
    bound(dropped, limit.document);
  }

  function hold(c: Commit, body: Body, peer: string | undefined, missing: Hash[]) {
    holding.set(c.hash, { c, body, peer, missing: new Set(missing) });
    for (const p of missing) {
      let s = blocked.get(p);
      if (!s) blocked.set(p, s = new Set());
      s.add(c.hash);
    }
    if (peer !== undefined) {
      perPeer.set(peer, (perPeer.get(peer) ?? 0) + 1);
      while (perPeer.get(peer)! > limit.peer) {
        let oldest: Hash | undefined;
        for (const [h, w] of holding) {
          if (w.peer === peer) {
            oldest = h;
            break;
          }
        }
        unhold(oldest!);
        drop(oldest!, peer, `more than ${limit.peer} held for the peer ${peer}`);
      }
    }
    while (holding.size > limit.document) {
      const oldest = holding.keys().next().value!;
      const w = unhold(oldest);
      drop(oldest, w.peer, `more than ${limit.document} held for the document`);
    }
  }

  /** Marks what waits on a commit that will never apply as stuck, and what waits on that. */
  function strand(on: Hash, why: string) {
    const todo: [Hash, string][] = [[on, why]];
    while (todo.length) {
      const [h, reason] = todo.pop()!;
      for (const w of [...blocked.get(h) ?? []]) {
        const { peer } = unhold(w);
        const r = `waits on ${h}: ${reason}`;
        stuck.set(w, { hash: w, ...(peer === undefined ? {} : { peer }), on: h, reason: r });
        todo.push([w, `stuck, as it ${r}`]);
      }
      blocked.delete(h);
    }
    bound(stuck, limit.document);
  }

  function refuse(c: Commit, peer: string | undefined, e: unknown) {
    const reason = reasonOf(e);
    refused.set(c.hash, { hash: c.hash, ...(peer === undefined ? {} : { peer }), reason });
    bound(refused, limit.document);
    strand(c.hash, `refused: ${reason}`);
  }

  function receive(c: Commit, peer?: string): Applied[] {
    let body: Body;
    try {
      body = open(c);
    } catch (e) {
      // not refused by its hash, which it may not have: a hash refused would block the real one
      if (typeof c?.hash === "string" && !log.has(c.hash)) drop(c.hash, peer, reasonOf(e));
      throw e;
    }
    if (log.has(c.hash) || holding.has(c.hash) || refused.has(c.hash) || stuck.has(c.hash)) {
      return [];
    }
    if (body.node !== id) {
      const e = new CommitError(`a commit of ${body.node}, not of ${id}`);
      refuse(c, peer, e);
      throw e;
    }
    for (const p of body.parents) {
      const bad = refused.get(p) ?? stuck.get(p);
      if (bad) {
        const reason = `waits on ${p}: ${refused.has(p) ? "refused" : "stuck"}: ${bad.reason}`;
        stuck.set(c.hash, { hash: c.hash, ...(peer === undefined ? {} : { peer }), on: p, reason });
        bound(stuck, limit.document);
        return [];
      }
    }
    dropped.delete(c.hash);
    const missing = body.parents.filter((p) => !log.has(p));
    if (missing.length) {
      hold(c, body, peer, missing);
      return [];
    }
    const out: Applied[] = [];
    const ready: { c: Commit; body: Body; peer?: string }[] = [{ c, body, peer }];
    // a bad commit is refused, and what waits on it is stuck; the rest apply, then it throws
    let bad: { e: unknown } | undefined;
    while (ready.length) {
      const next = ready.shift()!;
      let checked: { value: Json; patches: Patch[] };
      try {
        checked = check(next.c, next.body);
      } catch (e) {
        refuse(next.c, next.peer, e);
        bad ??= { e };
        continue;
      }
      try {
        out.push(write(next.c, next.body, checked.value, checked.patches));
      } catch (e) {
        // not the commit's fault, but this graph's: let go, so sending it again tries again
        drop(next.c.hash, next.peer, `not written here: ${reasonOf(e)}`);
        bad ??= { e };
        continue;
      }
      for (const w of [...blocked.get(next.c.hash) ?? []]) {
        const h = holding.get(w)!;
        h.missing.delete(next.c.hash);
        if (h.missing.size === 0) {
          unhold(w);
          ready.push(h);
        }
      }
      blocked.delete(next.c.hash);
    }
    if (bad) throw bad.e;
    return out;
  }

  function status(): Status {
    return {
      waiting: [...holding.values()].map((w) => ({
        hash: w.c.hash,
        ...(w.peer === undefined ? {} : { peer: w.peer }),
        missing: [...w.missing],
      })),
      refused: [...refused.values()],
      stuck: [...stuck.values()],
      dropped: [...dropped.values()],
    };
  }

  /** The shared node's item, as the sides when there are several. */
  function sides(item: ValueItem): ValueItem[] {
    if (heads.length === 0) return [item];
    const side = (h: Hash): SideItem => {
      const e = log.get(h)!;
      return { value: e.value!, from: item.from, change: e.header, commit: h };
    };
    /** the graph's own item, for the side it holds */
    const held = (h: Hash): SideItem => ({ ...item, change: log.get(h)!.header, commit: h });
    if (heads.length === 1) return [held(heads[0])];
    if (rebased) {
      const m = shown ??= merge(start, known, heads, mergeOf);
      const first: MergedItem = { ...item, heads: [...heads] };
      if (m.dropped.length) first.dropped = m.dropped;
      return [first, ...m.losing.map(side)];
    }
    return heads.map((h, i) => i === 0 ? held(h) : side(h));
  }

  /** Items as read through the wrapper: the shared node's as its sides. */
  function expand(items: readonly ValueItem[], op: ReadOp): ValueItem[] {
    const out: ValueItem[] = [];
    for (const item of items) {
      const node = item.from.route.at(-1)?.node ??
        (api.reach ? api.reach(op).node : undefined);
      if (node === id && !item.ephemeral) out.push(...sides(item));
      else out.push(item);
    }
    return out;
  }

  const read = (op: ReadOp): ValueItem[] => expand(api.read(op), op);

  function subscribe(op: SubscribeOp): { sub: number } {
    const send = op.send;
    return api.subscribe({
      ...op,
      send: (event: Heard) =>
        send(
          "change" in event && event.reaches
            ? { ...event, reaches: expand(event.reaches, op) }
            : event,
        ),
    });
  }

  // the layer's own operations, its getters kept live, as a scheduler's time
  const wrapped = Object.assign(
    Object.defineProperties({}, Object.getOwnPropertyDescriptors(api)),
    {
      read,
      subscribe,
      receive,
      commits: () => order.map((h) => log.get(h)!.commit),
      heads: () => [...heads],
      waiting: () => [...holding.keys()],
      status,
      body: (h: Hash) => log.get(h)?.body,
      hashOf: (time: number) => byTime.get(time),
    },
  ) as T & Shared;
  const below = api.top(wrapped);
  wrapped.top = told(below);
  return wrapped;
}
