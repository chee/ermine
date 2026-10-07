// A mirror: another host's served subtree, kept in this graph as ordinary
// reads see it. A process holds a local copy of what the owner serves (serve.ts),
// in ephemeral nodes it makes, kept in step by the link's subscriptions; so
// every read here stays synchronous, and reads an empty list (nothing known
// yet, CORE.tex, Reads are lists) until data has come. Nothing in program
// code is a promise: asynchrony shows only as items and changes.
//
// The copy. The mirror's process is started with the value
// {"channel": c, "name": n}; the host's connect(c) gives the transport, and
// the owner's served node is copied to ./n, beside the process node. Each
// copy node is ephemeral and made by the mirror's process, so whoever keeps
// this graph never keeps it (CORE.tex, Ephemeral nodes: an ordinary node
// would be kept "with nothing that made it"), and when the process is killed
// the scheduler lets the whole copy go (SCHEDULER.tex, Ephemeral nodes): the
// place reads as nothing again. Each copy change is made as IDEAS.tex has
// history from elsewhere enter: with the owner's change's agent, given a
// time here, marking readers as any change; its process is the mirror's (the
// local process that made it, so it may make ephemeral nodes), and its cause
// says where it came from: {"link": owner, "time": t, "process"?: p,
// "cause"?: c}, t being the owner's time. A copy node is one per path, so a
// node the owner has in two places is two copies here (an ephemeral node is
// in one slot); of a union, only the first member is followed and holds the
// children, the others are copied as they were when the slot was last read.
// The owner's mounted ids that are not here are not copied.
//
// Writing through. A wrapper on the top of the stack (CORE.tex, Running and
// wrapping) sees every write, place and unplace: one whose walk passes the
// mirror's root copy, by the route a read of its address gives from the
// graph's root, is sent to the owner, its address the names below the root.
// The mirror's own operations (its process's) pass. A write, or a place
// that makes a node, shows at once as a layer: an ephemeral node placed in
// front of the node in its slot, as IDEAS.tex's dragged shape (or, for a
// place, a new ephemeral node where the owner's will be), whose item comes
// first and whose change's cause is {"sending": cmd, "address": a, "agent":
// who, "cause"?: why}: the layer's change is the mirror process's, so its
// cause names whoever sent it and that sender's own cause (its site). An
// unplace, and a place that mounts or moves an id, have no layer: a layer
// cannot hide a member, so they show when the owner's change comes back.
// While anything is in flight, the owner's events wait, and when an answer
// comes, every layer is taken away, the events are applied, and the layers
// still in flight are placed again over the copy as it now is: so the copy
// takes the owner's value, and an answered write's layer goes. Every layer
// taken away is an unplacement whose cause says why: {"link": owner,
// "answered": cmd, "address": a, "refused"?: error} when an answer came,
// {"link": owner} when the owner's change came, {"gone": why} when the link
// went. A refusal is listed in the status node too. An operation with no
// layer answers with the status write that counts it in flight.
//
// The status node: ./pid/link, ephemeral, {"state": "dialing" | "mounted" |
// "unplaced" | "gone", "owner"?: peer, "why"?: text, "sending": n,
// "refused": [...], "failed": [...], "shadowed": [...]}, each refusal
// {"cmd", "address", "error"}, the last ten; each failure the same, for what
// could not be done here (a copy change, or the local part of a write sent),
// the last ten; shadowed lists the paths whose copy some other node is in
// front of, so that their addresses reach that node: the owner's changes
// there are not written to it, and wait until the copy is reached again.
//
// The root copy unplaced here: the state says "unplaced", and the owner's
// events are no longer applied; nothing is placed again. Restarting the
// process makes a new link.
//
// The owner going: the link ends, the copy is let go (its place reads as
// nothing, as before it came), and the status says gone, and why.
// Restarting the process makes a new link.

import { applyPatches, isObject } from "../patch.ts";
import type { Builtin, ComputeGiven, EffectGiven, Running } from "../loaders.ts";
import type { Scheduled, Scheduler } from "../schedule.ts";
import {
  type Acting,
  type Address,
  type Changed,
  ErmineError,
  type ErrorJson,
  type Event,
  type Header,
  type Id,
  invalid,
  type Json,
  type Listing,
  ours,
  type Patch,
  type PlaceOp,
  type SlotItem,
  told,
  type UnplaceOp,
  type ValueItem,
  type WriteOp,
} from "../types.ts";
import { mount, type Remote, Thrown, Unsupported } from "./mount.ts";
import type { Timing, Transport } from "./wire.ts";

ours(import.meta.url);

