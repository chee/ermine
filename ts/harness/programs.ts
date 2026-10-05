// Programs as data (PROTOCOL.tex): the harness's loader.
//
// A program node's value is a list of steps. load() checks that and gives a
// program with two parts, compute and effect; runHandler() runs a handler's
// or a cleanup's steps later, with the lasting interface.
//
// The interpreter calls a small interface, Api, which adapt() makes from a
// stack's interface; loader, at the end, is the loader the harness gives
// drive:
//
//   read(node)                 the node's value, or ABSENT
//   directory(node, name?)     with a name, the slot's ids ([] if gone);
//                              without, [[name, [id]]] as in the directory
//                              answer; ABSENT if the node is absent
//   lookup(name)               the ids found, a list
//   make({id, value, data?, cause?})
//   write({node, patches, cause?})
//   place({parent, name, id, position?, cause?})
//   unplace({parent, name, id, cause?})
//
// Every method is optional. A step whose operation the interface leaves out
// is invalid, {kind: "invalid", op}; so an effect may be given an interface
// with no reads, and a compute one with no writes. An interface that has the
// method may throw instead (and record it): the interpreter lets that error
// pass as it is, so drive sees the graph's own invalid or refused error.
//
// Errors. A throw step, an operator given the wrong kind or absent, an
// unknown variable, a step used in the wrong part: each throws a
// ProgramError of kind "thrown", why the message as text. A try binds its
// variable to errorJson(e) of what it caught: {kind, why} with op when an
// operation failed, so a caught refusal is {kind: "refused", op, why}.
//
// Variables live in one scope per part; let, each and try set them in it.
// An optional field (cause, position, name) that evaluates to absent is
// left out.

import { type Compute, type Effect, type Load, PENDING } from "../src/drive.ts";
import type { Interface, WriteOp } from "../src/types.ts";

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

/** Absent is not a value: a read of an absent node, a missing key. */
export const ABSENT: unique symbol = Symbol("absent");
export type Absent = typeof ABSENT;
export type Value = Json | Absent;

export type Api = {
  read?(node: string): Value;
  directory?(node: string, name?: string): Value;
  lookup?(name: string): Json;
  make?(op: { id: string; value: Json; data?: Json; cause?: Json }): unknown;
  write?(op: { node: string; patches: Json; cause?: Json }): unknown;
  place?(
    op: {
      parent: string;
      name: string;
      id: string;
      position?: number;
      cause?: Json;
    },
  ): unknown;
  unplace?(
    op: { parent: string; name: string; id: string; cause?: Json },
  ): unknown;
};

export type ComputeContext = {
  api: Api;
  /** the process id */
  self: string;
  path: Json;
  /** the changes that marked the process */
  changes: Json;
};

/** A handler, as registered: drive calls it with the lasting interface. */
export type Fire = (api: Api, input: Value) => void;
/** A cleanup, as registered: drive calls it with the lasting interface. */
export type Cleanup = (api: Api) => void;

export type EffectContext = {
  api: Api;
  self: string;
  /** the process's value */
  value: Json;
  /** its value before this run; ABSENT on the first run */
  previous: Value;
  /** registers a handler; one of the same name replaces it */
  handler(name: string, fire: Fire): void;
  /** sets the effect's cleanup; a later one replaces it */
  cleanup(run: Cleanup): void;
};

/** What a compute gives: a value, or pending. */
export type Outcome = { value: Json } | { pending: true };

export type Program = {
  compute(ctx: ComputeContext): Outcome;
  effect(ctx: EffectContext): void;
};

export class ProgramError extends Error {
  kind: string;
  op?: string;
  why: string;
  constructor(kind: string, why: string, op?: string) {
    super(why);
    this.name = "ProgramError";
    this.kind = kind;
    this.why = why;
    if (op !== undefined) this.op = op;
  }
}

function thrown(why: string): ProgramError {
  return new ProgramError("thrown", why);
}

/** An error as a try step binds it: {kind, why} and op if there is one. */
export function errorJson(e: unknown): Json {
  const out: { [key: string]: Json } = {};
  if (e !== null && typeof e === "object") {
    const o = e as { kind?: unknown; op?: unknown; why?: unknown };
    if (typeof o.kind === "string") {
      out.kind = o.kind;
      if (typeof o.op === "string") out.op = o.op;
      out.why = typeof o.why === "string" ? o.why : e instanceof Error ? e.message : String(e);
      return out;
    }
  }
  out.kind = "thrown";
  out.why = e instanceof Error ? e.message : String(e);
  return out;
}

