// The owner's side of a link, for a program a host runs, as serve.ts is for
// a TS graph in hand: each mounter's lines go to the host as lines (lines.ts)
// and the host's answers come back over the link. The program serves its own
// place: a mounter's request is sent with its place below the program's
// (the request's own, or none), which a host such as the C terminal chroots
// at the program's place, so "/" and ".." never leave the served subtree, as
// serve.ts does it. Its agent is stamped as serve.ts stamps it,
// {"actor": claimed, "peer": the mounter's verified key}, and its cause is
// as it sent it. A host that binds its programs puts the program's own agent
// in its place unless it trusts the program to act for others: the C
// terminal keeps the stamped actor and peer, under the program's own code,
// for a program whose value says "relay": true (c/term/NOTES.md).
//
// It can serve less than its place: options.place, names below it (one
// window of the terminal's /windows, say), is put in front of each request's
// place, and the request chrooted there.
//
// As serve.ts: only read, directory, lookup, write, place, unplace,
// subscribe and unsubscribe; reset, reload, events, start, batch and fire
// are unsupported; a request carrying process is wrong-field; the mounter's
// time is dropped (the host stamps). Subscriptions are numbered from 1 for
// each mounter, and their events pushed to it as {"sub": n, "event": e}: the
// host must push them to the program (its "push": true).
//
// Events go to each mounter at most options.rate times a second (60 by
// default), all that came since, in order; an event that is a write of one
// snapshot (as the C terminal's pty writes its screen) replaces the same
// subscription's such events still waiting, so a busy screen sends its
// latest at that rate, and a flood never queues. While the transport has
// more than options.limit bytes not yet sent (the link is behind), events
// wait, and are replaced, until it catches up; options.behind is told, or,
// without it, the log (stderr). More than options.hold waiting ends that
// mount.
//
// A line that is not a request this serves is answered here (not-a-request,
// missing, wrong-field, unknown-command), never passed on: the host is given
// only requests written again here, one line each.

import { isObject } from "../patch.ts";
import { invalid, ours } from "../types.ts";
import { seqOf } from "../../harness/main.ts";
import { stamped } from "./serve.ts";
import type { Lines } from "./lines.ts";
import { type Backlog, type Conn, type Transport, Wire, type WireOptions } from "./wire.ts";

ours(import.meta.url);

export type RelayOptions = WireOptions & {
  /** what to serve: names below the program's place (default [], the place itself) */
  place?: readonly string[];
  /** called with the peers mounted, each time one comes or goes */
  peers?: (peers: string[]) => void;
  /** events sent to each mounter at most this many times a second (default 60) */
  rate?: number;
  /** bytes the transport may have waiting before events wait too (default 262144) */
  limit?: number;
  /** called when a mounter's events start waiting for the link, and with its peer alone when they go again; the log if not given */
  behind?: (state: Behind) => void;
  /** events that may wait for one mounter (default 10000); past it, its mount ends: what it was told would have holes */
  hold?: number;
};

/** A mounter whose events wait: how many, how many were replaced by newer ones so far, and what the transport has waiting. */
export type Behind = {
  peer: string;
  behind: boolean;
  held: number;
  coalesced: number;
  backlog: Backlog;
};

export type Relayed = {
  readonly wire: Wire;
  peers(): string[];
  /** each mounter's events: waiting, replaced; whether the link is behind for it */
  behind(): Behind[];
  /** Ends every mount, each told why, and leaves the channel. */
  close(why?: string): Promise<void>;
};

const OPERATIONS = new Set(["read", "directory", "lookup", "write", "place", "unplace"]);
const UNSUPPORTED = new Set(["reset", "reload", "events", "start", "batch", "fire"]);

/** Serves the program's place on the host, through lines, to whoever mounts it on the transport. */
export function relay(host: Lines, transport: Transport, options: RelayOptions = {}): Relayed {
  const wire = new Wire(transport, options);
  const told = () => options.peers?.([...wire.conns.keys()]);
  const states = new Map<string, () => Behind>();
  wire.onconn = (conn) => {
    states.set(conn.peer, relaying(host, conn, options.place ?? [], options));
    conn.closed.then(() => {
      states.delete(conn.peer);
      told();
    });
    told();
  };
  return {
    wire,
    peers: () => [...wire.conns.keys()],
    behind: () => [...states.values()].map((state) => state()),
    close: (why = "the owner stopped sharing") => wire.close(why),
  };
}

