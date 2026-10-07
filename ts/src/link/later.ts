// A transport that is there at once and connects later: what a host hands
// a link when joining the channel takes a while, as Subduction's WebSocket
// does. Sends wait until it is connected, and go then, in order; a handler
// given before is given to it then. If it never connects, what waited is
// dropped, and the link finds nobody on the channel (wire.ts: a mounter's
// dial gives up; an owner hears no hello), so it ends as a quiet one does.

import { ours } from "../types.ts";
import type { Transport } from "./wire.ts";

ours(import.meta.url);

/** How a later transport is doing: joining, joined (as self), or failed (and why). */
export type Joining =
  | { state: "connecting" }
  | { state: "connected"; self: string }
  | { state: "failed"; why: string }
  | { state: "closed" };

export type Later = Transport & {
  /** the transport, once connected; rejects if it could not connect */
  readonly ready: Promise<Transport>;
  /** how it is doing now */
  readonly joining: Joining;
};

/** A transport now, for one that comes when the promise does. max is the payload limit until then. */
export function later(
  coming: Promise<Transport>,
  max = 60000,
  told: (j: Joining) => void = () => {},
): Later {
  let t: Transport | undefined;
  let handler: ((payload: Uint8Array, from: string) => void) | undefined;
  let waiting: Uint8Array[] = [];
  let closed = false;
  let joining: Joining = { state: "connecting" };
  const say = (j: Joining) => {
    joining = j;
    try {
      told(j);
    } catch { /* the listener's trouble */ }
  };
  const ready = coming.then(
    (x) => {
      if (closed) {
        Promise.resolve(x.close()).catch(() => {});
        throw new Error("closed before it connected");
      }
      t = x;
      if (handler) x.receive(handler);
      say({ state: "connected", self: x.self });
      for (const p of waiting.splice(0)) {
        try {
          const r = x.send(p);
          if (r) r.catch(() => {});
        } catch { /* best effort, as the channel is */ }
      }
      return x;
    },
    (e) => {
      waiting = [];
      if (!closed) say({ state: "failed", why: e instanceof Error ? e.message : String(e) });
      throw e;
    },
  );
  ready.catch(() => {});
  return {
    get self() {
      return t?.self ?? "";
    },
    get max() {
      return t?.max ?? max;
    },
    get ready() {
      return ready;
    },
    get joining() {
      return joining;
    },
    send(payload) {
      if (closed) return;
      if (t) return t.send(payload);
      if (joining.state === "connecting") waiting.push(payload);
    },
    receive(h) {
      handler = h;
      t?.receive(h);
    },
    close() {
      if (closed) return;
      closed = true;
      waiting = [];
      if (joining.state !== "failed") say({ state: "closed" });
      return t?.close();
    },
  };
}
