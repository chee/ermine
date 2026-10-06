// The conformance harness (PROTOCOL.tex): one JSON request per line on stdin,
// one JSON answer per line on stdout. Each reset builds a fresh graph. The
// protect and drive stacks are being redesigned, so a reset asking for one is
// answered unsupported, and so are batch and fire.
//
// A request is checked before the stack sees it, field by field in the order
// PROTOCOL.tex gives (Errors), so the first field missing or of the wrong
// kind answers; then the stack checks the rest.

import { isObject, whole } from "../src/patch.ts";
import { fields, graph, type Kind } from "../src/graph.ts";
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

/**
 * What has arrived for one subscription since the last events, and whether
 * it is still open: after unsubscribe, the next events hands over what
 * arrived before it, once, and then the number is gone.
 */
export type Queue = { events: Event[]; open: boolean };

/** One session: the stack, and the queue of each subscription, by its number. */
export type Session = { api: Interface; queues: Map<number, Queue> };

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
 * harness cannot (PROTOCOL.tex, Time and cause). Below drive it carries a
 * time too.
 */
function outside(): never {
  throw missing("cause");
}

/**
 * The request's fields an operation takes, checked in PROTOCOL.tex's order
 * before the stack sees them, as a change from outside: the first missing
 * or of the wrong kind answers.
 */
function checked(kind: Kind, r: Request, ...keys: string[]) {
  const op = pick(r, ...ACTING, ...keys);
  fields(kind, op, outside);
  return op;
}

