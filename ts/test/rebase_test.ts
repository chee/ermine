// Rebasing concurrent writes (ts/src/sync/rebase.ts; plans/eg-walker.org):
// the merge alone, a small fuzz of its one law, and the opt-in in share.ts.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { applyPatches, equal } from "../src/patch.ts";
import { graph } from "../src/graph.ts";
import { schedule, type Scheduler } from "../src/schedule.ts";
import { builtin } from "../src/loaders.ts";
import type { Json, Patch } from "../src/types.ts";
import { CommitError } from "../src/sync/commit.ts";
import { type Event, history, merge, rebase } from "../src/sync/rebase.ts";
import { type MergedItem, share, type SideItem } from "../src/sync/share.ts";

/** A made-up name: the n-th, as 64 hex digits, so names sort as numbers. */
const name = (n: number) => n.toString(16).padStart(64, "0");

/** A log of events made by hand, each on the parents given. */
function book(start: Json) {
  const log = new Map<string, Event>();
  let n = 0;
  return {
    log,
    /** an event on parents, with its Lamport number worked out */
    ev(parents: string[], ...patches: Patch[]): string {
      const lamport = 1 + Math.max(0, ...parents.map((p) => log.get(p)!.lamport));
      const hash = name(++n);
      log.set(hash, { hash, lamport, parents: [...parents].sort(), patches });
      return hash;
    },
    value: (heads: string[]) => rebase(start, history((h) => log.get(h), heads)).value,
    merge: (heads: string[]) => merge(start, (h) => log.get(h), heads),
  };
}

const splice = (path: (string | number)[], from: number, to: number, value?: Json): Patch =>
  value === undefined
    ? { type: "splice", path, range: [from, to] }
    : { type: "splice", path, range: [from, to], value };
const set = (path: (string | number)[], key: string, value?: Json): Patch =>
  value === undefined ? { type: "set", path, key } : { type: "set", path, key, value };

Deno.test("concurrent splices of a string merge, in code points", () => {
  const b = book("hello");
  const a = b.ev([], splice([], 5, 5, " world"));
  const c = b.ev([], splice([], 0, 1, "J"));
  assertEquals(b.value([a, c]), "Jello world");
  assertEquals(b.merge([a, c]).dropped, []);
  // code points, not UTF-16 units
  const e = book("a😀b");
  const x = e.ev([], splice([], 2, 3, "c"));
  const y = e.ev([], splice([], 0, 1, "😺"));
  assertEquals(e.value([x, y]), "😺😀c");
});

Deno.test("concurrent inserts at one place do not interleave, and order the same either way", () => {
  const b = book("");
  const a = b.ev([], splice([], 0, 0, "abc"));
  const c = b.ev([], splice([], 0, 0, "xyz"));
  const v = b.value([a, c]) as string;
  assert(v === "abcxyz" || v === "xyzabc", v);
  // given in any order, the same
  const events = [...b.log.values()];
  assertEquals(rebase("", events.reverse()).value, v);
});

Deno.test("a character deleted on both sides is deleted once", () => {
  const b = book("abcdef");
  const a = b.ev([], splice([], 1, 4));
  const c = b.ev([], splice([], 2, 5, "X"));
  assertEquals(b.value([a, c]), "aXf");
});

Deno.test("a delete overlapping a concurrent insert takes what it saw and keeps the insert", () => {
  const b = book("abcdef");
  const del = b.ev([], splice([], 1, 5));
  const ins = b.ev([], splice([], 3, 3, "XY"));
  assertEquals(b.value([del, ins]), "aXYf");
  assertEquals(b.merge([del, ins]).dropped, []);
  // and an insert at either edge of the deleted range stays at that edge
  const at1 = b.ev([], splice([], 1, 1, "<"));
  const at5 = b.ev([], splice([], 5, 5, ">"));
  assertEquals(b.value([del, at1, at5]), "a<>f");
});

Deno.test("concurrent deletes and inserts on three devices merge the same in any order", () => {
  const b = book("0123456789");
  const a = b.ev([], splice([], 2, 4), splice([], 0, 0, "A"));
  const c = b.ev([], splice([], 3, 7, "C"));
  const d = b.ev([], splice([], 9, 10), splice([], 5, 5, "D"));
  const v = b.value([a, c, d]);
  // C goes just after 2, before the deleted 3..6, among which D was made
  assertEquals(v, "A01CD78");
  const events = [...b.log.values()];
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    assertEquals(rebase("0123456789", order.map((i) => events[i])).value, v);
  }
  // and merged in steps, two then the third, as a device would
  const ac = b.ev([a, c]);
  assertEquals(b.value([ac, d]), v);
});

