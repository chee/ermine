// runner_test.ts: the deno-js runner against a stand-in OS: a program
// loaded, its setup run, its compute and handler made as SCHEDULER.tex's
// starts and placements, each called back by its id, and a read of the
// blitter's port turned into a Blitter.
//
//   deno test -A experimental_os/deno/runner_test.ts

import { assertEquals } from "@std/assert";
import { decode, encode, type Value } from "../../core/graph/typescript/cbor.ts";

type Map_ = { [k: string]: Value };

const PROGRAM = `
export default ({ api, compute, handler, self, name, data }) => {
  const blit = api.read({ address: ["/", "hw", "devices", "blitter", "port"] })[0].value
  const width = blit.measure("abc")
  compute("status", ({ api }) => ({ wall: api.read({ address: ["/", "dev", "clock", "wall"] })[0]?.value ?? null, width }))
  handler("hello", ({ api }, who) => "hello " + who + " from " + self)
  return { self, name, data: data[0]?.value ?? null }
}
`;

Deno.test("the runner runs a program's parts for the OS", async () => {
  const child = new Deno.Command("deno", {
    args: ["run", "-A", new URL("./runner.ts", import.meta.url).pathname],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const writer = child.stdin.getWriter();
  const reader = child.stdout.getReader();
  let buffered = new Uint8Array(0);
  const read = async (n: number) => {
    while (buffered.length < n) {
      const { value, done } = await reader.read();
      if (done) throw new Error("the runner ended");
      const next = new Uint8Array(buffered.length + value.length);
      next.set(buffered);
      next.set(value, buffered.length);
      buffered = next;
    }
    const out = buffered.slice(0, n);
    buffered = buffered.slice(n);
    return out;
  };
  const recv = async (): Promise<Map_> => {
    const head = await read(4);
    const n = new DataView(head.buffer).getUint32(0, true);
    return decode(await read(n)) as Map_;
  };
  const send = async (m: Map_) => {
    const body = encode(m);
    const frame = new Uint8Array(4 + body.length);
    new DataView(frame.buffer).setUint32(0, body.length, true);
    frame.set(body, 4);
    await writer.write(frame);
  };

  const rom = { w: 8, h: 16, chars: "abc", alpha: new Uint8Array(3 * 8 * 16) };
  /** the stand-in OS's answers to the runner's calls */
  const ops: Map_[] = [];
  const answer = async (m: Map_) => {
    ops.push(m);
    const fields = m.fields as Map_;
    const at = JSON.stringify(fields.address ?? null);
    let ok: Value = null;
    if (m.op === "read" && at === JSON.stringify(["/", "hw", "devices", "blitter", "port"])) ok = { items: [{ value: { live: "blitter" } }] };
    else if (m.op === "read" && at === JSON.stringify(["/", "hw", "font"])) ok = { items: [{ value: rom }] };
    else if (m.op === "read" && at === JSON.stringify(["/", "dev", "clock", "wall"])) ok = { items: [{ value: "12:00" }] };
    else if (m.op === "read") ok = { items: [] };
    else if (m.op === "start") ok = { change: { id: "@2" } };
    else if (m.op === "place") ok = { change: { id: `@1.${ops.length}` } };
    await send({ seq: m.seq, ok });
  };
  /** sends a frame and answers the runner's calls until it answers the frame */
  const run = async (frame: Map_): Promise<Map_> => {
    await send(frame);
    for (;;) {
      const m = await recv();
      if ("op" in m) await answer(m);
      else if (m.seq === frame.seq) return m;
    }
  };

  assertEquals((await run({ seq: 1, pid: "@1", load: "prog", source: PROGRAM })).returned, null);
  const setup = await run({ seq: 2, pid: "@1", call: { code: "prog" }, given: { part: "setup", api: 7, self: "@1", name: "@1", data: { path: ["x"] } } });
  assertEquals(setup.returned, { self: "@1", name: "@1", data: { path: ["x"] } });
  const start = ops.find((m) => m.op === "start")!;
  assertEquals((start.fields as Map_).name, "status");
  assertEquals((start.fields as Map_).address, ["@1"]);
  assertEquals(start.api, 7);
  const computeFn = ((start.fields as Map_).program as Map_).compute as Map_;
  const places = ops.filter((m) => m.op === "place").map((m) => m.fields as Map_);
  assertEquals(places.map((p) => p.name), ["on", "hello"]);
  const handlerFn = places[1].value as Map_;

  const compute = await run({ seq: 3, pid: "@1", call: computeFn.fn, given: { part: "compute", api: 8, self: "@2", name: "status" } });
  assertEquals(compute.returned, { wall: "12:00", width: 24 });
  const hello = await run({ seq: 4, pid: "@1", call: handlerFn.fn, given: { part: "handler", api: 9, args: ["chee"] } });
  assertEquals(hello.returned, "hello chee from @1");
  const missing = await run({ seq: 5, pid: "@1", call: 999, given: {} });
  assertEquals(typeof (missing.threw as Map_).text, "string");

  await writer.close();
  await reader.cancel();
  await child.status;
});
