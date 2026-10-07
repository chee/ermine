// The mounter's side of a link: a remote interface to the subtree an owner
// serves. Each operation is sent as a PROTOCOL.tex line and its answer
// awaited, so every operation returns a promise: ermine's Interface is
// synchronous, and a remote one cannot be, since the answer is on another
// host. Remote is therefore not an Interface: no wrapper stacks on it, no
// program runs against it, and bind, record, finish and top are not here. A
// host that wants one in its own graph mounts it at a place and awaits.
//
// A change from here that gives no cause gets this host's site, captured
// where it was called, as a change from outside any process does; the owner
// stamps its time. Events of a subscription are pushed by the owner and
// handed to send as they come. When the owner goes, or is not heard from,
// every pending operation fails with Gone and every subscription ends.

import { isObject } from "../patch.ts";
import {
  capture,
  type Changed,
  type DirectoryOp,
  ErmineError,
  type ErrorJson,
  type Event,
  Invalid,
  type Listing,
  type LookupOp,
  ours,
  type PlaceOp,
  type ReadOp,
  Refused,
  type RefusedItem,
  type SlotItem,
  type SubscribeOp,
  type UnplaceOp,
  type UnsubscribeOp,
  type ValueItem,
  type WriteOp,
} from "../types.ts";
import { encode } from "../../harness/main.ts";
import { decode, Malformed } from "../../harness/forms.ts";
import { type Conn, type Transport, Wire, type WireOptions } from "./wire.ts";

ours(import.meta.url);

/** The owner went, or a frame was lost: what was pending will never be answered. */
export class Gone extends Error {
  constructor(why: string) {
    super(`the link is gone: ${why}`);
    this.name = "Gone";
  }
}

/** A program's error, thrown on the owner's side and answered as one. */
export class Thrown extends Error {
  constructor(readonly error: ErrorJson) {
    super(error.why.text ?? error.why.code);
    this.name = "Thrown";
  }
}

/** What the owner does not do over a link. */
export class Unsupported extends Error {
  constructor(readonly cmd: string) {
    super(`${cmd} is not supported over a link`);
    this.name = "Unsupported";
  }
}

/** The most events kept for subs whose subscribe's answer has not been read yet. */
const EARLY = 4096;

/** A subscription over a link: send each event; ended when the link or the subscription ends. */
export type RemoteSubscribeOp = SubscribeOp & { ended?: (why: string) => void };

/** One line's answer as JSON text, and the pushed lines between. */
export type Answer = { [key: string]: unknown };

export type MountOptions = WireOptions;

/** Mounts what the owner on the transport serves. */
export async function mount(transport: Transport, options: MountOptions = {}): Promise<Remote> {
  const wire = new Wire(transport, options);
  try {
    const conn = await wire.dial();
    return new Remote(wire, conn);
  } catch (e) {
    await wire.close();
    throw e;
  }
}

/** The owner's served subtree, from here: each operation a promise. */
export class Remote {
  readonly #wire: Wire;
  readonly #conn: Conn;
  #id = 1;
  readonly #pending = new Map<
    number,
    { resolve: (text: string) => void; reject: (e: Error) => void }
  >();
  readonly #subs = new Map<number, RemoteSubscribeOp>();
  /**
   * events of subs not known here while a subscribe waits for its answer:
   * the answer's frame may come after them, or with them, before it is read
   */
  readonly #early = new Map<number, unknown[]>();
  #earlyCount = 0;
  #subscribing = 0;
  #gone: string | undefined;
  /** Resolves with why, once the link ends. */
  readonly closed: Promise<string>;
  /** Called with each line the owner pushes, as its text, for a host that speaks lines itself. */
  onpush: (text: string) => void = () => {};

  constructor(wire: Wire, conn: Conn) {
    this.#wire = wire;
    this.#conn = conn;
    conn.onmessage = ({ id, text }) => {
      if (id !== undefined) {
        const p = this.#pending.get(id);
        this.#pending.delete(id);
        p?.resolve(text);
        return;
      }
      this.onpush(text);
      this.#push(text);
    };
    this.closed = conn.closed.then((why) => {
      this.#gone = why;
      for (const p of this.#pending.values()) p.reject(new Gone(why));
      this.#pending.clear();
      for (const op of this.#subs.values()) op.ended?.(why);
      this.#subs.clear();
      return why;
    });
  }

  /** The owner's peer id. */
  get owner(): string {
    return this.#conn.peer;
  }

  #push(text: string) {
    let line: unknown;
    try {
      line = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObject(line) || typeof line.sub !== "number" || !Object.hasOwn(line, "event")) return;
    const op = this.#subs.get(line.sub);
    if (op) return op.send(revive(line.event) as Event);
    if (!this.#subscribing || this.#earlyCount >= EARLY) return;
    const early = this.#early.get(line.sub) ?? [];
    this.#early.set(line.sub, early);
    early.push(line.event);
    this.#earlyCount++;
  }

  /**
   * Sends one line, as its text, exactly, and gives the answer line's text:
   * for a host that speaks lines itself, as the stdio bridge does.
   */
  line(text: string): Promise<string> {
    if (this.#gone !== undefined) return Promise.reject(new Gone(this.#gone));
    const id = this.#id++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#conn.send(`{"id":${id},"text":${JSON.stringify(text)}}`);
    });
  }

  /** One operation: its line, its answer's result, or its error thrown. */
  async #call(cmd: string, op: object): Promise<unknown> {
    const { send: _s, ended: _e, ...fields } = op as { [key: string]: unknown };
    const seq = this.#id;
    const answer = JSON.parse(await this.line(encode({ seq, cmd, ...fields }))) as Answer;
    if (Object.hasOwn(answer, "ok")) return revive(answer.ok);
    if (Object.hasOwn(answer, "unsupported")) throw new Unsupported(String(answer.unsupported));
    throw errorOf(answer.error as ErrorJson);
  }

