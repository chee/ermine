// protect's rules (PROTECT.tex, Rules): the first rule whose given fields all
// equal the operation's wins; a peer rule matches the key an owner stamped on
// a mounter's agent, never what the mounter claimed.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { graph } from "../src/graph.ts";
import { protect, rules } from "../src/protect.ts";
import { Refused } from "../src/types.ts";

const site = { file: "protect_test.ts", line: 1, column: 1 };

/** A graph with notes/doc, behind protect with the rules given. */
function setup(list: Parameters<typeof rules>[0]) {
  const g = graph("root");
  let time = 0;
  g.place({
    agent: "host",
    time: ++time,
    cause: site,
    address: [],
    name: "notes",
    id: "notes",
    value: {},
  });
  g.place({
    agent: "host",
    time: ++time,
    cause: site,
    address: ["notes"],
    name: "doc",
    id: "doc",
    value: "hi",
  });
  const api = protect(g, rules(list));
  const write = (agent: unknown, value: string) =>
    api.write({
      agent: agent as never,
      time: ++time,
      cause: site,
      address: ["notes", "doc"],
      patches: [{ type: "snapshot", value }],
    });
  return { api, write };
}

const mounter = (actor: unknown, peer: string) => ({ actor, peer });

Deno.test("a peer rule matches the key the owner stamped on a mounter's agent", () => {
  const { write } = setup([
    { peer: "aaaa", allow: true },
    { op: "write", node: "doc", allow: false },
  ]);
  write(mounter("anyone", "aaaa"), "from the trusted peer");
  const e = assertThrows(() => write(mounter("chee", "bbbb"), "from another"), Refused);
  assertEquals((e as Refused).why.rule, 1);
  // a local agent has no peer: the peer rule never matches it
  assertThrows(() => write("chee", "local"), Refused);
});

Deno.test("a peer a mounter claims stays inside its actor, and matches no peer rule", () => {
  const { write } = setup([
    { peer: "aaaa", allow: true },
    { op: "write", allow: false },
  ]);
  // the owner stamps {"actor": claimed, "peer": key}: what the mounter put there is the actor's
  assertThrows(() => write(mounter({ peer: "aaaa" }, "bbbb"), "claimed"), Refused);
});

Deno.test("an agent rule matches the claimed actor; peer and agent together need both", () => {
  const { write } = setup([
    { agent: "chee", peer: "aaaa", allow: true },
    { op: "write", allow: false },
  ]);
  write(mounter("chee", "aaaa"), "both");
  assertThrows(() => write(mounter("chee", "bbbb"), "claimed chee, another key"), Refused);
  assertThrows(() => write(mounter("bun", "aaaa"), "the key, as bun"), Refused);
});

Deno.test("a rule that gives a field the operation lacks never matches it", () => {
  const { api } = setup([{ node: "doc", allow: false }, { id: "x", allow: false }]);
  // a lookup has no node; a read has no id
  assertEquals(api.lookup({ agent: "chee", name: "notes" }).length, 1);
  assertThrows(() => api.read({ agent: "chee", address: ["notes", "doc"] }), Refused);
  assert(api.read({ agent: "chee", address: ["notes"] }).length === 1);
});

Deno.test("a process rule matches the last step of a scheduler agent's code", () => {
  const { write } = setup([{ process: "@1-abcde", allow: false }]);
  assertThrows(
    () => write({ actor: "chee", code: [{ process: "@0-aaaaa" }, { process: "@1-abcde" }] }, "x"),
    Refused,
  );
  // the process that started it does not lend its rules
  write({ actor: "chee", code: [{ process: "@1-abcde" }, { process: "@2-fghij" }] }, "y");
});
