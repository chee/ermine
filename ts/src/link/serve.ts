// The owner's side of a link. One graph owns a subtree and serves it: each
// mounter's lines are answered against the owner's interface, chrooted at
// the served place, so a mounter can only name what is below it. The owner's
// stack gives every change its time; a mounter's time is dropped. Nothing
// merges: there is one writer, the owner's graph, and mounters send it
// operations.
//
// Lines are PROTOCOL.tex's, answered as the TS harness answers them
// (harness/main.ts), with these differences:
//   - only read, directory, lookup, write, place, unplace, subscribe and
//     unsubscribe; reset, reload, events, start, batch and fire are
//     unsupported;
//   - a request's place is below the served place, and its chroot hides the
//     served place too: "/" and ".." never reach above it;
//   - a request may not act as a process (wrong-field, field process):
//     processes are local, and a mounter's claim to be one is not checked;
//   - the owner says who: a request's agent becomes {"actor": a, "peer":
//     p}, a being the agent the mounter claimed (as it sent it, whatever it
//     is, so a "peer" it put in its own agent stays inside actor) and p the
//     mounter's verified key on the channel (the wire's sender of its
//     frames: Subduction's signer key, in hex; the in-memory hub's peer id).
//     So every change a mounter makes, and every read, is the stamped
//     agent's; its cause (its site) is as it sent it;
//   - subscription events are pushed, one line each, as
//     {"sub": n, "event": e}, not collected by events; when the owner ends
//     a subscription, as when the conversation ends, nothing more comes.

import { isObject, whole } from "../patch.ts";
import { fields } from "../graph.ts";
import type { Scheduler } from "../schedule.ts";
import {
  type Event,
  type Interface,
  invalid,
  type Json,
  missing,
  ours,
  wrongField,
} from "../types.ts";
import {
  answer,
  encode,
  pick,
  type Request,
  seqOf,
  type Session,
  trouble,
} from "../../harness/main.ts";
import { decode, Malformed } from "../../harness/forms.ts";
import { type Conn, type Transport, Wire, type WireOptions } from "./wire.ts";

ours(import.meta.url);

export type ServeOptions = WireOptions & {
  /**
   * The owner's clock, for a stack that does not stamp times itself, as a
   * bare graph or protect: the time of the next change. A stack with a
   * scheduler stamps its own.
   */
  time?: () => number;
};

/** The agent the owner acts on a mounter's request as: what it claimed, and who sent it. */
export function stamped(claimed: unknown, peer: string): { actor: Json; peer: string } {
  return { actor: (claimed ?? null) as Json, peer };
}

/** What serve gives back: who is mounted, and a way to stop. */
export type Served = {
  readonly wire: Wire;
  /** The peer ids mounted now. */
  peers(): string[];
  /** Ends every mount, each told why, and leaves the channel. */
  close(why?: string): Promise<void>;
};

const OPERATIONS = new Set(["read", "directory", "lookup", "write", "place", "unplace"]);
const UNSUPPORTED = new Set(["reset", "reload", "events", "start", "batch", "fire"]);
const ACTING = ["agent", "process", "place", "chroot"];

/** Serves the subtree at place of the owner's api to whoever mounts it on the transport. */
export function serve(
  api: Interface,
  place: readonly string[],
  transport: Transport,
  options: ServeOptions = {},
): Served {
  const wire = new Wire(transport, options);
  const scheduler = isScheduler(api) ? api : undefined;
  wire.onconn = (conn) => answering(api, scheduler, place, conn, options);
  return {
    wire,
    peers: () => [...wire.conns.keys()],
    close: (why = "the owner stopped serving") => wire.close(why),
  };
}

function isScheduler(api: Interface): api is Scheduler {
  const s = api as Partial<Scheduler>;
  return typeof s.time === "number" && typeof s.start === "function";
}

