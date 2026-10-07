// Programs as data (PROTOCOL.tex, Programs as data): the loader "steps". A
// part is a list of steps, each a map whose "do" says what it is; an
// expression is any value, except that a map with one key starting with "$"
// is an operator, and a list or any other map is evaluated member by member.
// A part's code that is not a list of steps cannot be loaded, which fails the
// run (SCHEDULER.tex, How a run ends).
//
// Each part, handler or cleanup has one flat set of variables. A variable may
// hold missing, which only $missing may look at; anywhere else it throws
// missing-value.

import { codePoints, equal, isObject } from "./patch.ts";
import {
  type Acts,
  cannotLoad,
  type EffectGiven,
  type Loaded,
  type Loader,
  type Part,
  type StartOp,
  Thrown,
} from "../../scheduler/typescript/loaders.ts";
import { ErmineError, type Json, ours } from "./types.ts";

ours(import.meta.url);

/** What a variable holds when it holds no value. */
const MISSING: unique symbol = Symbol("missing");
type Held = Json | typeof MISSING;
type Env = Map<string, Held>;

/** A return step: it ends the part with its value. */
class Return {
  constructor(readonly value: Json) {}
}
/** A pending step: it ends the compute, pending. */
class Wait {}

type Step = { readonly do: string; readonly [field: string]: Json };

/** The steps each "do" may be, and the fields of each that hold more steps. */
const STEPS: { readonly [kind: string]: readonly string[] } = {
  read: [],
  directory: [],
  lookup: [],
  let: [],
  if: ["then", "else"],
  each: ["steps"],
  return: [],
  pending: [],
  throw: [],
  try: ["steps"],
  write: [],
  place: [],
  unplace: [],
  start: [],
  handler: ["steps"],
  cleanup: ["steps"],
};

/** Whether code is a list of steps, each of a kind there is, its inner steps too. */
function isSteps(code: unknown): code is Step[] {
  const lists: unknown[] = [code];
  while (lists.length) {
    const list = lists.pop();
    if (!Array.isArray(list)) return false;
    for (const step of list) {
      if (!isObject(step) || typeof step.do !== "string" || !Object.hasOwn(STEPS, step.do)) {
        return false;
      }
      for (const field of STEPS[step.do]) {
        if (step[field] === undefined && field === "else") continue;
        lists.push(step[field]);
      }
    }
  }
  return true;
}

const problem = (code: string, details: { [key: string]: Json } = {}, text?: string) =>
  new Thrown({ code, ...details, ...(text ? { text } : {}) });

/** Variables, some taken from elsewhere the first time they are looked at, unless set before. */
class Late extends Map<string, Held> {
  constructor(private readonly late: { [name: string]: () => Held }) {
    super();
  }
  override has(name: string) {
    return super.has(name) || Object.hasOwn(this.late, name);
  }
  override get(name: string) {
    if (!super.has(name) && Object.hasOwn(this.late, name)) super.set(name, this.late[name]());
    return super.get(name);
  }
}

