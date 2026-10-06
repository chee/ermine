// Everything that depends on how far a harness lags PROTOCOL.tex lives here:
// the answer shapes it gives (lifted to the current shape), the program
// dialect it reads (requests lowered going out), and the switches that pick
// which rule an invariant holds it to. Nothing else in the fuzzer knows about
// lag.

// deno-lint-ignore-file no-explicit-any
import { isObject, type Json, type Obj } from "./model.ts";

export type Switches = {
  /** S1: the effect runs after every run that returned a value, or only when the value was written. */
  effects: "every-value" | "on-change";
  /** S2: a change marks the process that made it, or not. */
  own: "marked" | "unmarked";
  /** S3: an uncaught throw is listed in errors, or a run may fail with errors []. */
  throws: "listed" | "unlisted";
  /** S4: a run's reads replace the last when it finishes however it ended, or only when its compute returned. */
  reads: "every-run" | "returned";
  /** S5: a refused read is kept for marking (and a lookup's refused directory), or dropped. */
  refused: "counted" | "dropped";
  /**
   * S6: after an effect, which processes go above it: those whose last compute
   * read the value of a node the effect changed ("value-reads", as C and
   * Haskell do); read that node in any way ("node-reads", PROTOCOL at
   * 6bbceda: "read a node the effect changed"); or read anything the effect
   * or its cleanup changed ("any", the working-tree PROTOCOL).
   */
  heights: "value-reads" | "node-reads" | "any";
  /**
   * S7: a read's saw. "latest-change": the node's latest change of any kind
   * (PROTOCOL at 6bbceda). "by-kind": a value's making or last write, a
   * slot's last placement, fixed data's making (the working-tree PROTOCOL).
   */
  saw: "latest-change" | "by-kind";
  /** S8: the driver walks after every change ("every-change", 6bbceda), or once after a batch's last request ("batch-once", working tree). */
  walk: "every-change" | "batch-once";
  /** S9: a position counts in the slot after the move, one past the end allowed ("after-move", 6bbceda), or is a gap in the slot as it is ("gap", working tree). */
  positions: "after-move" | "gap";
  /** S10: the driver's value comparison: numbers by value ("value", 6bbceda) or as Object.is ("object-is", working tree). */
  equality: "value" | "object-is";
  /**
   * S11: when a run's reads replace the last for marking: when its compute
   * returns ("compute", CORE at 6bbceda: "Each run's reads replace the
   * previous run's when the run's compute returns"), or when the run is
   * finished ("finish").
   */
  kept: "compute" | "finish";
};

export type Profile = {
  name: string;
  /** "items": reads answer {items}; "value": {value}/{absent}, {slot}, {found}, {data} (A1-A4), and programs use $absent (A5). */
  dialect: "items" | "value";
  /** A7: a batch's inner change answers carry their own runs and stopped, which are lifted to the batch answer. */
  innerLists: boolean;
  /** A8: a fire answer carries the handler's record; lagging harnesses leave it out. */
  fireHandler: boolean;
  /** A10: an error's why is a string ("text") or {code, ...details, text?} ("code"). */
  why: "text" | "code";
  switches: Switches;
};

/** The target: PROTOCOL.tex and CORE.tex as committed at 6bbceda (see DESIGN.md, Target). */
export const SPEC: Switches = {
  effects: "every-value",
  own: "marked",
  throws: "listed",
  reads: "every-run",
  refused: "counted",
  heights: "node-reads",
  saw: "latest-change",
  walk: "every-change",
  positions: "after-move",
  equality: "value",
  kept: "compute",
};

/** The rules of the working-tree spec that can be judged in the node-id dialect. */
export const WORKTREE: Switches = {
  ...SPEC,
  heights: "any",
  saw: "by-kind",
  walk: "batch-once",
  positions: "gap",
  equality: "object-is",
};

export const LAG: Switches = {
  ...SPEC,
  effects: "on-change",
  own: "unmarked",
  throws: "unlisted",
  refused: "dropped",
  heights: "value-reads",
};