function error(seq: unknown, code: string, field: string, text: string, op?: unknown) {
  const e: { [key: string]: unknown } = { kind: "invalid", why: { code, field, text } };
  if (typeof op === "string") e.op = op;
  return JSON.stringify({ seq, error: e });
}

/** A line that is not a request, answered here as the host would: it never reaches the host. */
function notARequest(text: string, why: string) {
  return JSON.stringify({
    seq: seqOf(text),
    error: { kind: "invalid", why: { code: "not-a-request", text: why } },
  });
}

/** Whether a pushed event's text is a write of one snapshot, which makes the same sub's earlier such events needless. */
function whole(event: string): boolean {
  try {
    const e = JSON.parse(event);
    const patches = e?.change?.patches;
    return e.reaches === undefined && e.change?.kind === "write" && Array.isArray(patches) &&
      patches.length === 1 && patches[0]?.type === "snapshot";
  } catch {
    return false;
  }
}

/** Answers one mounter's lines through the host, and pushes its events, until it goes; gives its state. */
function relaying(
  host: Lines,
  conn: Conn,
  served: readonly string[],
  options: RelayOptions,
): () => Behind {
  /** this mounter's sub numbers, to the host's */
  const subs = new Map<number, number>();
  let next = 1;

  // events wait here, at most 1/rate seconds, or while the link is behind
  const gap = 1000 / (options.rate ?? 60), limit = options.limit ?? 262144;
  const hold = options.hold ?? 10000;
  const held: { n: number; text: string; whole: boolean }[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined, last = 0, coalesced = 0;
  let late = false, said = 0;
  const state = (): Behind => ({
    peer: conn.peer,
    behind: late,
    held: held.length,
    coalesced,
    backlog: conn.wire.backlog(),
  });
  const tell = (now: boolean) => {
    if (now === late && (!now || Date.now() - said < 5000)) return;
    late = now;
    said = Date.now();
    if (options.behind) return options.behind(state());
    const s = state();
    console.error(
      now
        ? `relay: the link to ${conn.peer.slice(0, 16)} is behind: ${
          Math.round(s.backlog.bytes / 1024)
        } kB waiting ${s.backlog.oldest} ms, ${s.held} events held, ${s.coalesced} replaced so far`
        : `relay: the link to ${conn.peer.slice(0, 16)} caught up`,
    );
  };
  const flush = () => {
    timer = undefined;
    if (conn.over) return void (held.length = 0);
    if (conn.wire.backlog().bytes > limit) {
      tell(true);
      timer = setTimeout(flush, gap);
      return;
    }
    tell(false);
    last = Date.now();
    for (const h of held.splice(0)) {
      conn.send(`{"text":${JSON.stringify(`{"sub":${h.n},"event":${h.text}}`)}}`);
    }
  };
  const push = (n: number, text: string) => {
    const w = whole(text);
    if (w) {
      // the same sub's snapshots still waiting, back to its last other event, are needless now
      for (let i = held.length - 1; i >= 0; i--) {
        if (held[i].n !== n) continue;
        if (!held[i].whole) break;
        held.splice(i, 1);
        coalesced++;
      }
    }
    held.push({ n, text, whole: w });
    if (held.length > hold) {
      held.length = 0;
      const why = `more than ${hold} events waiting for the link`;
      console.error(`relay: ending the mount of ${conn.peer.slice(0, 16)}: ${why}`);
      return conn.close(why);
    }
    if (timer === undefined) timer = setTimeout(flush, Math.max(0, last + gap - Date.now()));
  };

  /**
   * The answer line to a request line. Sends it to the host before it
   * awaits, so lines keep their order. Only a request it knows reaches the
   * host, and only as written here again, one line: the mounter's text never
   * does, so a newline in it cannot be a second request, at another place.
   */
  function answer(text: string): Promise<string> {
    let r: { [key: string]: unknown };
    try {
      const parsed = JSON.parse(text);
      if (!isObject(parsed)) {
        return Promise.resolve(notARequest(text, "a request is one JSON object"));
      }
      r = parsed as { [key: string]: unknown };
    } catch (e) {
      return Promise.resolve(notARequest(text, String(e)));
    }
    const seq = Object.hasOwn(r, "seq") ? r.seq : null;
    const cmd = r.cmd;
    const refused = (e: { toJSON(): unknown }) =>
      Promise.resolve(JSON.stringify({ seq, error: e.toJSON() }));
    if (cmd === undefined) {
      return refused(invalid("missing", "cmd is missing", { field: "cmd" }));
    }
    if (typeof cmd !== "string") {
      return refused(invalid("wrong-field", "a request's cmd is a string", { field: "cmd" }));
    }
    if (UNSUPPORTED.has(cmd)) return Promise.resolve(JSON.stringify({ seq, unsupported: cmd }));
    if (!OPERATIONS.has(cmd) && cmd !== "subscribe" && cmd !== "unsubscribe") {
      return refused(
        invalid("unknown-command", `there is no command ${JSON.stringify(cmd)}`, { cmd }),
      );
    }
    if (Object.hasOwn(r, "process")) {
      return Promise.resolve(
        error(seq, "wrong-field", "process", "a mounter acts as no process of the owner's", cmd),
      );
    }
    const below = r.place ?? [];
    if (!Array.isArray(below) || !below.every((n) => typeof n === "string")) {
      return Promise.resolve(error(seq, "wrong-field", "place", "a place is a list of names", cmd));
    }
    const hidden = r.chroot ?? 0;
    if (
      typeof hidden !== "number" || !Number.isInteger(hidden) || hidden < 0 || hidden > below.length
    ) {
      return Promise.resolve(
        error(seq, "wrong-field", "chroot", "a chroot is a count of the place's names", cmd),
      );
    }
    // chrooted at what is served: the host adds its own place in front, and its length to the chroot
    const out: { [key: string]: unknown } = {
      ...r,
      place: [...served, ...below],
      chroot: served.length + hidden,
      agent: stamped(r.agent, conn.peer),
    };
    delete out.time;
    if (cmd === "unsubscribe") {
      const n = r.sub;
      const k = typeof n === "number" ? subs.get(n) : undefined;
      if (k === undefined) {
        return Promise.resolve(
          error(seq, "wrong-field", "sub", `there is no subscription ${JSON.stringify(n)}`, cmd),
        );
      }
      out.sub = k;
      return host.line(JSON.stringify(out)).then((a) => {
        if (Object.hasOwn(JSON.parse(a), "ok")) {
          subs.delete(n as number);
          host.deaf(k);
        }
        return a;
      });
    }
    if (cmd === "subscribe") {
      return host.line(JSON.stringify(out)).then((a) => {
        const parsed = JSON.parse(a);
        const k = parsed.ok?.sub;
        if (typeof k !== "number") return a;
        if (conn.over) {
          // the mounter went while the host subscribed: no one will unsubscribe it but here
          forget(k);
          return a;
        }
        const n = next++;
        subs.set(n, k);
        host.listen(k, (event) => push(n, event));
        return JSON.stringify({ seq: parsed.seq, ok: { sub: n } });
      });
    }
    return host.line(JSON.stringify(out));
  }

  /** Unsubscribes the host's sub, its events kept nowhere: those it pushed before its answer go too. */
  function forget(k: number) {
    host.deaf(k);
    host.request("unsubscribe", { sub: k }).catch(() => {}).finally(() => host.deaf(k));
  }

  conn.onmessage = ({ id, text }) => {
    if (id === undefined) return;
    answer(text).then((a) => conn.send(`{"id":${id},"text":${JSON.stringify(a)}}`));
  };
  conn.closed.then(() => {
    clearTimeout(timer);
    held.length = 0;
    for (const k of subs.values()) forget(k);
    subs.clear();
  });
  return state;
}
