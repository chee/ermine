// Loaders (LOADERS.tex). A loader turns the code of one part of a program, a
// compute or an effect, into a function the scheduler calls with one map
// holding what that part is given (SCHEDULER.tex, A program is a compute and
// an effect). The function returns what the part returns: a value, pending,
// or, for an effect, a cleanup; or it throws what the part did not catch.
//
// This is the interface the reference scheduler gives every loader, and the
// same-thread JavaScript loader. The loader of programs as data, "steps", is
// in steps.ts.

import {
  type Change,
  type Changed,
  ErmineError,
  type ErrorJson,
  type Id,
  type Interface,
  invalid,
  type Json,
  ours,
  type Why,
} from "./types.ts";

ours(import.meta.url);

/** What a compute returns when a read it needed gave no items yet. */
export const PENDING: unique symbol = Symbol.for("ermine.pending");
export type Pending = typeof PENDING;

export type Part = "compute" | "effect";

/** A program or a loader, named by its node and the time of the change that last set it. */
export type Identity = { node: Id; time: number };

/** A program's value (SCHEDULER.tex, Programs). */
export type Program = { kind: string; compute: Json; effect?: Json };

/** start's operation: the address to place the process in, the program's path, its first value. */
export type StartOp = {
  agent?: Json;
  process?: Id;
  place?: readonly string[];
  chroot?: number;
  address: readonly string[];
  program: readonly string[];
  value?: Json;
  cause?: Json;
};

/** An interface a scheduler hands a process: the graph's operations, and start. */
export interface Acts extends Interface {
  start(op: StartOp): Changed;
}

/** What a compute is given. */
export type ComputeGiven = {
  /** reads only, recorded into the run, bound at the process's place */
  api: Acts;
  self: Id;
  /** the path of its place from its own "/" */
  cwd: readonly string[];
  /** its pid, the name it was placed under: the address [name] is the process node */
  name: string;
  /** every change kept for the process, in order, each once */
  changes: readonly Change[];
  /** the value to return for pending */
  pending: Pending;
};

/** A handler the world calls later, through the lasting interface. */
export type Handler = (input?: Json) => unknown;

/** What an effect is given. */
export type EffectGiven = {
  /** writes only, recorded into the run */
  api: Acts;
  self: Id;
  cwd: readonly string[];
  name: string;
  /** the process's value */
  value: Json;
  /** the value its last effect was given; left out on its first */
  previous?: Json;
  /** reads and writes until the process is killed, for code the world calls later */
  lasting: Acts;
  /** registers a handler of that name, replacing one the process has */
  handler(name: string, f: Handler): void;
};

/** A part as a function: a compute's returns a value or pending; an effect's may return a cleanup. */
export type Loaded = (given: ComputeGiven & EffectGiven) => unknown;

/**
 * What the scheduler tells a loader about a process it loaded: who it is,
 * where it runs, the program it kept, an interface that reads as the process
 * and records nothing, and its lasting interface, for writing answers.
 */
export type Running = {
  readonly id: Id;
  readonly name: string;
  readonly cwd: readonly string[];
  readonly program: Identity;
  readonly reads: Interface;
  readonly lasting: Acts;
};

/**
 * A loader (LOADERS.tex, The loader interface). load gives a part's code as a
 * function, or throws when it cannot load it, which fails the run; it is
 * asked when the part is about to run. started and killed say when a process
 * it loads starts and is killed.
 */
export interface Loader {
  load(code: Json, part: Part, process: Running): Loaded;
  started?(process: Running): void;
  killed?(process: Running): void;
}

/** A mistake in a program: an error of kind thrown, with a code from PROTOCOL.tex's list. */
export class Thrown extends Error {
  constructor(readonly why: Why, readonly op?: string) {
    super(typeof why.text === "string" ? why.text : why.code);
    this.name = "Thrown";
  }
  toJSON(): ErrorJson {
    return this.op === undefined
      ? { kind: "thrown", why: this.why }
      : { kind: "thrown", op: this.op, why: this.why };
  }
}

/** An error as JSON: invalid, refused, or thrown, whatever threw it. */
export function errorJson(e: unknown): ErrorJson {
  if (e instanceof ErmineError || e instanceof Thrown) return e.toJSON();
  const message = e instanceof Error ? e.message : String(e);
  return { kind: "thrown", why: { code: "thrown", message } };
}

/** A part that cannot be loaded. */
export function cannotLoad(text: string) {
  return invalid("not-a-program", text);
}

// The same-thread loader. A part's code is a module, given as its source or
// its address. Importing is slow, so until the module has loaded a compute
// reads the process's answer node and returns pending; once it has loaded,
// the loader places that node, through the process's lasting interface, so
// the run that read it is marked and the process runs again. A part is the
// module's export named after it, compute or effect, or else its default
// export; two parts of one program from one module share what it holds.

type Module = {
  state: "loading" | "loaded" | "failed";
  exports?: { [name: string]: unknown };
  error?: unknown;
};

/** The answer node's name under the process node. */
const LOADED = "loaded";

/** Whether code names a module rather than holding its source. */
function isAddress(code: string): boolean {
  return /^(https?:|file:|data:|blob:|jsr:|npm:|\.{0,2}\/)/.test(code);
}

/**
 * The same-thread loader: it runs a program's JavaScript in the scheduler's
 * own thread. importer imports a module by its address, import() by default.
 */
export function sameThread(
  importer: (url: string) => Promise<unknown> = (url) => import(url),
): Loader {
  const modules = new Map<string, Module>();
  // the processes waiting for each module, to be told when it has loaded
  const waiting = new Map<string, Set<Running>>();

  const fetch = (code: string): Module => {
    let m = modules.get(code);
    if (m) return m;
    m = { state: "loading" };
    modules.set(code, m);
    const url = isAddress(code)
      ? code
      : `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
    const held = m;
    importer(url).then(
      (exports) => {
        held.state = "loaded";
        held.exports = exports as { [name: string]: unknown };
      },
      (error) => {
        held.state = "failed";
        held.error = error;
      },
    ).finally(() => {
      const told = waiting.get(code);
      waiting.delete(code);
      for (const p of told ?? []) answer(p);
    });
    return m;
  };

  /** Places the answer node, so a run that read it while it had nothing runs again. */
  const answer = (p: Running) => {
    try {
      p.lasting.place(
        {
          address: [p.name],
          name: LOADED,
          id: `${p.id}/${LOADED}`,
          value: true,
          ephemeral: true,
        } as Parameters<Acts["place"]>[0],
      );
    } catch {
      // killed, or already answered: nothing waits
    }
  };

  const codeOf = (code: Json): string => {
    if (typeof code !== "string") throw cannotLoad("a part's code is a module's source or address");
    return code;
  };

  return {
    // loading starts when a part is first asked for
    killed(p) {
      for (const set of waiting.values()) set.delete(p);
    },
    load(code, part, p) {
      const source = codeOf(code);
      const m = fetch(source);
      return (given) => {
        if (m.state === "loading") {
          let set = waiting.get(source);
          if (!set) waiting.set(source, set = new Set());
          set.add(p);
          if (part === "compute") {
            given.api.read({ address: [given.name, LOADED] });
            return given.pending;
          }
          throw cannotLoad("the effect's module has not loaded yet");
        }
        if (m.state === "failed") {
          throw cannotLoad(`the module did not load: ${String(errorJson(m.error).why.message)}`);
        }
        const f = m.exports?.[part] ?? m.exports?.default;
        if (typeof f !== "function") throw cannotLoad(`the module has no ${part}`);
        return f(given);
      };
    },
  };
}
