// The link over Subduction's ephemeral messages, through wss://galaxy.observer,
// between two peers in this process. Skipped unless ERMINE_LIVE=1, since it
// needs the network and chee's server:
//
//   ERMINE_LIVE=1 deno test --allow-read --allow-env --allow-net test/link_live_test.ts

import { assert, assertEquals, assertRejects } from "@std/assert";
import { graph } from "../src/graph.ts";
import { type Event, Invalid } from "../src/types.ts";
import { stacks } from "../harness/main.ts";
import { channel } from "../src/link/wire.ts";
import { serve } from "../src/link/serve.ts";
import { mount } from "../src/link/mount.ts";

const live = (() => {
  try {
    return Deno.env.get("ERMINE_LIVE") === "1";
  } catch {
    return false;
  }
})();
const site = { file: "link_live_test.ts", line: 1, column: 1 };
const owner = { agent: "owner", cause: site };
const me = { agent: "mounter" };

Deno.test({
  name:
    "a link through galaxy.observer: mount, read, write, subscribe, place, an error, the chroot",
  ignore: !live,
  // the wasm keeps its WebSocket and timers of its own
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const api = stacks.schedule!(graph("root"), { root: "root" });
    api.place({ ...owner, address: [], name: "a", id: "a", value: null });
    api.place({ ...owner, address: ["a"], name: "secret", id: "secret", value: "hidden" });
    api.place({ ...owner, address: ["a"], name: "shared", id: "shared", value: { title: "hi" } });
    api.place({ ...owner, address: ["a", "shared"], name: "x", id: "x", value: 1 });

    // loaded only when live: the wasm is read at import
    const { subduction } = await import("../src/link/subduction.ts");
    const name = channel();
    const t0 = performance.now();
    const served = serve(api, ["a", "shared"], await subduction(name));
    const mounter = await subduction(name);
    const remote = await mount(mounter);
    const ms = () => Math.round(performance.now() - t0);
    console.log(`mounted ${name.slice(0, 8)}… owner ${remote.owner.slice(0, 8)}… at ${ms()} ms`);
    try {
      assertEquals((await remote.read({ ...me, address: ["x"] }))[0].value, 1);
      console.log(`read at ${ms()} ms`);

      const events: Event[] = [];
      await remote.subscribe({ ...me, address: ["x"], send: (e) => events.push(e) });
      const changed = await remote.write({
        ...me,
        address: ["x"],
        patches: [{ type: "snapshot", value: 2 }],
      });
      assertEquals(changed.change.time, 5);
      assertEquals(api.read({ agent: "owner", address: ["a", "shared", "x"] })[0].value, 2);
      api.write({
        ...owner,
        address: ["a", "shared", "x"],
        patches: [{ type: "snapshot", value: 3 }],
      });
      for (let i = 0; i < 100 && events.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assertEquals(events.map((e) => "change" in e && e.change.agent), [
        { actor: "mounter", peer: mounter.self },
        "owner",
      ]);
      console.log(`write and two events at ${ms()} ms`);

      await remote.place({ ...me, address: [], name: "y", id: "y", value: "x".repeat(150000) });
      assertEquals((await remote.read({ ...me, address: ["y"] }))[0].value, "x".repeat(150000));
      console.log(`150 kB placed and read back, in pieces, at ${ms()} ms`);

      const e = await assertRejects(() => remote.read({ ...me, address: [".."] }), Invalid);
      assertEquals((e as Invalid).why.code, "above-root");
      assertEquals(await remote.lookup({ ...me, name: "secret" }), []);

      // twenty at once, which Subduction delivers in any order
      const many = await Promise.all(
        Array.from(
          { length: 20 },
          (_, i) =>
            remote.write({ ...me, address: ["x"], patches: [{ type: "snapshot", value: i }] }),
        ),
      );
      assertEquals(many.map((c) => c.change.time), Array.from({ length: 20 }, (_, i) => 8 + i));
      console.log(`twenty writes in order at ${ms()} ms`);
    } finally {
      await served.close("the test is over");
      const why = await remote.closed;
      assert(why.includes("the test is over"), why);
      await remote.close();
    }
  },
});

Deno.test({
  name: "a 200 kB burst arrives promptly through galaxy.observer, paced and nudged",
  ignore: !live,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // fresh connections, where Deno's WebSocket held such a burst's tail ~30 s (plans/throughput.org)
    const { subduction } = await import("../src/link/subduction.ts");
    const name = channel();
    const sender = await subduction(name);
    const receiver = await subduction(name);
    const got = new Map<number, number>();
    const size = 16000, count = 13; // 208 000 bytes
    let began = 0;
    receiver.receive((payload) => {
      if (payload.length === size) got.set(payload[0], performance.now() - began);
    });
    try {
      // a moment for the server to have the receiver's subscription
      await new Promise((r) => setTimeout(r, 500));
      began = performance.now();
      await Promise.all(Array.from({ length: count }, (_, i) => {
        const bytes = new Uint8Array(size);
        crypto.getRandomValues(bytes.subarray(1));
        bytes[0] = i;
        return sender.send(bytes);
      }));
      const sent = performance.now() - began;
      for (let i = 0; i < 200 && got.size < count; i++) await new Promise((r) => setTimeout(r, 50));
      const last = Math.max(...got.values());
      const missing = Array.from({ length: count }, (_, i) => i).filter((i) => !got.has(i));
      console.log(
        `arrived (ms): ${
          [...got].sort((a, b) => a[0] - b[0]).map(([i, t]) => `${i}@${Math.round(t)}`).join(" ")
        }${missing.length ? `; missing ${missing.join(" ")}` : ""}`,
      );
      console.log(
        `${got.size} of ${count} x ${size} B: all handed on by ${
          Math.round(sent)
        } ms, the last arrived at ${Math.round(last)} ms`,
      );
      assertEquals(got.size, count);
      assert(last < 5000, `the last came at ${Math.round(last)} ms`);
    } finally {
      await sender.close();
      await receiver.close();
    }
  },
});
