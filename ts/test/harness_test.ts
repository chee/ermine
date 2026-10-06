import { assertEquals, assertThrows } from "@std/assert";
import { encode, Harness } from "../harness/main.ts";
import { invalid, type Json } from "../src/types.ts";

/** The answers a fresh harness gives to these requests, each without its seq. */
function answers(...requests: object[]) {
  const harness = new Harness();
  return requests.map((request) => {
    const { seq: _, ...answer } = JSON.parse(harness.line(JSON.stringify(request)));
    return answer;
  });
}

const reset = { cmd: "reset", stack: "graph", root: "root" };

Deno.test("errors answering events or reset name no op: neither is an operation", () => {
  const [before, , missing, unknown, noStack, noRoot, badStack, badRoot] = answers(
    { cmd: "events", agent: "host", sub: 1 },
    reset,
    { cmd: "events", agent: "host" },
    { cmd: "events", agent: "host", sub: 1 },
    { cmd: "reset", root: "root" },
    { cmd: "reset", stack: "graph" },
    { cmd: "reset", stack: "nope", root: "root" },
    { cmd: "reset", stack: "graph", root: 5 },
  );
  assertEquals(before.error.kind, "invalid");
  assertEquals("op" in before.error, false);
  for (
    const [answer, code, field] of [
      [missing, "missing", "sub"],
      [unknown, "wrong-field", "sub"],
      [noStack, "missing", "stack"],
      [noRoot, "missing", "root"],
      [badStack, "wrong-field", "stack"],
      [badRoot, "wrong-field", "root"],
    ]
  ) {
    const { text: _, ...why } = answer.error.why;
    assertEquals({ kind: answer.error.kind, why }, { kind: "invalid", why: { code, field } });
    assertEquals("op" in answer.error, false);
  }
});

Deno.test("errors answering an operation name it in op, subscribe and unsubscribe included", () => {
  const [, subscribe, unsubscribe, write] = answers(
    reset,
    { cmd: "subscribe", agent: "host" },
    { cmd: "unsubscribe", agent: "host", sub: 99 },
    { cmd: "write", agent: "host", time: 1, address: [], patches: [] },
  );
  assertEquals(subscribe.error.op, "subscribe");
  assertEquals(subscribe.error.why.code, "missing");
  assertEquals(unsubscribe.error.op, "unsubscribe");
  assertEquals(unsubscribe.error.why.code, "wrong-field");
  assertEquals(write.error.op, "write");
  assertEquals(write.error.why, { code: "missing", field: "cause", text: write.error.why.text });
});

Deno.test("requests the protocol does not have, or that are not requests, name no op", () => {
  const [unknown, noCmd] = answers({ cmd: "nope" }, {});
  assertEquals(unknown.error.why.code, "unknown-command");
  assertEquals("op" in unknown.error, false);
  assertEquals(noCmd.error.why.code, "missing");
  assertEquals("op" in noCmd.error, false);
  const harness = new Harness();
  const notOne = JSON.parse(harness.line("[1]"));
  assertEquals(notOne.seq, null);
  assertEquals(notOne.error.why.code, "not-a-request");
  assertEquals("op" in notOne.error, false);
});

Deno.test("events says who asks, as every request but reset does, before its sub; its errors name no op", () => {
  const [, , noAgent, nothing, notAnId, noId, notAPlace, asked] = answers(
    reset,
    { cmd: "subscribe", agent: "host", address: [] },
    { cmd: "events", sub: 1 },
    { cmd: "events" },
    { cmd: "events", agent: "host", sub: 1, process: 5 },
    { cmd: "events", agent: "host", sub: 1, process: null },
    { cmd: "events", agent: "host", sub: 1, place: "a" },
    { cmd: "events", agent: null, sub: 1, process: "p", place: ["a"], chroot: 1 },
  );
  for (
    const [answer, code, field] of [
      [noAgent, "missing", "agent"],
      [nothing, "missing", "agent"],
      [notAnId, "wrong-field", "process"],
      [noId, "wrong-field", "process"],
      [notAPlace, "wrong-field", "place"],
    ]
  ) {
    const { text: _, ...why } = answer.error.why;
    assertEquals({ kind: answer.error.kind, why }, { kind: "invalid", why: { code, field } });
    assertEquals("op" in answer.error, false);
  }
  assertEquals(asked, { ok: [] });
});

Deno.test("a value nests as deep as it likes: placed, written, read and sent back whole", () => {
  const depth = 100_000;
  const deep = (inner: string) => "[".repeat(depth) + inner + "]".repeat(depth);
  const harness = new Harness();
  const at = `"agent":"host","cause":0`;
  const [, , placed, written, read, events, cause] = [
    JSON.stringify({ seq: 1, ...reset }),
    `{"seq":2,"cmd":"subscribe","agent":"host","address":["e"]}`,
    `{"seq":3,"cmd":"place",${at},"time":1,"address":[],"name":"e","id":"e","value":${deep("1")}}`,
    `{"seq":4,"cmd":"write",${at},"time":2,"address":["e"],"patches":[{"type":"splice",` +
    `"path":${JSON.stringify(Array(depth - 1).fill(0))},"range":[0,0],"value":[7]}]}`,
    `{"seq":5,"cmd":"read","agent":"host","address":["e"]}`,
    `{"seq":6,"cmd":"events","agent":"host","sub":1}`,
    `{"seq":7,"cmd":"place","agent":${deep("2")},"cause":${deep("3")},"time":3,` +
    `"address":[],"name":"f","id":"f","value":null}`,
  ].map((line) => JSON.parse(harness.line(line)));
  assertEquals(JSON.stringify(placed.ok.change.value), deep("1"));
  assertEquals(written.ok.change.patches[0].path.length, depth - 1);
  assertEquals(read.ok.items.length, 1);
  assertEquals(JSON.stringify(read.ok.items[0].value), deep("7,1"));
  assertEquals(events.ok.map((e: { change: { time: number } }) => e.change.time), [1, 2]);
  assertEquals(JSON.stringify(cause.ok.change.agent), deep("2"));
  assertEquals(JSON.stringify(cause.ok.change.cause), deep("3"));
});

Deno.test("an answer is written as JSON.stringify writes it, frozen lists however deep included", () => {
  let list: Json = 1;
  for (let i = 0; i < 100_000; i++) list = Object.freeze([list]);
  assertEquals(encode(list), "[".repeat(100_000) + "1" + "]".repeat(100_000));
  const shared = { a: 1 };
  const plain = {
    s: 'a"\\\n 😀\ud800',
    n: [0, -0, 1.5, 1e21, -2e-7, NaN, Infinity],
    o: { u: undefined, f: () => 1, k: Symbol("k"), x: [undefined, () => 1, null] },
    shared: [shared, shared],
    error: invalid("time", "time 1 is not after 2", { last: 2 }),
    ["__proto__"]: [true, false],
  };
  assertEquals(encode(plain), JSON.stringify(plain));
  const holds: { self?: unknown } = {};
  holds.self = holds;
  assertThrows(() => encode(holds), TypeError);
});