// --- values ---------------------------------------------------------------

function isObject(v: Value): v is { [key: string]: Json } {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function put(o: { [key: string]: Json }, key: string, value: Json) {
  // defineProperty, so a "__proto__" key is a key
  Object.defineProperty(o, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function kindOf(v: Value): string {
  if (v === ABSENT) return "absent";
  if (v === null) return "null";
  if (Array.isArray(v)) return "list";
  return typeof v;
}

/** Value equality, as $eq: objects in any key order, numbers by value. */
export function equal(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => equal(x, b[i]));
  }
  if (isObject(a)) {
    if (!isObject(b)) return false;
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]));
  }
  return false;
}

function copy(v: Json): Json {
  if (Array.isArray(v)) return v.map(copy);
  if (isObject(v)) {
    const out: { [key: string]: Json } = {};
    for (const k of Object.keys(v)) put(out, k, copy(v[k]));
    return out;
  }
  return v;
}

// --- expressions ----------------------------------------------------------

type Vars = Map<string, Value>;

function operator(e: Json): string | undefined {
  if (!isObject(e)) return undefined;
  const keys = Object.keys(e);
  if (keys.length === 1 && keys[0].startsWith("$")) return keys[0];
  return undefined;
}

/** A value that must be there: anything but absent. */
function present(v: Value, what: string): Json {
  if (v === ABSENT) throw thrown(`${what} is absent`);
  return v;
}

function evaluate(e: Json, vars: Vars): Value {
  const op = operator(e);
  if (op !== undefined) {
    return apply(op, (e as { [key: string]: Json })[op], vars);
  }
  if (Array.isArray(e)) {
    return e.map((x, i) => present(evaluate(x, vars), `element ${i}`));
  }
  if (isObject(e)) {
    const out: { [key: string]: Json } = {};
    for (const k of Object.keys(e)) {
      put(out, k, present(evaluate(e[k], vars), `key ${JSON.stringify(k)}`));
    }
    return out;
  }
  return e;
}

/** Evaluates e and checks it is there. */
function value(e: Json, vars: Vars, what: string): Json {
  return present(evaluate(e, vars), what);
}

function list(e: Json, vars: Vars, what: string): Json[] {
  const v = value(e, vars, what);
  if (!Array.isArray(v)) {
    throw thrown(`${what} must be a list, not ${kindOf(v)}`);
  }
  return v;
}

function string(e: Json, vars: Vars, what: string): string {
  const v = value(e, vars, what);
  if (typeof v !== "string") {
    throw thrown(`${what} must be a string, not ${kindOf(v)}`);
  }
  return v;
}

function apply(op: string, arg: Json, vars: Vars): Value {
  switch (op) {
    case "$": {
      if (typeof arg !== "string") throw thrown("$ takes a variable name");
      if (!vars.has(arg)) throw thrown(`no variable ${JSON.stringify(arg)}`);
      return vars.get(arg)!;
    }
    case "$get": {
      const [base, ...keys] = list(arg, vars, "$get");
      if (base === undefined) throw thrown("$get needs a value");
      let v: Value = base;
      for (const k of keys) {
        if (Array.isArray(v)) {
          if (typeof k !== "number") {
            throw thrown(
              `$get: a list's key must be a number, not ${kindOf(k)}`,
            );
          }
          v = Number.isInteger(k) && k >= 0 && k < v.length ? v[k] : ABSENT;
        } else if (isObject(v)) {
          if (typeof k !== "string") {
            throw thrown(
              `$get: an object's key must be a string, not ${kindOf(k)}`,
            );
          }
          v = Object.hasOwn(v, k) ? v[k] : ABSENT;
        } else if (v === ABSENT) {
          return ABSENT;
        } else {
          throw thrown(`$get: cannot get from ${kindOf(v)}`);
        }
      }
      return v;
    }
    case "$eq": {
      const args = list(arg, vars, "$eq");
      if (args.length !== 2) throw thrown("$eq takes two values");
      return equal(args[0], args[1]);
    }
    case "$not": {
      const v = value(arg, vars, "$not");
      if (typeof v !== "boolean") {
        throw thrown(`$not takes a boolean, not ${kindOf(v)}`);
      }
      return !v;
    }
    case "$absent":
      return evaluate(arg, vars) === ABSENT;
    case "$add": {
      let sum = 0;
      for (const v of list(arg, vars, "$add")) {
        if (typeof v !== "number") {
          throw thrown(`$add takes numbers, not ${kindOf(v)}`);
        }
        sum += v;
      }
      return sum;
    }
    case "$concat": {
      const args = list(arg, vars, "$concat");
      if (args.every((v) => typeof v === "string")) return args.join("");
      if (args.every(Array.isArray)) return args.flat(1);
      throw thrown("$concat takes all strings or all lists");
    }
    case "$len": {
      const v = value(arg, vars, "$len");
      if (typeof v === "string") return [...v].length;
      if (Array.isArray(v)) return v.length;
      if (isObject(v)) return Object.keys(v).length;
      throw thrown(`$len takes a string, list or object, not ${kindOf(v)}`);
    }
    case "$quote":
      return copy(arg);
  }
  throw thrown(`unknown operator ${op}`);
}