  read(op: ReadOp): Promise<ValueItem[]> {
    return this.#call("read", op).then((ok) => (ok as { items: ValueItem[] }).items);
  }

  directory(op: DirectoryOp): Promise<Listing> {
    return this.#call("directory", op) as Promise<Listing>;
  }

  lookup(op: LookupOp): Promise<(SlotItem | RefusedItem)[]> {
    return this.#call("lookup", op).then((ok) =>
      (ok as { items: (SlotItem | RefusedItem)[] }).items
    );
  }

  write(op: WriteOp): Promise<Changed> {
    return this.#call("write", sited(op, this.write)) as Promise<Changed>;
  }

  place(op: PlaceOp): Promise<Changed> {
    return this.#call("place", sited(op, this.place)) as Promise<Changed>;
  }

  unplace(op: UnplaceOp): Promise<Changed> {
    return this.#call("unplace", sited(op, this.unplace)) as Promise<Changed>;
  }

  /** Numbered by the owner, from 1, for this mount. */
  async subscribe(op: RemoteSubscribeOp): Promise<{ sub: number }> {
    this.#subscribing++;
    try {
      const { sub } = await this.#call("subscribe", op) as { sub: number };
      const early = this.#early.get(sub) ?? [];
      this.#early.delete(sub);
      this.#earlyCount -= early.length;
      if (this.#gone !== undefined) {
        op.ended?.(this.#gone);
        return { sub };
      }
      this.#subs.set(sub, op);
      for (const event of early) op.send(revive(event) as Event);
      return { sub };
    } finally {
      // with none waiting, what is left was for subs no one here has
      if (!--this.#subscribing) {
        this.#early.clear();
        this.#earlyCount = 0;
      }
    }
  }

  async unsubscribe(op: UnsubscribeOp): Promise<void> {
    await this.#call("unsubscribe", op);
    const held = this.#subs.get(op.sub);
    this.#subs.delete(op.sub);
    held?.ended?.("unsubscribed");
  }

  /** Unmounts: tells the owner, fails what is pending, ends every subscription. */
  async close(why = "unmounted") {
    await this.#wire.close(why);
    await this.closed;
  }
}

/** The op with this host's site as its cause, if it gives none and acts as no process. */
function sited<T extends { cause?: unknown; process?: unknown }>(op: T, entry: unknown): T {
  if (op.cause !== undefined || op.process !== undefined) return op;
  const site = capture(entry);
  return site ? { ...op, cause: site } : op;
}

/** An answer's error as the error the stack would have thrown. */
function errorOf(error: ErrorJson): Error {
  if (!isObject(error)) return new Error("a malformed answer");
  let e: ErmineError;
  if (error.kind === "invalid") e = new Invalid(error.why, error.op);
  else if (error.kind === "refused") e = new Refused(error.why, error.op);
  else return new Thrown(error);
  return e;
}

/**
 * An answer's JSON with its values read from their forms (PROTOCOL.tex,
 * Values in JSON): bytes and typed arrays as buffers, NaN and the
 * infinities as numbers, a live value as its stand-in, which shows only its
 * kind. Everything that is not a value is plain JSON, so every map whose only
 * key is "/" is a form.
 */
export function revive(json: unknown): unknown {
  if (Array.isArray(json)) return json.map(revive);
  if (!isObject(json)) return json;
  const keys = Object.keys(json);
  if (keys.length === 1 && keys[0] === "/") {
    try {
      return decode(json, true);
    } catch (e) {
      if (!(e instanceof Malformed)) throw e;
      return json;
    }
  }
  const out: { [key: string]: unknown } = {};
  // defined, not set: a key "__proto__" stays a key, as JSON.parse made it
  for (const key of keys) {
    Object.defineProperty(out, key, {
      value: revive(json[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