export type MirrorOptions = Timing & {
  /** The transport for the channel a mirror's value names. */
  connect: (channel: string) => Transport;
  /** The agent the mirror reads and subscribes to the owner as; null if not given. */
  agent?: Json;
};

/** What mirrors gives a host: the program to put in its builtin table, and the wrapper. */
export type Mirrors = {
  /** The mirror's program, for builtin's table. */
  readonly program: Builtin;
  /**
   * Wraps the scheduler, which must not have been told its top yet: the
   * result is the top of the stack, which the host uses from then on.
   */
  wrap(api: Scheduler): Scheduler;
  /** The links running now, by the pid of the process that holds each. */
  readonly links: ReadonlyMap<Id, Link>;
};

/** What a mirror's value says (both kinds: this one, and kept.ts's). */
export type Config = { channel: string; name: string };

export const isConfig = (v: unknown): v is Config =>
  isObject(v) && typeof v.channel === "string" && typeof v.name === "string" && v.name !== "" &&
  v.name !== "." && v.name !== ".." && v.name !== "/";

/** The host's mirrors: one link for each mirror process running. */
export function mirrors(options: MirrorOptions): Mirrors {
  const links = new Map<Id, Link>();
  let inner: Scheduler | undefined;

  const program: Builtin = {
    compute({ api, name, pending }: ComputeGiven) {
      const own = api.read({ address: [name] }).find((i) => "value" in i) as ValueItem | undefined;
      if (!own) return pending;
      if (!isConfig(own.value)) {
        throw invalid("wrong-field", 'a mirror\'s value is {"channel": c, "name": n}', {
          field: "value",
        });
      }
      return { channel: own.value.channel, name: own.value.name };
    },
    effect({ self, name, cwd, value, lasting }: EffectGiven) {
      if (links.has(self) || !isConfig(value)) return;
      if (!inner) throw invalid("not-wrapped", "the mirrors' wrapper is not on the stack");
      const link = new Link(inner, options, {
        pid: self,
        status: [name, "link"],
        cwd: [...cwd],
        root: value.name,
        lasting,
      });
      links.set(self, link);
      link.start(value.channel);
    },
    killed(p: Running) {
      const link = links.get(p.id);
      links.delete(p.id);
      link?.end("the mirror was stopped");
    },
  };

  function wrap(api: Scheduler): Scheduler {
    if (inner) throw invalid("told", "the mirrors already wrap a stack");
    inner = api;
    /**
     * The link an operation reaches under, and the path below its root: the
     * node its address reaches is one of a mirror's copies or layers. Each is
     * ephemeral, so in one slot, so its route passes the mirror's root.
     */
    const under = (
      op: Acting & { address: Address },
    ): { link: Link; path: string[] } | undefined => {
      if (links.size === 0 || !api.reach) return;
      if (Object.getOwnPropertySymbols(op).length) return; // a start's own placement
      if (op.process !== undefined && links.has(op.process)) return; // the mirror's own
      let node: Id | undefined;
      try {
        node = api.reach(op).node;
      } catch {
        return;
      }
      if (node === undefined) return;
      for (const link of links.values()) {
        const path = link.pathOf(node);
        if (path) return { link, path };
      }
    };
    const wrapped: Scheduler = {
      ...api,
      write(op) {
        const at = under(op);
        return at ? at.link.write(op, at.path) : api.write(op);
      },
      place(op) {
        const at = under(op);
        return at ? at.link.place(op, at.path) : api.place(op);
      },
      unplace(op) {
        const at = under(op);
        if (at) return at.link.unplace(op, at.path);
        const answer = api.unplace(op);
        // someone's unplace may have taken a mirror's root copy away
        if (op.process === undefined || !links.has(op.process)) {
          for (const link of links.values()) link.check();
        }
        return answer;
      },
      get time() {
        return api.time;
      },
    } as Scheduler;
    const below = api.top(wrapped);
    wrapped.top = told(below);
    return wrapped;
  }

  return { program, wrap, links };
}

/** One operation sent to the owner and not yet answered. */
type Op = {
  k: number;
  cmd: "write" | "place" | "unplace";
  /** below the root: the node written, or the parent placed into */
  path: string[];
  name?: string;
  patches?: readonly Patch[];
  value?: Json;
  position?: number;
  /** whether it shows as a layer */
  layer: boolean;
  /** who sent it, and why, as the operation said: the layer's cause names them */
  agent: Json;
  cause?: Json;
};

/** A layer as placed: its id, and where. */
type Placed = { id: Id; address: string[]; name: string; depth: number; op: number };

