// The wire under a link: conversations between two peers over a transport
// that, like Subduction's ephemeral messages, delivers each payload to every
// other peer on a channel, best effort, in any order, and drops one that is
// too big. A conversation numbers its frames, so each side gets the other's
// messages in order, and a frame that stays missing breaks it; splits a
// message too big for one payload; and beats, so a side that goes quiet is
// gone.
//
// A frame is JSON: {"n": k, "to": peer, "m": message} or, for a piece of a
// message too big for one payload, {"n": k, "to": peer, "part": text,
// "more": true?}, the message's text in pieces, the last without more. n
// counts from 0 for each sender and receiver. The one frame to no one in
// particular is a mounter's hello, {"to": "*", "m": {"hello": "mount"}},
// which every owner on the channel hears, unnumbered.
//
// Messages: {"hello": "mount"} and {"hello": "serve"} to begin;
// {"beat": true} when a side has said nothing for a while; {"bye": why} when
// one side ends; {"id": k, "text": line} a request line and its answer, the
// answer with the request's id; {"text": line} a line pushed by the owner.

import { ours } from "../types.ts";

ours(import.meta.url);

/** What a link needs from a channel. */
export interface Transport {
  /** This peer's id on the channel: Subduction's verified signer key, so others cannot claim it. */
  readonly self: string;
  /** The largest payload, in bytes; a bigger one is dropped. */
  readonly max: number;
  /** Sends the payload to every other peer on the channel. */
  send(payload: Uint8Array): void | Promise<void>;
  /** Calls the handler with each payload another peer sent, and who sent it. */
  receive(handler: (payload: Uint8Array, from: string) => void): void;
  close(): void | Promise<void>;
  /** What it has been given and not sent yet (a paced transport's queue); none if it has no such thing. */
  backlog?(): Backlog;
}

/** What waits to be sent: bytes, payloads, and how long the oldest has waited (ms). */
export type Backlog = { bytes: number; payloads: number; oldest: number };

/** How a paced transport sends (paced). */
export type Pace = {
  /** bytes that may go at once (default 65536) */
  burst?: number;
  /** bytes a second after that (default 262144, below galaxy.observer's ~300 kB/s) */
  rate?: number;
  /**
   * after at least `burst` bytes went, a tiny payload this long after the
   * last send, and again at 4 and 16 times as long, unless something else
   * is sent first (ms; default 150; 0: none). Deno's WebSocket keeps a
   * burst bigger than the socket's buffer until its next write
   * (plans/throughput.org): this is that write.
   */
  nudge?: number;
};

/** The payload a nudge sends: no frame (it has no "to"), so every peer drops it. */
export const NUDGE = new TextEncoder().encode(`{"nudge":true}`);

/**
 * A transport that sends at most `burst` bytes at once, then `rate` bytes a
 * second, in order, so a big message (sent in pieces) or a flood never piles
 * up in the socket below; send's promise settles when the payload goes. And
 * after a burst it nudges (Pace.nudge).
 */
export function paced(inner: Transport, pace: Pace = {}): Transport {
  const burst = pace.burst ?? 65536, rate = pace.rate ?? 262144, nudge = pace.nudge ?? 150;
  type Waiting = { payload: Uint8Array; at: number; done: (e?: unknown) => void };
  const queue: Waiting[] = [];
  let tokens = burst, at = Date.now(), streak = 0, closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const nudges: ReturnType<typeof setTimeout>[] = [];
  const quiet = () => nudges.splice(0).forEach(clearTimeout);
  const poke = () => {
    if (queue.length || closed) return;
    streak = 0;
    try {
      const p = inner.send(NUDGE);
      if (p) p.catch(() => {});
    } catch { /* the next send writes anyway */ }
  };
  const pump = () => {
    timer = undefined;
    const now = Date.now();
    tokens = Math.min(burst, tokens + (now - at) * rate / 1000);
    at = now;
    let sent = false;
    while (queue.length) {
      const w = queue[0];
      // one bigger than a burst goes when the bucket is full
      if (tokens < Math.min(w.payload.length, burst)) break;
      queue.shift();
      tokens -= w.payload.length;
      streak += w.payload.length;
      sent = true;
      try {
        const p = inner.send(w.payload);
        if (p) p.then(() => w.done(), (e) => w.done(e ?? new Error("send failed")));
        else w.done();
      } catch (e) {
        w.done(e);
      }
    }
    if (queue.length) {
      const need = Math.min(queue[0].payload.length, burst) - tokens;
      timer = setTimeout(pump, Math.max(1, Math.ceil(need * 1000 / rate)));
    }
    if (sent && nudge && streak >= burst) {
      quiet();
      for (const k of [1, 4, 16]) nudges.push(setTimeout(poke, nudge * k));
    }
  };
  return {
    self: inner.self,
    max: inner.max,
    send(payload) {
      if (closed) return Promise.reject(new Error("closed"));
      return new Promise<void>((resolve, reject) => {
        queue.push({
          payload,
          at: Date.now(),
          done: (e) => (e === undefined ? resolve() : reject(e)),
        });
        if (timer === undefined) pump();
      });
    },
    receive: (handler) => inner.receive(handler),
    async close() {
      closed = true;
      clearTimeout(timer);
      quiet();
      for (const w of queue.splice(0)) w.done(new Error("closed"));
      await inner.close();
    },
    backlog() {
      const now = Date.now();
      return {
        bytes: queue.reduce((n, w) => n + w.payload.length, 0),
        payloads: queue.length,
        oldest: queue.length ? now - queue[0].at : 0,
      };
    },
  };
}

