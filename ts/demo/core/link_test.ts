/// <reference lib="dom" />
// Two demo worlds on one channel in memory: A shares a folder, B mounts it.
// B's copy is read at once (nothing, then A's values); a write in B shows at
// once as a layer in front of the copy, reaches A, and comes back as A's
// change; a write in A reaches B; a write A refuses leaves B's copy as it was
// and says why; and a reload of B starts its mount again from the boot image.
//
//   cd ts && deno test --allow-read --allow-env demo/core/link_test.ts

// deno-lint-ignore no-import-prefix no-unversioned-import -- the lock has it already, as npm:linkedom@*
import { parseHTML } from "npm:linkedom";
import { assert, assertEquals } from "@std/assert";
import { load, memory } from "../../src/keeper.ts";
import { hub } from "../../src/link/wire.ts";
import type { Json, ValueItem } from "../../src/types.ts";
import { named } from "../../src/link/name.ts";
import { World } from "./src/world.ts";

const page = parseHTML("<!doctype html><html><head></head><body></body></html>");
Object.assign(globalThis, {
  document: page.document,
  window: page.window,
  Node: page.Node,
  HTMLElement: page.HTMLElement,
});

async function until(f: () => boolean, what: string, ms = 4000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** What an address reads in a world, as its acting agent: the values, in order. */
function values(w: World, ...address: string[]): Json[] {
  return (w.scheduler.read({ agent: w.agent, address }) as ValueItem[])
    .filter((i) => "value" in i).map((i) => i.value);
}

function ok(w: World, code: string) {
  const s = w.run(code);
  assert(s.ok, `${code}: ${s.error?.why}`);
  return s;
}

/** Two worlds on one hub: A has notes/doc and shares notes; B mounts it. */
function setup() {
  const h = hub({ shuffle: true });
  const link = () => Promise.resolve(h.peer());
  const A = new World({ backend: () => memory(), link });
  const backend = memory();
  const B = new World({ backend: () => backend, link });
  A.reset();
  B.reset({ keep: true });
  ok(
    A,
    `batch(() => {\n  make("root", "notes", "notes", {})\n  make("notes", "doc", "doc", "hello")\n})`,
  );
  ok(A, `share("notes")`);
  const share = A.links()[0];
  assertEquals(share.role, "share");
  assertEquals(share.address, ["notes"]);
  ok(B, `mount(${JSON.stringify(share.channel)})`);
  const mount = B.links()[0];
  assertEquals(mount.role, "mount");
  const short = share.channel.slice(0, 8);
  assertEquals(mount.address, [short]);
  const stop = async () => {
    A.reset();
    B.reset();
    await new Promise((r) => setTimeout(r, 20));
    h.stop();
  };
  return { h, A, B, backend, short, share, mount, stop };
}

Deno.test("B mounts A's folder, and each sees the other's writes", async () => {
  const { A, B, short, stop } = setup();
  try {
    // synchronous, and nothing yet: pending is an empty read
    assertEquals(values(B, short), []);
    await until(() => values(B, short, "doc").length > 0, "B's copy");
    assertEquals(values(B, short, "doc"), ["hello"]);
    const mount = B.links()[0];
    assertEquals(mount.status?.state, "mounted");
    assertEquals(mount.joining.state, "connected");
    await until(() => (A.links()[0].status?.mounters as Json[]).length === 1, "A to see B");

    // the copy is the mirror's ephemeral nodes, and says who set it on A
    const [copy] = B.scheduler.read({ agent: B.agent, address: [short, "doc"] });
    assert(copy.ephemeral);
    assertEquals(copy.change?.agent, "chee");
    assert(B.mountOf(copy.from.route.at(-1)!.node), "the host knows it is a mount's");

    // B writes: at once a layer in front of the copy, then A's change
    ok(B, `write([${JSON.stringify(short)}, "doc"], "from B")`);
    assertEquals(values(B, short, "doc"), ["from B", "hello"]);
    const [layer] = B.scheduler.read({ agent: B.agent, address: [short, "doc"] });
    assertEquals((layer.change?.cause as { sending?: string }).sending, "write");
    await until(() => A.valueOf("doc") === "from B", "A to have B's write");
    await until(() => values(B, short, "doc").length === 1, "B's layer to go");
    assertEquals(values(B, short, "doc"), ["from B"]);
    // on A, the change is the mounter's: its site is on B's page
    const t = A.latest.get("doc")!;
    assert(A.linked.has(t), "A notes the change came through its share");

    // A writes: B's copy follows
    ok(A, `write("doc", "from A")`);
    await until(() => values(B, short, "doc")[0] === "from A", "B to see A's write");
    assertEquals(values(B, short, "doc"), ["from A"]);

    // B makes a node in the mount: A has it, and B's copy of it
    ok(B, `make([${JSON.stringify(short)}], "more", "more", 3)`);
    await until(() => A.valueOf("more") === 3, "A to have B's new node");
    await until(() => values(B, short, "more").length === 1, "B's copy of it");
  } finally {
    await stop();
  }
});

Deno.test("a write A refuses: B's layer goes, the copy stays, and the status says why", async () => {
  const { A, B, short, stop } = setup();
  try {
    A.rules = [{ agent: "hop", op: "write", node: "doc", allow: false, on: true }];
    await until(() => values(B, short, "doc").length > 0, "B's copy");
    ok(B, `as("hop", () => write([${JSON.stringify(short)}, "doc"], "no"))`);
    assertEquals(values(B, short, "doc"), ["no", "hello"]);
    await until(() => values(B, short, "doc").length === 1, "the layer to go");
    assertEquals(values(B, short, "doc"), ["hello"]);
    assertEquals(A.valueOf("doc"), "hello");
    const refused = B.links()[0].status?.refused as { error: { kind: string } }[];
    assertEquals(refused.length, 1);
    assertEquals(refused[0].error.kind, "refused");
  } finally {
    await stop();
  }
});

Deno.test("stopping the share: B's copy goes, and its mount says gone", async () => {
  const { A, B, short, share, stop } = setup();
  try {
    await until(() => values(B, short, "doc").length > 0, "B's copy");
    ok(A, `stop(${JSON.stringify(share.pid)})`);
    await until(() => B.links()[0]?.status?.state === "gone", "B's mount to say gone");
    assertEquals(values(B, short), []);
  } finally {
    await stop();
  }
});

Deno.test("a reload of B: the copy was not kept, and the boot image mounts again", async () => {
  const { h, A, B, backend, short, stop } = setup();
  let again: World | undefined;
  try {
    await until(() => values(B, short, "doc").length > 0, "B's copy");
    await B.keeper!.flush();
    const image = B.image();
    assert(image.includes(`["programs","mirror"]`), "the boot image starts the mount");
    B.reset();
    const kept = await load(backend);
    assert(kept, "B kept its graph");
    again = new World({ backend: () => backend, link: () => Promise.resolve(h.peer()) });
    again.reset({ keep: true, kept });
    // nothing of the copy was kept: it is the mirror's, and ephemeral
    assertEquals(values(again, short), []);
    again.reopen(image, "reopen");
    await until(() => values(again!, short, "doc").length > 0, "the copy again");
    assertEquals(values(again, short, "doc"), ["hello"]);
    // and it writes through, as before
    ok(again, `write([${JSON.stringify(short)}, "doc"], "after")`);
    await until(() => A.valueOf("doc") === "after", "A to have the write after the reload");
  } finally {
    again?.reset();
    await stop();
  }
});

Deno.test("sharing the whole workspace: programs and loaders come too, and it writes through", async () => {
  const h = hub({ shuffle: true });
  const link = () => Promise.resolve(h.peer());
  const A = new World({ backend: () => memory(), link });
  const B = new World({ backend: () => memory(), link });
  A.reset();
  B.reset();
  try {
    ok(
      A,
      `batch(() => {\n  make("root", "notes", "notes", {})\n  make("notes", "doc", "doc", "hello")\n})`,
    );
    ok(A, `share("root")`);
    const share = A.links()[0];
    assertEquals(share.address, []);
    ok(B, `mount(${JSON.stringify(share.channel)})`);
    const short = share.channel.slice(0, 8);
    await until(() => values(B, short, "notes", "doc").length > 0, "B's copy");
    // A's runtime is in the copy too: its loaders, its programs, its share's process
    await until(() => values(B, short, "programs", "share").length > 0, "programs");
    await until(() => values(B, short, "loaders", "host").length > 0, "loaders");
    assertEquals(values(B, short, "loaders", "host"), [{ loader: "host" }]);
    await until(
      () => values(B, short, "shares", share.pid, "link").length > 0,
      "A's share",
    );
    ok(B, `write([${JSON.stringify(short)}, "notes", "doc"], "from B")`);
    await until(() => A.valueOf("doc") === "from B", "A to have B's write");
    // A stamped who: the agent B acted as, and B's mount's key on the channel
    const by = A.scheduler.read({ agent: A.agent, address: ["notes", "doc"] })[0].change
      ?.agent as { actor: Json; peer: string };
    assertEquals(by.actor, B.agent);
    assertEquals(typeof by.peer, "string");
  } finally {
    A.reset();
    B.reset();
    await new Promise((r) => setTimeout(r, 20));
    h.stop();
  }
});

Deno.test("a kept mount: ordinary nodes, kept over a reload, made nothing twice when it mounts again", async () => {
  const h = hub({ shuffle: true });
  const link = () => Promise.resolve(h.peer());
  const A = new World({ backend: () => memory(), link });
  const backend = memory();
  const B = new World({ backend: () => backend, link });
  A.reset();
  B.reset({ keep: true });
  let again: World | undefined;
  try {
    ok(
      A,
      `batch(() => {\n  make("root", "notes", "notes", {})\n  make("notes", "doc", "doc", "hello")\n})`,
    );
    ok(A, `share("notes")`);
    const share = A.links()[0];
    ok(B, `mount(${JSON.stringify(share.channel)}, undefined, "kept")`);
    const mount = B.links()[0];
    assertEquals([mount.role, mount.kind], ["mount", "kept"]);
    const short = share.channel.slice(0, 8);
    await until(() => values(B, short, "doc").length > 0, "B's copy");
    const [copy] = B.scheduler.read({ agent: B.agent, address: [short, "doc"] });
    assert(!copy.ephemeral, "a kept copy is ordinary");
    assertEquals(B.mountOf(copy.from.route.at(-1)!.node)?.kind, "kept");
    // a write: a layer at once, then A's
    ok(B, `write([${JSON.stringify(short)}, "doc"], "from B")`);
    await until(() => A.valueOf("doc") === "from B", "A to have B's write");
    await until(
      () => JSON.stringify(values(B, short, "doc")) === '["from B"]',
      "B's layer to go",
    );
    // the reload
    await B.keeper!.flush();
    const image = B.image();
    assert(image.includes(`["programs","mirror-kept"]`), "the boot image starts the kept mount");
    B.reset();
    ok(A, `write("doc", "while B was away")`);
    const kept = await load(backend);
    assert(kept);
    again = new World({ backend: () => backend, link });
    again.reset({ keep: true, kept });
    // the copy is there at once, as it was last seen
    assertEquals(values(again, short, "doc"), ["from B"]);
    again.reopen(image, "reopen");
    await until(
      () => values(again!, short, "doc")[0] === "while B was away",
      "the copy to follow A again",
    );
    // one node at each path: nothing made twice
    const dir = again.scheduler.directory({ agent: again.agent, address: [short] });
    assert("directory" in dir);
    assertEquals(dir.directory.map(([n, items]) => [n, items.length]), [["doc", 1]]);
    const root = again.scheduler.directory({
      agent: again.agent,
      address: [],
      name: short,
    });
    assertEquals("items" in root && root.items.length, 1);
    ok(again, `write([${JSON.stringify(short)}, "doc"], "after")`);
    await until(() => A.valueOf("doc") === "after", "A to have the write after the reload");
  } finally {
    again?.reset();
    A.reset();
    B.reset();
    await new Promise((r) => setTimeout(r, 20));
    h.stop();
  }
});

Deno.test("share as a name, and mount the name into a folder of B's choosing", async () => {
  const h = hub({ shuffle: true });
  const link = () => Promise.resolve(h.peer());
  const A = new World({ backend: () => memory(), link });
  const B = new World({ backend: () => memory(), link });
  A.reset();
  B.reset();
  try {
    ok(
      A,
      `batch(() => {\n  make("root", "notes", "notes", {})\n  make("notes", "doc", "doc", "hello")\n})`,
    );
    const s = ok(A, `return share("notes", { name: "kitchen" })`);
    const channel = JSON.parse(s.result!);
    assertEquals(channel, named("kitchen"));
    assertEquals([A.links()[0].channel, A.links()[0].named], [channel, "kitchen"]);
    ok(B, `make("root", "inbox", "inbox", {})`);
    ok(B, `mount("kitchen", { at: "inbox" })`);
    const mount = B.links()[0];
    assertEquals([mount.channel, mount.named, mount.address], [channel, "kitchen", [
      "inbox",
      "kitchen",
    ]]);
    await until(() => values(B, "inbox", "kitchen", "doc").length > 0, "B's copy");
    assertEquals(values(B, "inbox", "kitchen", "doc"), ["hello"]);
    // 64 hex digits stand for themselves, and show no name
    ok(B, `mount(${JSON.stringify(channel.toUpperCase())}, { at: "inbox", kind: "kept" })`);
    const second = B.links()[1];
    assertEquals([second.channel, second.named, second.kind], [channel, undefined, "kept"]);
    assertEquals(second.address, ["inbox", channel.slice(0, 8)]);
  } finally {
    A.reset();
    B.reset();
    await new Promise((r) => setTimeout(r, 20));
    h.stop();
  }
});

Deno.test("a page may mount its own share, but not inside what it shares", () => {
  const h = hub();
  const link = () => Promise.resolve(h.peer());
  const A = new World({ backend: () => memory(), link });
  A.reset();
  try {
    ok(
      A,
      `batch(() => {\n  make("root", "notes", "notes", {})\n  make("notes", "deep", "deep", {})\n  make("root", "other", "other", {})\n})`,
    );
    ok(A, `share("notes", { name: "loop" })`);
    for (const at of ["notes", "deep"]) {
      const s = A.run(`mount("loop", { at: ${JSON.stringify(at)} })`);
      assert(!s.ok, `mounting into ${at} is refused`);
      assert(s.error!.why.includes("copy itself"), s.error!.why);
    }
    ok(A, `mount("loop", { at: "other" })`);
    ok(A, `mount("loop")`);
    // the whole workspace holds everything: no place in it is outside
    ok(A, `share("root", { name: "all" })`);
    assert(!A.run(`mount("all", { at: "other" })`).ok);
  } finally {
    A.reset();
    h.stop();
  }
});