// --- steps ----------------------------------------------------------------

type Step = { [key: string]: Json };
type Part = "compute" | "effect" | "handler" | "cleanup";

/** What a part's run needs beyond its variables. */
type Run = {
  part: Part;
  api: Api;
  handler?: (name: string, fire: Fire) => void;
  cleanup?: (run: Cleanup) => void;
};

/** How a list of steps ended: on, return, or pending. */
type End = undefined | { value: Json } | { pending: true };

// fields each step must have, and those it may have
const shapes: { [step: string]: { need: string[]; may: string[] } } = {
  read: { need: ["node", "as"], may: [] },
  directory: { need: ["node", "as"], may: ["name"] },
  lookup: { need: ["name", "as"], may: [] },
  let: { need: ["as", "value"], may: [] },
  if: { need: ["test", "then"], may: ["else"] },
  each: { need: ["list", "as", "steps"], may: [] },
  return: { need: ["value"], may: [] },
  pending: { need: [], may: [] },
  throw: { need: ["message"], may: [] },
  try: { need: ["steps", "as"], may: [] },
  make: { need: ["id", "value"], may: ["data", "cause"] },
  write: { need: ["node", "patches"], may: ["cause"] },
  place: { need: ["parent", "name", "id"], may: ["position", "cause"] },
  unplace: { need: ["parent", "name", "id"], may: ["cause"] },
  handler: { need: ["name", "steps"], may: [] },
  cleanup: { need: ["steps"], may: [] },
};

// fields that hold steps, and those that hold a literal string
const nested = ["then", "else", "steps"];
const literal: { [step: string]: string[] } = {
  read: ["as"],
  directory: ["as"],
  lookup: ["as"],
  let: ["as"],
  each: ["as"],
  try: ["as"],
  handler: ["name"],
};

/** Why v is not a list of steps, or undefined if it is. */
function checkSteps(v: Json, at: string): string | undefined {
  if (!Array.isArray(v)) return `${at} is not a list of steps`;
  for (let i = 0; i < v.length; i++) {
    const why = checkStep(v[i], `${at}[${i}]`);
    if (why) return why;
  }
  return undefined;
}

function checkStep(s: Json, at: string): string | undefined {
  if (!isObject(s)) return `${at} is not a step`;
  const kind = s.do;
  if (typeof kind !== "string" || !Object.hasOwn(shapes, kind)) {
    return `${at} has no known "do"`;
  }
  for (const f of shapes[kind].need) {
    if (!Object.hasOwn(s, f)) return `${at}: ${kind} needs "${f}"`;
  }
  for (const f of literal[kind] ?? []) {
    if (typeof s[f] !== "string") {
      return `${at}: ${kind}'s "${f}" must be a string`;
    }
  }
  if (
    kind === "if" || kind === "each" || kind === "try" || kind === "handler" ||
    kind === "cleanup"
  ) {
    for (const f of nested) {
      if (Object.hasOwn(s, f)) {
        const why = checkSteps(s[f], `${at}.${f}`);
        if (why) return why;
      }
    }
  }
  return undefined;
}

/** An optional field: undefined when not given or absent. */
function optional(s: Step, field: string, vars: Vars): Json | undefined {
  if (!Object.hasOwn(s, field)) return undefined;
  const v = evaluate(s[field], vars);
  return v === ABSENT ? undefined : v;
}

