// A host spoken to in PROTOCOL.tex lines, from a program it runs, as the C
// terminal runs an ermine program: each request a line out, each answer a
// line back, in order. A host may also send a subscription's events as they
// happen, unasked, as lines {"sub": n, "event": e} between the answers
// (PROTOCOL Commands, events); those go to whoever listens for that sub. How
// the lines are written and read is the caller's (deno/link.ts uses stdin
// and stdout), so nothing here needs the Deno API.

import { ours } from "../types.ts";

ours(import.meta.url);

/** The host's error answer, thrown. */
export class Answered extends Error {
  constructor(readonly answer: unknown) {
    super(JSON.stringify(answer));
    this.name = "Answered";
  }
}

export type LinesOptions = {
  /** events kept for subs no one listens to (default 1024); past it the oldest go, said in the log */
  early?: number;
};

export class Lines {
  #waiting: ((text: string) => void)[] = [];
  #listening = new Map<number, (event: string) => void>();
  /**
   * pushed events of a sub no one listens to yet: its subscribe's answer is
   * still on its way. Or no one ever will (a sub whose mounter went before it
   * was unsubscribed), so there are at most options.early, all subs together.
   */
  #early = new Map<number, string[]>();
  #earlyCount = 0;
  #warned = 0;
  readonly #most: number;
  #seq = 0;

  /** write: puts one line (no newline) to the host */
  constructor(readonly write: (line: string) => void, options: LinesOptions = {}) {
    this.#most = options.early ?? 1024;
  }

  /** One line the host wrote: an answer, or a pushed event. */
  take(text: string) {
    const m = /^\{"sub":(\d+),"event":/.exec(text);
    if (m) {
      const sub = Number(m[1]), event = text.slice(m[0].length, -1);
      const to = this.#listening.get(sub);
      if (to) return to(event);
      const early = this.#early.get(sub) ?? [];
      this.#early.set(sub, early);
      early.push(event);
      if (++this.#earlyCount > this.#most) this.#forget();
      return;
    }
    this.#waiting.shift()?.(text);
  }

  /** Sends a line, as its text, and gives the answer line's text. */
  line(text: string): Promise<string> {
    return new Promise((resolve) => {
      this.#waiting.push(resolve);
      this.write(text);
    });
  }

  /** One request: its ok, or its answer thrown. */
  async request(cmd: string, fields: { [key: string]: unknown } = {}): Promise<unknown> {
    const answer = JSON.parse(
      await this.line(JSON.stringify({ seq: ++this.#seq, cmd, ...fields })),
    );
    if (Object.hasOwn(answer, "ok")) return answer.ok;
    throw new Answered(answer);
  }

  /** Hands each event the host pushes for its sub to `to`, as the event's JSON text. */
  listen(sub: number, to: (event: string) => void) {
    this.#listening.set(sub, to);
    const early = this.#early.get(sub) ?? [];
    this.#early.delete(sub);
    this.#earlyCount -= early.length;
    for (const event of early) to(event);
  }

  /** Stops listening for the sub. */
  deaf(sub: number) {
    this.#listening.delete(sub);
    this.#earlyCount -= this.#early.get(sub)?.length ?? 0;
    this.#early.delete(sub);
  }

  /** The oldest event kept for a sub no one listens to, dropped. */
  #forget() {
    const [sub, early] = this.#early.entries().next().value!;
    early.shift();
    this.#earlyCount--;
    if (!early.length) this.#early.delete(sub);
    if (Date.now() - this.#warned < 5000) return;
    this.#warned = Date.now();
    console.error(
      `lines: more than ${this.#most} events for subs no one listens to: dropping sub ${sub}'s oldest`,
    );
  }

  /** Subscribes to an address and hands send each event, parsed. */
  async subscribe(
    fields: { [key: string]: unknown },
    send: (event: { [key: string]: unknown }) => void,
  ): Promise<number> {
    const { sub } = await this.request("subscribe", fields) as { sub: number };
    this.listen(sub, (event) => send(JSON.parse(event)));
    return sub;
  }

  /** Every request still waiting is answered with this line: the host is gone. */
  end(text: string) {
    for (const w of this.#waiting.splice(0)) w(text);
  }
}
