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

Deno.test("events needs no agent, and its errors name no op", () => {
  const [, , noAgent, nothing, acting, wrong] = answers(
    reset,
    { cmd: "subscribe", agent: "host", address: [] },
    { cmd: "events", sub: 1 },
    { cmd: "events" },
    { cmd: "events", agent: null, sub: 1, process: "p", place: ["a"], chroot: 1 },
    { cmd: "events", sub: "1" },
  );
  assertEquals(noAgent, { ok: [] });
  assertEquals(acting, { ok: [] });
  for (
    const [answer, code, field] of [
      [nothing, "missing", "sub"],
      [wrong, "wrong-field", "sub"],
    ]
  ) {
    const { text: _, ...why } = answer.error.why;
    assertEquals({ kind: answer.error.kind, why }, { kind: "invalid", why: { code, field } });
    assertEquals("op" in answer.error, false);
  }
});

Deno.test("a request before the first reset is missing reset, after its cmd is checked", () => {
  const [read, events, unknown, noCmd, , after] = answers(
    { cmd: "read", agent: "host", address: [] },
    { cmd: "events", sub: 1 },
    { cmd: "nope" },
    { agent: "host" },
    reset,
    { cmd: "read", agent: "host", address: [] },
  );
  for (const answer of [read, events]) {
    const { text: _, ...why } = answer.error.why;
    assertEquals([answer.error.kind, why], ["invalid", { code: "missing", field: "reset" }]);
  }
  assertEquals(read.error.op, "read");
  assertEquals("op" in events.error, false);
  assertEquals(unknown.error.why.code, "unknown-command");
  assertEquals([noCmd.error.why.code, noCmd.error.why.field], ["missing", "cmd"]);
  assertEquals(after.ok.items.length, 1);
});

Deno.test("subscriptions are numbered from 1 in each session; after unsubscribe, events hands over what arrived once", () => {
  const at = { agent: "host", cause: 0 };
  const [, one, two, , , events1, , gone, again, never, , fresh] = answers(
    reset,
    { cmd: "subscribe", agent: "host", address: [] },
    { cmd: "subscribe", agent: "host", address: ["a"] },
    { cmd: "place", ...at, time: 1, address: [], name: "a", id: "a", value: 1 },
    { cmd: "unsubscribe", agent: "host", sub: 1 },
    { cmd: "events", sub: 1 },
    { cmd: "write", ...at, time: 2, address: [], patches: [] },
    { cmd: "events", sub: 1 },
    { cmd: "unsubscribe", agent: "host", sub: 1 },
    { cmd: "events", sub: 3 },
    reset,
    { cmd: "subscribe", agent: "host", address: [] },
  );
  assertEquals([one.ok.sub, two.ok.sub, fresh.ok.sub], [1, 2, 1]);
  assertEquals(events1.ok.map((e: { change: { time: number } }) => e.change.time), [1]);
  for (const answer of [gone, again, never]) assertEquals(answer.error.why.code, "wrong-field");
  assertEquals(again.error.op, "unsubscribe");
  const [, , , , written, empty, after] = answers(
    reset,
    { cmd: "subscribe", agent: "host", address: [] },
    { cmd: "events", sub: 1 },
    { cmd: "unsubscribe", agent: "host", sub: 1 },
    { cmd: "write", ...at, time: 1, address: [], patches: [] },
    { cmd: "events", sub: 1 },
    { cmd: "events", sub: 1 },
  );
  // what arrived after unsubscribe is not handed over
  assertEquals(written.ok.change.time, 1);
  assertEquals(empty, { ok: [] });
  assertEquals(after.error.why.code, "wrong-field");
});

Deno.test("a line that is not one JSON object is not-a-request, under the seq a parser reaches first", () => {
  const harness = new Harness();
  const seq = (line: string | Uint8Array) => {
    const answer = JSON.parse(harness.line(line));
    assertEquals(answer.error, { kind: "invalid", why: answer.error.why });
    assertEquals(answer.error.why.code, "not-a-request");
    return answer.seq;
  };
  const cases: [string, number | null][] = [
    ['{"seq": 4, "cmd": "read", oops', 4],
    ['{"seq":7}{"seq":8}', 7],
    ['{"seq": 12x', 12],
    ['{"seq": 5', 5],
    ['{"seq": 1e1, "x": [1, {"a": [true, null, "s\\"]}], ', 10],
    ['{"cmd": "read", "seq": 3} trailing', 3],
    ['{"a": {"seq": 9}, "seq": 2, x', 2],
    ['{"a": [[[[1]]]], "s\\u0065q": 6 x', 6],
    ['{"cmd": oops, "seq": 1}', null],
    ['{"seq": 1.', null],
    ['{"seq": -1, x', null],
    ['{"seq": 1.5, x', null],
    ['{"seq": "1", x', null],
    ['[{"seq": 1}]', null],
    ["5", null],
    ["", null],
    ["not json", null],
    ['{"x": "a\tb", "seq": 1', null],
  ];
  for (const [line, expected] of cases) assertEquals(seq(line), expected, line);
  // a line is JSON up to its first byte that is not UTF-8
  const bytes = (...parts: (string | number[])[]) =>
    new Uint8Array(
      parts.flatMap((p) => typeof p === "string" ? [...new TextEncoder().encode(p)] : p),
    );
  assertEquals(seq(bytes('{"seq": 3, "cmd": "', [0xff], '"}')), 3);
  assertEquals(seq(bytes('{"cmd": "', [0xc3], '", "seq": 3}')), null);
  assertEquals(seq(bytes('{"seq": 3', [0xed, 0xa0, 0x80], "}")), 3);
  const fine = JSON.parse(
    harness.line(bytes('{"seq": 5, "cmd": "nope", "x": "\u00e9', [0xc3, 0xa9], '"}')),
  );
  assertEquals([fine.seq, fine.error.why.code], [5, "unknown-command"]);
});

