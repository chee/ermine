// The world the page shows: the stack, and what the host learns from it.
//
//   graph("root", kept) ── keep ── tap ── protect(may from /rules) ── schedule
//
// The tap is a wrapper made as keeper.ts makes one: it passes every
// operation on, and tells the host about each change an operation made (from
// Changed.made, letting go included) and each record a run finished with.
// It sits beneath protect, so the scheduler's bookkeeping, which is handed
// the tap as its bare graph, goes through it too, and it passes release on.
//
// Everything the panels show comes from here: changes as the tap saw them,
// records as finish returned them, and reads made now. Nothing is invented:
// an element is tied to a node only by a placement the tap saw.

import {
  actorOf,
  type Backend,
  type Builtin,
  builtin,
  type Change,
  type Changed,
  equal,
  type ErrorJson,
  graph,
  type HandlerRecord,
  type Id,
  type Interface,
  isLive,
  keep,
  type Keeper,
  type Kept,
  load,
  type Loader,
  type Made,
  type May,
  protect,
  type Record,
  sameThread,
  schedule,
  type Scheduler,
  type SchedulerFired as Fired,
  type Site,
  steps,
  told,
} from "d2/ermine";
import { ROOT } from "./seed.ts";

export type Json = import("d2/ermine").Json;

/** One change as the tap saw it, in the burst it came in. */
export type Line = {
  change: Change;
  marked: Id[];
  gone: Id[];
  burst: number;
  /** the path of the changed node when the change was seen */
  at?: string[];
};

/** One outside act, or one thing the world did later, and every change it settled. */
export type Burst = {
  n: number;
  label: string;
  /** "host" for the host's own acts; "later" for changes that came with no act open */
  by: "host" | "later";
  actor?: Json;
  lines: Line[];
  at: number;
  error?: ErrorJson;
};

/** Where an id is placed: each parent and the name it is under there. */
export type Place = { parent: Id; name: string };

export type World = {
  s: Scheduler;
  tap: Interface & { release: NonNullable<Interface["release"]> };
  k: Keeper;
  root: Id;
  /** what a load brought back, if anything was kept */
  loaded?: { time: number; nodes: number };
  bursts: Burst[];
  /** the newest lines, at most 4000 */
  lines: Line[];
  /** how many lines the tap has seen in all, the ones dropped from lines included */
  seen(): number;
  records: Map<Id, Record[]>;
  handlers: Map<Id, HandlerRecord[]>;
  where: Map<Id, Place[]>;
  /** each ephemeral node here, and the live value it was made with, if it was */
  ephemeral: Map<Id, unknown>;
  /** each live value, and the ephemeral node that holds it */
  owner: Map<unknown, Id>;
  /** the change that made each node, as the tap saw it */
  made: Map<Id, Change>;
  /** every pid the tap saw started, with its start's change */
  started: Map<Id, Change>;
  actor: string;
  /** the path from the root to an id, by its first place */
  pathOf(id: Id): string[] | undefined;
  /** runs an outside act as one burst */
  act<T>(label: string, fn: () => T): T | undefined;
  fire(pid: Id, handler: string, input?: Json): Fired | undefined;
  /** told after changes, once per tick */
  listen(f: () => void): () => void;
  /** told when an ephemeral node with a live value goes */
  onGone(f: (id: Id, live: unknown) => void): void;
  /** the rules protect reads from /rules */
  rules(): Json[];
};

export type StackOptions = {
  /** the page's stage, handed to the graph as /desk/screen by the page program */
  stage: object;
  /** how long the slow loader waits before importing, in ms */
  slow?: number;
  /** the importer of the same-thread loaders */
  importer?: (url: string) => Promise<unknown>;
};

const HOST = "host";

/** A plain map. */
export const isObject = (x: unknown): x is { [key: string]: Json } =>
  typeof x === "object" && x !== null && !Array.isArray(x) &&
  (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);

/** The tap: passes everything on, and tells see() what each change made and finish() returned. */
export function tap(
  api: Interface,
  see: (made: readonly Made[], gone: readonly Id[]) => void,
  saw: (record: Record) => void,
): Interface & { release: NonNullable<Interface["release"]> } {
  let depth = 0;
  let held: { made: readonly Made[]; gone: readonly Id[] }[] = [];
  const seen = <T extends Changed>(fn: () => T): T => {
    depth++;
    try {
      const answer = fn();
      held.push({
        made: answer.made ??
          [{ change: answer.change, marked: answer.marked.map((m) => m.process) }],
        gone: answer.gone ?? [],
      });
      return answer;
    } finally {
      if (--depth === 0) {
        // changes made while one was being made come back first: put them in time order
        const all = held.sort((a, b) => a.made[0].change.time - b.made[0].change.time);
        held = [];
        for (const h of all) see(h.made, h.gone);
      }
    }
  };
  if (!api.release) throw new Error("the tap needs the bare graph's release beneath it");
  const release = api.release;
  const wrapped = {
    ...api,
    write: (op) => seen(() => api.write(op)),
    place: (op) => seen(() => api.place(op)),
    unplace: (op) => seen(() => api.unplace(op)),
    release: (op) => seen(() => release(op)),
    finish: (rec, ending, finishing) => {
      const record = api.finish(rec, ending, finishing);
      saw(record);
      return record;
    },
  } as Interface & { release: NonNullable<Interface["release"]> };
  const below = api.top(wrapped);
  wrapped.top = told(below);
  return wrapped;
}

