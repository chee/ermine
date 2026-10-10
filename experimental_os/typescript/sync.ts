// sync.ts: the OS's sync (layers/subduction/SYNC.tex; working/PI-OS.tex, Sync
// and the network). Two machines share a folder of the graph through a
// Subduction server.
//
// The stack is sync > procs > protect > keeper > the bare graph: SYNC.tex's
// sync wrapper over procs, as it wraps the reference scheduler. Programs'
// interfaces are bound over it, so what a program does to a document, a
// write, a making by name, a mount or an unplacement, is committed; and every
// change from elsewhere comes in through procs' arrive, beneath protect.
//
// Sync is held by the host, as the layer's sync.ts says its process is: host code, not a
// program, since it wraps the stack and needs Subduction's wasm. What it
// keeps outside the graph is in a folder beside the SD card, <sd>.sync: the
// device's key (key, its Ed25519 seed, never placed in the graph) and
// Subduction's storage (store/). Its nodes:
//
//   /etc/sync               the settings: {"server": "wss://galaxy.observer"}
//   /dev/sync               the sync root, a document: {key, lock, made}
//   /dev/sync/@<pid>        the sync process (the layer's): refused, waiting, stuck, dropped, followed
//   /dev/sync/shared/<hex>  what this machine shares and mounts, a slot each: the person's choice, kept
//   /dev/sync/views         {hex: path}: the views this machine shows, its own, kept
//   /dev/sync/on/view       the host's handler that makes a view (share calls it)
//   /dev/sync/link          ephemeral: the server, connected or not, what moved, how many nodes are shown
//   /dev/sync/link/<hex>    ephemeral: each document synced with the server now
//
// The documents synced with the server are those /dev/sync/shared holds and,
// over and over, every document a placement in one names. The link holds
// each, so sync follows it. A document made here and in no shared folder is
// followed here and never sent.
//
// A node that is not a document, as the root and everything the image made
// are, is never given a new id. Sharing it is a view: a document made in
// /dev/sync/shared, its anchor, whose value is {view, value}, the path and
// that node's value, kept so. What is under the path is shown under the
// anchor's topic by presence.ts, live and read-only; so is whatever in a
// shared document is not a document, its ephemeral nodes among them. The
// path a view shows is read from /dev/sync/views, never from the anchor,
// which anyone with its id can write.
//
// The layer's sync keeps what it took in only in memory. So at each start, before any
// program runs, what Subduction's storage holds of the shared documents is
// taken in again, as on a host that keeps no graph (SYNC.tex, Starting
// again): applied again onto the nodes the SD card holds, with new times,
// leaving the values as they were.

import type { Graph } from "../../core/graph/typescript/graph.ts";
import type { Hash } from "../../core/graph/typescript/hash.ts";
import type { Id, Interface, Json, Listing, PlaceOp, ValueItem } from "../../core/graph/typescript/types.ts";
import { decode, type Value } from "../../core/graph/typescript/cbor.ts";
import type { Scheduler } from "../../core/scheduler/typescript/schedule.ts";
import { equal, isLive } from "../../core/graph/typescript/patch.ts";
import { bind, docOf, idOf, isSealed, publicKey, read as body, unhex, unwrap } from "../../layers/subduction/typescript/blob.ts";
import { unlocked } from "../../layers/subduction/typescript/lock.ts";
import { type Sync, sync as wrap } from "../../layers/subduction/typescript/sync.ts";
import type { Connection } from "../../layers/subduction/typescript/connect.ts";
import type { Storage } from "../../layers/subduction/typescript/storage.ts";
// deno-lint-ignore no-import-prefix
import type * as wasm from "npm:@automerge/subduction@0.23.0";
import type { Agent, Procs } from "./procs.ts";
import { type Holder, presence, type Said } from "./presence.ts";

export type Options = {
  /** the SD card; what sync keeps outside the graph is beside it, in <sd>.sync */
  sd: string;
  /** the bare graph */
  graph: Graph;
  /** the stack the wrapper is made over: protect over the keeper */
  below: Interface;
  procs: Procs;
  /** the host's agent, for what it does here */
  host: Agent;
  say: (text: string) => void;
};

