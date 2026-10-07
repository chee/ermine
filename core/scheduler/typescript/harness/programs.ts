// Programs as data (PROTOCOL.tex, Programs as data): the harness's loader.
//
// A program node's value is a list of steps. load() checks that and gives a
// program with two parts, compute and effect; runHandler() runs a handler's
// or a cleanup's steps later, with the lasting interface.
//
// The interpreter calls a small interface, Api, which adapt() makes from a
// stack's interface; loader, at the end, is the loader the harness gives
// drive:
//
//   read(address)                the items of the value, as in the read answer
//   directory(address, name?)    with a name, the slot's items; without,
//                                [[name, [item]]] as in the directory answer
//   lookup(name)                 the items found, as in the lookup answer
//   write({address, patches, cause?})
//   place({address, name, id, position?, value?, cause?})
//   unplace({address, name, id, cause?})
//
// Every method is optional. A step whose operation the interface leaves out
// is invalid, {kind: "invalid", op}; so an effect may be given an interface
// with no reads, and a compute one with no writes. An interface that has the
// method may throw instead (and record it): the interpreter lets that error
// pass as it is, so drive sees the graph's own invalid or refused error.
// Fields are evaluated and passed on as they are: an address is evaluated,
// then read as an address, by the graph.
//
// Errors. A throw step, an operator given the wrong kind, an unbound
// variable, a missing value used, a test that is not a boolean, a step used
// in the wrong part: each throws a ProgramError of kind "thrown", with
// PROTOCOL.tex's code. A try binds its variable to errorJson(e) of what it
// caught: {kind, op?, why}, so a caught refusal is {kind: "refused", op, why}.
//
// Variables live in one scope per part; let, each and try set them in it.
// An optional field (cause, position, value, name) that evaluates to missing
// is left out.

import { type Compute, type Effect, type Load, PENDING } from "../drive.ts";
import { ErmineError, type Interface, type Why } from "../../../graph/typescript/types.ts";

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

/** Missing is not a value: a key that is not there, a $value of no items. */
export const ABSENT: unique symbol = Symbol("missing");
export type Absent = typeof ABSENT;
export type Value = Json | Absent;

type Op = { [key: string]: Json };

export type Api = {
  read?(address: Json): Json;
  directory?(address: Json, name?: Json): Json;
  lookup?(name: Json): Json;
  write?(op: Op): unknown;
  place?(op: Op): unknown;
  unplace?(op: Op): unknown;
};

export type ComputeContext = {
  api: Api;
  /** the process id */
  self: string;
  /** its working directory, as names */
  cwd: Json;
  /** the name its node was reached by */
  name: string;
  /** the changes kept for it */
  changes: Json;
};

/** A handler, as registered: drive calls it with the lasting interface. */
export type Fire = (api: Api, input: Value) => void;
/** A cleanup, as registered: drive calls it with the lasting interface. */
export type Cleanup = (api: Api) => void;

