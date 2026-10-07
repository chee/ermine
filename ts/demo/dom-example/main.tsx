/** @jsxRuntime classic */
/** @jsx h */
// ermine/dom in a page: a graph, the reference scheduler, one doubling
// process, and a button bound to count. Clicking anything shows why it says
// what it says: the path, the node, and the change behind it.

import { graph } from "../../src/graph.ts";
import { protect } from "../../src/protect.ts";
import { schedule } from "../../src/schedule.ts";
import { builtin, type Loaded } from "../../src/loaders.ts";
import { h, node, render, why } from "../../src/dom/mod.ts";

const host = { agent: "page" };
const g = graph("root");
const doubled = {
  compute:
    (({ api }) => ((api.read({ address: ["count"] })[0]?.value as number) ?? 0) * 2) as Loaded,
};
const s = schedule(protect(g, () => true), { builtin: builtin({ doubled }) }, { graph: g });
s.top(s);
s.place({ ...host, address: [], name: "loaders", id: "loaders", value: null });
s.place({ ...host, address: ["loaders"], name: "builtin", id: "lb", value: { loader: "builtin" } });
s.place({ ...host, address: [], name: "programs", id: "programs", value: null });
s.place({
  ...host,
  address: ["programs"],
  name: "doubled",
  id: "pd",
  value: { kind: "builtin", compute: "doubled" },
});
s.place({ ...host, address: [], name: "count", id: "count", value: 0 });
const pid =
  (s.start({ ...host, address: [], program: ["programs", "doubled"] }).change as { id: string }).id;

const you = s.bind(s, { agent: "you", writes: true });
const count = node(you, "count");
const twice = node(you, pid);
const said = node(you, "said"); // nothing there: renders nothing

render(
  () => (
    <main>
      <button type="button" onClick={() => count((count() as number) + 1)}>{count}</button>
      <p>twice: {twice}</p>
      <p>{said}</p>
    </main>
  ),
  document.getElementById("app")!,
);

const out = document.getElementById("why")!;
document.addEventListener("click", (e) => {
  const w = why(e.target as Node);
  out.textContent = w
    ? JSON.stringify(
      w.reasons.map((r) => ({ path: r.path, node: r.node, change: r.change, by: r.by })),
      null,
      2,
    )
    : "not made from the graph";
});