Deno.test("lists, bytes and typed arrays merge as strings do", () => {
  const l = book([1, 2, 3]);
  const la = l.ev([], splice([], 3, 3, [4]));
  const lb = l.ev([], splice([], 0, 1));
  assertEquals(l.value([la, lb]), [2, 3, 4]);

  const by = book(new Uint8Array([1, 2, 3]).buffer);
  const ba = by.ev([], splice([], 0, 0, new Uint8Array([0]).buffer));
  const bb = by.ev([], splice([], 3, 3, new Uint8Array([9]).buffer));
  assert(equal(by.value([ba, bb]), new Uint8Array([0, 1, 2, 3, 9]).buffer));

  const t = book(new Float32Array([1.5, 2.5]));
  const ta = t.ev([], splice([], 1, 2, new Float32Array([7])));
  const tb = t.ev([], splice([], 2, 2, new Float32Array([8])));
  assert(equal(t.value([ta, tb]), new Float32Array([1.5, 7, 8])));
  const i = book(new BigInt64Array([1n]));
  const ia = i.ev([], splice([], 1, 1, new BigInt64Array([2n])));
  const ib = i.ev([], splice([], 0, 0, new BigInt64Array([0n])));
  assert(equal(i.value([ia, ib]), new BigInt64Array([0n, 1n, 2n])));
});

Deno.test("splices follow a list element moved by a concurrent splice", () => {
  const b = book({ l: ["one", "two"] });
  const a = b.ev([], splice(["l", 1], 3, 3, "!"));
  const c = b.ev([], splice(["l"], 0, 0, ["zero"]));
  assertEquals(b.value([a, c]), { l: ["zero", "one", "two!"] });
});

Deno.test("sets of different keys both stay; of one key, the first in the agreed order wins and the other is named", () => {
  const b = book({});
  const a = b.ev([], set([], "a", 1));
  const c = b.ev([], set([], "b", 2));
  assertEquals(b.value([a, c]), { a: 1, b: 2 });
  const x = b.ev([a, c], set([], "k", "x"));
  const y = b.ev([a, c], set([], "k", "y"));
  // equal Lamport numbers: the greater name wins, y's
  assertEquals(b.value([x, y]), { a: 1, b: 2, k: "y" });
  const m = b.merge([x, y]);
  assertEquals(m.dropped, [{ commit: x, patch: 0 }]);
  assertEquals(m.losing, [x]);
  // a higher Lamport number wins over a greater name
  const x2 = b.ev([x], set([], "k", "x2"));
  assertEquals(b.value([x2, y]), { a: 1, b: 2, k: "x2" });
  // a write made on another is no loss: it saw what it replaced
  const z = b.ev([x2, y], set([], "k", "z"));
  assertEquals(b.merge([z]).dropped, []);
});

Deno.test("a set under a key a concurrent change deleted is dropped, and named", () => {
  const b = book({ x: { y: 0 }, keep: true });
  const a = b.ev([], set(["x"], "y", 1));
  const c = b.ev([], set([], "x"));
  assertEquals(b.value([a, c]), { keep: true });
  const m = b.merge([a, c]);
  assertEquals(m.dropped, [{ commit: a, patch: 0 }]);
  assertEquals(m.losing, [a]);
  // under a key replaced concurrently, the same: the patch lands in what its maker saw
  const d = b.ev([], set([], "x", { fresh: 1 }));
  assertEquals(b.value([a, d]), { x: { fresh: 1 }, keep: true });
  assertEquals(b.merge([a, d]).dropped, [{ commit: a, patch: 0 }]);
});

Deno.test("a set inside a list element deleted concurrently is dropped", () => {
  const b = book([{ n: 1 }, { n: 2 }]);
  const a = b.ev([], set([1], "n", 3));
  const c = b.ev([], splice([], 1, 2));
  assertEquals(b.value([a, c]), [{ n: 1 }]);
  assertEquals(b.merge([a, c]).dropped, [{ commit: a, patch: 0 }]);
});

Deno.test("a concurrent snapshot wins over splices into what it replaced; the splices are named", () => {
  const b = book("draft");
  const a = b.ev([], splice([], 5, 5, " two"));
  const s = b.ev([], { type: "snapshot", value: "fresh" });
  assertEquals(b.value([a, s]), "fresh");
  const m = b.merge([a, s]);
  assertEquals(m.dropped, [{ commit: a, patch: 0 }]);
  assertEquals(m.losing, [a]);
  // two concurrent snapshots: the first in the agreed order wins
  const t = b.ev([], { type: "snapshot", value: "other" });
  assertEquals(b.value([s, t]), "other");
  assertEquals(b.merge([s, t]).dropped, [{ commit: s, patch: 0 }]);
});