export type Synced = {
  /** the wrapper, the top of the stack */
  api: Sync;
  /** resolves once what was committed here is in Subduction's storage, or after two seconds */
  flush(): Promise<void>;
};

const ROOT = new URL("../../", import.meta.url).pathname;
const SYNC = ["/", "dev", "sync"];
const SHARED = [...SYNC, "shared"];
const LINK = [...SYNC, "link"];
const VIEWS = [...SYNC, "views"];
const SERVER = "wss://galaxy.observer";

const hexOf = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The device's key: its seed, from <dir>/key, made there the first time. */
async function key(dir: string): Promise<string> {
  const file = `${dir}/key`;
  try {
    const seed = (await Deno.readTextFile(file)).trim();
    if (/^[0-9a-f]{64}$/.test(seed)) return seed;
  } catch {
    // none yet
  }
  const seed = hexOf(crypto.getRandomValues(new Uint8Array(32)));
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(file, seed + "\n", { mode: 0o600 });
  return seed;
}

/** procs as the scheduler the wrapper is begun with: arrive and time are procs'; start, fire and restart are not used here. */
function scheduler(p: Procs): Scheduler {
  const not = (op: string) => () => {
    throw new Error(`${op}: processes start and are called through procs, beneath sync`);
  };
  const s = {
    ...p.api,
    start: not("start"),
    fire: not("fire"),
    restart: not("restart"),
    // procs runs nothing before it answers: fn's operations run at the next settle
    batch: (fn: () => void) => {
      fn();
      return { runs: [], stopped: [] };
    },
  };
  Object.defineProperty(s, "time", { get: () => p.api.time });
  return s as unknown as Scheduler;
}

