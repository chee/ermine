// A handle's write, as shift's streams: a function updates, a patch is applied, anything else is a snapshot.

import { assertEquals } from "@std/assert";
import { graph } from "../src/graph.ts";
import { protect } from "../src/protect.ts";
import { schedule } from "../src/schedule.ts";
import { isPatch, node } from "../src/dom/mod.ts";

const cause = { file: "handle_test.ts", line: 1, column: 1 };

Deno.test("a handle writes as shift does: updater, patch, or value", () => {
  const g = graph("root");
  const s = schedule(protect(g, () => true), {}, { graph: g });
  s.top(s);
  s.place({ agent: "host", cause, address: [], name: "n", id: "n", value: 1 });
  const n = node(s, "n", { agent: "host", cause } as never);
  n((v: number) => v + 1);
  assertEquals(n(), 2);
  n([1, 2]);
  n({ type: "splice", path: [], range: [1, 1], value: [9] });
  assertEquals(n(), [1, 9, 2]);
  n((v: number[]) => ({ type: "splice", path: [], range: [0, v.indexOf(9)], value: [] }));
  assertEquals(n(), [9, 2]);
  n({ type: "nope" });
  assertEquals(n(), { type: "nope" });
});

Deno.test("isPatch: only shapes that are patches", () => {
  assertEquals(isPatch({ type: "snapshot", value: 1 }), true);
  assertEquals(isPatch({ type: "set", path: [], key: "a" }), true);
  assertEquals(isPatch({ type: "splice", path: [] }), false);
  assertEquals(isPatch([{ type: "snapshot", value: 1 }]), false);
});
