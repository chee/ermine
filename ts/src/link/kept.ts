// A kept mirror: another host's served subtree, copied into this graph as
// ordinary nodes, so whoever keeps this graph keeps the copy too. The other
// kind, mirror.ts, keeps it in ephemeral nodes and catches writes with a
// wrapper on the stack; this one needs no wrapper.
//
// The copy. The process is started with the value {"channel": c, "name": n}
// (mirror.ts's), and the owner's served node is copied to ./n, beside the
// process node. Each copy node is an ordinary node the mirror's process
// makes, one for each of the owner's nodes: the copy of the owner's node o is
// the node "<p>:<o>", p being the copy's place from the graph's root
// (mounts/92d99c44:doc), or o itself for a node made here and sent (below).
// A node the owner has in two slots is one node here in two slots. Of a
// union, only the first member is followed, as mirror.ts does. Each copy
// change is the mirror process's, so its agent is the process's own (its
// lasting interface fixes it), and its cause says whose change it copies:
// {"owner": {"node": o, "time": t, "agent": a, "process"?: q, "cause"?: c}},
// t the owner's time, a the owner's agent. The owner's ephemeral nodes are
// copied as ordinary nodes too: the copy is kept as it was last seen.
//
// Local changes. The mirror subscribes, as its process, to each copy node's
// address, so it sees every change anyone else makes there (its own are its
// process's, and pass). Each is sent to the owner with the agent and cause it
// had here; the owner stamps the agent with this peer (serve.ts).
//   - A write to a copy node shows at once as a layer: an ephemeral node, the
//     process's, placed first in the slot with the value written, whose cause
//     is {"sending": "write", "address": a, "agent": who, "cause"?: why};
//     the copy node goes back to the owner's value, so the copy says only
//     what the owner said. Writes while the layer is up are writes to the
//     layer (the address reaches it), sent in turn. When every one is
//     answered, the layer goes ({"link": owner, "answered": "write", ...})
//     and the owner's changes, held meanwhile, are applied to the copy.
//   - A place in a copy node is sent with its id as it is here (a copy's id
//     as the owner's): the node shows at once, being an ordinary node here,
//     and when the owner has it, its own id's copy is this node.
//   - An unplace is sent with the owner's id; it shows at once.
// The owner refusing: the mirror's compute throws the owner's error, so it
// shows as an error item on the mirror process, until the owner next takes
// something it sends; a refused place's node is unplaced again, and a
// refused unplace's node placed again from the owner's listing.
//
// The status node: ./pid/link, ephemeral, {"state": "dialing" | "mounted" |
// "gone", "owner"?: peer, "why"?: text, "sending": n, "refused"?: {"cmd",
// "address", "error"}}.
//
// The owner going: the copy stays, as it was last seen, and the status says
// gone. Killing the mirror unplaces the copy's root (its nodes stay in the
// graph, reached by nothing). Starting it again where it was, as a boot image
// does after a reload, reconciles: each copy node already in its slot is
// kept and written only if the owner's value differs; what the owner no longer
// has is unplaced; nothing is made twice. A node someone made in the copy
// while the mirror was not running, which the owner never had, is left alone.

import { applyPatches, equal } from "../patch.ts";
import type { Builtin, ComputeGiven, EffectGiven, Running } from "../loaders.ts";
import {
  type Change,
  type ErrorJson,
  type Event,
  type Header,
  type Id,
  type Interface,
  Invalid,
  type Json,
  type Listing,
  ours,
  type Patch,
  type PlaceOp,
  Refused,
  type SlotItem,
  type UnplaceOp,
  type ValueItem,
  type WriteOp,
} from "../types.ts";
import { mount, type Remote } from "./mount.ts";
import { type Config, errorOf, isConfig } from "./mirror.ts";
import type { Timing, Transport } from "./wire.ts";

ours(import.meta.url);

export type KeptOptions = Timing & {
  /** The transport for the channel a mirror's value names. */
  connect: (channel: string) => Transport;
  /** The agent the mirror reads and subscribes to the owner as; null if not given. */
  agent?: Json;
  /** The top of the host's stack: to unplace the copy's root when the mirror is killed. */
  api: () => Interface;
};

/** What kept mirrors give a host: the program for builtin's table, and the links running. */
export type KeptMirrors = {
  readonly program: Builtin;
  readonly links: ReadonlyMap<Id, KeptLink>;
};