Deno.test("a commit's patches apply in order, each on the one before", () => {
  const b = book({ t: "" });
  const a = b.ev([], set([], "u", ""), splice(["u"], 0, 0, "hi"), splice(["t"], 0, 0, "A"));
  const c = b.ev([], splice(["t"], 0, 0, "B"));
  const v = b.value([a, c]) as { t: string; u: string };
  assertEquals(v.u, "hi");
  assert(v.t === "AB" || v.t === "BA");
});

Deno.test("typing on two devices does not interleave: forward, backward, or between", () => {
  const forward = book("");
  let a = forward.ev([], splice([], 0, 0, "a"));
  a = forward.ev([a], splice([], 1, 1, "b"));
  a = forward.ev([a], splice([], 2, 2, "c"));
  let x = forward.ev([], splice([], 0, 0, "x"));
  x = forward.ev([x], splice([], 1, 1, "y"));
  x = forward.ev([x], splice([], 2, 2, "z"));
  assertEquals(forward.value([a, x]), "abcxyz");

  const backward = book("");
  let c = backward.ev([], splice([], 0, 0, "c"));
  c = backward.ev([c], splice([], 0, 0, "b"));
  c = backward.ev([c], splice([], 0, 0, "a"));
  let z = backward.ev([], splice([], 0, 0, "z"));
  z = backward.ev([z], splice([], 0, 0, "y"));
  z = backward.ev([z], splice([], 0, 0, "x"));
  assertEquals(backward.value([c, z]), "abcxyz");

  // between two characters, each device's commits alternating in the replay
  const between = book("--");
  const a1 = between.ev([], splice([], 1, 1, "a"));
  const x1 = between.ev([], splice([], 1, 1, "x"));
  const a2 = between.ev([a1], splice([], 2, 2, "b"));
  const x2 = between.ev([x1], splice([], 2, 2, "y"));
  assertEquals(between.value([a2, x2]), "-abxy-");
});

Deno.test("an insert next to a character deleted concurrently stays where it was put, in code points", () => {
  const b = book("😀😺🐱");
  const del = b.ev([], splice([], 1, 2));
  const after = b.ev([], splice([], 2, 2, "é"));
  const before = b.ev([], splice([], 1, 1, "ü"));
  assertEquals(b.value([del, after, before]), "😀üé🐱");
});

Deno.test("a write its heads saw and replaced is not dropped: only concurrent losses are", () => {
  const b = book({});
  const x = b.ev([], set([], "k", 1));
  const a = b.ev([x], set([], "j", 1));
  const c = b.ev([x], set([], "k", 2));
  assertEquals(b.value([a, c]), { j: 1, k: 2 });
  assertEquals(b.merge([a, c]), { value: { j: 1, k: 2 }, dropped: [], losing: [] });
  // with a third head that never saw x, still none: c replaced it, having seen it
  const d = b.ev([], set([], "z", 1));
  assertEquals(b.merge([a, c, d]).dropped, []);
  // but a head that never saw the write that beat it still loses (c's Lamport number is higher)
  const e = b.ev([], set([], "k", 3));
  assertEquals(b.merge([a, c, e]).dropped, [{ commit: e, patch: 0 }]);
  assertEquals(b.merge([a, c, e]).losing, [e]);
  // the same for a container taken out by a head that saw it
  const s = book({ m: {} });
  const y = s.ev([], set(["m"], "q", 1));
  const p = s.ev([y], set([], "other", 1));
  const q = s.ev([y], set([], "m"));
  assertEquals(s.merge([p, q]).dropped, []);
});

Deno.test("a parent not given is an error", () => {
  assertThrows(() =>
    rebase(null, [{ hash: name(2), lamport: 2, parents: [name(1)], patches: [] }])
  );
});

// The fuzz: random writes on random versions. Its one law, eg-walker's: a
// commit's value is its patches applied to the merge of its parents, which
// is how its maker made it. And the merge does not depend on order, and
// drops only what some head never saw.

/** A small seeded generator. */
function random(seed: number) {
  let s = seed >>> 0 || 1;
  return (n: number) => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) % n;
  };
}

/** The array shuffled in place, by r. */
function shuffle<T>(xs: T[], r: (n: number) => number): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = r(i + 1);
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

const WORDS = ["a", "bc", "😀", "", "xyz"];

