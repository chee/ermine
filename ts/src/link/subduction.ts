// A link's transport over Subduction's ephemeral messages
// (plans/link.org): a channel is a Subduction topic, its 32 bytes; this peer
// connects to a Subduction server over a WebSocket, subscribes to the topic,
// and publishes each payload there. Each message is signed by this peer's
// key, so its sender is verified, and the server fans it out to every other
// subscriber, never back to the sender. Delivery is best effort and in any
// order; a payload over 64 KiB is dropped; a message older than 30 seconds by
// the receiver's clock is dropped. Payloads are paced (wire.ts, paced), and
// a burst is followed by a tiny payload, so none waits in Deno's WebSocket
// for its next write (plans/throughput.org).
//
// The same module runs in the browser: the npm package's "browser" export is
// the bundler's build, and its plain "import" one loads the wasm itself.

// deno-lint-ignore no-import-prefix
import { MemorySigner, MemoryStorage, Subduction, Topic } from "npm:@automerge/subduction@0.23.0";
import { ours } from "../types.ts";
import { type Pace, paced, topic, type Transport } from "./wire.ts";

ours(import.meta.url);

/** chee's Subduction server. */
export const GALAXY = "wss://galaxy.observer";

export type SubductionOptions = {
  /** the server's WebSocket URL; galaxy.observer if left out */
  url?: string;
  /** the server's service name, for its handshake; the URL's host if left out */
  service?: string;
  /**
   * how payloads are sent (wire.ts, paced): at most 64 kB at once, then 256
   * kB a second, and a tiny payload after a burst, since Deno's WebSocket
   * holds what did not fit the socket's buffer until it next writes
   * (plans/throughput.org); false sends each at once
   */
  pace?: Pace | false;
};

/** Joins the channel on a Subduction server, as a new peer with a key of its own. */
export async function subduction(
  channel: string,
  options: SubductionOptions = {},
): Promise<Transport> {
  const bytes = topic(channel);
  const signer = MemorySigner.generate();
  const self = String(signer.peerId());
  let handler: (payload: Uint8Array, from: string) => void = () => {};
  const node = new Subduction({
    signer,
    storage: new MemoryStorage(),
    onEphemeral: (t: { toBytes(): Uint8Array }, sender: unknown, payload: Uint8Array) => {
      if (same(t.toBytes(), bytes)) handler(payload, String(sender));
    },
  });
  await node.connectDiscover(new URL(options.url ?? GALAXY), options.service);
  // publishing reaches the server only for a topic this peer subscribes to
  await node.subscribeEphemeral([Topic.fromBytes(bytes)]);
  const plain: Transport = {
    self,
    // Subduction's limit is 65536 bytes of payload; this leaves room
    max: 60000,
    send: (payload) => node.publishEphemeral(Topic.fromBytes(bytes), payload),
    receive: (h) => (handler = h),
    close: async () => {
      handler = () => {};
      try {
        await node.unsubscribeEphemeral([Topic.fromBytes(bytes)]);
        await node.disconnectAll();
      } catch { /* already gone */ }
    },
  };
  return options.pace === false ? plain : paced(plain, options.pace);
}

function same(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