/** The copy of one path: its members' local ids, the owner's ids, its subscription. */
type Copy = {
  path: string[];
  members: { local: Id; owner?: Id }[];
  /** the owner's time of the change last applied to the first member's value */
  time: number;
  sub?: number;
  ready: boolean;
  held: Event[];
  syncing: boolean;
  again: boolean;
  /** while another node is in front of the first member: a local subscription to its address */
  watch?: number;
};

type Said = { cmd: string; address: string[]; error: ErrorJson };

type Status = {
  state: "dialing" | "mounted" | "unplaced" | "gone";
  owner?: string;
  why?: string;
  sending: number;
  refused: Said[];
  failed: Said[];
  shadowed: string[][];
};

const key = (path: readonly string[]) => JSON.stringify(path);

/** The link one mirror process holds, its copy, and what it has sent. */
export class Link {
  readonly pid: Id;
  #inner: Scheduler;
  #options: MirrorOptions;
  #lasting: EffectGiven["lasting"];
  #cwd: string[];
  #name: string;
  #status: string[];
  #remote: Remote | undefined;
  #ended = false;
  #count = 0;
  #state: Status = { state: "dialing", sending: 0, refused: [], failed: [], shadowed: [] };
  /** copies by path */
  #copies = new Map<string, Copy>();
  /** each local copy id, to its path, and whether it is the root's */
  #ids = new Map<Id, string[]>();
  /** what is in flight, in the order sent */
  #ops: Op[] = [];
  /** layers placed now */
  #placed: Placed[] = [];
  /** the owner's events, held while anything is in flight */
  #queue: { path: string[]; event: Event }[] = [];
  /** the owner peer */
  #owner = "";

  constructor(
    inner: Scheduler,
    options: MirrorOptions,
    at: { pid: Id; status: string[]; cwd: string[]; root: string; lasting: EffectGiven["lasting"] },
  ) {
    this.#inner = inner;
    this.#options = options;
    this.pid = at.pid;
    this.#lasting = at.lasting;
    this.#cwd = at.cwd;
    this.#name = at.root;
    this.#status = at.status;
  }

  /** The path below the root of a copy or a layer, by its id; undefined for any other node. */
  pathOf(id: Id): string[] | undefined {
    const path = this.#ids.get(id);
    return path && [...path];
  }