/** A patch valid on v, of the shape {t: string, l: [string], m: {..}}, with now and then a replacement. */
function patchOn(v: Json, r: (n: number) => number): Patch {
  const doc = v as { t: string; l: string[]; m: { [k: string]: Json } };
  const word = () => WORDS[r(WORDS.length)];
  const range = (len: number): [number, number] => {
    const from = r(len + 1);
    return [from, from + r(Math.min(3, len - from) + 1)];
  };
  switch (r(9)) {
    case 0:
    case 1:
    case 2: {
      const [f, t] = range([...doc.t].length);
      return splice(["t"], f, t, word());
    }
    case 3:
    case 4: {
      const [f, t] = range(doc.l.length);
      return splice(["l"], f, t, r(2) ? [word()] : []);
    }
    case 5:
      if (doc.l.length) {
        const i = r(doc.l.length);
        const [f, t] = range([...doc.l[i]].length);
        return splice(["l", i], f, t, word());
      }
      return set(["m"], "k" + r(3), r(10));
    case 6:
      return set(["m"], "k" + r(3), r(3) ? r(10) : undefined);
    case 7:
      return r(4) ? set([], "t", word()) : set([], "m", {});
    default:
      return r(8) ? set(["m"], "k" + r(3), word()) : { type: "snapshot", value: start };
  }
}

const start: Json = { t: "", l: [], m: {} };

Deno.test("fuzz: each commit is its patches on the merge of its parents, and order does not matter", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const r = random(seed * 7919);
    const b = book(start);
    const all: string[] = [];
    for (let step = 0; step < 25; step++) {
      // a version: one or two known commits, as a device that had seen them
      const picks = all.length ? [all[r(all.length)], all[r(all.length)]] : [];
      const parents = [...new Set(picks)].filter((p) =>
        !picks.some((q) => q !== p && history((h) => b.log.get(h), [q]).some((e) => e.hash === p))
      );
      const before = b.value(parents);
      const patches = [patchOn(before, r)];
      if (r(3) === 0) patches.push(patchOn(applyPatches(before, patches), r));
      const made = applyPatches(before, patches);
      const h = b.ev(parents, ...patches);
      all.push(h);
      const got = b.value([h]);
      assert(
        equal(got, made),
        `seed ${seed} step ${step}: ${JSON.stringify(got)} ≠ ${JSON.stringify(made)}`,
      );
    }
    const heads = all.filter((h) => ![...b.log.values()].some((e) => e.parents.includes(h)));
    const one = rebase(start, [...b.log.values()]).value;
    for (let k = 0; k < 3; k++) {
      const shuffled = shuffle([...b.log.values()], r);
      assert(equal(one, rebase(start, shuffled).value), `seed ${seed}`);
    }
    assert(equal(one, b.value(heads)), `seed ${seed}`);
    // a dropped patch is one some head never saw
    for (const d of b.merge(heads).dropped) {
      assert(
        heads.some((h) => !history((x) => b.log.get(x), [h]).some((e) => e.hash === d.commit)),
        `seed ${seed}: ${d.commit} is in every head's history`,
      );
    }
  }
});

// The opt-in in share.ts: two devices, as in sync_test.ts, with merge "rebase".

const host = { agent: "host", cause: { file: "rebase_test.ts", line: 1, column: 1 } };

function device(merge: "rebase" | "sides" = "rebase") {
  const g = graph("root");
  const s = schedule(g, { host: builtin({}) }, { graph: g });
  s.place({ ...host, address: [], name: "doc", id: "doc", value: null });
  return share(s as Scheduler, { id: "doc", address: ["doc"], merge });
}
type Device = ReturnType<typeof device>;
const doc = (d: Device) => d.read({ agent: "host", address: ["doc"] }) as (SideItem & MergedItem)[];
const write = (d: Device, patches: Patch[]) => d.write({ agent: "me", address: ["doc"], patches });
function send(from: Device, to: Device) {
  const known = new Set(to.commits().map((c) => c.hash));
  for (const c of from.commits()) if (!known.has(c.hash)) to.receive(c);
}

