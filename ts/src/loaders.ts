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
  type Record,
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
  /**
   * Makes a scope owned by the process, and runs it at once (ts/demo/dom.org,
   * Scopes). It lasts until disposed or the process is killed. A scheduler
   * that has no scopes leaves it out.
   */
  scope?: MakeScope;
};

/** What a scope's compute is given: a read-only recorded interface, its id, pending, and a way to make children. */
export type ScopeGiven = {
  /** reads only, recorded under the scope's id, bound at its process's place */
  api: Acts;
  /** "<pid>#<n>" */
  id: Id;
  pending: Pending;
  /** makes a scope owned by this one: disposed when this one runs again, or is disposed */
  scope: MakeScope;
};

/** A scope's compute: a function of reads; it returns a value, of any kind, or pending. */
export type ScopeCompute<T> = (given: ScopeGiven) => T | Pending;

/** A scope's effect: applies the value; previous is what its last effect was given. May return a cleanup. */
export type ScopeEffect<T> = (value: T, previous: T | undefined) => unknown;

/** A scope, as its maker gets it: calling it disposes it. */
export type Scope = (() => void) & {
  readonly id: Id;
  /** its last finished run's record */
  readonly record: Record | undefined;
  readonly disposed: boolean;
};

export type MakeScope = <T>(compute: ScopeCompute<T>, effect: ScopeEffect<T>) => Scope;

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
  /**
   * The program it kept, its value as the search found it (SCHEDULER.tex, A
   * process keeps the program it started with), so a loader can load both
   * parts before the first runs. A scheduler may leave it out.
   */
  readonly code?: Program;
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

// The same-thread loader. A part's code is a module:
//
//   "..."                  a string is always the module's source;
//   {"import": address}    the module at that address: a URL, or a specifier
//                          the importer resolves (jsr:, npm:, or a path
//                          relative to the importer).
//
// So a part's code says it is an address by its shape, never by what its
// text starts with: source beginning with a comment, "//", is source.
//
// Importing is slow, so until a process's modules have loaded its compute
// reads the process's answer node, [pid, "loaded"], and returns pending
// (LOADERS.tex, The loader interface). When a module loads, or fails to, the
// loader writes that node through each waiting process's lasting interface:
// it places it the first time and writes it after, so the run that read it
// is marked and the process runs again, however many times it is told.
//
// When the scheduler gives the program (Running.code), the compute waits for
// both parts' modules, so the effect is never asked for before its module is
// there. When it does not, the compute reads the answer node in every run, so
// an effect whose module was still loading, which fails its run, is run again
// once it has loaded.
//
// A part is the module's export named after it, compute or effect, or else
// its default export; two parts of one program from one module share what it
// holds.

type Module = {
  state: "loading" | "loaded" | "failed";
  exports?: { [name: string]: unknown };
  error?: unknown;
};

/** The answer node's name under the process node. */
const LOADED = "loaded";

/** A part's code as the same-thread loader reads it: the module's key, and the URL to import. */
type Code = { key: string; url: string };

/** A part's code: a string is source; {"import": address} names a module. */
export function moduleOf(code: Json | undefined): Code {
  if (typeof code === "string") {
    return {
      key: `source:${code}`,
      url: `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`,
    };
  }
  if (
    typeof code === "object" && code !== null && Object.getPrototypeOf(code) === Object.prototype
  ) {
    const keys = Object.keys(code);
    const address = (code as { [key: string]: Json }).import;
    if (keys.length === 1 && typeof address === "string") {
      return { key: `import:${address}`, url: address };
    }
  }
  throw cannotLoad("a part's code is a module's source, a string, or {\"import\": address}");
}

/**
 * The same-thread loader: it runs a program's JavaScript in the scheduler's
 * own thread. importer imports a module by its URL, import() by default.
 */
