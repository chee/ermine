// d2's acceptance checks that need no browser: the page's world, booted over
// fake-indexeddb with a fake stage element, driven the way the page drives
// it (the same actions, the same fire), and read the way the panels read it.

import { assert, assertEquals, assertExists } from "@std/assert";
import { IDBFactory } from "fake-indexeddb";
import { type Id, indexeddb, type ProcessItem, type ValueItem } from "d2/ermine";
import { openStack, siteOf, type World } from "./src/stack.ts";
import { boot } from "./src/boot.ts";
import * as act from "./src/actions.ts";
import { RULES } from "./src/seed.ts";
import { FakeDocument, type FakeElement } from "./fake.ts";
import { join, share } from "./src/share.ts";
import { hub } from "../../src/link/wire.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function open(factory: InstanceType<typeof IDBFactory>) {
  const doc = new FakeDocument();
  const stage = doc.createElement("div");
  const w = await openStack(indexeddb("ermine-d2", factory), { stage, slow: 80 });
  // the host lets a gone node's live element go, as the page does
  w.onGone((_id, live) => (live as FakeElement).remove?.());
  boot(w);
  return { w, stage };
}

/** Waits until nothing is waiting: every module loaded, every run settled. */
async function settle(w: World) {
  for (let i = 0; i < 50; i++) {
    await wait(20);
    if (
      ![...w.started.keys()].some((p) => running(w, p) && items(w, p).some((i) => "waiting" in i))
    ) {
      return;
    }
  }
  throw new Error("still waiting");
}

const read = (w: World, path: string[]) => w.s.read({ agent: "host", address: path });
const items = (w: World, pid: Id) => {
  const path = w.pathOf(pid);
  return path ? read(w, path) as unknown as (ValueItem | ProcessItem)[] : [];
};
const running = (w: World, pid: Id) => w.pathOf(pid) !== undefined;
const valueOf = (w: World, pid: Id) =>
  (items(w, pid).find((i) => "value" in i) as ValueItem | undefined)?.value as
    | { [k: string]: unknown }
    | undefined;

/**
 * The live processes at a card. hello and twin are one node, so the node a
 * process was placed in cannot tell them apart; the frame its compute read
 * (its value says which) can.
 */
function at(w: World, card: string): Id[] {
  return [...w.started.entries()]
    .filter(([pid, c]) => {
      if (!running(w, pid)) return false;
      const frame = valueOf(w, pid)?.frame;
      return Array.isArray(frame) ? frame.at(-1) === card : w.pathOf(c.node)?.at(-1) === card;
    })
    .map(([pid]) => pid);
}

/** The frame the desk gave a card, and the line under its name. */
const lineOf = (stage: FakeElement, card: string) =>
  stage.children.find((k) => k.className === "frame" && k.children[0].textContent === card)
    ?.children[1].textContent ?? "";

const surfaceOf = (w: World, pid: Id) =>
  w.ephemeral.get(`${pid}/surface`) as FakeElement | undefined;