/** A channel's name: 32 random bytes in hex, shared out of band. Whoever has it can join. */
export function channel(): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(32)),
    (b) => b.toString(16).padStart(2, "0"),
  )
    .join("");
}

/** The 32 bytes a channel names. */
export function topic(name: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(name)) throw new Error("a channel is 64 hex digits: 32 bytes");
  return Uint8Array.from(name.match(/../g)!, (h) => parseInt(h, 16));
}

export type Timing = {
  /** a side that has sent nothing for this long sends a beat (ms) */
  beat?: number;
  /** a side not heard from for this long is gone (ms) */
  quiet?: number;
  /** a frame missing for this long, with later ones held, breaks the conversation (ms) */
  gap?: number;
  /** a mounter gives up finding an owner after this long (ms) */
  dial?: number;
};

const TIMING: Required<Timing> = { beat: 5000, quiet: 20000, gap: 5000, dial: 10000 };

/** How much a peer on the channel may make this side keep; past it, its conversation ends, or its frames are dropped, with the reason logged. */
export type Limits = {
  /** the biggest message sent in pieces, in characters of its text (default 16777216) */
  message?: number;
  /** frames held ahead of the next expected one (default 4096); a frame further ahead ends the conversation */
  ahead?: number;
  /** conversations at once on an owner's wire, and owners heard from while a mounter dials (default 256); more are not begun */
  conns?: number;
};

const LIMITS: Required<Limits> = { message: 16777216, ahead: 4096, conns: 256 };

export type WireOptions = Timing & Limits;

type Message = { [key: string]: unknown };
type Frame = { n?: number; to: string; m?: Message; part?: string; more?: true };

const UTF8 = new TextEncoder();
const TEXT = new TextDecoder();

/** One conversation with one peer. */
export class Conn {
  /** Called with each request or pushed line: {id?, text}. */
  onmessage: (m: { id?: number; text: string }) => void = () => {};
  /** Resolves with why, once the conversation ends. */
  readonly closed: Promise<string>;
  #end!: (why: string) => void;
  #over = false;
  #sent = 0;
  #heard = Date.now();
  #said = Date.now();
  #timer: ReturnType<typeof setInterval>;
  // receiving
  #next = 0;
  #held = new Map<number, Frame>();
  #gap: ReturnType<typeof setTimeout> | undefined;
  #parts: string[] = [];
  #partsSize = 0;