/** The pid shape the reference scheduler gives: @, a time, -, five letters. */
export const isPid = (name: string) => /^@\d+-[a-z]{5}$/.test(name);

/** Builds the world over a backend: loads, then graph, keep, tap, protect, schedule. */
export async function openStack(backend: Backend, options: StackOptions): Promise<World> {
  const kept: Kept | undefined = await load(backend);
  const g = graph(ROOT, kept);
  const k = keep(g, backend, ROOT, kept ? { kept } : {});

  const bursts: Burst[] = [];
  const lines: Line[] = [];
  const records = new Map<Id, Record[]>();
  const handlers = new Map<Id, HandlerRecord[]>();
  const where = new Map<Id, Place[]>();
  const ephemeral = new Map<Id, unknown>();
  const owner = new Map<unknown, Id>();
  const made = new Map<Id, Change>();
  const started = new Map<Id, Change>();
  const listeners = new Set<() => void>();
  const goneListeners: ((id: Id, live: unknown) => void)[] = [];
  let current: Burst | undefined;
  let stray: Burst | undefined;
  let told = false;
  let rulesCache: Json[] | undefined;
  let count = 0;

  if (kept) {
    for (const [id, node] of kept.nodes) {
      for (const [name, ids] of node.directory) {
        for (const child of ids) addPlace(child, { parent: id, name });
      }
    }
  }

  function pathOf(id: Id): string[] | undefined {
    const out: string[] = [];
    const seen = new Set<Id>();
    let at = id;
    while (at !== ROOT) {
      if (seen.has(at)) return undefined;
      seen.add(at);
      const p = where.get(at)?.[0];
      if (!p) return undefined;
      out.unshift(p.name);
      at = p.parent;
    }
    return out;
  }

  function addPlace(id: Id, p: Place) {
    const list = where.get(id) ?? [];
    if (!list.some((q) => q.parent === p.parent && q.name === p.name)) list.push(p);
    where.set(id, list);
  }

  function notify() {
    if (told) return;
    told = true;
    queueMicrotask(() => {
      told = false;
      for (const f of listeners) {
        try {
          f();
        } catch (e) {
          console.error(`a listener threw: ${e}`, (e as Error)?.stack);
        }
      }
    });
  }

  function burstFor(): Burst {
    if (current) return current;
    if (stray) return stray;
    stray = { n: bursts.length + 1, label: "later", by: "later", lines: [], at: Date.now() };
    bursts.push(stray);
    queueMicrotask(() => (stray = undefined));
    return stray;
  }

  function see(all: readonly Made[], gone: readonly Id[]) {
    const b = burstFor();
    for (const m of all) {
      const c = m.change;
      if (c.node === ROOT && c.kind !== "write" && c.name === "rules") rulesCache = undefined;
      if (
        c.kind === "write" &&
        where.get(c.node)?.some((p) => p.parent === ROOT && p.name === "rules")
      ) {
        rulesCache = undefined;
      }
      if (c.kind === "place") {
        addPlace(c.id, { parent: c.node, name: c.name });
        if (c.value !== undefined) {
          made.set(c.id, c);
          if (c.ephemeral) {
            ephemeral.set(c.id, isLive(c.value) ? c.value : undefined);
            if (isLive(c.value)) owner.set(c.value, c.id);
          }
          if (isPid(c.name) && c.name === c.id) started.set(c.id, c);
        }
      } else if (c.kind === "unplace") {
        const list = (where.get(c.id) ?? []).filter((p) =>
          !(p.parent === c.node && p.name === c.name)
        );
        if (list.length) where.set(c.id, list);
        else where.delete(c.id);
      }
      const path = pathOf(c.node);
      const line: Line = {
        change: c,
        marked: [...m.marked],
        gone: [],
        burst: b.n,
        ...(path ? { at: path } : {}),
      };
      lines.push(line);
      count++;
      b.lines.push(line);
    }
    if (gone.length && b.lines.length) b.lines[b.lines.length - 1].gone = [...gone];
    for (const id of gone) {
      const live = ephemeral.get(id);
      ephemeral.delete(id);
      where.delete(id);
      if (live !== undefined) {
        // one live thing may be held again by a newer node, as the stage is by a restarted page
        if (owner.get(live) === id) owner.delete(live);
        for (const f of goneListeners) f(id, live);
      }
    }
    if (lines.length > 4000) lines.splice(0, lines.length - 4000);
    notify();
  }

  function saw(record: Record) {
    const list = records.get(record.process) ?? [];
    list.push(record);
    if (list.length > 12) list.shift();
    records.set(record.process, list);
    notify();
  }

  const t = tap(k, see, saw);

  function rules(): Json[] {
    if (rulesCache) return rulesCache;
    try {
      const v = t.read({ agent: HOST, address: ["rules"] })[0]?.value;
      rulesCache = Array.isArray(v) ? [...v] : [];
    } catch {
      rulesCache = [];
    }
    return rulesCache;
  }

  /** PROTECT.tex's rules: the first whose given fields all equal the operation's wins. */
  const may: May = (agent, process, op, args) => {
    const actor = actorOf(agent);
    const code = isObject(agent) && Array.isArray(agent.code) ? agent.code : undefined;
    const last = code?.length ? (code[code.length - 1] as { process?: Id }).process : process;
    const a = args as { node?: Id; id?: Id };
    const list = rules();
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!isObject(r)) continue;
      if (Object.hasOwn(r, "agent") && !equal(r.agent as Json, actor)) continue;
      if (Object.hasOwn(r, "process") && r.process !== last) continue;
      if (Object.hasOwn(r, "op") && r.op !== op) continue;
      if (Object.hasOwn(r, "node") && r.node !== a.node) continue;
      if (Object.hasOwn(r, "id") && r.id !== a.id) continue;
      return r.allow === true ? true : { rule: i + 1 };
    }
    return true;
  };

  const p = protect(t, may);
  const delay = options.slow ?? 1200;
  const importer = options.importer ?? ((u: string) => import(u));
  const page: Builtin = {
    compute: () => "the page's stage",
    effect: (given) => {
      given.api.place({
        address: ["desk"],
        name: "screen",
        id: `${given.self}/screen`,
        value: options.stage as Json,
        ephemeral: true,
      });
    },
  };
  const loaders: { [name: string]: Loader } = {
    host: builtin({ page }),
    "same-thread": sameThread(importer),
    slow: sameThread((u) => new Promise((r) => setTimeout(r, delay)).then(() => importer(u))),
    steps: steps(),
  };
  const s = schedule(p, loaders, { graph: t, ...(kept ? { time: kept.time } : {}) });

  const w: World = {
    s,
    tap: t,
    k,
    root: ROOT,
    ...(kept ? { loaded: { time: kept.time, nodes: kept.nodes.size } } : {}),
    bursts,
    lines,
    seen: () => count,
    records,
    handlers,
    where,
    ephemeral,
    owner,
    made,
    started,
    actor: "you",
    pathOf,
    act(label, fn) {
      const b: Burst = {
        n: bursts.length + 1,
        label,
        by: "host",
        actor: w.actor,
        lines: [],
        at: Date.now(),
      };
      bursts.push(b);
      const was = current;
      current = b;
      try {
        return fn();
      } catch (e) {
        b.error = errorOf(e);
        return undefined;
      } finally {
        current = was;
        notify();
      }
    },
    fire(pid, handler, input) {
      const n = bursts.length + 1;
      const fired = w.act(`${handler} → ${pid}`, () =>
        s.fire({
          agent: w.actor,
          process: pid,
          handler,
          ...(input === undefined ? {} : { input: input as Json }),
        }));
      if (fired) {
        const list = handlers.get(pid) ?? [];
        list.push(fired.handler);
        if (list.length > 12) list.shift();
        handlers.set(pid, list);
        const b = bursts.find((x) => x.n === n);
        if (fired.error && b) b.error = fired.error;
      }
      return fired;
    },
    listen(f) {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    onGone(f) {
      goneListeners.push(f);
    },
    rules,
  };
  return w;
}

/** An error as JSON, whatever threw it. */
export function errorOf(e: unknown): ErrorJson {
  const j = (e as { toJSON?: () => unknown })?.toJSON?.();
  if (isObject(j) && typeof j.kind === "string" && isObject(j.why)) {
    return j as unknown as ErrorJson;
  }
  return { kind: "thrown", why: { code: "thrown", message: String((e as Error)?.message ?? e) } };
}

/** A site, if a cause is one. */
export function siteOf(cause: unknown): Site | undefined {
  return isObject(cause) && typeof cause.file === "string" && typeof cause.line === "number"
    ? cause as unknown as Site
    : undefined;
}

export const HOST_AGENT = HOST;