export const PROFILES: Record<string, Profile> = {
  current: {
    name: "current",
    dialect: "items",
    innerLists: false,
    fireHandler: true,
    why: "text",
    switches: SPEC,
  },
  worktree: {
    name: "worktree",
    dialect: "items",
    innerLists: false,
    fireHandler: true,
    why: "code",
    switches: WORKTREE,
  },
  "2026-10-lag": {
    name: "2026-10-lag",
    dialect: "value",
    innerLists: true,
    fireHandler: false,
    why: "text",
    switches: LAG,
  },
  "ts-2026-10": {
    name: "ts-2026-10",
    dialect: "items",
    innerLists: true,
    fireHandler: false,
    why: "text",
    // the TS harness raises heights for any read of a node an effect changed
    switches: { ...LAG, heights: "node-reads" },
  },
};

/** Applies --switch overrides such as "effects=every-value,own=marked". */
export function withSwitches(p: Profile, text?: string): Profile {
  if (!text) return p;
  const switches = { ...p.switches } as Record<string, string>;
  for (const part of text.split(",").filter(Boolean)) {
    const [k, v] = part.split("=");
    if (!(k in switches)) throw new Error(`no switch ${k}`);
    switches[k] = v;
  }
  return { ...p, switches: switches as Switches };
}

// A5: programs going out ------------------------------------------------------

/**
 * A request in the harness's program dialect. For "value": $missing becomes
 * $absent, and $value and $ids are dropped, since read binds the value and
 * directory and lookup bind lists of ids. Faithful only for programs that use
 * read results through those operators, as the generator's templates do.
 */
export function lower(p: Profile, x: unknown): any {
  if (p.dialect === "items") return x;
  return lowerJson(x);
}

export function lowerJson(x: unknown): any {
  if (Array.isArray(x)) return x.map(lowerJson);
  if (!isObject(x)) return x;
  const keys = Object.keys(x);
  if (keys.length === 1) {
    const k = keys[0];
    if (k === "$missing") return { $absent: lowerJson(x[k]) };
    if (k === "$value" || k === "$ids") return lowerJson(x[k]);
    if (k === "$quote") return x;
  }
  const out: Obj = {};
  for (const k of keys) out[k] = lowerJson(x[k]);
  return out;
}

// A1-A4: answers coming back --------------------------------------------------

const byNode = (node: unknown, value: Json) => ({ value, from: { node } });
const slotItems = (parent: unknown, name: unknown, ids: Json[], up?: number) =>
  ids.map((id, position) => ({
    id,
    from: { slot: { parent, name }, position, ...(up === undefined ? {} : { up }) },
  }));

/** The ok result of a request in the current shape. Lookup `from` is unknown under lag: `{"lagged": true}`. */
export function liftOk(p: Profile, req: Obj, ok: any): any {
  if (p.dialect === "items" || !isObject(ok)) return ok;
  switch (req.cmd) {
    case "read":
      if ("value" in ok) return { items: [byNode(req.node, ok.value)] };
      if (ok.absent === true) return { items: [] };
      return ok;
    case "data":
      if ("data" in ok) return { items: [byNode(req.node, ok.data)] };
      if (ok.absent === true) return { items: [] };
      return ok;
    case "directory":
      if (Array.isArray(ok.slot)) return { items: slotItems(req.node, req.name, ok.slot) };
      if (Array.isArray(ok.directory)) {
        return {
          directory: ok.directory.map(([name, ids]: [string, Json[]]) => [
            name,
            Array.isArray(ids) ? slotItems(req.node, name, ids) : ids,
          ]),
        };
      }
      if (ok.absent === true) return req.name === undefined ? { directory: [] } : { items: [] };
      return ok;
    case "lookup":
      if (Array.isArray(ok.found)) {
        return { items: ok.found.map((id: Json) => ({ id, from: { lagged: true } })) };
      }
      return ok;
    case "batch":
      if (Array.isArray(ok.answers) && Array.isArray(req.requests)) {
        return {
          ...ok,
          answers: ok.answers.map((a: any, i: number) => liftAnswer(p, req.requests[i] as Obj, a)),
        };
      }
      return ok;
  }
  return ok;
}

export function liftAnswer(p: Profile, req: Obj, answer: any): any {
  if (!isObject(answer) || !("ok" in answer) || !isObject(req)) return answer;
  let ok = liftOk(p, req, answer.ok);
  if (p.innerLists && req.cmd === "batch") ok = hoist(ok);
  return { ...answer, ok: normalizeRecords(p.dialect === "items" ? ok : liftRecords(ok)) };
}

