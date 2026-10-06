// The conformance harness (PROTOCOL.tex): one JSON request per line on stdin,
// one JSON answer per line on stdout. Each reset builds a fresh graph. The
// protect and drive stacks are being redesigned, so a reset asking for one is
// answered unsupported, and so are batch and fire.

import { isObject } from "../src/patch.ts";
import { acting, graph } from "../src/graph.ts";
import {
  ErmineError,
  type Event,
  type Interface,
  invalid,
  type Json,
  missing,
  wrongField,
} from "../src/types.ts";

export type Request = { readonly [key: string]: Json };

/** One session: the stack, and the events waiting for each subscription. */
export type Session = { api: Interface; queues: Map<number, Event[]> };

/** Answers what the harness does not do. */
export class Unsupported {
  constructor(readonly cmd: string) {}
}

/** The stacks a reset can ask for; those left out are answered unsupported. */
export const stacks: { [stack: string]: ((root: string) => Interface) | undefined } = {
  graph: (root) => built(graph(root)),
  protect: undefined,
  drive: undefined,
};

/** Tells the outermost layer it is the top, so no holder can tell it otherwise. */
function built<T extends Interface>(api: T): T {
  api.top(api);
  return api;
}

/** The request's fields with these names, those it has. */
export function pick(request: Request, ...keys: string[]) {
  const out: { [key: string]: Json } = {};
  for (const key of keys) if (Object.hasOwn(request, key)) out[key] = request[key];
  // deno-lint-ignore no-explicit-any
  return out as any;
}

const ACTING = ["agent", "process", "place", "chroot"];
const STAMP = ["time", "cause"];

/**
 * The commands that are operations, which an error answering one names in its
 * op (PROTOCOL.tex, Errors): the graph's (CORE.tex, Operations) and batch, the
 * driver's own (DRIVER.tex). events and fire are the harness's, and reset
 * builds the stack as a host does, so an error answering one has no op.
 */
const OPERATIONS = new Set([
  "read",
  "directory",
  "lookup",
  "write",
  "place",
  "unplace",
  "subscribe",
  "unsubscribe",
  "batch",
]);

/**
 * Every request from outside that makes a change carries a cause, even one
 * acting as a process: it stands for the site a host captures, which the
 * harness cannot. Below drive it carries a time too, which the graph checks.
 */
function outside(r: Request) {
  if (!Object.hasOwn(r, "cause")) throw missing("cause");
}

/** The commands, each given the session and the request, returning the ok result. */
export const commands: { [cmd: string]: (s: Session, r: Request) => unknown } = {
  read: (s, r) => ({ items: s.api.read(pick(r, ...ACTING, "address")) }),
  directory: (s, r) => s.api.directory(pick(r, ...ACTING, "address", "name")),
  lookup: (s, r) => ({ items: s.api.lookup(pick(r, ...ACTING, "name")) }),
  write: (s, r) => {
    outside(r);
    return s.api.write(pick(r, ...ACTING, ...STAMP, "address", "patches"));
  },
  place: (s, r) => {
    outside(r);
    return s.api.place(
      pick(r, ...ACTING, ...STAMP, "address", "name", "id", "position", "value"),
    );
  },
  unplace: (s, r) => {
    outside(r);
    return s.api.unplace(pick(r, ...ACTING, ...STAMP, "address", "name", "id"));
  },
  subscribe: (s, r) => {
    const queue: Event[] = [];
    const { sub } = s.api.subscribe({
      ...pick(r, ...ACTING, "address"),
      send: (event: Event) => queue.push(event),
    });
    s.queues.set(sub, queue);
    return { sub };
  },
  unsubscribe: (s, r) => {
    s.api.unsubscribe(pick(r, ...ACTING, "sub"));
    s.queues.delete(r.sub as number);
    return null;
  },
  events: (s, r) => {
    // every request but reset says who makes it (PROTOCOL.tex, Acting as someone)
    acting(pick(r, ...ACTING));
    if (!Object.hasOwn(r, "sub")) throw missing("sub");
    const queue = s.queues.get(r.sub as number);
    if (!queue) throw wrongField("sub", `there is no subscription ${JSON.stringify(r.sub)}`);
    return queue.splice(0);
  },
  // drive's own operations
  batch: () => {
    throw new Unsupported("batch");
  },
  fire: () => {
    throw new Unsupported("fire");
  },
};

/** The answer to one request, without its seq. */
export function answer(session: Session | undefined, request: Request): { [key: string]: unknown } {
  const cmd = request.cmd;
  try {
    if (cmd === undefined) throw missing("cmd");
    if (typeof cmd !== "string") throw wrongField("cmd", "a request's cmd is a string");
    if (!Object.hasOwn(commands, cmd)) {
      return trouble(
        invalid("unknown-command", `there is no command ${JSON.stringify(cmd)}`, { cmd }),
      );
    }
    if (!session) throw invalid("missing", "no session yet: reset first", { field: "reset" });
    return { ok: commands[cmd](session, request) };
  } catch (e) {
    return trouble(e, typeof cmd === "string" && OPERATIONS.has(cmd) ? cmd : undefined);
  }
}

/** An error as an answer: its kind, the operation it ended if there was one, and why. */
export function trouble(e: unknown, op?: string): { [key: string]: unknown } {
  if (e instanceof Unsupported) return { unsupported: e.cmd };
  if (e instanceof ErmineError) {
    if (e.op === undefined && op !== undefined) e.op = op;
    return { error: e.toJSON() };
  }
  // the harness's own mistake: never expected, and shown as one
  console.error(e);
  const error: { [key: string]: unknown } = {
    kind: "invalid",
    why: { code: "internal", text: String(e) },
  };
  if (op !== undefined) error.op = op;
  return { error };
}