  /** from: the number of the first frame it takes (a mounter's begins at the owner's hello it heard) */
  constructor(readonly wire: Wire, readonly peer: string, from = 0) {
    this.#next = from;
    this.closed = new Promise((resolve) => (this.#end = resolve));
    const t = wire.timing;
    this.#timer = setInterval(() => {
      const now = Date.now();
      if (now - this.#heard > t.quiet) this.close("quiet", false);
      else if (now - this.#said >= t.beat) this.send({ beat: true });
    }, Math.min(t.beat, t.quiet) / 2);
  }

  get over() {
    return this.#over;
  }

  /** Sends a message, as text already made, or an object written as JSON. */
  send(m: Message | string) {
    if (this.#over) return;
    const text = typeof m === "string" ? m : JSON.stringify(m);
    this.#said = Date.now();
    const whole = this.#frame(`"m":${text}`, false);
    if (whole.length <= this.wire.transport.max) {
      this.#sent++;
      return this.#put(whole);
    }
    // too big for one payload: the text in pieces, each as big as fits
    const room = this.wire.transport.max - 100;
    let i = 0;
    while (i < text.length) {
      let size = Math.max(1, Math.floor(room / 6));
      // grow the piece while it fits; JSON's escapes make a piece up to six bytes a unit
      while (i + size < text.length) {
        const bigger = Math.min(text.length - i, size * 2);
        if (this.#bytes(text.slice(i, i + bigger)) > room) break;
        size = bigger;
      }
      const piece = text.slice(i, i + size);
      i += size;
      const more = i < text.length ? `,"more":true` : "";
      this.#put(this.#frame(`"part":${JSON.stringify(piece)}${more}`));
    }
  }

  #bytes(piece: string) {
    return UTF8.encode(JSON.stringify(piece)).length;
  }

  /** A frame with the next number, counted unless it is only being measured. */
  #frame(body: string, count = true) {
    const n = count ? this.#sent++ : this.#sent;
    return UTF8.encode(`{"n":${n},"to":${JSON.stringify(this.peer)},${body}}`);
  }

  #put(bytes: Uint8Array) {
    try {
      const p = this.wire.transport.send(bytes);
      if (p) p.catch((e) => this.close(`send failed: ${e}`, false));
    } catch (e) {
      this.close(`send failed: ${e}`, false);
    }
  }

  /** A frame from the peer, in whatever order it came. */
  take(f: Frame) {
    this.#heard = Date.now();
    if (this.#over || typeof f.n !== "number" || f.n < this.#next) return;
    if (!Number.isInteger(f.n) || f.n >= this.#next + this.wire.limits.ahead) {
      return this.#refuse(
        `frame ${f.n} is more than ${this.wire.limits.ahead} ahead of frame ${this.#next}`,
      );
    }
    this.#held.set(f.n, f);
    const from = this.#next;
    while (this.#held.has(this.#next)) {
      const g = this.#held.get(this.#next)!;
      this.#held.delete(this.#next++);
      this.#deliver(g);
      if (this.#over) return;
    }
    // a frame missing is timed from when the last one before it came
    if (!this.#held.size || this.#next !== from) {
      clearTimeout(this.#gap);
      this.#gap = undefined;
    }
    if (this.#held.size && this.#gap === undefined) {
      this.#gap = setTimeout(
        () => this.close(`frame ${this.#next} never came`),
        this.wire.timing.gap,
      );
    }
  }

  #deliver(f: Frame) {
    let m = f.m;
    if (typeof f.part === "string") {
      this.#parts.push(f.part);
      this.#partsSize += f.part.length;
      if (this.#partsSize > this.wire.limits.message) {
        this.#parts = [];
        return this.#refuse(`a message longer than ${this.wire.limits.message} characters`);
      }
      if (f.more) return;
      try {
        m = JSON.parse(this.#parts.join(""));
      } catch {
        m = undefined;
      }
      this.#parts = [];
      this.#partsSize = 0;
    }
    if (typeof m !== "object" || m === null) return this.close("a message that is not JSON");
    if (m.bye !== undefined) return this.close(`the peer left: ${m.bye}`, false);
    if (m.beat || m.hello) return;
    if (typeof m.text === "string") {
      this.onmessage(typeof m.id === "number" ? { id: m.id, text: m.text } : { text: m.text });
    }
  }

  /** Ends the conversation over a limit the peer went past, saying so in the log too. */
  #refuse(why: string) {
    console.error(`wire: ending the conversation with ${this.peer.slice(0, 16)}: ${why}`);
    this.close(why);
  }

  /** Ends the conversation, telling the peer unless it is gone. */
  close(why = "closed", tell = true) {
    if (this.#over) return;
    if (tell) this.send({ bye: why });
    this.#over = true;
    clearInterval(this.#timer);
    clearTimeout(this.#gap);
    this.#held.clear();
    this.#parts = [];
    this.wire.conns.delete(this.peer);
    this.#end(why);
  }
}

/** Every conversation this peer has on one transport. */
export class Wire {
  readonly conns = new Map<string, Conn>();
  readonly timing: Required<Timing>;
  readonly limits: Required<Limits>;
  /** Called with each new conversation a mounter began, on an owner's wire. */
  onconn: ((conn: Conn) => void) | undefined;
  #dialing: ((conn: Conn) => void) | undefined;
  #warned = 0;

  constructor(readonly transport: Transport, options: WireOptions = {}) {
    const { message, ahead, conns, ...timing } = options;
    this.timing = { ...TIMING, ...defined(timing) };
    this.limits = { ...LIMITS, ...defined({ message, ahead, conns }) };
    transport.receive((payload, from) => this.#take(payload, from));
  }

  /** Says in the log that a peer was not heard, at most every few seconds, so a flood of them is not a flood of lines. */
  #warn(why: string) {
    if (Date.now() - this.#warned < 5000) return;
    this.#warned = Date.now();
    console.error(`wire: ${why}`);
  }

  /** What the transport has been given and not sent yet. */
  backlog(): Backlog {
    return this.transport.backlog?.() ?? { bytes: 0, payloads: 0, oldest: 0 };
  }

  #take(payload: Uint8Array, from: string) {
    let f: Frame;
    try {
      f = JSON.parse(TEXT.decode(payload));
    } catch {
      return;
    }
    if (typeof f !== "object" || f === null) return;
    const self = this.transport.self;
    if (f.to === "*") {
      // a mounter looking for an owner
      if (!this.onconn || f.m?.hello !== "mount") return;
      let conn = this.conns.get(from);
      if (!conn) {
        if (this.conns.size >= this.limits.conns) {
          return this.#warn(`${this.limits.conns} peers mounted already: a hello not answered`);
        }
        conn = new Conn(this, from);
        this.conns.set(from, conn);
        this.onconn(conn);
      }
      // said again for every hello, in case the first answer was lost
      conn.send({ hello: "serve" });
      return;
    }
    if (f.to !== self) return;
    const conn = this.conns.get(from);
    if (conn) return conn.take(f);
    if (!this.#dialing) return;
    // the first owner to answer a mounter's hello is the one it talks to;
    // its frames may come before its hello, so they wait for it. Any of its
    // hellos will do: it says one for each of ours, numbered on, in case the
    // first was lost, and before we say anything it says nothing else but beats
    const early = this.#early.get(from) ?? [];
    if (typeof f.n === "number" && Number.isInteger(f.n) && f.m?.hello === "serve") {
      const c = new Conn(this, from, f.n);
      this.conns.set(from, c);
      const done = this.#dialing;
      this.#dialing = undefined;
      this.#early.clear();
      c.take(f);
      for (const g of early) c.take(g);
      return done(c);
    }
    // so many held, from so many, at most; a hello is never refused for them
    if (!this.#early.has(from) && this.#early.size >= this.limits.conns) {
      return this.#warn(`${this.limits.conns} peers heard while dialing: one more not heard`);
    }
    if (early.length >= this.limits.ahead) {
      return this.#warn(`${this.limits.ahead} frames from ${from.slice(0, 16)} before its hello`);
    }
    this.#early.set(from, early);
    early.push(f);
  }

  #early = new Map<string, Frame[]>();

  /** Finds the owner on the channel: says hello until one answers. */
  dial(): Promise<Conn> {
    if (this.#dialing) throw new Error("already dialing");
    return new Promise((resolve, reject) => {
      const hello = UTF8.encode(JSON.stringify({ to: "*", m: { hello: "mount" } }));
      const say = () => {
        try {
          const p = this.transport.send(hello);
          if (p) p.catch(() => {});
        } catch { /* said again in a moment */ }
      };
      const again = setInterval(say, 1000);
      const late = setTimeout(() => {
        finish();
        reject(new Error(`no owner answered on the channel in ${this.timing.dial} ms`));
      }, this.timing.dial);
      const finish = () => {
        clearInterval(again);
        clearTimeout(late);
        this.#dialing = undefined;
        this.#early.clear();
      };
      this.#dialing = (conn) => {
        finish();
        resolve(conn);
      };
      say();
    });
  }

  /** Ends every conversation, saying bye, then the transport. */
  async close(why = "closed") {
    for (const conn of [...this.conns.values()]) conn.close(why);
    this.onconn = undefined;
    // let the byes go before the transport closes
    await new Promise((r) => setTimeout(r, 0));
    await this.transport.close();
  }
}

/** The fields that are not undefined, so a default stands for one left out. */
function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Peers in one process: a channel in memory, for tests. Each payload goes to
 * every other peer after a moment; with shuffle, in any order, as
 * Subduction's do; one bigger than max is dropped, as Subduction drops it.
 */
export function hub(options: { shuffle?: boolean; max?: number } = {}) {
  const peers = new Map<string, (payload: Uint8Array, from: string) => void>();
  const cut = new Set<string>();
  let count = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  return {
    peer(): Transport {
      const self = `peer-${++count}`;
      return {
        self,
        max: options.max ?? 65536,
        send(payload) {
          if (payload.length > (options.max ?? 65536) || cut.has(self)) return;
          for (const [id, handler] of peers) {
            if (id === self || cut.has(id)) continue;
            const copy = payload.slice();
            const t = setTimeout(() => {
              timers.delete(t);
              handler(copy, self);
            }, options.shuffle ? Math.floor(Math.random() * 4) : 0);
            timers.add(t);
          }
        },
        receive(handler) {
          peers.set(self, handler);
        },
        close() {
          peers.delete(self);
        },
      };
    },
    /** Drops everything to and from the peer from now on, as a host that vanished. */
    cut(id: string) {
      cut.add(id);
    },
    /** Clears what is still in flight. */
    stop() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}