Deno.test("share, rebased: concurrent splices read as one merged item on both, and a write over it settles", () => {
  const A = device(), B = device();
  write(A, [{ type: "snapshot", value: { text: "hello" } }]);
  send(A, B);
  write(A, [splice(["text"], 5, 5, " world")]);
  write(B, [splice(["text"], 0, 1, "J")]);
  send(A, B);
  send(B, A);
  for (const d of [A, B]) {
    const items = doc(d);
    assertEquals(items.length, 1);
    assertEquals(items[0].value, { text: "Jello world" });
    assertEquals(items[0].heads, d.heads());
    assertEquals(items[0].dropped, undefined);
  }
  // the blob says it is rebased, and names no base
  const [last] = A.commits().slice(-1);
  assertEquals(A.body(last.hash)?.merge, "rebase");
  write(A, [splice(["text"], 11, 11, "!")]);
  const [m] = A.commits().slice(-1);
  assertEquals(A.body(m.hash)?.parents.length, 2);
  assertEquals(A.body(m.hash)?.base, undefined);
  send(A, B);
  assertEquals(doc(B).map((i) => i.value), [{ text: "Jello world!" }]);
  assertEquals(doc(B)[0].commit, m.hash);
});

Deno.test("share, rebased: what the merge drops is named, and the losing head's own value follows", () => {
  const A = device(), B = device();
  write(A, [{ type: "snapshot", value: { k: 0 } }]);
  send(A, B);
  write(A, [set([], "k", 1)]);
  write(B, [set([], "k", 2)]);
  send(A, B);
  send(B, A);
  const items = doc(A);
  // the same on both, but for the changes that applied them here
  const shared = (d: Device) =>
    doc(d).map((i) => ({ value: i.value, heads: i.heads, dropped: i.dropped, commit: i.commit }));
  assertEquals(shared(A), shared(B));
  assertEquals(items.length, 2);
  const winner = items[0].value as { k: number };
  assertEquals(items[0].dropped?.length, 1);
  assertEquals(items[1].value, { k: 3 - winner.k });
  assertEquals(items[1].commit, items[0].dropped![0].commit);
});

Deno.test("share, rebased: a write both heads saw, replaced on one, is no loss", () => {
  const A = device(), B = device();
  write(A, [{ type: "snapshot", value: { k: 1 } }]);
  send(A, B);
  write(A, [set([], "j", 1)]);
  write(B, [set([], "k", 2)]);
  send(A, B);
  send(B, A);
  for (const d of [A, B]) {
    const items = doc(d);
    assertEquals(items.length, 1);
    assertEquals(items[0].value, { j: 1, k: 2 });
    assertEquals(items[0].dropped, undefined);
  }
});

Deno.test("share, rebased: a commit of the other kind is refused", () => {
  const A = device("sides"), B = device("rebase");
  write(A, [{ type: "snapshot", value: 1 }]);
  assertThrows(() => B.receive(A.commits()[0]), CommitError);
  write(B, [{ type: "snapshot", value: 2 }]);
  assertThrows(() => A.receive(B.commits()[0]), CommitError);
});

Deno.test("share, rebased: three devices, commits delivered shuffled and twice, read the same", () => {
  for (let seed = 1; seed <= 12; seed++) {
    const r = random(seed * 104729);
    const ds = [device(), device(), device()];
    write(ds[0], [{ type: "snapshot", value: { t: "", l: [], m: {} } }]);
    send(ds[0], ds[1]);
    send(ds[0], ds[2]);
    for (let step = 0; step < 20; step++) {
      const d = ds[r(3)];
      const [item] = doc(d);
      // a write on what this device reads: the merge
      write(d, [patchOn(item.value, r)]);
      // now and then some commits go somewhere, shuffled, some twice
      if (r(3) === 0) {
        const from = ds[r(3)], to = ds[r(3)];
        if (from !== to) {
          const cs = from.commits();
          for (const c of shuffle([...cs, ...cs.slice(0, r(cs.length + 1))], r)) to.receive(c);
        }
      }
    }
    for (const to of ds) {
      for (const from of ds) {
        if (from === to) continue;
        for (const c of shuffle([...from.commits()], r)) to.receive(c);
      }
    }
    const view = (d: Device) =>
      doc(d).map((i) => ({ value: i.value, heads: i.heads, dropped: i.dropped, commit: i.commit }));
    // what each holds is the merge of every commit, replayed from the bodies
    const events = ds[0].commits().map((c): Event => {
      const body = ds[0].body(c.hash)!;
      return { hash: c.hash, lamport: body.lamport, parents: body.parents, patches: body.patches };
    });
    const merged = rebase(null, events).value;
    for (const d of ds) {
      assert(equal(doc(d)[0].value, merged), `seed ${seed}`);
      assertEquals(d.waiting(), [], `seed ${seed}`);
      assertEquals(d.heads(), ds[0].heads(), `seed ${seed}`);
      assertEquals(view(d), view(ds[0]), `seed ${seed}`);
    }
  }
});