/** The loader of programs as data. live makes a stand-in for a live value of a kind, for $live. */
export function steps(options: { live?: (kind: string) => Json } = {}): Loader {
  return {
    load(code, part): Loaded {
      if (!isSteps(code)) throw cannotLoad(`a ${part} is a list of steps`);
      const list = code;
      if (part === "compute") {
        return (given) => {
          // each read from the given at its first use, so a wrapping loader
          // (a cache) sees only what the code used
          const env: Env = new Late({
            self: () => given.self,
            cwd: () => [...given.cwd],
            name: () => given.name,
            changes: () => given.changes as unknown as Json,
          });
          try {
            run(list, env, { part: "compute", api: given.api });
          } catch (e) {
            if (e instanceof Return) return e.value;
            if (e instanceof Wait) return given.pending;
            throw e;
          }
          return null;
        };
      }
      return (given) => {
        const env: Env = new Map<string, Held>([
          ["self", given.self],
          ["cwd", [...given.cwd]],
          ["name", given.name],
          ["value", given.value],
        ]);
        env.set("previous", Object.hasOwn(given, "previous") ? given.previous! : MISSING);
        const ctx: Ctx = { part: "effect", api: given.api, effect: given };
        try {
          run(list, env, ctx);
        } catch (e) {
          if (!(e instanceof Return)) throw e;
        }
        const cleanup = ctx.cleanup;
        if (!cleanup) return undefined;
        // told {"killed": true} at a kill; before an effect, killed is missing (SCHEDULER.tex, Open)
        return (told?: { killed?: boolean }) => {
          const vars = new Map<string, Held>([
            ["self", given.self],
            ["cwd", [...given.cwd]],
            ["name", given.name],
            ["killed", told?.killed === true ? true : MISSING],
          ]);
          try {
            run(cleanup, vars, { part: "cleanup", api: given.lasting });
          } catch (e) {
            if (!(e instanceof Return)) throw e;
          }
        };
      };
    },
  };

  /** What a list of steps runs in: which part, its interface, and an effect's own. */
  type Ctx = {
    part: Part | "handler" | "cleanup";
    api: Acts;
    effect?: EffectGiven;
    /** an effect's cleanup: the last cleanup step's */
    cleanup?: Step[];
  };

  function run(list: readonly Step[], env: Env, ctx: Ctx): void {
    for (const step of list) one(step, env, ctx);
  }

  function one(step: Step, env: Env, ctx: Ctx): void {
    const set = (value: Held) => {
      if (typeof step.as === "string") env.set(step.as, value);
    };
    const value = (field: string) => need(evaluate(step[field], env));
    const maybe = (field: string) => step[field] === undefined ? undefined : value(field);
    const api = ctx.api;
    switch (step.do) {
      case "read":
        return set(api.read({ address: value("address") as string[] }) as unknown as Json);
      case "directory": {
        const name = maybe("name");
        const got = api.directory({
          address: value("address") as string[],
          ...(name === undefined ? {} : { name: name as string }),
        });
        return set(("items" in got ? got.items : got.directory) as unknown as Json);
      }
      case "lookup":
        return set(api.lookup({ name: value("name") as string }) as unknown as Json);
      case "let":
        return set(evaluate(step.value, env));
      case "if": {
        const test = value("test");
        if (typeof test !== "boolean") {
          throw problem("not-boolean", {}, "an if test is true or false");
        }
        const branch = test ? step.then : step.else;
        if (branch !== undefined) run(branch as unknown as Step[], env, ctx);
        return;
      }
      case "each": {
        const list = value("list");
        if (!Array.isArray(list)) {
          throw problem("operator", { operator: "each" }, "each needs a list");
        }
        for (const item of list) {
          set(item);
          run(step.steps as unknown as Step[], env, ctx);
        }
        return;
      }
      case "return":
        throw new Return(value("value"));
      case "pending":
        if (ctx.part !== "compute") throw problem("wrong-part", {}, "only a compute is pending");
        throw new Wait();
      case "throw":
        throw problem("thrown", { message: value("message") });
      case "try": {
        try {
          run(step.steps as unknown as Step[], env, ctx);
        } catch (e) {
          if (e instanceof ErmineError || e instanceof Thrown) return set(e.toJSON() as Json);
          throw e;
        }
        return set(null);
      }
      case "write":
        api.write({
          address: value("address") as string[],
          patches: value("patches") as never,
          ...cause(),
        });
        return;
      case "place": {
        const op: { [key: string]: Json } = {
          address: value("address"),
          name: value("name"),
          id: value("id"),
        };
        for (const field of ["position", "value", "ephemeral"]) {
          const v = maybe(field);
          if (v !== undefined) op[field] = v;
        }
        api.place({ ...op, ...cause() } as never);
        return;
      }
      case "unplace":
        api.unplace({
          address: value("address") as string[],
          name: value("name") as string,
          id: value("id") as string,
          ...cause(),
        });
        return;
      case "start": {
        const op = {
          address: value("address"),
          program: value("program"),
          ...(step.value === undefined ? {} : { value: value("value") }),
          ...cause(),
        } as unknown as StartOp;
        const started = api.start(op);
        return set(started.change.kind === "place" ? started.change.id : null);
      }
      case "handler": {
        const effect = ctx.effect;
        if (ctx.part !== "effect" || !effect) {
          throw problem("wrong-part", {}, "only an effect registers a handler");
        }
        const name = value("name");
        const body = step.steps as unknown as Step[];
        effect.handler(String(name), (input) => {
          const vars = new Map<string, Held>([
            ["self", effect.self],
            ["cwd", [...effect.cwd]],
            ["name", effect.name],
          ]);
          vars.set("input", input === undefined ? MISSING : input);
          try {
            run(body, vars, { part: "handler", api: effect.lasting });
          } catch (e) {
            if (!(e instanceof Return)) throw e;
          }
        });
        return;
      }
      case "cleanup":
        if (ctx.part !== "effect") throw problem("wrong-part", {}, "only an effect has a cleanup");
        ctx.cleanup = step.steps as unknown as Step[];
        return;
    }

    function cause(): { cause?: Json } {
      return step.cause === undefined ? {} : { cause: value("cause") };
    }
  }

  /** A value, or missing; a missing value anywhere but held or tested throws. */
  function evaluate(expr: Json | undefined, env: Env): Held {
    if (expr === undefined) return MISSING;
    if (Array.isArray(expr)) return expr.map((e) => need(evaluate(e, env)));
    if (!isObject(expr)) return expr;
    const keys = Object.keys(expr);
    if (keys.length === 1 && keys[0].startsWith("$")) return operator(keys[0], expr[keys[0]], env);
    const out: { [key: string]: Json } = {};
    for (const key of keys) {
      Object.defineProperty(out, key, {
        value: need(evaluate(expr[key], env)),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }

  function operator(op: string, arg: Json, env: Env): Held {
    const wrong = (text: string) => problem("operator", { operator: op }, text);
    const args = (): Json[] => {
      if (!Array.isArray(arg)) throw wrong(`${op} takes a list`);
      return arg.map((e) => need(evaluate(e, env)));
    };
    const items = (): Json[] => {
      const list = need(evaluate(arg, env));
      if (!Array.isArray(list)) throw wrong(`${op} takes a list of items`);
      return list;
    };
    switch (op) {
      case "$": {
        if (typeof arg !== "string") throw wrong("a variable is named by a string");
        if (!env.has(arg)) throw problem("unbound", { name: arg }, `${arg} has no value`);
        return env.get(arg)!;
      }
      case "$get": {
        if (!Array.isArray(arg) || arg.length === 0) throw wrong("$get takes a value and keys");
        let at: Held = need(evaluate(arg[0], env));
        for (const k of arg.slice(1)) {
          const key = need(evaluate(k, env));
          if (at === MISSING) return MISSING;
          if (Array.isArray(at)) {
            if (typeof key !== "number" || !Number.isInteger(key) || key < 0) {
              throw wrong("a key into a list is a whole number");
            }
            at = key < at.length ? at[key] : MISSING;
          } else if (isObject(at)) {
            if (typeof key !== "string") throw wrong("a key into a map is a string");
            at = Object.hasOwn(at, key) ? at[key] : MISSING;
          } else throw wrong("$get goes into a map or a list");
        }
        return at;
      }
      case "$eq": {
        const [a, b] = args();
        return equal(a, b);
      }
      case "$not": {
        const v = need(evaluate(arg, env));
        if (typeof v !== "boolean") throw wrong("$not takes a boolean");
        return !v;
      }
      case "$missing":
        return evaluate(arg, env) === MISSING;
      case "$value": {
        for (const item of items()) {
          if (isObject(item) && Object.hasOwn(item, "value")) return item.value;
        }
        return MISSING;
      }
      case "$ids":
        return items().flatMap((item) =>
          isObject(item) && typeof item.id === "string" ? [item.id] : []
        );
      case "$add": {
        const all = args();
        if (!all.every((n) => typeof n === "number")) throw wrong("$add takes numbers");
        return (all as number[]).reduce((a, b) => a + b, 0);
      }
      case "$concat": {
        const all = args();
        if (all.every((s) => typeof s === "string")) return (all as string[]).join("");
        if (all.every(Array.isArray)) return (all as Json[][]).flat(1) as Json;
        throw wrong("$concat takes strings, or lists");
      }
      case "$len": {
        const v = need(evaluate(arg, env));
        if (typeof v === "string") return codePoints(v).length;
        if (Array.isArray(v)) return v.length;
        if (isObject(v)) return Object.keys(v).length;
        throw wrong("$len takes a string, a list or a map");
      }
      case "$quote":
        return arg;
      case "$live": {
        const kind = need(evaluate(arg, env));
        if (typeof kind !== "string" || !options.live) {
          throw wrong("$live makes a stand-in of a kind");
        }
        return options.live(kind);
      }
      default:
        throw problem("operator", { operator: op }, `there is no operator ${op}`);
    }
  }
}

/** A held value, or missing-value where it is missing. */
function need(held: Held): Json {
  if (held === MISSING) throw problem("missing-value", {}, "a missing value cannot be used here");
  return held;
}