function method<K extends keyof Api>(api: Api, op: K): NonNullable<Api[K]> {
  const f = api[op];
  if (typeof f !== "function") {
    throw new ProgramError("invalid", `this interface has no ${op}`, op);
  }
  const g = f as (...args: unknown[]) => unknown;
  return ((...args: unknown[]) => g.apply(api, args)) as NonNullable<Api[K]>;
}

function runSteps(steps: Step[], vars: Vars, run: Run): End {
  for (const s of steps) {
    const end = runStep(s, vars, run);
    if (end) return end;
  }
  return undefined;
}

function runStep(s: Step, vars: Vars, run: Run): End {
  const kind = s.do as string;
  switch (kind) {
    case "read": {
      const node = string(s.node, vars, "read's node");
      vars.set(s.as as string, method(run.api, "read")(node));
      return;
    }
    case "directory": {
      const node = string(s.node, vars, "directory's node");
      const name = optional(s, "name", vars);
      if (name !== undefined && typeof name !== "string") {
        throw thrown(`directory's name must be a string, not ${kindOf(name)}`);
      }
      const f = method(run.api, "directory");
      vars.set(s.as as string, name === undefined ? f(node) : f(node, name));
      return;
    }
    case "lookup": {
      const name = string(s.name, vars, "lookup's name");
      vars.set(s.as as string, method(run.api, "lookup")(name));
      return;
    }
    case "let":
      vars.set(s.as as string, evaluate(s.value, vars));
      return;
    case "if": {
      const test = value(s.test, vars, "if's test");
      if (typeof test !== "boolean") {
        throw thrown(`if's test must be a boolean, not ${kindOf(test)}`);
      }
      if (test) return runSteps(s.then as Step[], vars, run);
      if (Object.hasOwn(s, "else")) {
        return runSteps(s.else as Step[], vars, run);
      }
      return;
    }
    case "each": {
      for (const x of list(s.list, vars, "each's list")) {
        vars.set(s.as as string, x);
        const end = runSteps(s.steps as Step[], vars, run);
        if (end) return end;
      }
      return;
    }
    case "return":
      return { value: value(s.value, vars, "the value returned") };
    case "pending":
      if (run.part !== "compute") throw thrown(`pending in ${a(run.part)}`);
      return { pending: true };
    case "throw": {
      const m = value(s.message, vars, "throw's message");
      throw thrown(typeof m === "string" ? m : JSON.stringify(m));
    }
    case "try": {
      let caught: Json = null;
      let end: End;
      try {
        end = runSteps(s.steps as Step[], vars, run);
      } catch (e) {
        caught = errorJson(e);
      }
      vars.set(s.as as string, caught);
      return end;
    }
    case "make": {
      const op: { id: string; value: Json; data?: Json; cause?: Json } = {
        id: string(s.id, vars, "make's id"),
        value: value(s.value, vars, "make's value"),
      };
      const data = optional(s, "data", vars);
      if (data !== undefined) op.data = data;
      const cause = optional(s, "cause", vars);
      if (cause !== undefined) op.cause = cause;
      method(run.api, "make")(op);
      return;
    }
    case "write": {
      const op: { node: string; patches: Json; cause?: Json } = {
        node: string(s.node, vars, "write's node"),
        patches: value(s.patches, vars, "write's patches"),
      };
      const cause = optional(s, "cause", vars);
      if (cause !== undefined) op.cause = cause;
      method(run.api, "write")(op);
      return;
    }
    case "place": {
      const op: {
        parent: string;
        name: string;
        id: string;
        position?: number;
        cause?: Json;
      } = {
        parent: string(s.parent, vars, "place's parent"),
        name: string(s.name, vars, "place's name"),
        id: string(s.id, vars, "place's id"),
      };
      const position = optional(s, "position", vars);
      if (position !== undefined) {
        if (typeof position !== "number") {
          throw thrown(
            `place's position must be a number, not ${kindOf(position)}`,
          );
        }
        op.position = position;
      }
      const cause = optional(s, "cause", vars);
      if (cause !== undefined) op.cause = cause;
      method(run.api, "place")(op);
      return;
    }
    case "unplace": {
      const op: { parent: string; name: string; id: string; cause?: Json } = {
        parent: string(s.parent, vars, "unplace's parent"),
        name: string(s.name, vars, "unplace's name"),
        id: string(s.id, vars, "unplace's id"),
      };
      const cause = optional(s, "cause", vars);
      if (cause !== undefined) op.cause = cause;
      method(run.api, "unplace")(op);
      return;
    }
    case "handler": {
      if (run.part !== "effect" || !run.handler) {
        throw thrown(`handler in ${a(run.part)}`);
      }
      const steps = s.steps as Step[];
      const self = vars.get("self") ?? ABSENT;
      run.handler(s.name as string, (api, input) => {
        runHandler(steps, { self, input }, api);
      });
      return;
    }
    case "cleanup": {
      if (run.part !== "effect" || !run.cleanup) {
        throw thrown(`cleanup in ${a(run.part)}`);
      }
      const steps = s.steps as Step[];
      // the cleanup sees the effect's variables as they are now
      const seen = new Map(vars);
      run.cleanup((api) => {
        runSteps(steps, new Map(seen), { part: "cleanup", api });
      });
      return;
    }
  }
  throw thrown(`unknown step ${kind}`);
}

