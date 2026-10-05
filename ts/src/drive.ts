// The reference driver (CORE.tex, Running and wrapping; PROTOCOL.tex, The
// reference driver). It keeps the time, walks the tree of processes beneath
// its root after every change, and runs what is due in rounds: computes
// first, lowest height first, then effects.
//
// Every change passes through it, since it gives each its time, so it learns
// the tree and each process's value from the changes themselves and reads
// nothing on its own account. A run's interfaces are bound from the top of the
// stack, so what a program does passes through every wrapper.

import { applyPatches, byCodePoint, equal, isObject, placed } from "./patch.ts";
import { checkPath } from "./graph.ts";
import {
  type Acting,
  type Bound,
  type Change,
  type Changed,
  type Ending,
  type Finishing,
  type Id,
  type Interface,
  Invalid,
  type Json,
  type MakeOp,
  type Path,
  type PlaceOp,
  type Record,
  type RecordError,
  type Recording,
  Refused,
  told,
  type UnplaceOp,
  type WriteOp,
} from "./types.ts";

/** What a compute returns when it read something that is not there yet. */
export const PENDING: unique symbol = Symbol("pending");

export type ComputeContext = {
  /** reads only, recorded into the run */
  api: Interface;
  self: Id;
  path: Path;
  /** the changes that marked the process */
  changes: readonly Change[];
};

export type EffectContext = {
  /** writes only, recorded into the run */
  api: Interface;
  self: Id;
  value: Json;
  /** the value before this run; left out on the first run since the process started */
  previous?: Json;
  /** writes only, and works until the process stops, for code the world calls later */
  lasting: Interface;
  /** names a handler the host can fire; one of the same name replaces it */
  handler(name: string, run: Handler): void;
};

/** A compute returns a value, or PENDING. Returning nothing is null. */
export type Compute = (ctx: ComputeContext) => Json | typeof PENDING | undefined;
/** An effect may return its cleanup, called before its next effect and when it stops. */
export type Effect = (ctx: EffectContext) => void | (() => void);
export type Handler = (input?: Json) => void;

/** The host's loader: a program node's value as a compute or an effect. It throws if it cannot. */
export type Load = {
  (code: Json, part: "compute"): Compute;
  (code: Json, part: "effect"): Effect;
};

/** A process the request stopped, and the changes its cleanup made. */
export type Stopped = { process: Id; changes: Change[]; error?: unknown };

/** What the driver did before answering: the records it finished, in order, and what it stopped. */
export type Settled = { runs: Record[]; stopped: Stopped[] };

export type Driven = Changed & Settled;

export type FireOp = Acting & { process: Id; handler: string; input?: Json };
/** The handler's changes, what ran after, and what it threw, if it did. */
export type Fired = Settled & { changes: Change[]; error?: unknown };

export interface Driver extends Interface {
  make(op: MakeOp): Driven;
  write(op: WriteOp): Driven;
  place(op: PlaceOp): Driven;
  unplace(op: UnplaceOp): Driven;
  /** Does fn; what its changes marked runs once, after the last. */
  batch(fn: () => void): Settled;
  /** Runs a process's handler with its lasting interface, outside any run, then what it marked. */
  fire(op: FireOp): Fired;
}

/**
 * The root and each process node, as the changes have shown them. A process
 * node is one whose fixed data is an object with a path; its path is kept
 * as given, a path or not.
 */
type Known = { process?: { path: unknown }; value: Json; slots: Map<string, Id[]> };

/** One run, from its compute until it is finished. */
type Run = {
  rec: Recording;
  /** what the compute returned, if it returned a value */
  result?: { value: Json };
  /** the effect program's code, if the effect slot had one */
  effect?: { code: Json };
  /** set when the run ended before its effect */
  ending?: Ending;
  errors: RecordError[];
  /** the process's value before this run */
  before: Json;
};

type Process = {
  id: Id;
  agent: Json;
  /** its path, or why its fixed data's path is not one */
  path: Path | { not: string };
  height: number;
  /** no run since it started has run its effect */
  fresh: boolean;
  lasting: Bound;
  handlers: Map<string, Handler>;
  cleanup?: () => void;
  /** the nodes its last compute read the value of, and every node it read */
  values: Set<Id>;
  read: Set<Id>;
  /** whether the driver wrote its value this round */
  wrote: boolean;
  /** its run this round, until finished */
  run?: Run;
};

/** A due process: the changes that marked it, and the time of the first. */
type Due = { marks: Change[]; first: number };