/** The status a kept mirror says in ./pid/link. */
type Status = {
  state: "dialing" | "mounted" | "gone";
  owner?: string;
  why?: string;
  sending: number;
  refused?: { cmd: string; address: string[]; error: ErrorJson };
};

/** The copy of one path below the root. */
type Path = {
  path: string[];
  /** the owner's node there, and its copy here */
  owner?: Id;
  local?: Id;
  /** the owner's value, and the change that set it */
  value?: Json;
  change?: Header;
  time: number;
  remoteSub?: number;
  localSub?: number;
  ready: boolean;
  syncing: boolean;
  again: boolean;
  /** the owner's events held: before the first read, or while a layer is up */
  held: Event[];
  /** the layer in front of the copy node, while writes are in flight */
  layer?: Id;
  flight: number;
};

const key = (path: readonly string[]) => JSON.stringify(path);

/** The host's kept mirrors: one link for each process running the program. */
export function kept(options: KeptOptions): KeptMirrors {
  const links = new Map<Id, KeptLink>();
  const program: Builtin = {
    compute({ api, name, pending }: ComputeGiven) {
      // the owner's last refusal, until it next takes something: an error item on this process.
      // Read before the process's own node, and thrown without reading it: a failed run puts
      // an item in front of the process's value, which would mark a compute that read it, and
      // that one would fail again, for ever
      const status = api.read({ address: [name, "link"] }).find((i) => "value" in i) as
        | ValueItem
        | undefined;
      const refused = (status?.value as Status | undefined)?.refused;
      if (refused) {
        const why = { ...refused.error.why, address: refused.address };
        throw refused.error.kind === "refused"
          ? new Refused(why, refused.cmd)
          : new Invalid(why, refused.cmd);
      }
      const own = api.read({ address: [name] }).find((i) => "value" in i) as ValueItem | undefined;
      if (!own) return pending;
      if (!isConfig(own.value)) {
        throw new Invalid({
          code: "wrong-field",
          field: "value",
          text: 'a mirror\'s value is {"channel": c, "name": n}',
        });
      }
      return { channel: own.value.channel, name: own.value.name };
    },
    effect({ self, name, cwd, value, lasting }: EffectGiven) {
      if (links.has(self) || !isConfig(value)) return;
      const link = new KeptLink(options, {
        pid: self,
        status: [name, "link"],
        cwd: [...cwd],
        config: value,
        lasting,
      });
      links.set(self, link);
      link.start();
    },
    killed(p: Running) {
      const link = links.get(p.id);
      links.delete(p.id);
      link?.end("the mirror was stopped");
    },
  };
  return { program, links };
}

/** The link one kept mirror process holds, and its copy. */
export class KeptLink {
  readonly pid: Id;
  readonly prefix: string;
  #options: KeptOptions;
  #lasting: EffectGiven["lasting"];
  #cwd: string[];
  #name: string;
  #channel: string;
  #status: string[];
  #remote: Remote | undefined;
  #ended = false;
  #count = 0;
  #state: Status = { state: "dialing", sending: 0 };
  #paths = new Map<string, Path>();
  /** local ids placed here and sent, not yet answered: a listing does not take them away */
  #placing = new Set<Id>();
  /** each copy node and layer here, to its path */
  #ids = new Map<Id, string[]>();
  #owner = "";

  constructor(
    options: KeptOptions,
    at: {
      pid: Id;
      status: string[];
      cwd: string[];
      config: Config;
      lasting: EffectGiven["lasting"];
    },
  ) {
    this.#options = options;
    this.pid = at.pid;
    this.#lasting = at.lasting;
    this.#cwd = at.cwd;
    this.#name = at.config.name;
    this.#channel = at.config.channel;
    this.#status = at.status;
    this.prefix = `${[...at.cwd, at.config.name].join("/")}:`;
  }

  /** The path below the root of a copy node or a layer, by its id; undefined for any other. */
  pathOf(id: Id): string[] | undefined {
    const path = this.#ids.get(id);
    return path && [...path];
  }

