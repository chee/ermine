// A link between two hosts in one process, over the in-memory channel: one
// owns and serves a subtree, the other mounts it and sends it operations.

import { assert, assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { graph } from "../src/graph.ts";
import { type Interface, Invalid, type Json } from "../src/types.ts";
import { stacks } from "../harness/main.ts";
import { hub, type Timing } from "../src/link/wire.ts";
import { serve } from "../src/link/serve.ts";
import { Gone, mount, type Remote } from "../src/link/mount.ts";
import type { Event } from "../src/types.ts";

const site = { file: "link_test.ts", line: 1, column: 1 };
const owner = { agent: "owner", cause: site };

/** An owner's stack, the reference scheduler's, with a/shared/{x, y} and a/secret. */
function owned(): Interface {
  const api = stacks.schedule!(graph("root"), { root: "root" });
  api.place({ ...owner, address: [], name: "a", id: "a", value: null });
  api.place({ ...owner, address: ["a"], name: "secret", id: "secret", value: "hidden" });
  api.place({ ...owner, address: ["a"], name: "shared", id: "shared", value: { title: "hi" } });
  api.place({ ...owner, address: ["a", "shared"], name: "x", id: "x", value: 1 });
  return api;
}

type Linked = {
  api: Interface;
  remote: Remote;
  /** the mounter's id on the channel, as the owner hears it */
  peer: string;
  stop: () => Promise<void>;
  cut: (who: "owner") => void;
};

async function linked(
  options: { shuffle?: boolean; max?: number; timing?: Timing; api?: Interface } = {},
): Promise<Linked> {
  const h = hub(options);
  const api = options.api ?? owned();
  const ownerT = h.peer();
  const served = serve(api, ["a", "shared"], ownerT, options.timing);
  const mounter = h.peer();
  const remote = await mount(mounter, options.timing);
  return {
    api,
    remote,
    peer: mounter.self,
    cut: () => h.cut(ownerT.self),
    stop: async () => {
      await remote.close().catch(() => {});
      await served.close();
      await new Promise((r) => setTimeout(r, 10));
      h.stop();
    },
  };
}

const me = { agent: "mounter" };

Deno.test("a mounter reads the served place as its root", async () => {
  const { remote, stop } = await linked();
  try {
    const items = await remote.read({ ...me, address: [] });
    assertEquals(items.map((i) => i.value), [{ title: "hi" }]);
    const x = await remote.read({ ...me, address: ["x"] });
    assertEquals(x[0].value, 1);
    // the route is what this mount walked, from the served place
    assertEquals(x[0].from, { route: [{ parent: "shared", name: "x", node: "x", position: 0 }] });
    const dir = await remote.directory({ ...me, address: [] });
    assertEquals("directory" in dir && dir.directory.map(([name]) => name), ["x"]);
  } finally {
    await stop();
  }
});

Deno.test("a mounter's write is stamped by the owner's clock, with the mounter's site", async () => {
  const { api, remote, peer, stop } = await linked();
  try {
    const changed = await remote.write({
      ...me,
      address: ["x"],
      time: 999,
      patches: [{ type: "snapshot", value: 2 }],
    });
    // four placements before it, by the owner's scheduler
    assertEquals(changed.change.time, 5);
    // the owner says who: the agent the mounter claimed, and its verified key
    assertEquals(changed.change.agent, { actor: "mounter", peer });
    const cause = changed.change.cause as { file: string };
    assert(cause.file.endsWith("link_test.ts"), `the site is here: ${JSON.stringify(cause)}`);
    assertEquals(api.read({ agent: "owner", address: ["a", "shared", "x"] })[0].value, 2);
  } finally {
    await stop();
  }
});

Deno.test("a mounter cannot say its own peer: a claimed one stays inside actor", async () => {
  const { api, remote, peer, stop } = await linked();
  try {
    const claimed = { actor: "mallory", peer: "peer-999" };
    const changed = await remote.write({
      agent: claimed,
      address: ["x"],
      patches: [{ type: "snapshot", value: 3 }],
    });
    assertEquals(changed.change.agent, { actor: claimed, peer });
    assert(peer !== "peer-999");
    const [x] = api.read({ agent: "owner", address: ["a", "shared", "x"] });
    assertEquals(x.change?.agent, { actor: claimed, peer });
    // a placement too, and a read is answered as the stamped agent (no error)
    const placed = await remote.place({
      agent: "m",
      address: [],
      name: "z",
      id: "z",
      value: 0,
    });
    assertEquals(placed.change.agent, { actor: "m", peer });
  } finally {
    await stop();
  }
});

Deno.test("a mounter's subscription sees the owner's change", async () => {
  const { api, remote, stop } = await linked();
  try {
    const events: Event[] = [];
    let ended = "";
    const { sub } = await remote.subscribe({
      ...me,
      address: ["x"],
      send: (e) => events.push(e),
      ended: (why) => (ended = why),
    });
    assertEquals(sub, 1);
    api.write({
      ...owner,
      address: ["a", "shared", "x"],
      patches: [{ type: "snapshot", value: 7 }],
    });
    for (let i = 0; i < 50 && !events.length; i++) await new Promise((r) => setTimeout(r, 2));
    assertEquals(events.length, 1);
    const e = events[0] as { change: { node: string; kind: string; agent: Json } };
    assertEquals([e.change.node, e.change.kind, e.change.agent], ["x", "write", "owner"]);
    await remote.unsubscribe({ ...me, sub });
    assertEquals(ended, "unsubscribed");
    api.write({
      ...owner,
      address: ["a", "shared", "x"],
      patches: [{ type: "snapshot", value: 8 }],
    });
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(events.length, 1);
  } finally {
    await stop();
  }
});

Deno.test("a mounter places a node, with values in their forms", async () => {
  const { api, remote, stop } = await linked();
  try {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const value = { b: bytes, f: new Float32Array([1.5, NaN]), z: -0, inf: -Infinity };
    const placed = await remote.place({ ...me, address: [], name: "y", id: "y", value });
    assertEquals(placed.change.kind, "place");
    assertEquals(placed.change.node, "shared");
    const there = api.read({ agent: "owner", address: ["a", "shared", "y"] })[0].value as {
      b: ArrayBuffer;
      f: Float32Array;
      z: number;
    };
    assertEquals(new Uint8Array(there.b), new Uint8Array([1, 2, 3]));
    assertInstanceOf(there.f, Float32Array);
    assert(Object.is(there.z, -0));
    const back = (await remote.read({ ...me, address: ["y"] }))[0].value as typeof value;
    assertEquals(new Uint8Array(back.b), new Uint8Array([1, 2, 3]));
    assert(Number.isNaN(back.f[1]) && Object.is(back.z, -0) && back.inf === -Infinity);
  } finally {
    await stop();
  }
});

Deno.test("an error is answered as the error the owner's stack threw", async () => {
  const { remote, stop } = await linked();
  try {
    const e = await assertRejects(
      () => remote.write({ ...me, address: ["nope"], patches: [{ type: "snapshot", value: 1 }] }),
      Invalid,
    );
    assertEquals((e as Invalid).why.code, "nothing-there");
    assertEquals((e as Invalid).op, "write");
    // a raw line that is not JSON is answered not-a-request, its seq read if it can be
    assertEquals(
      JSON.parse(await remote.line('{"seq": 4, "cmd": ')),
      {
        seq: 4,
        error: {
          kind: "invalid",
          why: { code: "not-a-request", text: "SyntaxError: Unexpected end of JSON input" },
        },
      },
    );
    assertEquals(
      JSON.parse(await remote.line('{"seq":5,"cmd":"reset","stack":"graph","root":"r"}')),
      {
        seq: 5,
        unsupported: "reset",
      },
    );
  } finally {
    await stop();
  }
});

Deno.test("a mounter cannot reach above the served place", async () => {
  const { remote, stop } = await linked();
  try {
    for (const address of [[".."], ["/", ".."], ["..", ".."]]) {
      const e = await assertRejects(() => remote.read({ ...me, address }), Invalid);
      assertEquals((e as Invalid).why.code, "above-root", JSON.stringify(address));
    }
    // a place of its own, chrooted, is still below the served place
    const e = await assertRejects(
      () => remote.read({ ...me, place: ["x"], chroot: 1, address: [".."] }),
      Invalid,
    );
    assertEquals((e as Invalid).why.code, "above-root");
    assertEquals((await remote.read({ ...me, place: ["x"], address: [".."] }))[0].value, {
      title: "hi",
    });
    // the secret beside the served place is not found by name
    assertEquals(await remote.lookup({ ...me, name: "secret" }), []);
    assertEquals(await remote.read({ ...me, address: ["secret"] }), []);
    // a place that is not a list is wrong, not the root
    const bad = await assertRejects(
      () => remote.read({ ...me, place: "a" as unknown as string[], address: [] }),
      Invalid,
    );
    assertEquals((bad as Invalid).why, {
      code: "wrong-field",
      field: "place",
      text: "a place is a list of names",
    });
    // a mounter acts as no process of the owner's
    const proc = await assertRejects(
      () => remote.read({ ...me, process: "@6-jabab", address: [] }),
      Invalid,
    );
    assertEquals((proc as Invalid).why.field, "process");
  } finally {
    await stop();
  }
});

Deno.test("a bare graph is served with the owner's clock", async () => {
  const g = graph("root");
  let last = 0;
  g.place({ ...owner, time: ++last, address: [], name: "s", id: "s", value: 0 });
  const h = hub();
  const served = serve(g, ["s"], h.peer(), { time: () => ++last });
  const remote = await mount(h.peer());
  try {
    const changed = await remote.write({
      ...me,
      address: [],
      patches: [{ type: "snapshot", value: 1 }],
    });
    assertEquals(changed.change.time, 2);
  } finally {
    await remote.close();
    await served.close();
    h.stop();
  }
});

Deno.test("frames that come out of order, and a value too big for one, arrive whole and in order", async () => {
  const { api, remote, stop } = await linked({ shuffle: true, max: 300 });
  try {
    const big = "ermine ".repeat(400) + 'é漢😀 "\\';
    const writes = [];
    for (let i = 0; i < 10; i++) {
      writes.push(
        remote.write({
          ...me,
          address: ["x"],
          patches: [{ type: "snapshot", value: `${i}${big}` }],
        }),
      );
    }
    const done = await Promise.all(writes);
    assertEquals(done.map((c) => c.change.time), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    assertEquals(api.read({ agent: "owner", address: ["a", "shared", "x"] })[0].value, `9${big}`);
    assertEquals((await remote.read({ ...me, address: ["x"] }))[0].value, `9${big}`);
  } finally {
    await stop();
  }
});

Deno.test("when the owner leaves, what is pending fails and subscriptions end", async () => {
  const h = hub();
  const api = owned();
  const served = serve(api, ["a", "shared"], h.peer());
  const remote = await mount(h.peer());
  let ended = "";
  await remote.subscribe({ ...me, address: ["x"], send: () => {}, ended: (why) => (ended = why) });
  assertEquals((await remote.read({ ...me, address: [] }))[0].value, { title: "hi" });
  // sent, but the owner leaves before it is answered
  const pending = assertRejects(() => remote.read({ ...me, address: [] }), Gone, "bye now");
  await served.close("bye now");
  await pending;
  assertEquals(await remote.closed, "the peer left: bye now");
  assertEquals(ended, "the peer left: bye now");
  await assertRejects(() => remote.read({ ...me, address: [] }), Gone);
  await remote.close();
  h.stop();
});

Deno.test("when the owner goes quiet, what is pending fails", async () => {
  const timing = { beat: 20, quiet: 80 };
  const { remote, cut, stop } = await linked({ timing });
  try {
    cut("owner");
    await assertRejects(() => remote.read({ ...me, address: [] }), Gone, "quiet");
  } finally {
    await stop();
  }
});

Deno.test("mounting finds no owner on an empty channel", async () => {
  const h = hub();
  await assertRejects(() => mount(h.peer(), { dial: 50 }), Error, "no owner answered");
  h.stop();
});

Deno.test("the stdio bridge speaks PROTOCOL lines, collecting pushed events", async () => {
  const { bridge } = await import("../src/link/bridge.ts");
  const h = hub({ shuffle: true });
  const api = owned();
  const served = serve(api, ["a", "shared"], h.peer());
  const remote = await mount(h.peer());
  const lines = bridge(remote);
  const ask = async (r: object | string) =>
    JSON.parse(await lines.line(typeof r === "string" ? r : JSON.stringify(r)));
  try {
    assertEquals(await ask({ seq: 1, cmd: "subscribe", agent: "c", address: ["x"] }), {
      seq: 1,
      ok: { sub: 1 },
    });
    // JSON.stringify would drop the sign of -0, so the line is written out
    const w = await ask(
      '{"seq":2,"cmd":"write","agent":"c","cause":{"file":"term.c","line":9,"column":1},' +
        '"address":["x"],"patches":[{"type":"snapshot","value":-0}]}',
    );
    assertEquals(w.ok.change.time, 5);
    // the event came before the answer, so it is here now
    const raw = await lines.line('{"seq":3,"cmd":"events","sub":1}');
    assert(raw.includes('"patches":[{"type":"snapshot","value":-0}]'), raw);
    assertEquals(JSON.parse(raw).ok.length, 1);
    assertEquals(await ask({ seq: 4, cmd: "unsubscribe", agent: "c", sub: 1 }), {
      seq: 4,
      ok: null,
    });
    assertEquals(await ask({ seq: 5, cmd: "events", sub: 1 }), { seq: 5, ok: [] });
    assertEquals((await ask({ seq: 6, cmd: "events", sub: 1 })).error.why.code, "wrong-field");
    assertEquals(
      (await ask({ seq: 7, cmd: "read", agent: "c", address: [".."] })).error.why.code,
      "above-root",
    );
    await served.close();
    await remote.closed;
    assertEquals(
      (await ask({ seq: 8, cmd: "read", agent: "c", address: [] })).error.why.code,
      "gone",
    );
  } finally {
    await remote.close();
    h.stop();
  }
});

Deno.test("relay stamps a mounter's agent in the line it gives the host, with its cause as sent", async () => {
  const { Lines } = await import("../src/link/lines.ts");
  const { relay } = await import("../src/link/relay.ts");
  const h = hub();
  const seen: { [key: string]: unknown }[] = [];
  const host: InstanceType<typeof Lines> = new Lines((line) => {
    const r = JSON.parse(line);
    seen.push(r);
    // the host answers every operation with ok, as a host that changed something would
    queueMicrotask(() => host.take(JSON.stringify({ seq: r.seq, ok: null })));
  });
  const relayed = relay(host, h.peer());
  const mounter = h.peer();
  const remote = await mount(mounter);
  try {
    const cause = { file: "b.ts", line: 3, column: 1 };
    await remote.write({
      agent: { actor: "m", peer: "not me" },
      cause,
      address: ["keys"],
      patches: [{ type: "snapshot", value: "up" }],
    });
    assertEquals(seen.length, 1);
    assertEquals(seen[0].agent, { actor: { actor: "m", peer: "not me" }, peer: mounter.self });
    assertEquals(seen[0].cause, cause);
    assertEquals(seen[0].place, []);
  } finally {
    await remote.close();
    await relayed.close();
    h.stop();
  }
});

Deno.test("relay serves less than its place: options.place goes in front, chrooted there", async () => {
  const { Lines } = await import("../src/link/lines.ts");
  const { relay } = await import("../src/link/relay.ts");
  const h = hub();
  const seen: { [key: string]: unknown }[] = [];
  const host: InstanceType<typeof Lines> = new Lines((line) => {
    const r = JSON.parse(line);
    seen.push(r);
    queueMicrotask(() => host.take(JSON.stringify({ seq: r.seq, ok: { items: [] } })));
  });
  const relayed = relay(host, h.peer(), { place: ["@9-wixib"] });
  const remote = await mount(h.peer());
  try {
    await remote.read({ agent: "m", address: ["screen"] });
    await remote.read({ agent: "m", place: ["screen"], chroot: 1, address: [] } as never);
    assertEquals(seen.map((r) => [r.place, r.chroot]), [[["@9-wixib"], 1], [
      ["@9-wixib", "screen"],
      2,
    ]]);
    // a place that is not names, or a chroot past it, never reaches the host (it would act at the program's own place)
    await assertRejects(() => remote.read({ agent: "m", place: "x", address: [] } as never));
    await assertRejects(() =>
      remote.read({ agent: "m", place: [], chroot: 1, address: [] } as never)
    );
    assertEquals(seen.length, 2);
  } finally {
    await remote.close();
    await relayed.close();
    h.stop();
  }
});

Deno.test("a mirror of one shared window keeps it as one window, named as asked, where asked", async () => {
  const { Lines } = await import("../src/link/lines.ts");
  const { mirror } = await import("../src/link/windows.ts");
  // the owner: a terminal's window w1 with its screen, keys and size, served alone
  const api = stacks.schedule!(graph("root"), { root: "root" });
  api.place({ ...owner, address: [], name: "windows", id: "windows", value: null });
  api.place({ ...owner, address: ["windows"], name: "w1", id: "w1", value: null });
  const screen = { rows: 1, cols: 5, lines: ["hi"] };
  api.place({
    ...owner,
    address: ["windows", "w1"],
    name: "screen",
    id: "w1/screen",
    value: screen,
  });
  api.place({ ...owner, address: ["windows", "w1"], name: "keys", id: "w1/keys", value: "" });
  api.place({ ...owner, address: ["windows", "w1"], name: "size", id: "w1/size", value: null });
  const h = hub();
  const served = serve(api, ["windows", "w1"], h.peer());
  const remote = await mount(h.peer());
  // this host: answers every request, a subscribe with its number
  const seen: { [key: string]: unknown }[] = [];
  let subs = 0;
  const host: InstanceType<typeof Lines> = new Lines((line) => {
    const r = JSON.parse(line);
    seen.push(r);
    const ok = r.cmd === "subscribe" ? { sub: ++subs } : null;
    queueMicrotask(() => host.take(JSON.stringify({ seq: r.seq, ok })));
  });
  const kept = await mirror(host, remote, {
    agent: "m",
    id: "@1-m",
    place: ["here"],
    as: "kitchen",
    every: 60000,
  });
  try {
    for (let i = 0; i < 50 && kept.windows().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assertEquals(kept.windows(), ["kitchen"]);
    const places = seen.filter((r) => r.cmd === "place").map((r) => [r.address, r.name, r.id]);
    assertEquals(places, [
      [["here"], "kitchen", "@1-m/kitchen"],
      [["here", "kitchen"], "screen", "@1-m/kitchen/screen"],
      [["here", "kitchen"], "keys", "@1-m/kitchen/keys"],
      [["here", "kitchen"], "size", "@1-m/kitchen/size"],
    ]);
    assertEquals(seen.find((r) => r.name === "screen")?.value, screen);
    // a key typed into the kept window reaches the shared window's keys
    const keys = seen.find((r) =>
      r.cmd === "subscribe" && (r.address as string[]).at(-1) === "keys"
    );
    assertEquals(keys?.address, ["here", "kitchen", "keys"]);
    host.take(
      `{"sub":${subs},"event":{"change":{"patches":[{"type":"snapshot","value":"+"}],"cause":{"file":"x","line":1}}}}`,
    );
    for (let i = 0; i < 50; i++) {
      if (api.read({ ...owner, address: ["windows", "w1", "keys"] })[0]?.value === "+") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assertEquals(api.read({ ...owner, address: ["windows", "w1", "keys"] })[0]?.value, "+");
  } finally {
    await kept.stop();
    await remote.close();
    await served.close();
    await new Promise((r) => setTimeout(r, 10));
    h.stop();
  }
});

Deno.test("a paced transport sends a burst in order, at most its burst at once and then its rate, then nudges", async () => {
  const { paced, NUDGE } = await import("../src/link/wire.ts");
  const h = hub({ max: 1 << 20 });
  const sender = paced(h.peer(), { burst: 65536, rate: 1_000_000, nudge: 20 });
  const receiver = h.peer();
  const got: { at: number; bytes: Uint8Array }[] = [];
  receiver.receive((payload) => got.push({ at: Date.now(), bytes: payload }));
  try {
    const began = Date.now();
    const sends = Array.from({ length: 8 }, (_, i) => sender.send(new Uint8Array(30000).fill(i)));
    // two fit the burst; the rest wait
    assertEquals(sender.backlog!().payloads, 6);
    await Promise.all(sends);
    const took = Date.now() - began;
    // 240000 bytes, 65536 at once, then 1 MB a second: about 175 ms
    assert(took >= 150 && took < 1000, `took ${took} ms`);
    assertEquals(sender.backlog!().bytes, 0);
    await new Promise((r) => setTimeout(r, 60));
    const data = got.filter((g) => g.bytes.length === 30000);
    assertEquals(data.map((g) => g.bytes[0]), [0, 1, 2, 3, 4, 5, 6, 7]);
    // after the burst, a nudge: a payload no peer takes as a frame
    const nudges = got.filter((g) => g.bytes.length === NUDGE.length);
    assert(nudges.length >= 1, "a nudge after the burst");
    assert(nudges[0].at >= data[7].at + 15, "the nudge comes after the last send");
  } finally {
    await sender.close();
    h.stop();
  }
});

Deno.test("relay sends a busy screen's latest at its rate, keeping every other event in order", async () => {
  const { Lines } = await import("../src/link/lines.ts");
  const { relay } = await import("../src/link/relay.ts");
  const h = hub();
  const host: InstanceType<typeof Lines> = new Lines((line) => {
    const r = JSON.parse(line);
    queueMicrotask(() =>
      host.take(JSON.stringify({ seq: r.seq, ok: r.cmd === "subscribe" ? { sub: 1 } : null }))
    );
  });
  const relayed = relay(host, h.peer(), { rate: 10 });
  const remote = await mount(h.peer());
  const got: Event[] = [];
  try {
    await remote.subscribe({ agent: "m", address: ["screen"], send: (e) => got.push(e) });
    const push = (time: number, patches: unknown[]) =>
      host.take(
        `{"sub":1,"event":${
          JSON.stringify({ change: { node: "s", time, kind: "write", agent: "a", patches } })
        }}`,
      );
    const screen = (n: number) => [{ type: "snapshot", value: { lines: [`${n}`] } }];
    // 50 screens, a write of one key, 49 screens: all at once
    for (let i = 0; i < 50; i++) push(i + 1, screen(i));
    push(51, [{ type: "set", path: [], key: "title", value: "t" }]);
    for (let i = 51; i < 100; i++) push(i + 1, screen(i));
    for (let i = 0; i < 100 && got.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    // the screen before the other write, that write, and the latest screen
    assertEquals(got.map((e) => "change" in e ? e.change.time : 0), [50, 51, 100]);
    assertEquals(relayed.behind()[0].coalesced, 97);
    // another screen soon after waits for the rate: one tenth of a second
    const began = Date.now();
    push(101, screen(100));
    for (let i = 0; i < 100 && got.length < 4; i++) await new Promise((r) => setTimeout(r, 5));
    assert(Date.now() - began >= 50, `${Date.now() - began} ms`);
    assertEquals(got.length, 4);
  } finally {
    await remote.close();
    await relayed.close();
    h.stop();
  }
});

Deno.test("a mirror writes a busy remote screen here at its rate, ending at the latest", async () => {
  const { Lines } = await import("../src/link/lines.ts");
  const { mirror } = await import("../src/link/windows.ts");
  const api = stacks.schedule!(graph("root"), { root: "root" });
  api.place({ ...owner, address: [], name: "windows", id: "windows", value: null });
  api.place({ ...owner, address: ["windows"], name: "w1", id: "w1", value: null });
  for (const [name, value] of [["screen", { lines: ["0"] }], ["keys", ""], ["size", null]]) {
    api.place({
      ...owner,
      address: ["windows", "w1"],
      name: name as string,
      id: `w1/${name}`,
      value: value as Json,
    });
  }
  const h = hub();
  const served = serve(api, ["windows"], h.peer());
  const remote = await mount(h.peer());
  const seen: { [key: string]: unknown }[] = [];
  let subs = 0;
  const host: InstanceType<typeof Lines> = new Lines((line) => {
    const r = JSON.parse(line);
    seen.push(r);
    const ok = r.cmd === "subscribe" ? { sub: ++subs } : null;
    queueMicrotask(() => host.take(JSON.stringify({ seq: r.seq, ok })));
  });
  const kept = await mirror(host, remote, { agent: "m", id: "@1-m", every: 60000, rate: 10 });
  const writes = () =>
    seen.filter((r) => r.cmd === "write" && (r.address as string[]).at(-1) === "screen");
  try {
    for (let i = 0; i < 50 && kept.windows().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assertEquals(kept.windows(), ["w1"]);
    for (let i = 1; i <= 100; i++) {
      api.write({
        ...owner,
        address: ["windows", "w1", "screen"],
        patches: [{ type: "snapshot", value: { lines: [`${i}`] } }],
      });
    }
    const last = () => (writes().at(-1)?.patches as { value: Json }[] | undefined)?.at(-1)?.value;
    for (let i = 0; i < 100; i++) {
      if (JSON.stringify(last()) === JSON.stringify({ lines: ["100"] })) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assertEquals(last(), { lines: ["100"] });
    assert(writes().length <= 5, `${writes().length} writes for 100 screens`);
    // each write is one snapshot: what came before it was needless
    assert(writes().every((w) => (w.patches as unknown[]).length === 1));
  } finally {
    await kept.stop();
    await remote.close();
    await served.close();
    await new Promise((r) => setTimeout(r, 10));
    h.stop();
  }
});

/** A transport whose handler the test calls itself, sending nowhere: for one side of a wire alone. */
function alone(self = "me") {
  const sent: { to?: string; n?: number; m?: { [key: string]: unknown } }[] = [];
  let handler: (payload: Uint8Array, from: string) => void = () => {};
  const transport = {
    self,
    max: 65536,
    send: (payload: Uint8Array) => void sent.push(JSON.parse(new TextDecoder().decode(payload))),
    receive: (h: typeof handler) => void (handler = h),
    close: () => {},
  };
  const hear = (frame: object, from: string) =>
    handler(new TextEncoder().encode(JSON.stringify(frame)), from);
  return { transport, sent, hear };
}

/** A host that answers each line as answers says, in order, and pushes what the test asks. */
async function recording(answers: (r: { [key: string]: unknown }) => unknown = () => null) {
  const { Lines } = await import("../src/link/lines.ts");
  const seen: { [key: string]: unknown }[] = [];
  const host: InstanceType<typeof Lines> = new Lines((line) => {
    assert(!line.includes("\n"), `one line: ${line}`);
    const r = JSON.parse(line);
    seen.push(r);
    queueMicrotask(() => host.take(JSON.stringify({ seq: r.seq, ok: answers(r) })));
  });
  return { host, seen };
}

Deno.test("relay answers a line that is not a request it serves itself: a newline in it never reaches the host", async () => {
  const { relay } = await import("../src/link/relay.ts");
  const { host, seen } = await recording(() => ({ items: [] }));
  const h = hub();
  const relayed = relay(host, h.peer());
  const remote = await mount(h.peer());
  try {
    const place = '{"seq":9,"cmd":"place","address":[],"name":"z","id":"z","value":1}';
    // two requests in one line: not JSON, so neither goes
    const two = JSON.parse(await remote.line(`{"seq":1,"cmd":"read","address":[]}\n${place}`));
    assertEquals([two.seq, two.error.why.code], [1, "not-a-request"]);
    // JSON with a newline in it, of a command it does not serve
    const unknown = JSON.parse(await remote.line('{"seq":2,\n"cmd":"bogus"}'));
    assertEquals([unknown.seq, unknown.error.why.code], [2, "unknown-command"]);
    const none = JSON.parse(await remote.line('{"seq":3}'));
    assertEquals([none.seq, none.error.why.code], [3, "missing"]);
    const odd = JSON.parse(await remote.line("[1]"));
    assertEquals(odd.error.why.code, "not-a-request");
    assertEquals(seen.length, 0);
    // and the host's answers still go to the request they answer
    const read = JSON.parse(await remote.line('{"seq":4,"cmd":"read","agent":"m","address":[]}'));
    assertEquals(read, { seq: 4, ok: { items: [] } });
    assertEquals(seen.length, 1);
  } finally {
    await remote.close();
    await relayed.close();
    h.stop();
  }
});

/** An owner that pushes a subscription's event before it answers the subscribe. */
async function hasty() {
  const { Wire } = await import("../src/link/wire.ts");
  const h = hub();
  const wire = new Wire(h.peer());
  wire.onconn = (conn) => {
    conn.onmessage = ({ id, text }) => {
      const r = JSON.parse(text);
      if (r.cmd === "subscribe") {
        conn.send({ text: JSON.stringify({ sub: 1, event: { change: { time: 7 } } }) });
      }
      conn.send({
        id,
        text: JSON.stringify({ seq: r.seq, ok: r.cmd === "subscribe" ? { sub: 1 } : null }),
      });
    };
  };
  return { h, wire };
}

Deno.test("a mounter's subscription keeps an event that came before its answer", async () => {
  const { h, wire } = await hasty();
  const remote = await mount(h.peer());
  try {
    const got: Event[] = [];
    await remote.subscribe({ ...me, address: [], send: (e) => got.push(e) });
    assertEquals(got, [{ change: { time: 7 } }] as unknown as Event[]);
  } finally {
    await remote.close();
    await wire.close();
    h.stop();
  }
});

Deno.test("the stdio bridge keeps an event that came before its subscribe's answer", async () => {
  const { bridge } = await import("../src/link/bridge.ts");
  const { h, wire } = await hasty();
  const remote = await mount(h.peer());
  try {
    const lines = bridge(remote);
    await lines.line('{"seq":1,"cmd":"subscribe","agent":"c","address":[]}');
    const events = JSON.parse(await lines.line('{"seq":2,"cmd":"events","sub":1}'));
    assertEquals(events, { seq: 2, ok: [{ change: { time: 7 } }] });
  } finally {
    await remote.close();
    await wire.close();
    h.stop();
  }
});

Deno.test("a mounter whose first hello from the owner was lost takes the next", async () => {
  const h = hub();
  const inner = h.peer();
  let dropped = 0;
  // the owner's transport loses its first hello
  const ownerT = {
    ...inner,
    send(payload: Uint8Array) {
      if (!dropped && new TextDecoder().decode(payload).includes('"hello":"serve"')) {
        dropped++;
        return;
      }
      return inner.send(payload);
    },
  };
  const served = serve(owned(), ["a", "shared"], ownerT);
  const remote = await mount(h.peer());
  try {
    assertEquals(dropped, 1);
    assertEquals((await remote.read({ ...me, address: ["x"] }))[0].value, 1);
  } finally {
    await remote.close();
    await served.close();
    h.stop();
  }
});

Deno.test("relay unsubscribes at the host a subscription its mounter left before it was answered", async () => {
  const { Lines } = await import("../src/link/lines.ts");
  const { relay } = await import("../src/link/relay.ts");
  const seen: { [key: string]: unknown }[] = [];
  let release = () => {};
  const host: InstanceType<typeof Lines> = new Lines((line) => {
    const r = JSON.parse(line);
    seen.push(r);
    const answer = () =>
      host.take(JSON.stringify({ seq: r.seq, ok: r.cmd === "subscribe" ? { sub: 41 } : null }));
    if (r.cmd === "subscribe") release = answer;
    else queueMicrotask(answer);
  });
  const h = hub();
  const relayed = relay(host, h.peer());
  const remote = await mount(h.peer());
  try {
    const subscribing = remote.subscribe({ ...me, address: [], send: () => {} }).catch(() => {});
    for (let i = 0; i < 50 && !seen.length; i++) await new Promise((r) => setTimeout(r, 2));
    await remote.close();
    for (let i = 0; i < 50 && relayed.peers().length; i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
    assertEquals(relayed.peers(), []);
    release();
    await subscribing;
    for (let i = 0; i < 50 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 2));
    assertEquals(seen.map((r) => [r.cmd, r.sub]), [["subscribe", undefined], ["unsubscribe", 41]]);
  } finally {
    await relayed.close();
    h.stop();
  }
});

/** A terminal's /windows with window w1, served, and mounted. */
async function windowed() {
  const api = stacks.schedule!(graph("root"), { root: "root" });
  api.place({ ...owner, address: [], name: "windows", id: "windows", value: null });
  const window = (name: string) => {
    api.place({ ...owner, address: ["windows"], name, id: name, value: null });
    for (const [node, value] of [["screen", { lines: ["0"] }], ["keys", ""], ["size", null]]) {
      api.place({
        ...owner,
        address: ["windows", name],
        name: node as string,
        id: `${name}/${node}`,
        value: value as Json,
      });
    }
  };
  const h = hub();
  const served = serve(api, ["windows"], h.peer());
  const remote = await mount(h.peer());
  return {
    api,
    window,
    remote,
    stop: async () => {
      await remote.close();
      await served.close();
      await new Promise((r) => setTimeout(r, 10));
      h.stop();
    },
  };
}

Deno.test("a mirror that could not keep a window undoes what it made and tries again", async () => {
  const { Lines } = await import("../src/link/lines.ts");
  const { mirror } = await import("../src/link/windows.ts");
  const { window, remote, stop } = await windowed();
  window("w1");
  const seen: { [key: string]: unknown }[] = [];
  let subs = 0, failed = 0;
  const host: InstanceType<typeof Lines> = new Lines((line) => {
    const r = JSON.parse(line);
    seen.push(r);
    // the first placement of a screen fails
    const fail = r.cmd === "place" && r.name === "screen" && !failed++;
    const answer = fail
      ? { seq: r.seq, error: { kind: "invalid", why: { code: "nope", text: "no" } } }
      : { seq: r.seq, ok: r.cmd === "subscribe" ? { sub: ++subs } : null };
    queueMicrotask(() => host.take(JSON.stringify(answer)));
  });
  const errors = console.error;
  console.error = () => {};
  const kept = await mirror(host, remote, { agent: "m", id: "@1-m", every: 20 });
  try {
    assertEquals(kept.windows(), []);
    // what it placed is unplaced
    assert(seen.some((r) => r.cmd === "unplace" && r.id === "@1-m/w1"));
    // the next listing keeps it: its keys are listened to last
    const listened = () =>
      seen.some((r) => r.cmd === "subscribe" && r.address?.toString() === "w1,keys");
    for (let i = 0; i < 100 && !listened(); i++) await new Promise((r) => setTimeout(r, 10));
    assert(listened(), "kept on the next listing");
    assertEquals(kept.windows(), ["w1"]);
    assertEquals(seen.filter((r) => r.cmd === "place" && r.name === "screen").length, 2);
  } finally {
    console.error = errors;
    await kept.stop();
    await stop();
  }
});

Deno.test("a mirror stopped while it keeps a window leaves nothing placed", async () => {
  const { Lines } = await import("../src/link/lines.ts");
  const { mirror } = await import("../src/link/windows.ts");
  const { window, remote, stop } = await windowed();
  const seen: { [key: string]: unknown }[] = [];
  let subs = 0, gated = false;
  const waiting: (() => void)[] = [];
  const host: InstanceType<typeof Lines> = new Lines((line) => {
    const r = JSON.parse(line);
    seen.push(r);
    // once the window is being placed, answers wait
    if (r.cmd === "place") gated = true;
    const answer = () =>
      host.take(JSON.stringify({ seq: r.seq, ok: r.cmd === "subscribe" ? { sub: ++subs } : null }));
    if (gated) waiting.push(answer);
    else queueMicrotask(answer);
  });
  const kept = await mirror(host, remote, { agent: "m", id: "@1-m", every: 60000 });
  try {
    window("w1");
    for (let i = 0; i < 100 && !gated; i++) await new Promise((r) => setTimeout(r, 5));
    assert(gated, "the window is being placed");
    const stopping = kept.stop();
    // the host answers everything from now on
    gated = false;
    for (const answer of waiting.splice(0)) answer();
    await stopping;
    await new Promise((r) => setTimeout(r, 50));
    // every node placed was unplaced after
    const placed = seen.filter((r) => r.cmd === "place").map((r) => r.id);
    assert(placed.length >= 1);
    for (const id of placed) {
      const at = seen.findLastIndex((r) => r.cmd === "place" && r.id === id);
      assert(
        seen.slice(at).some((r) => r.cmd === "unplace" && r.id === id),
        `${id} was left placed`,
      );
    }
    assertEquals(kept.windows(), []);
  } finally {
    await stop();
  }
});

Deno.test("a wire ends a conversation that sends a frame far ahead, or a message too long", async () => {
  const { Conn, Wire } = await import("../src/link/wire.ts");
  const errors = console.error;
  console.error = () => {};
  try {
    const { transport } = alone();
    const wire = new Wire(transport, { ahead: 8, message: 10 });
    const far = new Conn(wire, "p");
    far.take({ n: 3, to: "me", m: { text: "x" } });
    assert(!far.over, "within the window");
    far.take({ n: 8, to: "me", m: { text: "x" } });
    assert(far.over);
    assertEquals(await far.closed, "frame 8 is more than 8 ahead of frame 0");
    const long = new Conn(wire, "q");
    long.take({ n: 0, to: "me", part: '{"text":', more: true });
    long.take({ n: 1, to: "me", part: '"abc', more: true });
    assert(long.over);
    assertEquals(await long.closed, "a message longer than 10 characters");
    await wire.close();
  } finally {
    console.error = errors;
  }
});

Deno.test("an owner's wire begins at most so many conversations", async () => {
  const { Wire } = await import("../src/link/wire.ts");
  const errors = console.error;
  console.error = () => {};
  try {
    const { transport, hear } = alone();
    const wire = new Wire(transport, { conns: 2 });
    const began: string[] = [];
    wire.onconn = (conn) => began.push(conn.peer);
    for (const from of ["a", "b", "c", "a"]) hear({ to: "*", m: { hello: "mount" } }, from);
    assertEquals(began, ["a", "b"]);
    assertEquals([...wire.conns.keys()], ["a", "b"]);
    await wire.close();
  } finally {
    console.error = errors;
  }
});

Deno.test("a dialing mounter holds so much from strangers, and still hears an owner's hello", async () => {
  const { Wire } = await import("../src/link/wire.ts");
  const errors = console.error;
  console.error = () => {};
  try {
    const { transport, hear } = alone();
    const wire = new Wire(transport, { conns: 2, ahead: 2 });
    const dialing = wire.dial();
    // a stranger's frames, past what is held of one, and then one stranger too many
    for (let n = 0; n < 5; n++) hear({ n, to: "me", m: { text: "junk" } }, "x");
    // its second hello, after a beat
    hear({ n: 2, to: "me", m: { beat: true } }, "o");
    hear({ n: 0, to: "me", m: { text: "junk" } }, "y");
    hear({ n: 1, to: "me", m: { hello: "serve" } }, "o");
    const conn = await dialing;
    assertEquals(conn.peer, "o");
    const got: string[] = [];
    conn.onmessage = ({ text }) => got.push(text);
    hear({ n: 3, to: "me", m: { text: "hi" } }, "o");
    assertEquals(got, ["hi"]);
    await wire.close();
  } finally {
    console.error = errors;
  }
});

Deno.test("a frame missing is timed from the last progress, so steady reordering is no gap", async () => {
  const { Conn, Wire } = await import("../src/link/wire.ts");
  const { transport } = alone();
  const wire = new Wire(transport, { gap: 100 });
  const conn = new Conn(wire, "p");
  const got: string[] = [];
  conn.onmessage = ({ text }) => got.push(text);
  const frame = (n: number) => ({ n, to: "me", m: { text: `${n}` } });
  try {
    conn.take(frame(1));
    conn.take(frame(3));
    await new Promise((r) => setTimeout(r, 60));
    conn.take(frame(0));
    // 0 and 1 came: 2 is missing from now
    await new Promise((r) => setTimeout(r, 70));
    assert(!conn.over, "broken though frames kept coming");
    conn.take(frame(2));
    assertEquals(got, ["0", "1", "2", "3"]);
    // and a frame that stays missing still breaks it
    conn.take(frame(5));
    assertEquals(await conn.closed, "frame 4 never came");
  } finally {
    await wire.close();
  }
});

Deno.test("Lines keeps at most so many events for subs no one listens to", async () => {
  const { Lines } = await import("../src/link/lines.ts");
  const errors = console.error;
  console.error = () => {};
  try {
    const host = new Lines(() => {}, { early: 3 });
    for (let i = 0; i < 5; i++) host.take(`{"sub":7,"event":${i}}`);
    const got: string[] = [];
    host.listen(7, (e) => got.push(e));
    assertEquals(got, ["2", "3", "4"]);
    // deaf forgets what was kept for a sub, so it makes room
    for (let i = 0; i < 3; i++) host.take(`{"sub":8,"event":${i}}`);
    host.deaf(8);
    for (let i = 0; i < 3; i++) host.take(`{"sub":9,"event":${i}}`);
    const nine: string[] = [];
    host.listen(9, (e) => nine.push(e));
    assertEquals(nine, ["0", "1", "2"]);
  } finally {
    console.error = errors;
  }
});

Deno.test("relay ends a mount whose events wait past its hold while the link is behind", async () => {
  const { relay } = await import("../src/link/relay.ts");
  const { host } = await recording((r) => (r.cmd === "subscribe" ? { sub: 1 } : null));
  const h = hub();
  const inner = h.peer();
  const behind = { ...inner, backlog: () => ({ bytes: 1 << 30, payloads: 1, oldest: 0 }) };
  const errors = console.error;
  console.error = () => {};
  const relayed = relay(host, behind, { hold: 5, behind: () => {} });
  const remote = await mount(h.peer());
  try {
    await remote.subscribe({ ...me, address: [], send: () => {} });
    for (let i = 0; i < 10; i++) host.take(`{"sub":1,"event":{"change":{"time":${i}}}}`);
    assertEquals(await remote.closed, "the peer left: more than 5 events waiting for the link");
  } finally {
    console.error = errors;
    await remote.close();
    await relayed.close();
    h.stop();
  }
});

Deno.test("revive keeps a key __proto__ a key, even where setting it would set the prototype", async () => {
  const { revive } = await import("../src/link/mount.ts");
  // the accessor as the language defines it, which Deno leaves out
  const had = Object.getOwnPropertyDescriptor(Object.prototype, "__proto__");
  Object.defineProperty(Object.prototype, "__proto__", {
    configurable: true,
    get(this: object) {
      return Object.getPrototypeOf(this);
    },
    set(this: object, v: unknown) {
      if (typeof v === "object") Object.setPrototypeOf(this, v);
    },
  });
  let out: { [key: string]: unknown };
  try {
    out = revive(JSON.parse('{"a":{"__proto__":{"polluted":true}}}')) as typeof out;
  } finally {
    if (had) Object.defineProperty(Object.prototype, "__proto__", had);
    else delete (Object.prototype as { __proto__?: unknown }).__proto__;
  }
  const a = out.a as { [key: string]: unknown };
  assertEquals(Object.getPrototypeOf(a), Object.prototype);
  assert(Object.hasOwn(a, "__proto__"));
  assertEquals(Object.getOwnPropertyDescriptor(a, "__proto__")?.value, { polluted: true });
  assertEquals((a as { polluted?: unknown }).polluted, undefined);
});