export async function sync(o: Options): Promise<Synced> {
  const g = o.graph;
  const p = o.procs;
  const HOST = o.host as unknown as Json;
  const dir = `${o.sd}.sync`;
  const seed = await key(dir);
  const me = publicKey(seed);
  const lock = unlocked();
  const look = (address: string[]) => g.read({ agent: "machine", address }) as ValueItem[];
  const listing = (address: string[]): Listing | undefined => {
    try {
      return g.directory({ agent: "machine", address });
    } catch {
      return undefined;
    }
  };

  // --- the sync root, /dev/sync: a document, its id from the made bytes its value keeps
  const at = look(SYNC)[0];
  const v = at?.value as { made?: unknown; key?: unknown } | undefined;
  let made = typeof v?.made === "string" && /^[0-9a-f]{64}$/.test(v.made) ? v.made : undefined;
  const node = at?.from.route.at(-1)?.node;
  if (!made || node !== idOf(bind(lock.name, made))) {
    if (at && node !== undefined) p.api.unplace({ agent: HOST, address: ["/", "dev"], name: "sync", id: node });
    made = lock.make()!;
    p.api.place({ agent: HOST, address: ["/", "dev"], name: "sync", id: idOf(bind(lock.name, made)), value: { key: me, lock: lock.name, made } });
  } else if (v?.key !== me) {
    p.api.write({ agent: HOST, address: SYNC, patches: [{ type: "snapshot", value: { key: me, lock: lock.name, made } }] });
  }
  // an earlier start's process node: sync.ts places its own anew at each start
  for (const [name, items] of (listing(SYNC) as { directory?: [string, { id: Id }[]][] })?.directory ?? []) {
    if (!name.startsWith("@")) continue;
    for (const i of items) p.api.unplace({ agent: HOST, address: SYNC, name, id: i.id, cause: { sync: "an earlier start's process" } });
  }
  if (!look(SHARED).length) p.api.place({ agent: HOST, address: SYNC, name: "shared", id: "sync-shared", value: null });
  if (!look(VIEWS).length) p.api.place({ agent: HOST, address: SYNC, name: "views", id: "sync-views", value: {} });

  // --- the wrapper, over protect and beneath procs: programs' operations go through it from here, procs' bookkeeping beneath it
  // a stand-in for another machine's live value is its kind, in PROTOCOL.tex's JSON form
  const live = (kind: string) => ({ "/": { live: kind } }) as Json;
  const s = wrap(o.below, { graph: g, clock: { get time() { return p.api.time; } }, key: me, seed, locks: [lock], root: made, roots: [ROOT], live });
  const top = p.top(s, s.bookkeeping);
  s.begin(scheduler(p));
  const link = {
    server: "",
    connected: false,
    peer: null as string | null,
    documents: 0,
    shown: 0,
    moved: { out: 0, in: 0, sent: 0, heard: 0 },
    stage: "",
    error: null as string | null,
  };
  let shown = JSON.stringify(link);
  top.place({ agent: HOST, address: SYNC, name: "link", id: "sync-link", value: link, ephemeral: true });

  /** What /dev/sync/shared holds: the documents shared or mounted here, by their hex. */
  function roots(): Set<Hash> {
    const out = new Set<Hash>();
    for (const [, items] of (listing(SHARED) as { directory?: [string, { id: Id }[]][] })?.directory ?? []) {
      for (const i of items) {
        const hex = docOf(i.id);
        if (hex) out.add(hex);
      }
    }
    return out;
  }

  /** The documents a placement in this one names, from what the store holds of it, loose commits and fragments. */
  function placed(doc: Hash): Hash[] {
    const out: Hash[] = [];
    for (const item of s.items) {
      if (item.doc !== doc || item.kind === "message") continue;
      const w = unwrap(item.blob);
      const opened = w && lock.open("", w.closed);
      if (!(opened instanceof Uint8Array)) continue;
      let sealed: Value;
      try {
        sealed = decode(opened);
      } catch {
        continue;
      }
      for (const one of item.kind === "loose" ? [sealed] : Array.isArray(sealed) ? sealed : []) {
        if (!isSealed(one)) continue;
        const b = body(new Uint8Array(one.change));
        if (b?.kind === "place" && b.id) out.push(b.id);
      }
    }
    return out;
  }

  /** The documents synced with the server now: the roots, and what they place, over and over. The link holds each. */
  const linked = new Set<Hash>();
  let synced = new Set<Hash>();
  function documents(): Hash[] {
    const out = new Set<Hash>();
    const queue = [...roots()];
    while (queue.length) {
      const hex = queue.shift()!;
      if (out.has(hex)) continue;
      out.add(hex);
      queue.push(...placed(hex));
    }
    for (const hex of out) {
      if (linked.has(hex)) continue;
      try {
        // a mount through sync: sync follows it
        top.place({ agent: HOST, address: LINK, name: hex, id: idOf(hex) });
        linked.add(hex);
      } catch (e) {
        link.error = `link ${hex.slice(0, 8)}: ${message(e)}`;
      }
    }
    for (const hex of [...linked]) {
      if (out.has(hex)) continue;
      linked.delete(hex);
      try {
        top.unplace({ agent: HOST, address: LINK, name: hex, id: idOf(hex) });
      } catch {
        // gone already
      }
    }
    link.documents = out.size;
    synced = out;
    return [...out];
  }

  // --- views: a folder that is not a document, shown through a document that stands for it

  /** Each view's anchor, by its hex, and the path it shows: /dev/sync/views, this machine's own, never another's. */
  const views = (): { [hex: string]: string } => {
    const v = look(VIEWS)[0]?.value;
    return v && typeof v === "object" && !Array.isArray(v) ? v as { [hex: string]: string } : {};
  };
  const address = (path: string) => ["/", ...path.split("/").filter((n) => n && n !== ".")];

  /**
   * A view of a path: a document made in /dev/sync/shared, as the caller,
   * whose value is {view, value}, the path and its node's value, and whose
   * topic carries what is under the path (presence.ts). The id of one there
   * already, if there is one.
   */
  function view(caller: Agent, path: string): Id {
    const names = address(path);
    const at = "/" + names.slice(1).join("/");
    const item = look(names)[0];
    if (names.length > 1 && !item) throw new Error(`nothing at ${at}`);
    const shared = roots();
    for (const [hex, where] of Object.entries(views())) if (where === at && shared.has(hex)) return idOf(hex);
    const agent = { ...caller, code: [...caller.code, { handler: "view", of: "host" }] } as unknown as Json;
    const value = item === undefined || isLive(item.value) ? null : item.value;
    // a making by name, with no id: sync gives it one from the lock (SYNC.tex, Making and mounting)
    const making = { agent, address: SHARED, name: "view", value: { view: at, value } } as unknown as PlaceOp;
    const id = (top.place(making).change as { id: Id }).id;
    const hex = docOf(id)!;
    top.place({ agent, address: SHARED, name: hex, id });
    top.unplace({ agent, address: SHARED, name: "view", id });
    p.api.write({ agent, address: VIEWS, patches: [{ type: "set", path: [], key: hex, value: at }] });
    return id;
  }
  p.hostHandler(["dev", "sync"], "view", (h, path) => view(h.caller, String(path ?? "/")));

  /** Keeps each anchor's value the path's node's value, when either changed. */
  const mirrored = new Map<Hash, { value: unknown; anchor: unknown }>();
  function mirror() {
    for (const [hex, path] of Object.entries(views())) {
      if (!synced.has(hex)) continue;
      const v = look(address(path))[0]?.value;
      const value = v === undefined || isLive(v) ? null : v;
      const anchor = look([...LINK, hex])[0]?.value as { view?: unknown; value?: unknown } | undefined;
      const was = mirrored.get(hex);
      if (was && was.value === value && was.anchor === anchor) continue;
      mirrored.set(hex, { value, anchor });
      if (anchor?.view === path && equal((anchor.value ?? null) as Json, value as Json)) continue;
      top.write({ agent: HOST, cause: { view: path }, address: [...LINK, hex], patches: [{ type: "snapshot", value: { view: path, value } as Json }] });
    }
  }

  // --- presence: what is not a document, under what is shared, shown live (presence.ts)

  const pres = presence({
    graph: g,
    key: me,
    roots: [ROOT],
    // a shared document's own topic first, so an ephemeral node in it is shown there, then the views
    holders() {
      const v = views();
      const out: Holder[] = [];
      for (const hex of synced) if (v[hex] === undefined) out.push({ topic: hex, address: [...LINK, hex], all: false });
      for (const hex of synced) if (v[hex] !== undefined) out.push({ topic: hex, address: address(v[hex]), all: true });
      return out;
    },
    hidden: () => settings().private,
    at: (hex) => synced.has(hex) ? [...LINK, hex] : undefined,
  });
  let topicOf: ((h: Hash) => wasm.Topic) | undefined;
  let presenting: Connection | undefined;
  let subscribed = new Set<Hash>();
  let sending: Promise<unknown> = Promise.resolve();
  function publish(m: Said) {
    const c = conn;
    const t = topicOf;
    if (!c || c.offline || !t) return;
    sending = sending.then(async () => {
      if (!subscribed.has(m.topic)) {
        subscribed.add(m.topic);
        await c.node.subscribeEphemeral([t(m.topic)]);
      }
      await c.node.publishEphemeral(t(m.topic), m.payload);
    }).catch((e) => {
      link.error = `presence: ${message(e)}`;
    });
  }

  // --- the connection: made when something is shared, offline first, so a start takes in what is stored before any program runs

  let storage: Storage | undefined;
  let conn: Connection | undefined;
  let opening: Promise<void> | undefined;
  /** when joining was last tried */
  let tried = -Infinity;

  const settings = () => {
    const v = look(["/", "etc", "sync"])[0]?.value as { server?: unknown; private?: unknown } | undefined;
    return {
      server: typeof v?.server === "string" ? v.server : SERVER,
      // paths never shown in a view or a shared folder
      private: Array.isArray(v?.private) ? v.private.filter((x): x is string => typeof x === "string") : [],
    };
  };

  async function open() {
    const { Storage } = await import("../../layers/subduction/typescript/storage.ts");
    const { files } = await import("../../layers/subduction/typescript/deno/files.ts");
    const { connect, legacy, local } = await import("../../layers/subduction/typescript/connect.ts");
    // deno-lint-ignore no-import-prefix
    const { Topic } = await import("npm:@automerge/subduction@0.23.0");
    topicOf = (h) => Topic.fromBytes(unhex(h));
    storage ??= await Storage.open(files(`${dir}/store`));
    link.server = settings().server;
    // what is heard goes to sync.ts, and to presence, which answers wants and wants what has no stand-in
    const d = local(s, { documents });
    const device = { ...d, hear: (m: Parameters<typeof d.hear>[0]) => (pres.heard(m), d.hear(m)) };
    // each document stored under legacy(id), as galaxy.observer needs and an open server takes
    conn = await connect(device, { seed, server: link.server, storage, offline: true, tree: legacy });
  }

  /** Joins the server; on failure, tried again in ten seconds. */
  let joining = false;
  function join() {
    const c = conn;
    if (!c || !c.offline || joining || performance.now() - tried < 10000) return;
    tried = performance.now();
    joining = true;
    c.setOffline(false).then(() => {
      link.error = null;
      o.say(`sync: joined ${link.server} as ${me.slice(0, 16)}…`);
    }, (e) => {
      link.error = `joining ${link.server}: ${message(e)}`;
    }).finally(() => (joining = false));
  }

  // a start: what the store holds of the shared documents is taken in before any program runs
  if (roots().size) {
    try {
      await open();
    } catch (e) {
      link.error = message(e);
      o.say(`sync: the store could not be read: ${message(e)}`);
    }
  }

  // --- each quarter second: the wall clock, the settings, a round when something changed, the link's value

  let ticked = performance.now();
  let pumped = -1;
  let last = 0;
  let had = "";
  const turn = () => {
    const now = performance.now();
    if (now - ticked >= 1000) {
      s.tick(Math.round(now - ticked));
      ticked = now;
    }
    mirror();
    const want = settings().server;
    const rooted = [...roots()].sort().join(" ");
    if (!conn && !opening && rooted) {
      opening = open().catch((e) => {
        link.error = message(e);
      }).finally(() => (opening = undefined));
    }
    if (conn && !opening && want !== link.server) {
      // another server: this connection closes, and the next turn opens one on the same storage
      const c = conn;
      conn = undefined;
      tried = -Infinity;
      opening = c.close().finally(() => (opening = undefined));
      o.say(`sync: the server is now ${want}`);
    }
    if (conn) {
      if (rooted) join();
      if (s.items.length !== pumped || rooted !== had || now - last > 2000) {
        pumped = s.items.length;
        had = rooted;
        last = now;
        conn.pump();
      }
      link.connected = !!conn.peer && !conn.offline;
      if (link.connected) {
        if (presenting !== conn) {
          // a new connection: everything shown is sent again
          presenting = conn;
          subscribed = new Set();
          pres.again();
        }
        pres.turn(now);
        for (const m of pres.take()) publish(m);
      }
      link.shown = pres.size;
      link.peer = conn.peer || null;
      link.moved = { ...conn.moved };
      link.stage = conn.stage;
      const failed = conn.log.findLast((e) => "error" in e);
      if (failed && typeof failed.at === "number" && Date.now() - failed.at < 10000) link.error = String(failed.error);
    } else link.connected = false;
    const text = JSON.stringify(link);
    if (text === shown) return;
    shown = text;
    try {
      top.write({ agent: HOST, address: LINK, patches: [{ type: "snapshot", value: link as unknown as Json }] });
    } catch {
      // its node is gone
    }
  };
  setInterval(() => {
    try {
      turn();
    } catch (e) {
      link.error = message(e);
    }
  }, 250);

  return {
    api: s,
    async flush() {
      if (conn) await Promise.race([conn.pump(), sleep(2000)]);
      await storage?.flush();
    },
  };
}