Deno.test("d2: first visit, reload, and the walkthrough's acts", async () => {
  const factory = new IDBFactory();
  const { w, stage } = await open(factory);

  // the seed: every placement has a site, captured in d2's own code
  const seedLines = w.bursts[0].lines;
  assertEquals(seedLines.length, 34);
  for (const l of seedLines) {
    const site = siteOf(l.change.cause);
    assertExists(site, "every seed placement carries a site");
    assert(site.file.endsWith("seed.ts"), site.file);
  }

  // later's loader is nearer and slow: its process reads as waiting, with the changes kept for it
  await wait(30);
  const [later] = at(w, "later");
  assertExists(later);
  const first = items(w, later)[0] as ProcessItem;
  assert("waiting" in first, "later waits for its slow loader");
  await settle(w);
  assert(!("waiting" in (items(w, later)[0] as object)));
  assertEquals(read(w, [...w.pathOf(later)!, "loaded"]).length, 1, "the loader's answer node");

  // the stage shows only what processes drew: a header, seven frames, a surface in each but count
  const kids = stage.children;
  assertEquals(kids[0].textContent, "7 cards");
  assertEquals(kids.filter((k) => k.className === "frame").length, 7);
  for (const card of ["hello", "twin", "samples", "picture", "later", "hush"]) {
    const [pid] = at(w, card);
    assertExists(surfaceOf(w, pid), `${card} drew a surface`);
  }
  // every element on the stage that is a node's value was placed by a process
  for (const [id, live] of w.ephemeral) {
    if (!live) continue;
    const made = w.made.get(id)!;
    assertExists(made.process, `${id} was placed by a process`);
  }
  // hello and twin are one node, read by two processes
  const [hello] = at(w, "hello");
  const [twin] = at(w, "twin");
  assert(hello && twin && hello !== twin);

  // typing: the handler edit, as you; both processes are marked, both show it
  const fired = w.fire(hello, "edit", { value: "hello, desk" });
  assertExists(fired);
  assertEquals(fired.error, undefined);
  const edit = fired.changes[0];
  assertEquals(edit.kind, "write");
  assertEquals((edit.agent as { actor: string }).actor, "you");
  const line = w.lines.find((l) => l.change.time === edit.time)!;
  assert(line.marked.includes(hello) && line.marked.includes(twin), "both readers marked");
  assertEquals((surfaceOf(w, twin)!.firstChild as FakeElement).value, "hello, desk");

  // front: paper moves to the front of desk/theme; the accent every note finds changes
  assertEquals((valueOf(w, hello)!.theme as { accent: string }).accent, "#c2703d");
  act.front(w, ["desk"], "theme", "theme.paper");
  const frontLine = w.lines.at(-1)!;
  assert(siteOf(w.bursts.find((b) => b.label.startsWith("front"))!.lines[0].change.cause)!
    .file.endsWith("actions.ts"));
  assertEquals((valueOf(w, hello)!.theme as { accent: string }).accent, "#4f6f8f");
  assert(frontLine !== undefined);

  // nearer: a copy of dusk at cards/picture/theme; only the picture's process runs again
  const [picture] = at(w, "picture");
  const before = w.records.get(hello)!.length;
  // the winner, paper since front, is read as you from where the lookup found it, and copied
  act.nearer(w, ["desk", "cards", "picture"], "theme", ["..", "..", "theme"]);
  const nearBurst = w.bursts.at(-1)!;
  const ran = new Set(nearBurst.lines.flatMap((l) => l.marked));
  assert(ran.has(picture));
  assert(!ran.has(hello) && !ran.has(twin), "no other card was marked");
  assertEquals(w.records.get(hello)!.length, before);
  assertEquals((valueOf(w, picture)!.theme as { accent: string }).accent, "#4f6f8f");
  const lastPic = w.records.get(picture)!.at(-1)!;
  const theme = lastPic.lookups.find((l) => l.name === "theme")!;
  assertEquals(theme.searched.length, 1, "the search stops at . on the first rung");

  // a dropped image: the host writes the bytes, as you; only the picture's process runs again
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]).buffer;
  act.dropBytes(w, ["desk", "cards", "picture", "image"], bytes);
  const drop = w.bursts.at(-1)!;
  assertEquals(drop.lines[0].change.kind, "write");
  assert(siteOf(drop.lines[0].change.cause)!.file.endsWith("actions.ts"));
  assertEquals(valueOf(w, picture)!.size, 7);
  assert(!drop.lines.some((l) => l.marked.includes(hello)));

  // a program edit: every note shows the newer item; restart takes it up
  const note = read(w, ["desk", "programs", "note"])[0];
  const src = (note.value as { compute: string }).compute.replace('"15px"', '"18px"');
  act.editProgram(w, "program.note", src);
  const newer = items(w, hello).find((i) => "newer" in i) as { newer: { program: unknown } };
  assertExists(newer, "hello reads as newer");
  assertExists(items(w, twin).find((i) => "newer" in i));
  const oldSurface = surfaceOf(w, hello)!;
  const restarted = act.restart(w, hello, "program.note");
  assertExists(restarted);
  await settle(w);
  const fresh = restarted.change.kind === "place" ? restarted.change.id : "";
  assert(fresh && fresh !== hello);
  assert(!running(w, hello), "the old process was unplaced");
  assertEquals(oldSurface.parent, undefined, "its surface was let go");
  const release = w.lines.find((l) =>
    l.change.kind === "unplace" && l.change.id === `${hello}/surface`
  )!;
  assertExists(release);
  assertEquals((release.change.cause as { killed: string }).killed, hello);
  assertEquals(surfaceOf(w, fresh)!.props.get("--size"), "18px");
  assertEquals(items(w, fresh).find((i) => "newer" in i), undefined);
  // the frame's line names the process the graph has at the card now, not the desk's old child
  assert(lineOf(stage, "hello").startsWith(fresh), lineOf(stage, "hello"));
  assert(!lineOf(stage, "hello").includes(hello));

  // as guest: rule 1 refuses the write to hello's text, and nothing changes
  w.actor = "guest";
  const text = read(w, ["desk", "cards", "hello", "text"])[0].value;
  (surfaceOf(w, fresh)!.firstChild as FakeElement).value = "guest was here";
  const refused = w.fire(fresh, "edit", { value: "guest was here" });
  assertEquals(refused?.error?.kind, "refused");
  assertEquals(refused?.error?.why.rule, 1);
  assertEquals(read(w, ["desk", "cards", "hello", "text"])[0].value, text);
  assertEquals(
    (surfaceOf(w, fresh)!.firstChild as FakeElement).value,
    text,
    "the note shows the graph",
  );
  // later's text is not under that rule
  const [laterNow] = at(w, "later");
  assertEquals(w.fire(laterNow, "edit", { value: "guest wrote this" })?.error, undefined);

  // as guest, hush: the search is refused at the root
  const guest = act.startHere(w, ["desk", "cards", "hush"], ["programs", "hush"]);
  assertExists(guest);
  await settle(w);
  const gpid = guest.change.kind === "place" ? guest.change.id : "";
  assertEquals(valueOf(w, gpid)!.refused, ["..", "..", ".."]);
  assertEquals(valueOf(w, gpid)!.secret, null);
  const [, hostHush] = [gpid, at(w, "hush").find((p) => p !== gpid)!];
  assertEquals(valueOf(w, hostHush)!.secret, "the cake is in the fridge");
  assert(surfaceOf(w, gpid)!.textContent.includes("refused at ../../.."));
  assert(lineOf(stage, "hush").includes(gpid), "the hush frame names both processes");
  assert(lineOf(stage, "hush").includes(hostHush));
  w.actor = "you";
  assertEquals(w.rules(), RULES);

  // nothing ephemeral is kept
  const keptNodes = w.k.kept().nodes;
  for (const id of w.ephemeral.keys()) assert(!keptNodes.has(id), `${id} is not kept`);
  const time = w.s.time;
  const pids = new Set(w.started.keys());
  await w.k.flush();

  // reload: what was kept comes back; the old process nodes are swept; nothing reconnects by id
  const again = await open(factory);
  const v = again.w;
  assertEquals(v.loaded?.time, time);
  const sweep = v.bursts[0];
  assert(sweep.label.startsWith("sweep"), sweep.label);
  assert(sweep.lines.every((l) => l.change.kind === "unplace"));
  await settle(v);
  assertEquals(read(v, ["desk", "cards", "hello", "text"])[0].value, "hello, desk");
  assertEquals(read(v, ["desk", "theme"])[0].from.route.at(-1)?.node, "theme.paper");
  assertEquals(read(v, ["desk", "cards", "picture", "theme"]).length, 1);
  assert((read(v, ["desk", "programs", "note"])[0].value as { compute: string }).compute
    .includes('"18px"'));
  for (const pid of v.started.keys()) assert(!pids.has(pid), `${pid} is new`);
  for (const l of v.lines) assert(l.change.time > time);
  const [h2] = at(v, "hello");
  assertEquals(surfaceOf(v, h2)!.props.get("--size"), "18px");
  assertEquals(again.stage.children[0].textContent, "7 cards");

  // the page started again: a new screen, the old one let go with its frames; the desk makes
  // new frames, and replaces each child it had started for an old one, so one process per card
  const page = [...v.started.entries()].find(([, c]) => c.node === v.root)![0];
  const counted = v.seen();
  act.restart(v, page, "programs.page");
  await settle(v);
  assert(v.seen() > counted);
  assert(!running(v, page));
  assertEquals(
    v.owner.get(again.stage),
    [...v.started.keys()].filter((p) => running(v, p))
      .map((p) => `${p}/screen`).find((id) => v.ephemeral.has(id)),
    "the stage is the new screen",
  );
  assertEquals(again.stage.children.filter((k) => k.className === "frame").length, 7);
  for (const card of ["hello", "twin", "samples", "picture", "count", "later", "hush"]) {
    assertEquals(at(v, card).length, 1, `one process at ${card}`);
  }
  assertEquals((surfaceOf(v, at(v, "hello")[0])!.firstChild as FakeElement).value, "hello, desk");
});

Deno.test("d2: share serves /desk; a mounter's write is stamped {actor, peer} by the owner", async () => {
  const { w } = await open(new IDBFactory());
  await settle(w);
  const h = hub();
  const shared = await share(w.s, () => Promise.resolve(h.peer()));
  const remote = await join(shared.channel, () => Promise.resolve(h.peer()));
  // the viewer claims a plain actor; serve wraps it with the peer it came from
  const [item] = await remote.read({ agent: "viewer", address: ["cards", "hello", "text"] });
  assertEquals(item.value, "hello");
  await remote.write({
    agent: "viewer",
    address: ["cards", "hello", "text"],
    patches: [{ type: "snapshot", value: "from afar" }],
  });
  assertEquals(read(w, ["desk", "cards", "hello", "text"])[0].value, "from afar");
  const line = w.lines.findLast((l) =>
    l.change.kind === "write" && l.change.node === "hello.text"
  )!;
  const agent = line.change.agent as { actor: unknown; peer: unknown };
  assertEquals(agent.actor, "viewer");
  assertEquals(typeof agent.peer, "string");
  await remote.close();
  await shared.close();
  h.stop();
});