/**
 * Records in the working-tree shape (A0: reads as `{op, address, name?,
 * route, saw}` with no `directories`) brought to the shape the invariants
 * read: `reads: [{node, saw}]`, `directories: [{node, name?, saw}]`, the node
 * being the last route step's, and `routes`, every `{parent, name}` a walk went
 * through (for marking). Records already in that shape pass unchanged.
 */
export function normalizeRecords(x: any): any {
  if (Array.isArray(x)) return x.map(normalizeRecords);
  if (!isObject(x)) return x;
  const out: Obj = {};
  for (const [k, v] of Object.entries(x)) out[k] = normalizeRecords(v);
  const reads = out.reads;
  if (
    "ending" in out && Array.isArray(reads) && !("directories" in out) &&
    reads.some((r: any) => isObject(r) && "op" in r)
  ) {
    const values: Obj[] = [], dirs: Obj[] = [], data: Obj[] = [], routes: Obj[] = [];
    for (const r of reads as any[]) {
      const route = Array.isArray(r?.route) ? r.route : [];
      for (const s of route) if (isObject(s)) routes.push({ parent: s.parent, name: s.name });
      const node = route.length ? route[route.length - 1].node : r?.address;
      const entry: Obj = { node, saw: r?.saw ?? null, ...(r?.refused ? { refused: true } : {}) };
      if (r?.op === "directory") dirs.push({ ...entry, ...("name" in r ? { name: r.name } : {}) });
      else if (r?.op === "data") data.push(entry);
      else values.push(entry);
    }
    out.reads = values;
    out.directories = dirs;
    out.data = data;
    out.routes = routes;
  }
  return out;
}

/** A7: a batch's inner runs and stopped, moved to the batch answer, ahead of its own. */
function hoist(ok: any): any {
  if (!isObject(ok) || !Array.isArray(ok.answers)) return ok;
  const runs: any[] = [], stopped: any[] = [];
  const answers = ok.answers.map((a: any) => {
    if (!isObject(a?.ok)) return a;
    const { runs: r, stopped: s, ...rest } = a.ok as any;
    if (Array.isArray(r)) runs.push(...r);
    if (Array.isArray(s)) stopped.push(...s);
    return { ...a, ok: rest };
  });
  return {
    ...ok,
    answers,
    runs: [...runs, ...(Array.isArray(ok.runs) ? ok.runs : [])],
    stopped: [...stopped, ...(Array.isArray(ok.stopped) ? ok.stopped : [])],
  };
}

/**
 * A6: a record's compute or effect entry for a program node that gave no
 * items is {node, saw: null, slot}; lagging harnesses give {node, absent: true, slot}.
 */
function liftRecords(x: any): any {
  if (Array.isArray(x)) return x.map(liftRecords);
  if (!isObject(x)) return x;
  const out: Obj = {};
  for (const [k, v] of Object.entries(x)) {
    if ((k === "compute" || k === "effect") && isObject(v) && v.absent === true && "slot" in v) {
      const { absent: _a, ...rest } = v;
      out[k] = { ...rest, saw: null };
    } else out[k] = liftRecords(v);
  }
  return out;
}

/** The reverse of liftOk, for writing a saved scenario's expectation in the harness's dialect. */
export function lowerOk(p: Profile, req: Obj, ok: any): any {
  if (p.dialect === "items" || !isObject(ok)) return ok;
  const items = ok.items as any[] | undefined;
  switch (req.cmd) {
    case "read":
      return items?.length ? { value: lowerJson(items[0].value) } : { absent: true };
    case "data":
      return items?.length ? { data: items[0].value } : { absent: true };
    case "directory":
      if (items) return { slot: items.map((i) => i.id) };
      return {
        directory: (ok.directory as any[]).map(([n, its]) => [n, its.map((i: any) => i.id)]),
      };
    case "lookup":
      return { found: (items ?? []).map((i) => i.id) };
  }
  return ok;
}

/**
 * A value for comparing across dialects: program operators lowered, and lookup
 * `from` left out when either side lagged.
 */
export function comparable(x: unknown, crossDialect: boolean): unknown {
  if (!crossDialect) return x;
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (!isObject(v)) return v;
    const out: Obj = {};
    for (const [k, w] of Object.entries(v)) {
      if (k === "from" && isObject(w) && ("lagged" in w || "up" in w)) continue;
      out[k] = strip(w) as Json;
    }
    return out;
  };
  return strip(lowerJson(x));
}