export function drive(api: Interface, root: Id, load: Load): Driver {
  const lower = api;
  let top: Interface;
  let clock = 0;

  const known = new Map<Id, Known>();
  const running = new Map<Id, Process>();
  const due = new Map<Id, Due>();
  /** the processes in the order the last walk reached them */
  let order: Id[] = [];

  /** what the request being answered will report */
  let out: Settled | undefined;
  /** where the changes being made are gathered, for a cleanup or a handler */
  let gathering: Change[] | undefined;

  // changes

  /** whether a change is being applied, and the changes made meanwhile, noted after it */
  let applying = false;
  const held: Changed[] = [];

  function change<Op>(apply: (op: Op & { time: number }) => Changed) {
    return (op: Op): Driven => {
      const [answer, settled] = request(() => {
        // the time is taken first, as a subscriber may make another change
        // while the graph sends it this one
        const time = ++clock;
        const outer = applying;
        applying = true;
        let answer: Changed;
        try {
          answer = apply({ ...op, time });
        } catch (e) {
          // an invalid or refused change takes no time
          if (clock === time) clock--;
          throw e;
        } finally {
          applying = outer;
        }
        if (outer) held.push(answer);
        else {
          note(answer);
          while (held.length) note(held.shift()!);
        }
        return answer;
      });
      return { ...answer, ...settled };
    };
  }

  /**
   * Does fn as a request. The outermost request, once fn returns or throws,
   * runs what is due, and reports it; one inside it reports what it stopped.
   */
  function request<T>(fn: () => T): [T, Settled] {
    if (out) {
      const from = out.stopped.length;
      const result = fn();
      return [result, { runs: [], stopped: out.stopped.slice(from) }];
    }
    const settled: Settled = out = { runs: [], stopped: [] };
    try {
      return [fn(), settled];
    } finally {
      try {
        settle();
      } finally {
        out = undefined;
      }
    }
  }

  /** Adds what a change marked to the due list, then learns from it and walks the tree. */
  function note(answer: Changed) {
    const c = answer.change;
    gathering?.push(c);
    for (const { process } of answer.marked) mark(process, c);
    walk(c);
  }

  function learn(c: Change) {
    if (c.kind === "make") {
      const data = c.data;
      if (isObject(data) && Object.hasOwn(data, "path")) {
        known.set(c.node, { process: { path: data.path }, value: c.value, slots: new Map() });
      } else if (c.node === root) {
        known.set(c.node, { value: c.value, slots: new Map() });
      }
      return;
    }
    const node = known.get(c.node);
    if (!node) return;
    if (c.kind === "write") {
      node.value = applyPatches(node.value, c.patches);
      return;
    }
    const slot = node.slots.get(c.name) ?? [];
    const next = c.kind === "place"
      ? placed(slot, c.id, c.position)
      : slot.filter((id) => id !== c.id);
    if (next.length) node.slots.set(c.name, next);
    else node.slots.delete(c.name);
  }

  function mark(id: Id, c: Change) {
    if (!running.has(id) || c.process === id) return;
    const d = due.get(id);
    if (d) d.marks.push(c);
    else due.set(id, { marks: [c], first: c.time });
  }

  // the tree

  let walking = false;
  const walks: Change[] = [];

  /**
   * Learns from the change, starts what it made reachable and stops what it
   * cut off. A change made during the walk, by a cleanup, waits its turn, so
   * each change is learned, and starts what it reaches, in time order.
   */
  function walk(c: Change) {
    walks.push(c);
    if (walking) return;
    walking = true;
    try {
      while (walks.length) {
        const c = walks.shift()!;
        learn(c);
        const reached = tree();
        for (const id of reached) if (!running.has(id)) start(id, c);
        const now = new Set(reached);
        const gone = order.filter((id) => running.has(id) && !now.has(id));
        order = reached;
        for (const id of gone) stop(id);
      }
    } finally {
      walking = false;
    }
  }

  /** The process nodes beneath the root: depth first, names in code point order, ids in slot order. */
  function tree(): Id[] {
    const reached: Id[] = [];
    const seen = new Set<Id>([root]);
    const enter = (node: Id) => {
      const slots = known.get(node)?.slots;
      if (!slots) return;
      for (const name of [...slots.keys()].sort(byCodePoint)) {
        if (name === "compute" || name === "effect") continue;
        for (const id of slots.get(name)!) {
          if (seen.has(id) || !known.get(id)?.process) continue;
          seen.add(id);
          reached.push(id);
          enter(id);
        }
      }
    };
    enter(root);
    return reached;
  }

  function start(id: Id, c: Change) {
    const given = known.get(id)!.process!.path;
    let path: Process["path"];
    try {
      checkPath(given);
      path = given;
    } catch (e) {
      path = { not: (e as Error).message };
    }
    running.set(id, {
      id,
      agent: c.agent,
      path,
      height: 0,
      fresh: true,
      lasting: top.bind(top, { ...binding(c.agent, id, path), writes: true, reads: false }),
      handlers: new Map(),
      values: new Set(),
      read: new Set(),
      wrote: false,
    });
    due.set(id, { marks: [c], first: c.time });
  }

  function stop(id: Id) {
    const p = running.get(id)!;
    running.delete(id);
    due.delete(id);
    if (p.run) finish(p);
    // before its cleanup, so what the cleanup stops comes after it
    const stopped: Stopped = { process: id, changes: [] };
    out!.stopped.push(stopped);
    if (p.cleanup) Object.assign(stopped, clean(p));
    p.lasting.end();
    p.handlers.clear();
  }

  /** Runs a process's cleanup, gathering the changes it makes. */
  function clean(p: Process): { changes: Change[]; error?: unknown } {
    const cleanup = p.cleanup!;
    p.cleanup = undefined;
    const outer = gathering;
    const changes: Change[] = gathering = [];
    try {
      cleanup();
      return { changes };
    } catch (error) {
      return { changes, error };
    } finally {
      gathering = outer;
    }
  }

  // rounds

  function settle() {
    while (due.size) {
      const ran = new Set<Process>();
      while (due.size) {
        const id = next();
        const { marks } = due.get(id)!;
        due.delete(id);
        const p = running.get(id)!;
        if (ran.has(p)) {
          // it runs again: the run it replaces ends here, with no effect
          if (p.run) finish(p);
          ran.delete(p);
        } else {
          p.wrote = false;
        }
        ran.add(p);
        compute(p, marks);
      }
      for (const p of ran) if (running.get(p.id) === p && p.run) conclude(p);
    }
  }

  /** The due process with the lowest height, then the oldest first mark, then the lowest id. */
  function next(): Id {
    const rank = (id: Id) => [running.get(id)!.height, due.get(id)!.first] as const;
    let best: Id | undefined;
    for (const id of due.keys()) {
      if (best === undefined) {
        best = id;
        continue;
      }
      const [h, f] = rank(id);
      const [bh, bf] = rank(best);
      if (h < bh || (h === bh && (f < bf || (f === bf && byCodePoint(id, best) < 0)))) best = id;
    }
    return best!;
  }

  function compute(p: Process, marks: Change[]) {
    const bound = binding(p.agent, p.id, p.path);
    const reader = top.bind(top, { ...bound, writes: false });
    const rec = top.record(reader, marks);
    const run: Run = { rec, errors: [], before: known.get(p.id)!.value };
    p.run = run;
    try {
      if ("not" in p.path) {
        // fixed data never changes, so it fails each run until a restart
        run.errors.push({ kind: "invalid", op: "path", why: p.path.not });
        run.ending = "failed";
        return;
      }
      const c = rec.program("compute");
      if (!c) {
        run.errors.push({ kind: "invalid", op: "compute", why: "the compute slot is gone" });
        run.ending = "failed";
        return;
      }
      const e = rec.program("effect");
      if ("absent" in c || (e && "absent" in e)) {
        run.ending = "pending";
        return;
      }
      if (e && "value" in e) run.effect = { code: e.value };
      const v = load(c.value, "compute")({ api: rec, self: p.id, path: p.path, changes: marks });
      if (v === PENDING) {
        run.ending = "pending";
        return;
      }
      // an invalid or refused operation, even one it caught, spoils the value
      if (rec.errors.length) {
        run.ending = blame(rec.errors);
        return;
      }
      const value = v === undefined ? null : v;
      run.result = { value };
      if (!equal(value, known.get(p.id)!.value)) {
        const writer = top.bind(top, { ...bound, writes: true });
        try {
          rec.through(writer).write({ node: p.id, patches: [{ type: "snapshot", value }] });
        } finally {
          writer.end();
        }
        p.wrote = true;
      }
    } catch (e) {
      run.ending = blame(rec.errors, e);
    } finally {
      reader.end();
      // the program nodes are read as part of the compute
      const programs = rec.programs.filter((node) => node !== p.id);
      p.values = new Set([...programs, ...rec.reads.map((r) => r.node)]);
      p.read = new Set([
        ...rec.programs,
        ...p.values,
        ...rec.directories.map((d) => d.node),
        ...rec.lookups.flatMap((l) =>
          l.searched.filter((s) => !("refused" in s)).map((s) => s.node)
        ),
      ]);
      rise(p, (q) => q.values.has(p.id));
    }
  }

  /** Runs the cleanup and effect if they are owed, and finishes the run. */
  function conclude(p: Process) {
    const run = p.run!;
    // taken now, so a stop during its own effect does not finish it twice
    p.run = undefined;
    let cleanup: Change[] = [];
    if (run.ending === undefined && run.result && (p.fresh || p.wrote)) {
      const previous = p.fresh ? {} : { previous: run.before };
      p.fresh = false;
      try {
        if (p.cleanup) {
          const cleaned = clean(p);
          cleanup = cleaned.changes;
          if ("error" in cleaned) throw cleaned.error;
        }
        if (run.effect) effect(p, run, previous);
      } catch (e) {
        run.ending = blame(run.rec.errors, e);
      }
    }
    finish(p, run, cleanup);
  }

  function effect(p: Process, run: Run, previous: { previous?: Json }) {
    const writer = top.bind(top, { ...binding(p.agent, p.id, p.path), writes: true, reads: false });
    const outer = gathering;
    const changes: Change[] = gathering = [];
    try {
      const after = load(run.effect!.code, "effect")({
        api: run.rec.through(writer),
        self: p.id,
        value: run.result!.value,
        ...previous,
        lasting: p.lasting,
        handler: (name, h) => void p.handlers.set(name, h),
      });
      if (typeof after === "function") p.cleanup = after;
    } finally {
      writer.end();
      gathering = outer;
      rise(p, (q) => changes.some((c) => q.read.has(c.node)));
    }
    if (run.rec.errors.length) run.ending = blame(run.rec.errors);
  }

  /** Raises above p each other process that depends on it, as a height only rises. */
  function rise(p: Process, depends: (q: Process) => boolean) {
    for (const q of running.values()) {
      if (q !== p && depends(q)) q.height = Math.max(q.height, p.height + 1);
    }
  }

  /** Finishes a run, by default the process's open one, and reports its record. */
  function finish(p: Process, run = p.run!, cleanup: Change[] = []) {
    if (p.run === run) p.run = undefined;
    const finishing: Finishing = { cleanup, errors: run.errors };
    if (run.result) finishing.value = run.result.value;
    out!.runs.push(top.finish(run.rec, run.ending ?? "done", finishing));
  }

  // the driver's own operations

  /** Its changes' answers report what each stopped; this reports what ran after. */
  function batch(fn: () => void): Settled {
    let from = 0;
    const [, { runs, stopped }] = request(() => {
      fn();
      from = out!.stopped.length;
    });
    return { runs, stopped: stopped.slice(from) };
  }

  function fire(op: FireOp): Fired {
    const p = typeof op?.process === "string" ? running.get(op.process) : undefined;
    if (!p) throw new Invalid(`${JSON.stringify(op?.process)} is not a running process`);
    const handler = typeof op.handler === "string" ? p.handlers.get(op.handler) : undefined;
    if (!handler) throw new Invalid(`${p.id} has no handler ${JSON.stringify(op.handler)}`);
    const changes: Change[] = [];
    let error: { error?: unknown } = {};
    const [, settled] = request(() => {
      const outer = gathering;
      gathering = changes;
      try {
        if ("input" in op && op.input !== undefined) handler(op.input);
        else handler();
      } catch (e) {
        error = { error: e };
      } finally {
        gathering = outer;
      }
    });
    return { changes, ...settled, ...error };
  }

  const driver: Driver = {
    ...lower,
    make: change((op: MakeOp) => lower.make(op)),
    write: change((op: WriteOp) => lower.write(op)),
    place: change((op: PlaceOp) => lower.place(op)),
    unplace: change((op: UnplaceOp) => lower.unplace(op)),
    batch,
    fire,
  };
  top = driver;
  const below = lower.top(driver);
  driver.top = told((api) => {
    top = api;
    below(api);
  });
  return driver;
}

/** What a process's interfaces are bound to: a path that is not one is left out. */
function binding(agent: Json, process: Id, path: Process["path"]) {
  return "not" in path ? { agent, process } : { agent, process, path };
}

/** How a run ends after trouble: refused if anything was refused, failed otherwise. */
function blame(errors: readonly RecordError[], thrown?: unknown): Ending {
  return thrown instanceof Refused || errors.some((e) => e.kind === "refused")
    ? "refused"
    : "failed";
}