export type EffectContext = {
  api: Api;
  self: string;
  cwd: Json;
  name: string;
  /** the process's value */
  value: Json;
  /** the value its last effect was given; ABSENT on the first */
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

/** A mistake in a program, or an operation its interface does not have. */
export class ProgramError extends Error {
  kind: "thrown" | "invalid";
  op?: string;
  why: Why;
  constructor(kind: "thrown" | "invalid", why: Why, op?: string) {
    super(why.text ?? why.code);
    this.name = "ProgramError";
    this.kind = kind;
    this.why = why;
    if (op !== undefined) this.op = op;
  }
}

function thrown(code: string, text: string, details: { [key: string]: Json } = {}): ProgramError {
  return new ProgramError("thrown", { code, ...details, text });
}

/** An error as a try step binds it, and as a record lists it: {kind, op?, why}. */
export function errorJson(e: unknown): Json {
  if (e instanceof ErmineError) return e.toJSON() as unknown as Json;
  if (e instanceof ProgramError) {
    const out: { [key: string]: Json } = { kind: e.kind };
    if (e.op !== undefined) out.op = e.op;
    out.why = e.why as unknown as Json;
    return out;
  }
  const text = e instanceof Error ? e.message : String(e);
  return { kind: "thrown", why: { code: "thrown", message: text, text } };
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
  if (v === ABSENT) return "missing";
  if (v === null) return "null";
  if (Array.isArray(v)) return "list";
  return typeof v;
}

/** Value equality, as $eq: objects in any key order, numbers as Object.is compares them. */
export function equal(a: Json, b: Json): boolean {
  if (typeof a === "number" && typeof b === "number") return Object.is(a, b);
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

/** A value that must be there: anything but missing. */
function present(v: Value, what: string): Json {
  if (v === ABSENT) throw thrown("missing-value", `${what} is missing`);
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

/** An operator's operand that must be a list. */
function operands(op: string, e: Json, vars: Vars): Json[] {
  const v = value(e, vars, op);
  if (!Array.isArray(v)) throw wrongKind(op, `${op} takes a list, not ${kindOf(v)}`);
  return v;
}

function wrongKind(op: string, text: string): ProgramError {
  return thrown("operator", text, { operator: op });
}

function apply(op: string, arg: Json, vars: Vars): Value {
  switch (op) {
    case "$": {
      if (typeof arg !== "string") throw wrongKind("$", "$ takes a variable name");
      if (!vars.has(arg)) {
        throw thrown("unbound", `no variable ${JSON.stringify(arg)}`, { name: arg });
      }
      return vars.get(arg)!;
    }
    case "$get": {
      const [base, ...keys] = operands("$get", arg, vars);
      if (base === undefined) throw wrongKind("$get", "$get needs a value");
      let v: Value = base;
      for (const k of keys) {
        if (v === ABSENT) return ABSENT;
        if (Array.isArray(v)) {
          if (typeof k !== "number") {
            throw wrongKind("$get", `$get: a list's key is a number, not ${kindOf(k)}`);
          }
          v = Number.isInteger(k) && k >= 0 && k < v.length ? v[k] : ABSENT;
        } else if (isObject(v)) {
          if (typeof k !== "string") {
            throw wrongKind("$get", `$get: an object's key is a string, not ${kindOf(k)}`);
          }
          v = Object.hasOwn(v, k) ? v[k] : ABSENT;
        } else {
          throw wrongKind("$get", `$get: cannot get from ${kindOf(v)}`);
        }
      }
      return v;
    }
    case "$eq": {
      const args = operands("$eq", arg, vars);
      if (args.length !== 2) throw wrongKind("$eq", "$eq takes two values");
      return equal(args[0], args[1]);
    }
    case "$not": {
      const v = value(arg, vars, "$not");
      if (typeof v !== "boolean") throw wrongKind("$not", `$not takes a boolean, not ${kindOf(v)}`);
      return !v;
    }
    case "$missing":
      return evaluate(arg, vars) === ABSENT;
    case "$value": {
      for (const item of operands("$value", arg, vars)) {
        if (isObject(item) && Object.hasOwn(item, "value")) return item.value;
      }
      return ABSENT;
    }
    case "$ids": {
      const ids: Json[] = [];
      for (const item of operands("$ids", arg, vars)) {
        if (isObject(item) && Object.hasOwn(item, "id")) ids.push(item.id);
      }
      return ids;
    }
    case "$add": {
      let sum = 0;
      for (const v of operands("$add", arg, vars)) {
        if (typeof v !== "number") throw wrongKind("$add", `$add takes numbers, not ${kindOf(v)}`);
        sum += v;
      }
      return sum;
    }
    case "$concat": {
      const args = operands("$concat", arg, vars);
      if (args.every((v) => typeof v === "string")) return args.join("");
      if (args.every(Array.isArray)) return args.flat(1);
      throw wrongKind("$concat", "$concat takes all strings or all lists");
    }
    case "$len": {
      const v = value(arg, vars, "$len");
      if (typeof v === "string") return [...v].length;
      if (Array.isArray(v)) return v.length;
      if (isObject(v)) return Object.keys(v).length;
      throw wrongKind("$len", `$len takes a string, list or object, not ${kindOf(v)}`);
    }
    case "$quote":
      return copy(arg);
  }
  throw wrongKind(op, `unknown operator ${op}`);
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
  read: { need: ["address", "as"], may: [] },
  directory: { need: ["address", "as"], may: ["name"] },
  lookup: { need: ["name", "as"], may: [] },
  let: { need: ["as", "value"], may: [] },
  if: { need: ["test", "then"], may: ["else"] },
  each: { need: ["list", "as", "steps"], may: [] },
  return: { need: ["value"], may: [] },
  pending: { need: [], may: [] },
  throw: { need: ["message"], may: [] },
  try: { need: ["steps", "as"], may: [] },
  write: { need: ["address", "patches"], may: ["cause"] },
  place: { need: ["address", "name", "id"], may: ["position", "value", "cause"] },
  unplace: { need: ["address", "name", "id"], may: ["cause"] },
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
    if (typeof s[f] !== "string") return `${at}: ${kind}'s "${f}" must be a string`;
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

/** An optional field: undefined when not given or missing. */
function optional(s: Step, field: string, vars: Vars): Json | undefined {
  if (!Object.hasOwn(s, field)) return undefined;
  const v = evaluate(s[field], vars);
  return v === ABSENT ? undefined : v;
}

function method<K extends keyof Api>(api: Api, op: K): NonNullable<Api[K]> {
  const f = api[op];
  if (typeof f !== "function") {
    // as the graph's own interfaces say it: one that only reads, or only writes
    const code = op === "write" || op === "place" || op === "unplace" ? "read-only" : "write-only";
    throw new ProgramError("invalid", { code, text: `this interface has no ${op}` }, op);
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

/** The fields of a change step: each needed one evaluated, each optional one if not missing. */
function fields(s: Step, vars: Vars): Op {
  const kind = s.do as string;
  const op: Op = {};
  for (const f of shapes[kind].need) op[f] = value(s[f], vars, `${kind}'s ${f}`);
  for (const f of shapes[kind].may) {
    const v = optional(s, f, vars);
    if (v !== undefined) op[f] = v;
  }
  return op;
}

function runStep(s: Step, vars: Vars, run: Run): End {
  const kind = s.do as string;
  switch (kind) {
    case "read": {
      const address = value(s.address, vars, "read's address");
      vars.set(s.as as string, method(run.api, "read")(address));
      return;
    }
    case "directory": {
      const address = value(s.address, vars, "directory's address");
      const name = optional(s, "name", vars);
      const f = method(run.api, "directory");
      vars.set(s.as as string, name === undefined ? f(address) : f(address, name));
      return;
    }
    case "lookup": {
      const name = value(s.name, vars, "lookup's name");
      vars.set(s.as as string, method(run.api, "lookup")(name));
      return;
    }
    case "let":
      vars.set(s.as as string, evaluate(s.value, vars));
      return;
    case "if": {
      const test = value(s.test, vars, "if's test");
      if (typeof test !== "boolean") {
        throw thrown("not-boolean", `if's test must be a boolean, not ${kindOf(test)}`);
      }
      if (test) return runSteps(s.then as Step[], vars, run);
      if (Object.hasOwn(s, "else")) return runSteps(s.else as Step[], vars, run);
      return;
    }
    case "each": {
      const list = value(s.list, vars, "each's list");
      if (!Array.isArray(list)) throw wrongKind("each", `each takes a list, not ${kindOf(list)}`);
      for (const x of list) {
        vars.set(s.as as string, x);
        const end = runSteps(s.steps as Step[], vars, run);
        if (end) return end;
      }
      return;
    }
    case "return":
      return { value: value(s.value, vars, "the value returned") };
    case "pending":
      if (run.part !== "compute") throw thrown("wrong-part", `pending in ${a(run.part)}`);
      return { pending: true };
    case "throw": {
      const message = value(s.message, vars, "throw's message");
      throw thrown("thrown", typeof message === "string" ? message : JSON.stringify(message), {
        message,
      });
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
    case "write":
    case "place":
    case "unplace":
      method(run.api, kind)(fields(s, vars));
      return;
    case "handler": {
      if (run.part !== "effect" || !run.handler) {
        throw thrown("wrong-part", `handler in ${a(run.part)}`);
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
        throw thrown("wrong-part", `cleanup in ${a(run.part)}`);
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
  throw thrown("not-a-program", `unknown step ${kind}`);
}

function a(part: Part): string {
  return part === "effect" ? "an effect" : `a ${part}`;
}

// --- entry points ---------------------------------------------------------

/**
 * Reads a program node's value. A list of steps gives a program; anything
 * else gives a ProgramError with code not-a-program, and the run fails.
 */
export function load(code: Json): Program | ProgramError {
  const why = checkSteps(code, "the program");
  if (why) return thrown("not-a-program", why);
  const steps = copy(code) as Step[];
  return {
    compute(ctx) {
      const vars: Vars = new Map<string, Value>([
        ["self", ctx.self],
        ["cwd", ctx.cwd],
        ["name", ctx.name],
        ["changes", ctx.changes],
      ]);
      const end = runSteps(steps, vars, { part: "compute", api: ctx.api });
      return end ?? { value: null };
    },
    effect(ctx) {
      const vars: Vars = new Map<string, Value>([
        ["self", ctx.self],
        ["cwd", ctx.cwd],
        ["name", ctx.name],
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
  if (why) throw thrown("not-a-program", why);
  const scope: Vars = vars instanceof Map ? new Map(vars) : new Map(Object.entries(vars));
  runSteps(steps as Step[], scope, { part: "handler", api });
}

// --- the driver's loader --------------------------------------------------

/** The interpreter's interface over a stack's interface. */
export function adapt(api: Interface): Api {
  // deno-lint-ignore no-explicit-any
  const loose = api as any;
  return {
    read: (address) => loose.read({ address }),
    directory(address, name) {
      const r = loose.directory(name === undefined ? { address } : { address, name });
      return "directory" in r ? r.directory : r.items;
    },
    lookup: (name) => loose.lookup({ name }),
    write: (op) => loose.write(op),
    place: (op) => loose.place(op),
    unplace: (op) => loose.unplace(op),
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
        cwd: [...ctx.cwd],
        name: ctx.name,
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
      cwd: [...ctx.cwd],
      name: ctx.name,
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