/** The commands, each given the session and the request, returning the ok result. */
export const commands: { [cmd: string]: (s: Session, r: Request) => unknown } = {
  read: (s, r) => ({ items: s.api.read(checked("read", r, "address")) }),
  directory: (s, r) => s.api.directory(checked("directory", r, "address", "name")),
  lookup: (s, r) => ({ items: s.api.lookup(checked("lookup", r, "name")) }),
  write: (s, r) => s.api.write(checked("write", r, ...STAMP, "address", "patches")),
  place: (s, r) =>
    s.api.place(checked("place", r, ...STAMP, "address", "name", "id", "position", "value")),
  unplace: (s, r) => s.api.unplace(checked("unplace", r, ...STAMP, "address", "name", "id")),
  subscribe: (s, r) => {
    const queue: Queue = { events: [], open: true };
    const op = {
      ...pick(r, ...ACTING, "address"),
      send: (event: Event) => queue.events.push(event),
    };
    fields("subscribe", op, outside);
    const { sub } = s.api.subscribe(op);
    s.queues.set(sub, queue);
    return { sub };
  },
  unsubscribe: (s, r) => {
    s.api.unsubscribe(checked("unsubscribe", r, "sub"));
    const queue = s.queues.get(r.sub as number);
    if (queue) queue.open = false;
    return null;
  },
  // not an operation: it needs no agent (PROTOCOL.tex, Acting as someone; Commands)
  events: (s, r) => {
    if (!Object.hasOwn(r, "sub")) throw missing("sub");
    const queue = whole(r.sub) ? s.queues.get(r.sub) : undefined;
    if (!queue) throw wrongField("sub", `there is no subscription ${JSON.stringify(r.sub)}`);
    if (!queue.open) s.queues.delete(r.sub as number);
    return queue.events.splice(0);
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

/**
 * Decodes a line's bytes, keeping a byte order mark: U+FEFF is not JSON
 * whitespace, so a line that starts with one is not one JSON object, and
 * stops being JSON at its first byte. Each line is decoded on its own, so the
 * first line of stdin is answered as any other.
 */
const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** A harness: reads lines, answers each, until stdin closes. */
export class Harness {
  session: Session | undefined;

  /**
   * The answer line to one line, given as its text or as its bytes, which
   * are UTF-8 or the line is not JSON from the first byte that is not.
   * Undefined is a line that is not UTF-8 at all.
   */
  line(input: string | Uint8Array | undefined): string {
    let text = "";
    let utf8 = input !== undefined;
    if (typeof input === "string") text = input;
    else if (input !== undefined) {
      const valid = utf8Length(input);
      text = UTF8.decode(input.subarray(0, valid));
      utf8 = valid === input.length;
    }
    let request: unknown;
    try {
      if (!utf8) throw new Error("the line is not UTF-8");
      request = JSON.parse(text);
    } catch (e) {
      return encode({ seq: seqOf(text), error: notARequest(String(e)) });
    }
    if (!isObject(request)) {
      return encode({ seq: seqOf(text), error: notARequest("a request is one JSON object") });
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

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const ESCAPES: { [c: string]: string } = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};
const DIGIT = /[0-9]/;
const HEX = /^[0-9a-fA-F]{4}$/;

/**
 * The seq of a line that is not one JSON object, if one can be read
 * (PROTOCOL.tex, Lines): a "seq" key of the object the line starts with,
 * holding a whole number, that a parser reading the line from its start
 * reaches before the line stops being JSON. Null otherwise. It keeps its own
 * stack, so a value however deep before the seq is passed over.
 */
export function seqOf(text: string): number | null {
  let i = 0;
  const space = () => {
    while (i < text.length && WHITESPACE.has(text[i])) i++;
  };
  /** A string at i, which starts with a quote; undefined where the line stops being JSON in it. */
  const string = (): string | undefined => {
    let out = "";
    for (let j = i + 1; j < text.length;) {
      const c = text[j];
      if (c === '"') {
        i = j + 1;
        return out;
      }
      if (c.charCodeAt(0) < 0x20) return;
      if (c !== "\\") {
        out += c;
        j++;
      } else if (Object.hasOwn(ESCAPES, text[j + 1] ?? "")) {
        out += ESCAPES[text[j + 1]];
        j += 2;
      } else if (text[j + 1] === "u" && HEX.test(text.slice(j + 2, j + 6))) {
        out += String.fromCharCode(parseInt(text.slice(j + 2, j + 6), 16));
        j += 6;
      } else return;
    }
  };
  /** A number at i; undefined where the line stops being JSON before it ends. */
  const number = (): number | undefined => {
    let j = i;
    const digits = () => {
      if (!DIGIT.test(text[j] ?? "")) return false;
      while (DIGIT.test(text[j] ?? "")) j++;
      return true;
    };
    if (text[j] === "-") j++;
    if (text[j] === "0") j++;
    else if (!/[1-9]/.test(text[j] ?? "") || !digits()) return;
    if (text[j] === "." && (j++, !digits())) return;
    if (text[j] === "e" || text[j] === "E") {
      j++;
      if (text[j] === "+" || text[j] === "-") j++;
      if (!digits()) return;
    }
    const n = Number(text.slice(i, j));
    i = j;
    return n;
  };
  /** Passes over the key and colon of a member at i; false where the line stops being JSON. */
  const key = (): string | undefined => {
    space();
    if (text[i] !== '"') return;
    const k = string();
    if (k === undefined) return;
    space();
    if (text[i] !== ":") return;
    i++;
    return k;
  };
  /** Passes over one value at i; false where the line stops being JSON in it. */
  const value = (): boolean => {
    const closers: string[] = [];
    while (true) {
      space();
      const c = text[i];
      if (c === "{" || c === "[") {
        i++;
        space();
        if (text[i] === (c === "{" ? "}" : "]")) i++;
        else {
          closers.push(c === "{" ? "}" : "]");
          if (c === "{" && key() === undefined) return false;
          continue;
        }
      } else if (c === '"') {
        if (string() === undefined) return false;
      } else if (c === "t" || c === "f" || c === "n") {
        const word = c === "t" ? "true" : c === "f" ? "false" : "null";
        if (text.slice(i, i + word.length) !== word) return false;
        i += word.length;
      } else if (number() === undefined) return false;
      // after a value: close what it ended, or go on to the next member
      while (true) {
        if (!closers.length) return true;
        space();
        const closer = closers[closers.length - 1];
        if (text[i] === closer) {
          i++;
          closers.pop();
          continue;
        }
        if (text[i] !== ",") return false;
        i++;
        if (closer === "}" && key() === undefined) return false;
        break;
      }
    }
  };
  space();
  if (text[i] !== "{") return null;
  i++;
  space();
  if (text[i] === "}") return null;
  while (true) {
    const k = key();
    if (k === undefined) return null;
    space();
    if (k === "seq") {
      const at = i;
      const n = number();
      if (n !== undefined && whole(n)) return n;
      i = at;
    }
    if (!value()) return null;
    space();
    if (text[i] !== ",") return null;
    i++;
  }
}

/**
 * How many bytes from the start are UTF-8: the line stops being JSON at the
 * first byte that does not begin or continue a well-formed sequence.
 */
export function utf8Length(bytes: Uint8Array): number {
  const tail = (i: number, low = 0x80, high = 0xbf) =>
    i < bytes.length && bytes[i] >= low && bytes[i] <= high;
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let n: number;
    if (b < 0x80) n = 1;
    else if (b >= 0xc2 && b <= 0xdf) n = tail(i + 1) ? 2 : 0;
    else if (b >= 0xe0 && b <= 0xef) {
      const low = b === 0xe0 ? 0xa0 : 0x80;
      const high = b === 0xed ? 0x9f : 0xbf;
      n = tail(i + 1, low, high) && tail(i + 2) ? 3 : 0;
    } else if (b >= 0xf0 && b <= 0xf4) {
      const low = b === 0xf0 ? 0x90 : 0x80;
      const high = b === 0xf4 ? 0x8f : 0xbf;
      n = tail(i + 1, low, high) && tail(i + 2) && tail(i + 3) ? 4 : 0;
    } else n = 0;
    if (!n) return i;
    i += n;
  }
  return i;
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
  const encoder = new TextEncoder();
  const out = (line: string) => {
    const bytes = encoder.encode(line + "\n");
    let n = 0;
    while (n < bytes.length) n += Deno.stdout.writeSync(bytes.subarray(n));
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
      out(harness.line(joined.subarray(start, end)));
      start = end + 1;
    }
    pending = joined.slice(start);
  }
  if (pending.length) out(harness.line(pending));
}

if (import.meta.main) await main();