/** A harness: reads lines, answers each, until stdin closes. */
export class Harness {
  session: Session | undefined;

  /** The answer line to one line. */
  line(text: string | undefined): string {
    let request: unknown;
    try {
      if (text === undefined) throw new Error("the line is not UTF-8");
      request = JSON.parse(text);
    } catch (e) {
      return encode({ seq: null, error: notARequest(String(e)) });
    }
    if (!isObject(request)) {
      return encode({ seq: null, error: notARequest("a request is one JSON object") });
    }
    const seq = Object.hasOwn(request, "seq") ? request.seq : null;
    const answer = this.#answer(request);
    try {
      return encode({ seq, ...answer });
    } catch (e) {
      // the harness's own mistake, answered so that the lines stay in step
      return encode({ seq, ...trouble(e) });
    }
  }

  #answer(request: Request) {
    if (request.cmd !== "reset") return answer(this.session, request);
    try {
      const stack = request.stack;
      if (stack === undefined) throw missing("stack");
      if (typeof stack !== "string" || !Object.hasOwn(stacks, stack)) {
        throw wrongField("stack", `there is no stack ${JSON.stringify(stack)}`);
      }
      const build = stacks[stack];
      if (!build) return { unsupported: "reset" };
      if (request.root === undefined) throw missing("root");
      if (typeof request.root !== "string") throw wrongField("root", "the root is an id, a string");
      this.session = { api: build(request.root), queues: new Map() };
      return { ok: null };
    } catch (e) {
      // reset is not an operation: its errors name none
      return trouble(e);
    }
  }
}

function notARequest(text: string) {
  return { kind: "invalid", why: { code: "not-a-request", text } };
}

/**
 * The JSON text of an answer, as JSON.stringify writes it, however deep its
 * values nest. A value is any JSON value, with no bound on its depth
 * (CORE.tex, Nodes), and V8's JSON.stringify recurses into a frozen list, as
 * every list the graph holds is, so it runs out of stack a few thousand
 * deep. This keeps its own stack instead.
 */
export function encode(value: unknown): string {
  const out: string[] = [];
  // Each entry is text to write as it is, or, where its text is undefined, a
  // value to write as JSON. The text closing a list or object carries it, so
  // the walk knows it has left it.
  const texts: (string | undefined)[] = [undefined];
  const values: unknown[] = [prepare(value, "")];
  const open = new Set<object>();
  const text = (t: string, closing?: object) => {
    texts.push(t);
    values.push(closing);
  };
  const json = (v: unknown) => {
    texts.push(undefined);
    values.push(v);
  };
  while (texts.length) {
    const t = texts.pop();
    const v = values.pop();
    if (t !== undefined) {
      out.push(t);
      if (v !== undefined) open.delete(v as object);
      continue;
    }
    if (v === null || skipped(v)) out.push("null");
    else if (typeof v === "boolean") out.push(v ? "true" : "false");
    else if (typeof v === "number" || typeof v === "string") out.push(JSON.stringify(v));
    else if (typeof v !== "object") throw new TypeError(`a ${typeof v} is not JSON`);
    else if (open.has(v)) throw new TypeError("a value that holds itself is not JSON");
    else if (Array.isArray(v)) {
      open.add(v);
      out.push("[");
      text("]", v);
      // the members go on last first, so the first comes out first
      for (let i = v.length - 1; i >= 0; i--) {
        const member = prepare(v[i], String(i));
        json(skipped(member) ? null : member);
        if (i > 0) text(",");
      }
    } else {
      open.add(v);
      out.push("{");
      text("}", v);
      const kept: [string, unknown][] = [];
      for (const key of Object.keys(v)) {
        const member = prepare((v as { [key: string]: unknown })[key], key);
        if (!skipped(member)) kept.push([key, member]);
      }
      for (let i = kept.length - 1; i >= 0; i--) {
        json(kept[i][1]);
        text(JSON.stringify(kept[i][0]) + ":");
        if (i > 0) text(",");
      }
    }
  }
  return out.join("");
}

/** A value as JSON.stringify sees it: what its toJSON gives, if it has one. */
function prepare(value: unknown, key: string): unknown {
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") return toJSON.call(value, key);
  }
  return value;
}

/** What JSON.stringify leaves out of an object, and writes as null in a list. */
function skipped(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

async function main() {
  const harness = new Harness();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  const out = (line: string) => {
    const bytes = encoder.encode(line + "\n");
    let n = 0;
    while (n < bytes.length) n += Deno.stdout.writeSync(bytes.subarray(n));
  };
  const decode = (bytes: Uint8Array) => {
    try {
      return decoder.decode(bytes);
    } catch {
      return undefined;
    }
  };
  // lines end at 0x0a and nowhere else
  let pending = new Uint8Array(0);
  for await (const chunk of Deno.stdin.readable) {
    const joined = new Uint8Array(pending.length + chunk.length);
    joined.set(pending);
    joined.set(chunk, pending.length);
    let start = 0;
    let end: number;
    while ((end = joined.indexOf(0x0a, start)) >= 0) {
      out(harness.line(decode(joined.subarray(start, end))));
      start = end + 1;
    }
    pending = joined.slice(start);
  }
  if (pending.length) out(harness.line(decode(pending)));
}

if (import.meta.main) await main();
