// The conformance harness (PROTOCOL.tex): one JSON request per line on stdin,
// one JSON answer per line on stdout. Each reset builds a fresh stack.

import { equal, isObject } from "../src/patch.ts";
import { graph } from "../src/graph.ts";
import { type May, protect, subject } from "../src/protect.ts";
import { drive, type Settled } from "../src/drive.ts";
import { ErmineError, type Event, type Interface, Invalid, type Json } from "../src/types.ts";
import { errorJson, loader } from "./programs.ts";
import { dataItems, listingItems, lookupItems, readItems } from "./items.ts";

export type Request = { readonly [key: string]: Json };

/** A stack as the harness holds it: the interface, and any operations its wrappers add. */
// deno-lint-ignore no-explicit-any
export type Stack = Interface & { [op: string]: any };

/** One session: the stack, and the events waiting for each subscription. */
export type Session = { api: Stack; queues: Map<number, Event[]> };

/** Answers what the stack does not have. */
export class Unsupported {
  constructor(readonly cmd: string) {}
}

/** Builds each stack a reset can ask for, and tells it its top once built. */
export const stacks: { [stack: string]: ((request: Request) => Stack) | undefined } = {
  graph: () => graph(),
  protect: (r) => built(protect(graph(), rules(r.rules))),
  drive: (r) => {
    if (typeof r.root !== "string") throw new Invalid("drive needs a root, an id");
    return built(drive(protect(graph(), rules(r.rules)), r.root, loader));
  },
};

/** Tells the outermost layer it is the top, so no holder can tell it otherwise. */
function built<T extends Interface>(api: T): T {
  api.top(api);
  return api;
}

/** The harness's may: the first rule whose given fields all equal the operation's wins. */
export function rules(list: Json | undefined): May {
  if (list === undefined) return () => true;
  if (!Array.isArray(list) || !list.every(isObject)) {
    throw new Invalid("rules are a list of objects");
  }
  const all = list as { readonly [key: string]: Json }[];
  return (agent, process, op, args) => {
    const node = subject(op, args);
    for (const rule of all) {
      if ("agent" in rule && !equal(rule.agent, agent)) continue;
      if ("process" in rule && (process === undefined || rule.process !== process)) continue;
      if ("op" in rule && rule.op !== op) continue;
      if ("node" in rule && (node === undefined || rule.node !== node)) continue;
      return rule.allow === true;
    }
    return true;
  };
}

/** The request's fields with these names, those it has. */
export function pick(request: Request, ...keys: string[]) {
  const out: { [key: string]: Json } = {};
  for (const key of keys) if (key in request) out[key] = request[key];
  // deno-lint-ignore no-explicit-any
  return out as any;
}

const ACTING = ["agent", "process"];
const STAMP = ["time", "site", "cause"];