export function sameThread(
  importer: (url: string) => Promise<unknown> = (url) => import(url),
): Loader {
  const modules = new Map<string, Module>();
  // the processes waiting for each module, to be told when it has loaded
  // by pid, not by the Running object, which a wrapping loader may copy
  const waiting = new Map<string, Map<Id, Running>>();

  const fetch = (code: Code): Module => {
    let m = modules.get(code.key);
    if (m) return m;
    m = { state: "loading" };
    modules.set(code.key, m);
    const held = m;
    importer(code.url).then(
      (exports) => {
        held.state = "loaded";
        held.exports = exports as { [name: string]: unknown };
      },
      (error) => {
        held.state = "failed";
        held.error = error;
      },
    ).finally(() => {
      const told = waiting.get(code.key);
      waiting.delete(code.key);
      for (const p of told?.values() ?? []) answer(p);
    });
    return m;
  };

  const wait = (code: Code, p: Running) => {
    let set = waiting.get(code.key);
    if (!set) waiting.set(code.key, set = new Map());
    set.set(p.id, p);
  };

  /**
   * Writes the answer node, placing it if it is not there yet: either way a
   * change to it, which marks the run that read it.
   */
  const answer = (p: Running) => {
    const at = { address: [p.name, LOADED] };
    try {
      if (p.lasting.read(at as Parameters<Acts["read"]>[0]).length) {
        p.lasting.write(
          { ...at, patches: [{ type: "snapshot", value: true }] } as Parameters<Acts["write"]>[0],
        );
      } else {
        p.lasting.place(
          {
            address: [p.name],
            name: LOADED,
            id: `${p.id}/${LOADED}`,
            value: true,
            ephemeral: true,
          } as Parameters<Acts["place"]>[0],
        );
      }
    } catch (e) {
      // killed, or refused: nothing waits for it
      if (!(e instanceof ErmineError)) throw e;
    }
  };

  /** The other part's module, when the scheduler gives the program and it has one. */
  const otherOf = (p: Running, part: Part): Code | undefined => {
    const other = p.code?.[part === "compute" ? "effect" : "compute"];
    if (other === undefined) return;
    try {
      return moduleOf(other);
    } catch {
      return; // it fails when it is loaded
    }
  };

  return {
    started(p) {
      // both parts start loading now, when the program is known
      for (const code of [p.code?.compute, p.code?.effect]) {
        if (code === undefined) continue;
        try {
          fetch(moduleOf(code));
        } catch {
          // it fails when it is loaded
        }
      }
    },
    killed(p) {
      for (const set of waiting.values()) set.delete(p.id);
    },
    load(code, part, p) {
      const own = moduleOf(code);
      const m = fetch(own);
      const other = part === "compute" ? otherOf(p, part) : undefined;
      return (given) => {
        if (part === "compute") {
          const loading = [own, ...(other ? [other] : [])].filter((c) =>
            fetch(c).state === "loading"
          );
          for (const c of loading) wait(c, p);
          // without the program, the effect's module is unknown: read the answer in every run
          if (loading.length || p.code === undefined) {
            given.api.read({ address: [given.name, LOADED] });
          }
          if (loading.length) return given.pending;
        } else if (m.state === "loading") {
          wait(own, p);
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

// The loader of programs built into the host, as LOADERS.tex allows: "a name
// in a table of programs built into a microcontroller's image". A part's
// code is a name in the host's table, and the part is the function there.
// For host code that has to be a process, as a link's mirror is, so it can
// make ephemeral nodes; the program's scope is still only what a part is
// given.

/** A program the host has: its parts as functions, and what to do when a process running it is killed. */
export type Builtin = {
  compute: Loaded;
  effect?: Loaded;
  /** told when a process running it is killed, after its cleanup and its ephemeral nodes */
  killed?(process: Running): void;
};

/** The loader of the host's own programs: each part's code is the name of one in the table. */
export function builtin(table: { readonly [name: string]: Builtin }): Loader {
  /** the program each process loaded, to tell it of the kill */
  const running = new Map<Id, Builtin>();
  const named = (code: Json): Builtin => {
    if (typeof code !== "string" || !Object.hasOwn(table, code)) {
      throw cannotLoad(`the host has no program ${JSON.stringify(code)}`);
    }
    return table[code];
  };
  return {
    load(code, part, p) {
      const b = named(code);
      const f = b[part];
      if (typeof f !== "function") throw cannotLoad(`${String(code)} has no ${part}`);
      running.set(p.id, b);
      return f;
    },
    killed(p) {
      const b = running.get(p.id);
      running.delete(p.id);
      b?.killed?.(p);
    },
  };
}