/** Answers one mounter's lines, and pushes its subscriptions' events, until it goes. */
function answering(
  api: Interface,
  scheduler: Scheduler | undefined,
  served: readonly string[],
  conn: Conn,
  options: ServeOptions,
) {
  // the harness's session, without a graph: no command here reloads
  const session = { api, scheduler, subs: new Map(), next: 1 } as unknown as Session;
  /** this mounter's subscriptions: the stack's number for each, and who made it */
  const subs = new Map<number, { sub: number; agent: Json }>();
  let next = 1;

  /** The request as the owner acts on it: at the served place, chrooted there, with the owner's time. */
  function rewrite(r: Request): Request {
    const out: { [key: string]: Json } = { ...r };
    if (Object.hasOwn(r, "process")) {
      throw wrongField("process", "a mounter acts as no process of the owner's");
    }
    out.agent = stamped(r.agent, conn.peer);
    const below = r.place ?? [];
    if (!Array.isArray(below) || !below.every((n) => typeof n === "string")) {
      throw wrongField("place", "a place is a list of names");
    }
    const hidden = r.chroot ?? 0;
    if (!whole(hidden) || hidden > below.length) {
      throw wrongField("chroot", "chroot counts names of the place");
    }
    out.place = [...served, ...(below as string[])];
    out.chroot = served.length + (hidden as number);
    delete out.time;
    if (options.time && !scheduler) out.time = options.time();
    return out;
  }

  function subscribe(r: Request) {
    let agent: Json;
    try {
      agent = decode(r.agent);
    } catch (e) {
      if (!(e instanceof Malformed)) throw e;
      throw wrongField("agent");
    }
    const n = next++;
    const op = {
      ...pick(r, ...ACTING, "address"),
      ...(r.agent === undefined ? {} : { agent }),
      send: (event: Event) => conn.send(`{"text":${JSON.stringify(encode({ sub: n, event }))}}`),
    };
    fields("subscribe", op);
    const { sub } = api.subscribe(op);
    subs.set(n, { sub, agent });
    return { sub: n };
  }

  function unsubscribe(r: Request) {
    if (!Object.hasOwn(r, "sub")) throw missing("sub");
    const held = whole(r.sub) ? subs.get(r.sub) : undefined;
    if (!held) throw wrongField("sub", `there is no subscription ${JSON.stringify(r.sub)}`);
    api.unsubscribe({ ...pick(r, ...ACTING), sub: held.sub });
    subs.delete(r.sub as number);
    return null;
  }

  function respond(r: Request): { [key: string]: unknown } {
    const cmd = r.cmd;
    if (typeof cmd === "string" && UNSUPPORTED.has(cmd)) return { unsupported: cmd };
    if (
      typeof cmd !== "string" ||
      !(OPERATIONS.has(cmd) || cmd === "subscribe" || cmd === "unsubscribe")
    ) {
      // missing, wrong-field or unknown-command, as the harness says it
      return answer(session, r);
    }
    let request: Request;
    try {
      if (!Object.hasOwn(r, "agent")) throw missing("agent");
      request = rewrite(r);
    } catch (e) {
      return trouble(e, cmd);
    }
    if (cmd === "subscribe" || cmd === "unsubscribe") {
      try {
        return { ok: cmd === "subscribe" ? subscribe(request) : unsubscribe(request) };
      } catch (e) {
        return trouble(e, cmd);
      }
    }
    return answer(session, request);
  }

  /** The answer line to a request line, as the harness writes it. */
  function line(text: string): string {
    let request: unknown;
    try {
      request = JSON.parse(text);
    } catch (e) {
      return encode({ seq: seqOf(text), error: notARequest(String(e)) });
    }
    if (!isObject(request)) {
      return encode({ seq: seqOf(text), error: notARequest("a request is one JSON object") });
    }
    const seq = Object.hasOwn(request, "seq") ? request.seq : null;
    try {
      return encode({ seq, ...respond(request as Request) });
    } catch (e) {
      return encode({ seq, ...trouble(e) });
    }
  }

  conn.onmessage = ({ id, text }) => {
    if (id === undefined) return;
    conn.send(`{"id":${id},"text":${JSON.stringify(line(text))}}`);
  };
  conn.closed.then(() => {
    for (const { sub, agent } of subs.values()) {
      try {
        api.unsubscribe({ agent, place: [...served], chroot: served.length, sub });
      } catch { /* already gone */ }
    }
    subs.clear();
  });
}

function notARequest(text: string) {
  return { kind: "invalid", why: invalid("not-a-request", text).why };
}