  get #agent(): Json {
    return this.#options.agent ?? null;
  }

  async start(channel: string) {
    this.#lasting.place({
      address: this.#status.slice(0, -1),
      name: this.#status[this.#status.length - 1],
      id: `${this.pid}/link`,
      value: this.#state as unknown as Json,
      ephemeral: true,
    } as PlaceOp);
    let remote: Remote;
    try {
      remote = await mount(this.#options.connect(channel), this.#options);
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

  /** Ends the link: the process was killed, so its nodes are let go by the scheduler. */
  end(why: string) {
    if (this.#ended) return;
    this.#ended = true;
    this.#remote?.close(why).catch(() => {});
  }

  // the status node

  #say(change: Partial<Status>): Changed | undefined {
    this.#state = { ...this.#state, ...change };
    if (this.#ended) return;
    try {
      return this.#lasting.write({
        address: this.#status,
        patches: [{ type: "snapshot", value: this.#state as unknown as Json }],
      } as WriteOp);
    } catch {
      return undefined; // killed meanwhile
    }
  }

  #gone(why: string) {
    if (this.#ended) return;
    this.#lift({ gone: why });
    this.#ops = [];
    this.#queue = [];
    const root = this.#copies.get(key([]));
    for (const c of this.#copies.values()) this.#unwatch(c);
    this.#copies.clear();
    for (const m of root?.members ?? []) {
      try {
        this.#lasting.unplace({
          address: [],
          name: this.#name,
          id: m.local,
          cause: { gone: why },
        } as UnplaceOp);
      } catch { /* already gone */ }
    }
    this.#ids.clear();
    this.#say({ state: "gone", why, sending: 0, shadowed: [] });
    this.#ended = true;
  }

  /** Something here could not be done: listed in the status, the last ten. */
  #fail(cmd: string, address: readonly string[], e: unknown) {
    const failed = [...this.#state.failed, { cmd, address: [...address], error: errorOf(e) }];
    this.#say({ failed: failed.slice(-10) });
  }

  /** Whether the root copy was placed and is no longer in its slot. */
  #rootGone(): boolean {
    const root = this.#copies.get(key([]))?.members[0]?.local;
    if (root === undefined) return false;
    try {
      const listing = this.#inner.directory({
        ...this.#as(undefined),
        address: [...this.#cwd],
        name: this.#name,
      }) as Listing;
      return !("items" in listing && listing.items.some((i) => i.id === root));
    } catch {
      return true;
    }
  }

  /** Says so if someone has unplaced the root copy: the owner's events have nowhere to go. */
  check(): boolean {
    if (this.#ended || this.#state.state === "unplaced") return this.#state.state === "unplaced";
    if (!this.#rootGone()) return false;
    this.#say({ state: "unplaced", why: "the copy's root was unplaced here" });
    return true;
  }

  /** Whether an address reaches exactly this node, beneath the wrappers. */
  #reaches(address: string[], node: Id | undefined): boolean {
    if (node === undefined) return false;
    if (!this.#inner.reach) return true;
    try {
      return this.#inner.reach({ ...this.#as(undefined), address }).node === node;
    } catch {
      return false;
    }
  }

  /** Whether a copy's first member is what its address reaches; if not, says so, and waits for it. */
  #reached(c: Copy): boolean {
    const { address, name } = this.#slot(c.path);
    if (this.#reaches([...address, name], c.members[0]?.local)) return true;
    if (this.check()) return false;
    if (c.watch === undefined) {
      try {
        c.watch = this.#lasting.subscribe({
          address: this.#localAt(c.path),
          send: (event: Event) => {
            if ("change" in event && event.reaches !== undefined) {
              queueMicrotask(() => this.#recheck(c));
            }
          },
        }).sub;
      } catch { /* killed meanwhile */ }
      this.#say({ shadowed: [...this.#state.shadowed, [...c.path]] });
    }
    return false;
  }

  /** The route to a shadowed copy changed: once its address reaches it again, it is read again. */
  #recheck(c: Copy) {
    if (this.#ended || this.#copies.get(key(c.path)) !== c) return this.#unwatch(c);
    const { address, name } = this.#slot(c.path);
    if (!this.#reaches([...address, name], c.members[0]?.local)) return;
    this.#unwatch(c);
    this.#sync(c.path).catch(() => {});
  }

  #unwatch(c: Copy) {
    if (c.watch === undefined) return;
    try {
      this.#lasting.unsubscribe({ sub: c.watch });
    } catch { /* killed */ }
    c.watch = undefined;
    const k = key(c.path);
    this.#say({ shadowed: this.#state.shadowed.filter((p) => key(p) !== k) });
  }

  // the copy

  /** The change's who, as the owner's change had it. */
  #who(change: Header | undefined): { agent: Json; cause: Json } {
    if (!change) return { agent: this.#agent, cause: { link: this.#owner } };
    const cause: { [key: string]: Json } = { link: this.#owner, time: change.time };
    if (change.process !== undefined) cause.process = change.process;
    if (change.cause !== undefined) cause.cause = change.cause;
    return { agent: change.agent, cause };
  }

  /** Where a path's members are: the address of their parent from the graph's root, and the slot. */
  #slot(path: readonly string[]): { address: string[]; name: string } {
    if (!path.length) return { address: [...this.#cwd], name: this.#name };
    return {
      address: [...this.#cwd, this.#name, ...path.slice(0, -1)],
      name: path[path.length - 1],
    };
  }

  /** The copy's own operations, as the mirror's process, with the owner's change's agent and cause. */
  #as(change: Header | undefined) {
    return { ...this.#who(change), process: this.pid, place: [], chroot: 0 };
  }

  /** Copies one path from the owner, and everything below it, and follows it. */
  async #sync(path: string[], slot?: Header): Promise<void> {
    const remote = this.#remote;
    if (!remote || this.#ended) return;
    const k = key(path);
    let c = this.#copies.get(k);
    if (!c) {
      c = {
        path,
        members: [],
        time: -Infinity,
        ready: false,
        held: [],
        syncing: false,
        again: false,
      };
      this.#copies.set(k, c);
    }
    if (c.syncing) {
      c.again = true;
      return;
    }
    c.syncing = true;
    try {
      if (c.sub === undefined) {
        const copy = c;
        const { sub } = await remote.subscribe({
          agent: this.#agent,
          address: path,
          send: (event) => this.#event(copy, event),
        });
        if (this.#ended || this.#copies.get(k) !== c) {
          // dropped while subscribing: nothing follows it now
          remote.unsubscribe({ agent: this.#agent, sub }).catch(() => {});
          return;
        }
        c.sub = sub;
      }
      const [items, listing] = await Promise.all([
        remote.read({ agent: this.#agent, address: path }),
        remote.directory({ agent: this.#agent, address: path }),
      ]);
      if (this.#ended || this.#copies.get(k) !== c || this.#state.state === "unplaced") return;
      const children = this.#bare(() => this.#members(c!, items, slot));
      if (children === undefined) return; // its parent's address reaches another node: read again then
      c.ready = true;
      const held = c.held.splice(0);
      if (held.length) this.#bare(() => held.forEach((event) => this.#apply(c!, event)));
      if (!children) {
        // the owner has nothing here: below the root, the path is no longer followed
        if (path.length && !items.length) this.#bare(() => this.#drop(c!, slot));
        return;
      }
      const names = "directory" in listing ? listing.directory : [];
      const here = new Set<string>();
      const waits: Promise<void>[] = [];
      for (const [name, slotItems] of names as [string, SlotItem[]][]) {
        if (!slotItems.some((i) => !i.pending)) continue;
        here.add(name);
        waits.push(this.#sync([...path, name], slotItems[0]?.change));
      }
      // what this path held that the owner no longer has
      for (const other of [...this.#copies.values()]) {
        const p = other.path;
        if (
          p.length === path.length + 1 && path.every((n, i) => p[i] === n) &&
          !here.has(p[p.length - 1])
        ) {
          this.#bare(() => this.#drop(other, undefined));
        }
      }
      await Promise.all(waits);
    } catch (e) {
      // the link went, or the path did at the owner: what follows from that is said elsewhere;
      // anything else is something here that could not be done
      if (!this.#ended && !this.check() && !remoteError(e)) this.#fail("copy", path, e);
    } finally {
      c.syncing = false;
      if (c.again && !this.#ended && this.#copies.get(k) === c) {
        c.again = false;
        this.#sync(path, slot).catch(() => {});
      }
    }
  }

  /**
   * Makes the path's local members the owner's: the same first member keeps
   * its copy and children; another first member makes them again. Gives
   * whether the first member is here, so its children are copied; undefined,
   * changing nothing, when the parent copy's address reaches another node.
   */
  #members(c: Copy, items: ValueItem[], slot: Header | undefined): boolean | undefined {
    const parent = c.path.length ? this.#copies.get(key(c.path.slice(0, -1))) : undefined;
    if (parent && !this.#reached(parent)) return undefined;
    const owners = items.map((i) => i.from.route[i.from.route.length - 1]?.node);
    const first = c.members[0];
    const same = first !== undefined && items.length > 0 && first.owner === owners[0];
    if (!same) {
      // the path reaches another node now, or nothing: let the old copy go, and its paths below
      this.#dropBelow(c.path);
      for (const m of c.members) this.#unplace(c.path, m.local, slot);
      c.members = [];
      c.time = -Infinity;
    } else {
      // the first stays; the others are copied again
      for (const m of c.members.slice(1)) this.#unplace(c.path, m.local, slot);
      c.members = c.members.slice(0, 1);
    }
    const { address, name } = this.#slot(c.path);
    items.forEach((item, n) => {
      const owner = owners[n];
      if (n === 0 && same) {
        if ((item.change?.time ?? -Infinity) > c.time) {
          // written only to the copy: if another node is in front of it, when it is reached again
          if (!this.#write(c, item.change, [{ type: "snapshot", value: item.value }])) return;
        }
      } else {
        const local = `${this.pid}/${++this.#count}`;
        this.#inner.place({
          ...this.#as(slot ?? item.change),
          address,
          name,
          id: local,
          value: item.value,
          ephemeral: true,
          ...(n === 0 ? { position: 0 } : {}),
        });
        this.#ids.set(local, c.path);
        c.members.push({ local, ...(owner === undefined ? {} : { owner }) });
        // who set the value, when that is not who placed it
        if (n === 0 && slot && item.change && item.change.time !== slot.time) {
          if (!this.#write(c, item.change, [{ type: "snapshot", value: item.value }])) return;
        }
      }
      if (n === 0) c.time = item.change?.time ?? c.time;
    });
    return items.length > 0;
  }

  /**
   * Writes the owner's change to a copy's first member, by its address when
   * that reaches exactly it; false, writing nothing, when it reaches another
   * node (one placed in front of it), which must not take the owner's change.
   */
  #write(c: Copy, change: Header | undefined, patches: readonly Patch[]): boolean {
    if (!this.#reached(c)) return false;
    const { address, name } = this.#slot(c.path);
    this.#inner.write({ ...this.#as(change), address: [...address, name], patches });
    return true;
  }

  #unplace(path: readonly string[], local: Id, change: Header | undefined) {
    const { address, name } = this.#slot(path);
    this.#ids.delete(local);
    try {
      this.#inner.unplace({ ...this.#as(change), address, name, id: local });
    } catch { /* gone with its parent */ }
  }

  /** Stops following every path below this one; their nodes go with their parent's. */
  #dropBelow(path: readonly string[]) {
    for (const [k, c] of this.#copies) {
      const p = c.path;
      if (p.length > path.length && path.every((n, i) => p[i] === n)) {
        this.#copies.delete(k);
        this.#unwatch(c);
        for (const m of c.members) this.#ids.delete(m.local);
        if (c.sub !== undefined) {
          this.#remote?.unsubscribe({ agent: this.#agent, sub: c.sub }).catch(() => {});
        }
      }
    }
  }

  /** Lets a path's copy go: the path has nothing at the owner now. */
  #drop(c: Copy, change: Header | undefined) {
    this.#dropBelow(c.path);
    for (const m of c.members) this.#unplace(c.path, m.local, change);
    c.members = [];
    this.#copies.delete(key(c.path));
    this.#unwatch(c);
    if (c.sub !== undefined) {
      this.#remote?.unsubscribe({ agent: this.#agent, sub: c.sub }).catch(() => {});
    }
  }

  /** One of the owner's events for a path. */
  #event(c: Copy, event: Event) {
    if (this.#ended || !("change" in event) || this.#state.state === "unplaced") return;
    if (this.#ops.length) {
      this.#queue.push({ path: c.path, event });
      return;
    }
    this.#bare(() => this.#apply(c, event));
  }

  /** Applies an owner's event to the copy, layers taken away. */
  #apply(c: Copy, event: Event) {
    if (!("change" in event) || this.#copies.get(key(c.path)) !== c) return;
    if (!c.ready) {
      c.held.push(event);
      return;
    }
    const change = event.change;
    if (event.reaches !== undefined) {
      // the route changed: below the root, the parent's own change says so
      if (!c.path.length) this.#sync([]).catch(() => {});
      return;
    }
    const first = c.members[0];
    if (!first || (first.owner !== undefined && change.node !== first.owner)) return;
    if (change.kind === "write") {
      if (change.time <= c.time) return;
      try {
        // another node in front of the copy: it is read again when the copy is reached
        if (this.#write(c, change, change.patches)) c.time = change.time;
      } catch (e) {
        if (this.check()) return;
        this.#fail("copy", c.path, e);
        this.#sync(c.path).catch(() => {});
      }
      return;
    }
    // a placement in its directory: a new node shows at once, then the slot is read again
    const child = [...c.path, change.name];
    const there = this.#copies.get(key(child));
    if (!this.#reached(c)) return; // read again when the copy is reached
    if (change.kind === "place" && change.value !== undefined && !there?.members.length) {
      const local = `${this.pid}/${++this.#count}`;
      try {
        this.#inner.place({
          ...this.#as(change),
          address: [...this.#cwd, this.#name, ...c.path],
          name: change.name,
          id: local,
          value: change.value,
          ephemeral: true,
        });
        this.#ids.set(local, child);
        const copy: Copy = there ?? {
          path: child,
          members: [],
          time: change.time,
          ready: false,
          held: [],
          syncing: false,
          again: false,
        };
        copy.members = [{ local, owner: change.id }];
        copy.time = change.time;
        this.#copies.set(key(child), copy);
      } catch { /* read again below */ }
    }
    this.#sync(child, change).catch(() => {});
  }

  // layers

  /** Runs fn with every layer taken away, then places those still in flight again. */
  #bare<T>(fn: () => T): T {
    if (!this.#placed.length) return fn();
    this.#lift({ link: this.#owner });
    try {
      return fn();
    } finally {
      this.#restore();
    }
  }

  /** Takes every layer away, shallowest first, so each one's parent is the copy's; cause says why. */
  #lift(cause: Json) {
    const placed = this.#placed.sort((a, b) => a.depth - b.depth);
    this.#placed = [];
    for (const l of placed) {
      this.#ids.delete(l.id);
      try {
        this.#lasting.unplace({ address: l.address, name: l.name, id: l.id, cause } as UnplaceOp);
      } catch { /* gone with what it was in */ }
    }
  }

  /** The layers of what is in flight: one for each node written, one for each node placed. */
  #layers() {
    const out: {
      path: string[];
      address: string[];
      name: string;
      depth: number;
      value: (base: Json | undefined) => Json | undefined;
      position?: number;
      op: Op;
    }[] = [];
    const writes = new Map<string, Op[]>();
    for (const op of this.#ops) {
      if (!op.layer) continue;
      if (op.cmd === "write") {
        const k = key(op.path);
        if (!writes.has(k)) writes.set(k, []);
        writes.get(k)!.push(op);
        continue;
      }
      const at = [...op.path, op.name!];
      const { address, name } = this.#local(at);
      out.push({
        path: at,
        address,
        name,
        depth: at.length,
        value: () => op.value,
        ...(op.position === undefined ? {} : { position: op.position }),
        op,
      });
    }
    for (const ops of writes.values()) {
      const path = ops[0].path;
      const { address, name } = this.#local(path);
      out.push({
        path,
        address,
        name,
        depth: path.length,
        value: (base) => {
          if (base === undefined) return undefined;
          let v = base;
          for (const op of ops) {
            try {
              v = applyPatches(v, op.patches!);
            } catch { /* the owner will say */ }
          }
          return v;
        },
        position: 0,
        op: ops[ops.length - 1],
      });
    }
    return out;
  }

  /** A path's slot as the mirror's process addresses it, from its place. */
  #local(path: readonly string[]): { address: string[]; name: string } {
    if (!path.length) return { address: [], name: this.#name };
    return { address: [this.#name, ...path.slice(0, -1)], name: path[path.length - 1] };
  }

  /** Places the layers of what is in flight, deepest first, over the copy as it is now. */
  #restore(): Map<number, Changed> {
    const made = new Map<number, Changed>();
    if (this.#ended) return made;
    const layers = this.#layers().sort((a, b) => b.depth - a.depth);
    for (const l of layers) {
      const base = l.op.cmd === "write"
        ? this.#lasting.read({ address: [...l.address, l.name] })[0]?.value
        : undefined;
      const value = l.value(base);
      if (value === undefined) continue;
      const id = `${this.pid}/~${++this.#count}`;
      try {
        const answer = this.#lasting.place({
          address: l.address,
          name: l.name,
          id,
          value,
          ephemeral: true,
          cause: sending(l.op),
          ...(l.position === undefined ? {} : { position: this.#clamp(l, l.position) }),
        } as PlaceOp);
        this.#placed.push({ id, address: l.address, name: l.name, depth: l.depth, op: l.op.k });
        this.#ids.set(id, l.path);
        made.set(l.op.k, answer);
      } catch { /* its parent is not here now */ }
    }
    return made;
  }

  /** A position no greater than the slot's length. */
  #clamp(l: { address: string[]; name: string }, position: number): number {
    try {
      const listing = this.#lasting.directory({ address: l.address, name: l.name }) as Listing;
      const n = "items" in listing ? listing.items.length : 0;
      return Math.min(position, n);
    } catch {
      return 0;
    }
  }

  // sending

  #send(op: Op, call: (remote: Remote) => Promise<unknown>): Scheduled {
    const remote = this.#remote;
    if (!remote || this.#ended) throw invalid("gone", "the mirror's link is gone");
    // layers before the first one go, so this one's parent is the copy's
    let made: Map<number, Changed> | undefined;
    const fast = op.cmd === "write" && this.#placed.every((l) => {
      const o = this.#ops.find((x) => x.k === l.op);
      return o?.cmd === "write";
    });
    let answer: Changed | undefined;
    if (fast) {
      const own = this.#placed.find((l) => key(this.#ids.get(l.id) ?? []) === key(op.path));
      const parent = op.path.length > 0 &&
        this.#placed.some((l) => key(this.#ids.get(l.id) ?? []) === key(op.path.slice(0, -1)));
      if (own) {
        this.#ops.push(op);
        const { address, name } = this.#local(op.path);
        answer = this.#lasting.write(
          { address: [...address, name], patches: op.patches!, cause: sending(op) } as WriteOp,
        );
      } else if (!parent) {
        this.#ops.push(op);
        made = this.#restoreOne(op);
      }
    }
    if (!this.#ops.includes(op)) {
      this.#lift(sending(op));
      this.#ops.push(op);
      made = this.#restore();
    }
    const status = this.#say({ sending: this.#ops.length });
    answer ??= made?.get(op.k) ?? status;
    call(remote).then(
      () => this.#answered(op),
      (e) => this.#answered(op, e),
    );
    if (!answer) throw invalid("gone", "the mirror's link is gone");
    return answer as Scheduled;
  }

  /** Places the one write layer of a node with no layer, when no other layer is in its way. */
  #restoreOne(op: Op): Map<number, Changed> {
    const made = new Map<number, Changed>();
    const { address, name } = this.#local(op.path);
    const base = this.#lasting.read({ address: [...address, name] })[0]?.value;
    if (base === undefined) return made;
    const value = applyPatches(base, op.patches!);
    const id = `${this.pid}/~${++this.#count}`;
    made.set(
      op.k,
      this.#lasting.place({
        address,
        name,
        id,
        value,
        ephemeral: true,
        position: 0,
        cause: sending(op),
      } as PlaceOp),
    );
    this.#placed.push({ id, address, name, depth: op.path.length, op: op.k });
    this.#ids.set(id, op.path);
    return made;
  }

  /** The owner answered: its events are applied, and the layers placed again over the copy. */
  #answered(op: Op, error?: unknown) {
    if (this.#ended) return;
    this.#ops = this.#ops.filter((o) => o !== op);
    const queue = this.#queue.splice(0);
    const said = error === undefined ? undefined : errorOf(error);
    this.#lift({
      link: this.#owner,
      answered: op.cmd,
      address: op.path,
      ...(said ? { refused: said as unknown as Json } : {}),
    });
    for (const { path, event } of queue) {
      const c = this.#copies.get(key(path));
      if (c) this.#apply(c, event);
    }
    this.#restore();
    const refused = error === undefined ? this.#state.refused : [
      ...this.#state.refused,
      { cmd: op.cmd, address: op.path, error: said! },
    ].slice(-10);
    this.#say({ sending: this.#ops.length, refused });
  }

  write(op: WriteOp, path: string[]): Scheduled {
    // a write that does not apply here is not sent
    const { address, name } = this.#local(path);
    const base = this.#lasting.read({ address: [...address, name] })[0]?.value;
    if (base !== undefined) applyPatches(base, op.patches);
    const o: Op = {
      k: ++this.#count,
      cmd: "write",
      path,
      patches: op.patches,
      layer: true,
      ...said(op),
    };
    return this.#send(o, (r) =>
      r.write({
        agent: op.agent,
        ...(op.cause === undefined ? {} : { cause: op.cause }),
        address: path,
        patches: op.patches,
      }));
  }

  place(op: PlaceOp, path: string[]): Scheduled {
    const id = this.#ownerId(op.id);
    const layer = op.value !== undefined && op.ephemeral !== true;
    const o: Op = {
      k: ++this.#count,
      cmd: "place",
      path,
      name: op.name,
      layer,
      ...said(op),
      ...(op.value === undefined ? {} : { value: op.value }),
      ...(op.position === undefined ? {} : { position: op.position }),
    };
    return this.#send(o, (r) =>
      r.place({
        agent: op.agent,
        ...(op.cause === undefined ? {} : { cause: op.cause }),
        address: path,
        name: op.name,
        id,
        ...(op.position === undefined ? {} : { position: op.position }),
        ...(op.value === undefined ? {} : { value: op.value }),
        ...(op.ephemeral === undefined ? {} : { ephemeral: op.ephemeral }),
      }));
  }

  unplace(op: UnplaceOp, path: string[]): Scheduled {
    const id = this.#ownerId(op.id);
    const o: Op = {
      k: ++this.#count,
      cmd: "unplace",
      path,
      name: op.name,
      layer: false,
      ...said(op),
    };
    return this.#send(o, (r) =>
      r.unplace({
        agent: op.agent,
        ...(op.cause === undefined ? {} : { cause: op.cause }),
        address: path,
        name: op.name,
        id,
      }));
  }

  /** The owner's id for a local copy's id; any other id as it is. */
  #ownerId(local: Id): Id {
    for (const c of this.#copies.values()) {
      const m = c.members.find((m) => m.local === local);
      if (m?.owner !== undefined) return m.owner;
    }
    return local;
  }
}

/** Who sent an operation and why, as it said. */
function said(op: { agent?: unknown; cause?: unknown }): { agent: Json; cause?: Json } {
  return {
    agent: (op.agent ?? null) as Json,
    ...(op.cause === undefined ? {} : { cause: op.cause as Json }),
  };
}

/**
 * A layer's cause: what is being sent to the owner, where, and on whose
 * behalf, with the sender's own cause (its site), since the layer's change
 * is the mirror's process's and its agent says only that.
 */
function sending(op: Op): Json {
  return {
    sending: op.cmd,
    address: op.path,
    agent: op.agent,
    ...(op.cause === undefined ? {} : { cause: op.cause }),
  };
}

/** An owner's answer that was not ok, as JSON. */
export function errorOf(e: unknown): ErrorJson {
  if (e instanceof Thrown) return e.error;
  if (e instanceof Unsupported) {
    return { kind: "invalid", why: { code: "unsupported", text: e.message } };
  }
  if (e instanceof ErmineError) return e.toJSON();
  return {
    kind: "invalid",
    why: { code: "gone", text: e instanceof Error ? e.message : String(e) },
  };
}