Deno.test("a line that starts with a byte order mark is not one JSON object, under null, the first line as any other", () => {
  // U+FEFF is not JSON whitespace, so the line stops being JSON at its first byte
  const harness = new Harness();
  const bom = [0xef, 0xbb, 0xbf];
  const line = (request: object, before: number[] = []) =>
    JSON.parse(
      harness.line(
        new Uint8Array([...before, ...new TextEncoder().encode(JSON.stringify(request))]),
      ),
    );
  const notARequest = (answer: { seq: unknown; error: { kind: string; why: { code: string } } }) =>
    assertEquals(
      [answer.seq, answer.error.kind, answer.error.why.code],
      [null, "invalid", "not-a-request"],
    );
  // the first line of all, as bytes and as text: neither reset starts a session
  notARequest(line({ seq: 1, ...reset }, bom));
  notARequest(JSON.parse(harness.line("\ufeff" + JSON.stringify({ seq: 2, ...reset }))));
  const before = line({ seq: 3, cmd: "read", agent: "host", address: [] });
  const { text: _, ...why } = before.error.why;
  assertEquals([before.seq, why], [3, { code: "missing", field: "reset" }]);
  assertEquals(line({ seq: 4, ...reset }), { seq: 4, ok: null });
  // a later line: nothing is placed
  const place = {
    seq: 5,
    cmd: "place",
    agent: "host",
    cause: 0,
    time: 1,
    address: [],
    name: "a",
    id: "a",
    value: "\ufeff",
  };
  notARequest(line(place, bom));
  assertEquals(line({ seq: 6, cmd: "read", agent: "host", address: ["a"] }), {
    seq: 6,
    ok: { items: [] },
  });
  // inside a line it is a character like any other
  assertEquals(line(place).ok.change.value, "\ufeff");
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

Deno.test("an answer is written as JSON.stringify writes it, but for values JSON has no word for", () => {
  let list: Json = 1;
  for (let i = 0; i < 100_000; i++) list = Object.freeze([list]);
  assertEquals(encode(list), "[".repeat(100_000) + "1" + "]".repeat(100_000));
  const shared = { a: 1 };
  const plain = {
    s: 'a"\\\n 😀\ud800',
    n: [0, 1.5, 1e21, -2e-7],
    o: { u: undefined, f: () => 1, k: Symbol("k"), x: [undefined, () => 1, null] },
    shared: [shared, shared],
    error: invalid("time", "time 1 is not after 2", { last: 2 }),
    ["__proto__"]: [true, false],
  };
  assertEquals(encode(plain), JSON.stringify(plain));
  // numbers JSON cannot write, -0, buffers, and a map whose only key is "/"
  assertEquals(
    encode([-0, NaN, Infinity, -Infinity, { "/": 1 }]),
    '[-0,{"/":{"number":"NaN"}},{"/":{"number":"Infinity"}},{"/":{"number":"-Infinity"}},' +
      '{"/":{"map":{"/":1}}}]',
  );
  assertEquals(
    encode([new Uint8Array([104, 105]).buffer, new Float32Array([0.1, -0, NaN])]),
    '[{"/":{"bytes":"aGk"}},{"/":{"float32":[0.1,-0,"NaN"]}}]',
  );
  assertEquals(
    encode(new BigInt64Array([-(2n ** 63n)])),
    '{"/":{"int64":["-9223372036854775808"]}}',
  );
  const holds: { self?: unknown } = {};
  holds.self = holds;
  assertThrows(() => encode(holds), TypeError);
});

Deno.test("with schedule, the session numbers subscriptions from 1, whatever the scheduler holds", () => {
  const cause = { file: "t", line: 1, column: 1 };
  const [, , , , , , subscribed, events] = answers(
    { cmd: "reset", stack: "schedule", root: "root" },
    {
      cmd: "place",
      agent: "host",
      address: [],
      name: "loaders",
      id: "loaders",
      value: null,
      cause,
    },
    {
      cmd: "place",
      agent: "host",
      address: ["loaders"],
      name: "steps",
      id: "steps",
      value: { loader: "steps" },
      cause,
    },
    {
      cmd: "place",
      agent: "host",
      address: [],
      name: "programs",
      id: "programs",
      value: null,
      cause,
    },
    {
      cmd: "place",
      agent: "host",
      address: ["programs"],
      name: "p",
      id: "p",
      value: { kind: "steps", compute: [{ do: "return", value: 1 }] },
      cause,
    },
    { cmd: "start", agent: "host", address: [], program: ["programs", "p"], cause },
    { cmd: "subscribe", agent: "host", address: ["@6-jabab"] },
    { cmd: "events", sub: 1 },
  );
  assertEquals(subscribed, { ok: { sub: 1 } });
  assertEquals(events, { ok: [] });
});

Deno.test("start, batch and fire are the scheduler's: unsupported below it", () => {
  const [, start, batch, fire] = answers(
    reset,
    { cmd: "start", agent: "host", address: [], program: ["p"] },
    { cmd: "batch", agent: "host", requests: [] },
    { cmd: "fire", agent: "host", process: "p", handler: "h" },
  );
  assertEquals([start, batch, fire], [
    { unsupported: "start" },
    { unsupported: "batch" },
    { unsupported: "fire" },
  ]);
});