function a(part: Part): string {
  return part === "effect" ? "an effect" : `a ${part}`;
}

// --- entry points ---------------------------------------------------------

/**
 * Reads a program node's value. A list of steps gives a program; anything
 * else gives a ProgramError (kind "thrown"), and the run fails.
 */
export function load(code: Json): Program | ProgramError {
  const why = checkSteps(code, "the program");
  if (why) return thrown(why);
  const steps = copy(code) as Step[];
  return {
    compute(ctx) {
      const vars: Vars = new Map<string, Value>([
        ["self", ctx.self],
        ["path", ctx.path],
        ["changes", ctx.changes],
      ]);
      const end = runSteps(steps, vars, { part: "compute", api: ctx.api });
      return end ?? { value: null };
    },
    effect(ctx) {
      const vars: Vars = new Map<string, Value>([
        ["self", ctx.self],
        ["value", ctx.value],
        ["previous", ctx.previous],
      ]);
      runSteps(steps, vars, {
        part: "effect",
        api: ctx.api,
        handler: (name, fire) => ctx.handler(name, fire),
        cleanup: (run) => ctx.cleanup(run),
      });
    },
  };
}

/**
 * Runs a handler's steps with the given variables (self and input) and
 * interface, the lasting one. Throws what the steps throw.
 */
export function runHandler(
  steps: Json,
  vars: { [name: string]: Value } | Map<string, Value>,
  api: Api,
): void {
  const why = checkSteps(steps, "the handler");
  if (why) throw thrown(why);
  const scope: Vars = vars instanceof Map ? new Map(vars) : new Map(Object.entries(vars));
  runSteps(steps as Step[], scope, { part: "handler", api });
}

// --- the driver's loader --------------------------------------------------

/** The interpreter's interface over a stack's interface. */
export function adapt(api: Interface): Api {
  return {
    read(node) {
      const r = api.read({ node });
      return "value" in r ? r.value as Json : ABSENT;
    },
    directory(node, name) {
      const r = api.directory(name === undefined ? { node } : { node, name });
      if ("absent" in r) return ABSENT;
      return "slot" in r ? r.slot : r.directory;
    },
    lookup: (name) => api.lookup({ name }).found,
    make: (op) => api.make(op),
    write: (op) => api.write(op as unknown as WriteOp),
    place: (op) => api.place(op),
    unplace: (op) => api.unplace(op),
  };
}

/**
 * The driver's loader: a program node's value as a compute or an effect, run
 * by this interpreter. A value that is not a list of steps throws, and the
 * run fails.
 */
export const loader = ((code: Json, part: "compute" | "effect") => {
  const program = load(code);
  if (program instanceof ProgramError) throw program;
  if (part === "compute") {
    const compute: Compute = (ctx) => {
      const outcome = program.compute({
        api: adapt(ctx.api),
        self: ctx.self,
        path: ctx.path as unknown as Json,
        changes: ctx.changes as unknown as Json,
      });
      return "pending" in outcome ? PENDING : outcome.value;
    };
    return compute;
  }
  const effect: Effect = (ctx) => {
    let cleanup: Cleanup | undefined;
    const lasting = () => adapt(ctx.lasting);
    program.effect({
      api: adapt(ctx.api),
      self: ctx.self,
      value: ctx.value as Json,
      previous: "previous" in ctx ? ctx.previous as Json : ABSENT,
      handler: (name, fire) =>
        ctx.handler(name, (input) => fire(lasting(), input === undefined ? ABSENT : input as Json)),
      cleanup: (run) => {
        cleanup = run;
      },
    });
    const run = cleanup;
    if (run) return () => run(lasting());
  };
  return effect;
}) as Load;