/** The commands, each given the session and the request, returning the ok result. */
export const commands: {
  [cmd: string]: (s: Session, r: Request) => unknown;
} = {
  make: (s, r) => plain(s.api.make(pick(r, ...ACTING, ...STAMP, "id", "value", "data"))),
  write: (s, r) => plain(s.api.write(pick(r, ...ACTING, ...STAMP, "node", "patches"))),
  place: (s, r) =>
    plain(s.api.place(pick(r, ...ACTING, ...STAMP, "parent", "name", "id", "position"))),
  unplace: (s, r) => plain(s.api.unplace(pick(r, ...ACTING, ...STAMP, "parent", "name", "id"))),
  read: (s, r) => ({ items: readItems(r.node as string, s.api.read(pick(r, ...ACTING, "node"))) }),
  data: (s, r) => ({ items: dataItems(r.node as string, s.api.data(pick(r, ...ACTING, "node"))) }),
  directory: (s, r) =>
    listingItems(
      r.node as string,
      r.name as string | undefined,
      s.api.directory(pick(r, ...ACTING, "node", "name")),
    ),
  lookup: (s, r) => ({
    items: lookupItems(r.name as string, s.api.lookup(pick(r, ...ACTING, "name", "path"))),
  }),
  subscribe: (s, r) => {
    const queue: Event[] = [];
    const { sub } = s.api.subscribe({
      ...pick(r, ...ACTING, "node"),
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
    const queue = s.queues.get(r.sub as number);
    if (!queue) throw new Invalid(`there is no subscription ${JSON.stringify(r.sub)}`);
    return queue.splice(0);
  },
  // drive's own operations
  batch: (s, r) => {
    if (typeof s.api.batch !== "function") throw new Unsupported("batch");
    const requests = r.requests;
    if (!Array.isArray(requests) || !requests.every(isObject)) {
      throw new Invalid("a batch's requests are a list of requests");
    }
    const answers: unknown[] = [];
    const settled: Settled = s.api.batch(() => {
      for (const request of requests as Request[]) answers.push(answer(s, request));
    });
    return plain({ answers, ...settled });
  },
  fire: (s, r) => {
    if (typeof s.api.fire !== "function") throw new Unsupported("fire");
    const fired = s.api.fire(pick(r, ...ACTING, "handler", "input"));
    return plain("error" in fired ? { ...fired, error: errorJson(fired.error) } : fired);
  },
};

/** A record's program entry for an absent program node: saw null, not absent. */
function encoded(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(encoded);
  if (typeof v !== "object" || v === null) return v;
  const o = v as { [key: string]: unknown };
  const out: { [key: string]: unknown } = {};
  for (const [k, x] of Object.entries(o)) {
    out[k] = (k === "compute" || k === "effect") && isObject(x as never) &&
        (x as { absent?: unknown }).absent === true
      ? (({ absent: _, ...rest }) => ({ ...rest, saw: null }))(x as { absent: true })
      : encoded(x);
  }
  return out;
}

/** An answer as JSON: a stopped process's cleanup error as {kind, why}. */
function plain<T>(answer: T): T {
  const stopped = (answer as { stopped?: { error?: unknown }[] })?.stopped;
  if (!Array.isArray(stopped)) return answer;
  return {
    ...answer,
    stopped: stopped.map((s) => "error" in s ? { ...s, error: errorJson(s.error) } : s),
  };
}

/** The answer to one request, without its seq. */
export function answer(session: Session | undefined, request: Request): { [key: string]: unknown } {
  const cmd = request.cmd;
  try {
    if (typeof cmd !== "string") throw new Invalid("a request has a cmd, a string");
    const command = commands[cmd];
    if (!command) return { unsupported: cmd };
    if (!session) throw new Invalid("no session yet: reset first");
    return { ok: encoded(command(session, request)) };
  } catch (e) {
    return trouble(e);
  }
}

export function trouble(e: unknown): { [key: string]: unknown } {
  if (e instanceof Unsupported) return { unsupported: e.cmd };
  if (e instanceof ErmineError) return { error: { kind: e.kind, why: e.message } };
  // a request the stack could not take at all, such as a field of the wrong kind
  return { error: { kind: "invalid", why: String(e) } };
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
      return JSON.stringify({ seq: null, error: { kind: "invalid", why: String(e) } });
    }
    if (!isObject(request)) {
      return JSON.stringify({
        seq: null,
        error: { kind: "invalid", why: "a request is one JSON object" },
      });
    }
    const seq = "seq" in request ? request.seq : null;
    return JSON.stringify({ seq, ...this.#answer(request) });
  }

  #answer(request: Request) {
    if (request.cmd !== "reset") return answer(this.session, request);
    try {
      const stack = typeof request.stack === "string" ? request.stack : "";
      if (!Object.hasOwn(stacks, stack)) throw new Invalid(`no stack ${JSON.stringify(stack)}`);
      const build = stacks[stack];
      if (!build) return { unsupported: "reset" };
      this.session = { api: build(request), queues: new Map() };
      return { ok: null };
    } catch (e) {
      return trouble(e);
    }
  }
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