  get #agent(): Json {
    return this.#options.agent ?? null;
  }

  async start() {
    try {
      this.#lasting.place({
        address: this.#status.slice(0, -1),
        name: this.#status[this.#status.length - 1],
        id: `${this.pid}/link`,
        value: this.#state as unknown as Json,
        ephemeral: true,
      } as PlaceOp);
    } catch { /* there already */ }
    let remote: Remote;
    try {
      remote = await mount(this.#options.connect(this.#channel), this.#options);
    } catch (e) {
      return this.#gone(e instanceof Error ? e.message : String(e));
    }
    if (this.#ended) return void remote.close().catch(() => {});
    this.#remote = remote;
    this.#owner = remote.owner;
    remote.closed.then((why) => this.#gone(why));
    this.#say({ state: "mounted", owner: remote.owner });
    this.#sync([]).catch(() => {});
  }

  /** The process was killed: the link ends, and the copy's root is unplaced. */
  end(why: string) {
    if (this.#ended) return;
    this.#ended = true;
    this.#remote?.close(why).catch(() => {});
    const root = this.#paths.get(key([]))?.local;
    const subs = [...this.#paths.values()].flatMap((p) => p.localSub ?? []);
    this.#paths.clear();
    // the stack the process ran on (a host may have moved to another graph by the time this runs),
    // after the kill that called this has finished
    const api = this.#options.api();
    queueMicrotask(() => {
      for (const sub of subs) {
        try {
          api.unsubscribe({ agent: this.#agent, sub });
        } catch { /* gone with the process */ }
      }
      if (root === undefined) return;
      try {
        api.unplace({
          agent: this.#agent,
          address: this.#cwd,
          name: this.#name,
          id: root,
          cause: { stopped: this.pid },
        });
      } catch { /* its place is gone too */ }
    });
  }

  #say(change: Partial<Status>) {
    this.#state = { ...this.#state, ...change };
    for (const [k, v] of Object.entries(this.#state)) {
      if (v === undefined) delete (this.#state as { [k: string]: unknown })[k];
    }
    if (this.#ended) return;
    try {
      this.#lasting.write({
        address: this.#status,
        patches: [{ type: "snapshot", value: this.#state as unknown as Json }],
      } as WriteOp);
    } catch { /* killed meanwhile */ }
  }

  /** The owner went: the copy stays as it was last seen. */
  #gone(why: string) {
    if (this.#ended) return;
    for (const p of this.#paths.values()) {
      p.remoteSub = undefined;
      p.held = [];
      p.flight = 0;
      if (p.layer) this.#lift(p, { gone: why });
    }
    this.#placing.clear();
    this.#remote = undefined;
    this.#say({ state: "gone", why, sending: 0 });
  }

  // addresses, from the process's place

  /** The address of a path's copy node. */
  #at(path: readonly string[]): string[] {
    return [this.#name, ...path];
  }

  /** The slot a path's copy node is in. */
  #slot(path: readonly string[]): { address: string[]; name: string } {
    if (!path.length) return { address: [], name: this.#name };
    return { address: [this.#name, ...path.slice(0, -1)], name: path[path.length - 1] };
  }

  /** The ids in a path's slot here, ephemeral ones (layers) left out. */
  #here(path: readonly string[]): Id[] {
    try {
      const l = this.#lasting.directory(this.#slot(path)) as Listing;
      return "items" in l ? l.items.filter((i) => !i.ephemeral).map((i) => i.id) : [];
    } catch {
      return [];
    }
  }

  /** The copy of the owner's id, in a slot that holds these ids. */
  #copyOf(owner: Id | undefined, slot: readonly Id[]): Id {
    if (owner !== undefined && slot.includes(owner)) return owner;
    return this.prefix + (owner ?? "");
  }

  /** The owner's id for an id here: a copy's, or the id itself. */
  #ownerOf(local: Id): Id {
    return local.startsWith(this.prefix) ? local.slice(this.prefix.length) : local;
  }

  /** A copy change's cause: the owner's change it copies. */
  #cause(change: Header | undefined, node: Id | undefined): Json {
    const owner: { [k: string]: Json } = { link: this.#owner };
    if (node !== undefined) owner.node = node;
    if (change) {
      owner.time = change.time;
      owner.agent = change.agent;
      if (change.process !== undefined) owner.process = change.process;
      if (change.cause !== undefined) owner.cause = change.cause;
    }
    return { owner };
  }

  /** The copy node's own value here, wherever it is in its slot. */
  #localValue(p: Path): Json | undefined {
    try {
      const items = this.#lasting.read({ address: this.#at(p.path) }) as ValueItem[];
      const mine = items.find((i) => "value" in i && i.from.route.at(-1)?.node === p.local);
      return mine?.value;
    } catch {
      return undefined;
    }
  }

  // the copy

  /** Copies one path from the owner, and everything below it, and follows it. */
  async #sync(path: string[]): Promise<void> {
    const remote = this.#remote;
    if (!remote || this.#ended) return;
    const k = key(path);
    let p = this.#paths.get(k);
    if (!p) {
      p = {
        path,
        time: -Infinity,
        ready: false,
        syncing: false,
        again: false,
        held: [],
        flight: 0,
      };
      this.#paths.set(k, p);
    }
    if (p.syncing) {
      p.again = true;
      return;
    }
    p.syncing = true;
    try {
      if (p.remoteSub === undefined) {
        const at = p;
        p.remoteSub = (await remote.subscribe({
          agent: this.#agent,
          address: path,
          send: (event) => this.#remoteEvent(at, event),
        })).sub;
      }
      const [items, listing] = await Promise.all([
        remote.read({ agent: this.#agent, address: path }),
        remote.directory({ agent: this.#agent, address: path }),
      ]);
      if (this.#ended || this.#paths.get(k) !== p) return;
      if (p.layer) {
        // a write is in flight here: this read is done again when it is answered
        p.again = true;
        return;
      }
      const first = items.find((i) => "value" in i);
      if (!first) return this.#drop(p);
      this.#copy(p, first);
      p.ready = true;
      for (const e of p.held.splice(0)) this.#apply(p, e);
      const names = "directory" in listing ? listing.directory : [];
      const owned = new Map<string, SlotItem>();
      for (const [name, slot] of names as [string, SlotItem[]][]) {
        const member = slot.find((i) => !i.pending);
        if (member) owned.set(name, member);
      }
      this.#reconcile(p, owned);
      await Promise.all([...owned.keys()].map((name) => this.#sync([...path, name])));
    } catch {
      // the link went, or the path did: what follows from that is said elsewhere
    } finally {
      p.syncing = false;
      if (p.again && !this.#ended && this.#paths.get(k) === p && !p.layer) {
        p.again = false;
        this.#sync(path).catch(() => {});
      }
    }
  }

  /** Makes the path's copy node the owner's node's, placing it, or writing it if it differs. */
  #copy(p: Path, item: ValueItem) {
    const owner = item.from.route.at(-1)?.node;
    const slot = this.#slot(p.path);
    const ids = this.#here(p.path);
    const local = this.#copyOf(owner, ids);
    const cause = this.#cause(item.change, owner);
    if (p.local !== undefined && p.local !== local) this.#dropBelow(p.path);
    // a copy of another of the owner's nodes in this slot: the owner's is this one now
    for (const id of ids) {
      if (id !== local && id.startsWith(this.prefix) && !this.#placing.has(id)) {
        this.#unplace(slot, id, cause);
      }
    }
    if (!ids.includes(local)) {
      try {
        this.#lasting.place({ ...slot, id: local, value: item.value, cause } as PlaceOp);
      } catch {
        // the node is here already, elsewhere in the copy, or kept from before: placed again
        this.#lasting.place({ ...slot, id: local, cause } as PlaceOp);
      }
    }
    p.owner = owner;
    p.local = local;
    p.value = item.value;
    p.change = item.change;
    p.time = item.change?.time ?? p.time;
    this.#ids.set(local, p.path);
    const here = this.#localValue(p);
    if (here === undefined || !equal(here, item.value)) {
      this.#lasting.write({
        address: this.#at(p.path),
        patches: [{ type: "snapshot", value: item.value }],
        cause,
      } as WriteOp);
    }
    if (p.localSub === undefined) {
      const at = p;
      p.localSub = this.#lasting.subscribe({
        address: this.#at(p.path),
        send: (event: Event) => this.#localEvent(at, event),
      }).sub;
    }
  }

  /** Unplaces from a path's copy node each copy the owner no longer has there. */
  #reconcile(p: Path, owned: Map<string, SlotItem>) {
    let listing: Listing;
    try {
      listing = this.#lasting.directory({ address: this.#at(p.path) }) as Listing;
    } catch {
      return;
    }
    if (!("directory" in listing)) return;
    for (const [name, items] of listing.directory) {
      const theirs = owned.get(name);
      const ids = items.filter((i) => !i.ephemeral).map((i) => i.id);
      const want = theirs ? this.#copyOf(theirs.id, ids) : undefined;
      for (const id of ids) {
        if (id === want || this.#placing.has(id)) continue;
        // a node someone made here that the owner never had is theirs: left alone
        if (!id.startsWith(this.prefix) && !this.#ids.has(id)) continue;
        this.#unplace(
          { address: this.#at(p.path), name },
          id,
          this.#cause(theirs?.change, undefined),
        );
        if (!theirs) this.#forget([...p.path, name]);
      }
    }
  }

  #unplace(slot: { address: string[]; name: string }, id: Id, cause: Json) {
    try {
      this.#lasting.unplace({ ...slot, id, cause } as UnplaceOp);
    } catch { /* gone already */ }
  }

  /** Stops following a path and every path below it. */
  #forget(path: readonly string[]) {
    for (const [k, p] of this.#paths) {
      const q = p.path;
      if (q.length >= path.length && path.every((n, i) => q[i] === n)) {
        this.#paths.delete(k);
        if (p.local !== undefined) this.#ids.delete(p.local);
        if (p.remoteSub !== undefined) {
          this.#remote?.unsubscribe({ agent: this.#agent, sub: p.remoteSub }).catch(() => {});
        }
        if (p.localSub !== undefined) {
          try {
            this.#lasting.unsubscribe({ sub: p.localSub });
          } catch { /* killed */ }
        }
      }
    }
  }

  /** Stops following the paths below one: its copy node is another now. */
  #dropBelow(path: readonly string[]) {
    for (const p of [...this.#paths.values()]) {
      if (p.path.length > path.length && path.every((n, i) => p.path[i] === n)) {
        this.#forget(p.path);
      }
    }
  }

  /** The owner has nothing at the path now. */
  #drop(p: Path) {
    if (!p.path.length) return; // the served node itself: the copy stays as it was seen
    if (p.local !== undefined) {
      this.#unplace(this.#slot(p.path), p.local, { owner: { link: this.#owner } });
    }
    this.#forget(p.path);
  }

  #remoteEvent(p: Path, event: Event) {
    if (this.#ended || this.#paths.get(key(p.path)) !== p) return;
    if (!p.ready || p.layer) {
      p.held.push(event);
      return;
    }
    this.#apply(p, event);
  }

  /** One of the owner's events for a path, applied to its copy. */
  #apply(p: Path, event: Event) {
    if (!("change" in event) || event.reaches !== undefined) {
      this.#sync(p.path).catch(() => {});
      return;
    }
    const change = event.change;
    if (change.kind === "write" && change.node === p.owner) {
      if (change.time <= p.time) return;
      try {
        p.value = applyPatches(p.value ?? null, change.patches);
        p.time = change.time;
        p.change = change;
        this.#lasting.write({
          address: this.#at(p.path),
          patches: change.patches as Patch[],
          cause: this.#cause(change, change.node),
        } as WriteOp);
      } catch {
        this.#sync(p.path).catch(() => {});
      }
      return;
    }
    // a placement or an unplacement in its directory: read again
    this.#sync(p.path).catch(() => {});
  }

  // local changes

  #localEvent(p: Path, event: Event) {
    if (this.#ended || !("change" in event)) return;
    const change = event.change;
    if (change.process === this.pid) return; // the mirror's own
    // after the change that sent it has finished
    queueMicrotask(() => this.#local(p, change));
  }

  /** Someone else's change to a copy node: sent to the owner. */
  #local(p: Path, change: Change) {
    const remote = this.#remote;
    if (this.#ended || this.#paths.get(key(p.path)) !== p) return;
    const who = {
      agent: change.agent,
      ...(change.cause === undefined ? {} : { cause: change.cause }),
    };
    const sent = (cmd: string, done: (e?: unknown) => void, call: Promise<unknown>) => {
      this.#say({ sending: this.#state.sending + 1 });
      call.then(() => done(), (e) => done(e ?? new Error(`${cmd} failed`)))
        .finally(() => this.#say({ sending: Math.max(0, this.#state.sending - 1) }));
    };
    if (!remote) {
      // no owner to send it to: the copy says the owner's value again, and why
      this.#refused("write", p.path, {
        kind: "invalid",
        why: { code: "gone", text: "the mirror's link is gone" },
      });
      if (change.kind === "write" && p.value !== undefined && !p.layer) {
        this.#lasting.write({
          address: this.#at(p.path),
          patches: [{ type: "snapshot", value: p.value }],
          cause: { gone: this.#state.why ?? "not mounted" },
        } as WriteOp);
      }
      return;
    }
    if (change.kind === "write") {
      if (change.node !== p.local && change.node !== p.layer) return;
      if (!p.layer) {
        // the copy node itself was written: it says the owner's value again, and the layer what was written
        const written = this.#localValue(p);
        if (p.value !== undefined) {
          this.#lasting.write({
            address: this.#at(p.path),
            patches: [{ type: "snapshot", value: p.value }],
            cause: this.#cause(p.change, p.owner),
          } as WriteOp);
        }
        if (written !== undefined) {
          const id = `${this.pid}/~${++this.#count}`;
          try {
            this.#lasting.place({
              ...this.#slot(p.path),
              id,
              value: written,
              ephemeral: true,
              position: 0,
              cause: sending("write", p.path, who),
            } as PlaceOp);
            p.layer = id;
            this.#ids.set(id, p.path);
          } catch { /* the slot is gone */ }
        }
      }
      p.flight++;
      sent(
        "write",
        (e) => this.#settle(p, "write", e),
        remote.write({ ...who, address: p.path, patches: change.patches }),
      );
      return;
    }
    if (change.node !== p.local) return; // a placement in a layer is the layer's own
    if (change.kind === "place") {
      if (change.ephemeral) return; // a process's own node here: never the owner's
      const id = change.id;
      this.#placing.add(id);
      sent(
        "place",
        (e) => {
          this.#placing.delete(id);
          if (e === undefined) return this.#ok();
          this.#refused("place", [...p.path, change.name], errorOf(e));
          // the owner did not take it: it is not in the copy
          this.#unplace({ address: this.#at(p.path), name: change.name }, id, {
            refused: errorOf(e) as unknown as Json,
          });
        },
        remote.place({
          ...who,
          address: p.path,
          name: change.name,
          id: this.#ownerOf(id),
          ...(change.value === undefined ? {} : { value: change.value }),
          ...(change.position === undefined ? {} : { position: change.position }),
        }),
      );
      return;
    }
    if (change.kind === "unplace") {
      sent(
        "unplace",
        (e) => {
          if (e === undefined) return this.#ok();
          this.#refused("unplace", [...p.path, change.name], errorOf(e));
          this.#sync(p.path).catch(() => {}); // placed again from the owner's listing
        },
        remote.unplace({
          ...who,
          address: p.path,
          name: change.name,
          id: this.#ownerOf(change.id),
        }),
      );
    }
  }

  #ok() {
    if (this.#state.refused) this.#say({ refused: undefined });
  }

  #refused(cmd: string, address: string[], error: ErrorJson) {
    this.#say({ refused: { cmd, address, error } });
  }

  /** A write was answered: when none is in flight on the path, the layer goes and the owner's changes come. */
  #settle(p: Path, cmd: string, e: unknown) {
    if (e === undefined) this.#ok();
    else this.#refused(cmd, p.path, errorOf(e));
    p.flight = Math.max(0, p.flight - 1);
    if (p.flight || this.#ended) return;
    if (p.layer) {
      this.#lift(p, {
        link: this.#owner,
        answered: cmd,
        address: p.path,
        ...(e === undefined ? {} : { refused: errorOf(e) as unknown as Json }),
      });
    }
    for (const event of p.held.splice(0)) this.#apply(p, event);
    if (p.again) {
      p.again = false;
      this.#sync(p.path).catch(() => {});
    }
  }

  #lift(p: Path, cause: Json) {
    const id = p.layer!;
    p.layer = undefined;
    this.#ids.delete(id);
    this.#unplace(this.#slot(p.path), id, cause);
  }
}

/** A layer's cause: what is being sent, where, on whose behalf, and why (the sender's site). */
function sending(cmd: string, address: string[], who: { agent: Json; cause?: Json }): Json {
  return {
    sending: cmd,
    address,
    agent: who.agent,
    ...(who.cause === undefined ? {} : { cause: who.cause }),
  };
}
