// A link for a host that speaks PROTOCOL.tex lines itself, on a pipe, as the
// C terminal does: each line is sent to the owner as it is and its answer
// given back as it came, except events, answered here from what the owner
// pushed, as the harness collects them. A line after the link is gone is
// answered with an error of code gone. The Deno command line that puts this
// on stdin and stdout is deno/link.ts.

import { ours } from "../types.ts";
import type { Remote } from "./mount.ts";

ours(import.meta.url);

/** The most events kept for subs whose subscribe's answer has not been read yet. */
const EARLY = 4096;

/** A subscription's events as their texts, and whether it is still open. */
type Queue = { events: string[]; open: boolean };

/**
 * Answers lines through a remote, in order: each line is sent as it is and
 * its answer given back, except events, answered here from what was pushed.
 * Gives one answer line for each request line.
 */
export function bridge(remote: Remote): { line: (text: string) => Promise<string> } {
  const queues = new Map<number, Queue>();
  let gone: string | undefined;
  remote.closed.then((why) => (gone = why));
  const error = (seq: unknown, code: string, text: string, more: object = {}) =>
    JSON.stringify({ seq, error: { kind: "invalid", why: { code, ...more, text } } });

  // the owner writes each pushed line as {"sub":n,"event":e}, so the event's text is kept as it came
  // events of a sub not known here while a subscribe waits for its answer:
  // the answer may be read after them
  const early = new Map<number, string[]>();
  let subscribing = 0, earlyCount = 0;
  remote.onpush = (text) => {
    const m = /^\{"sub":(\d+),"event":/.exec(text);
    if (!m) return;
    const n = Number(m[1]), event = text.slice(m[0].length, -1);
    const queue = queues.get(n);
    if (queue) {
      if (queue.open) queue.events.push(event);
      return;
    }
    if (!subscribing || earlyCount >= EARLY) return;
    early.set(n, [...(early.get(n) ?? []), event]);
    earlyCount++;
  };
  return {
    async line(text) {
      let request: { [key: string]: unknown } | undefined;
      try {
        const r = JSON.parse(text);
        if (typeof r === "object" && r !== null && !Array.isArray(r)) request = r;
      } catch { /* the owner answers it not-a-request */ }
      const seq = request && Object.hasOwn(request, "seq") ? request.seq : null;
      if (request?.cmd === "events") {
        if (!Object.hasOwn(request, "sub")) {
          return error(seq, "missing", "sub is missing", { field: "sub" });
        }
        const n = request.sub;
        const queue = typeof n === "number" ? queues.get(n) : undefined;
        if (!queue) {
          return error(seq, "wrong-field", `there is no subscription ${JSON.stringify(n)}`, {
            field: "sub",
          });
        }
        if (!queue.open) queues.delete(n as number);
        const events = queue.events.splice(0);
        return `{"seq":${JSON.stringify(seq)},"ok":[${events.join(",")}]}`;
      }
      if (gone !== undefined) return error(seq, "gone", `the link is gone: ${gone}`);
      const subscribe = request?.cmd === "subscribe";
      if (subscribe) subscribing++;
      let answer: string;
      try {
        answer = await remote.line(text);
      } catch (e) {
        return error(seq, "gone", String(e instanceof Error ? e.message : e));
      } finally {
        if (subscribe) subscribing--;
      }
      if (request?.cmd === "subscribe" || request?.cmd === "unsubscribe") {
        const a = JSON.parse(answer);
        if (request.cmd === "subscribe" && typeof a.ok?.sub === "number") {
          const events = early.get(a.ok.sub) ?? [];
          early.delete(a.ok.sub);
          earlyCount -= events.length;
          queues.set(a.ok.sub, { events, open: true });
        }
        // with none waiting, what is left was for subs no one here has
        if (!subscribing) {
          early.clear();
          earlyCount = 0;
        }
        if (request.cmd === "unsubscribe" && Object.hasOwn(a, "ok")) {
          const queue = queues.get(request.sub as number);
          if (queue) queue.open = false;
        }
      }
      return answer;
    },
  };
}
