// The map: the tree as directory reads give it, from the root down. A slot
// with several ids is a union, its members stacked, the first winning;
// ephemeral nodes are dashed; process nodes carry the items the scheduler
// puts in front of their value. A node reached again (twin) is named, not
// drawn twice.

import type { Id, ProcessItem, SlotItem, ValueItem } from "d2/ermine";
import { isPid } from "./stack.ts";
import { ProcessBadge, short, ui, Value, world as w } from "./view.tsx";

type Seen = Map<Id, string>;

function Node({ path, item, seen, depth }: {
  path: string[];
  item: SlotItem;
  seen: Seen;
  depth: number;
}) {
  const id = item.id;
  const name = path.length ? path[path.length - 1] : "/";
  const again = seen.get(id);
  const sel = ui.selected.value?.node === id;
  const lit = ui.lit.value === id;
  let read: (ValueItem | ProcessItem)[] = [];
  try {
    read = w.s.read({ agent: "host", address: path }) as unknown as (ValueItem | ProcessItem)[];
  } catch { /* gone */ }
  const own = read.filter((i) => !("value" in i)) as ProcessItem[];
  const value =
    (read.find((i) => "value" in i && i.from.route.at(-1)?.node === id) as ValueItem | undefined)
      ?.value;
  const head = (
    <div
      class={`node ${item.ephemeral ? "eph" : ""} ${item.pending ? "pending" : ""} ${
        sel ? "sel" : ""
      } ${lit ? "lit" : ""} ${isPid(name) ? "proc" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        ui.selected.value = { node: id };
        ui.tab.value = "why";
      }}
    >
      <span class="name">{name}</span>
      {id !== name && path.length > 0 && <span class="nid">{short(id)}</span>}
      {item.from && "position" in item.from && item.from.position > 0 && (
        <span class="pos" title="its position in the slot: behind the first">
          #{item.from.position}
        </span>
      )}
      {again ? <span class="again">same node as {again}</span> : <Value value={value} />}
      {own.map((o, i) => <ProcessBadge key={i} item={o} />)}
    </div>
  );
  if (again || depth > 9) return <li>{head}</li>;
  seen.set(id, path.join("/"));
  let names: [string, SlotItem[]][] = [];
  try {
    const got = w.tap.directory({ agent: "host", address: path });
    if ("directory" in got) names = got.directory;
  } catch { /* gone */ }
  // only the first member's directory is walked by a name; show each member's own
  return (
    <li>
      {head}
      {names.length > 0 && (
        <ul>
          {names.map(([n, items]) =>
            items.length > 1
              ? (
                <li key={n} class="union">
                  <span class="union-name">{n} · a union of {items.length}, the first wins</span>
                  <ul>
                    {items.map((it, i) => (
                      <Member key={it.id} path={[...path, n]} item={it} index={i} seen={seen} />
                    ))}
                  </ul>
                </li>
              )
              : <Node key={n} path={[...path, n]} item={items[0]} seen={seen} depth={depth + 1} />
          )}
        </ul>
      )}
    </li>
  );
}

function Member(
  { path, item, index, seen }: { path: string[]; item: SlotItem; index: number; seen: Seen },
) {
  // a member behind the first cannot be reached by a path; its value is read as the union's items
  let value: unknown;
  try {
    const items = w.tap.read({ agent: "host", address: path });
    value = items.find((i) => i.from.route.at(-1)?.node === item.id)?.value;
  } catch { /* gone */ }
  const sel = ui.selected.value?.node === item.id;
  void seen;
  return (
    <li>
      <div
        class={`node member ${index > 0 ? "behind" : "wins"} ${item.ephemeral ? "eph" : ""} ${
          sel ? "sel" : ""
        }`}
        onClick={(e) => {
          e.stopPropagation();
          ui.selected.value = { node: item.id };
        }}
      >
        <span class="name">{index === 0 ? "▲" : "·"} {short(item.id)}</span>
        <Value value={value} />
      </div>
    </li>
  );
}

export function MapPanel(_: { v: number }) {
  void ui.lit.value;
  const seen: Seen = new Map();
  return (
    <div class="map">
      <p class="muted small-note">
        The tree as directory reads give it now. Dashed: ephemeral. A name in several slots, or a
        node placed twice, is the same node.
      </p>
      <ul class="tree">
        <Node
          path={[]}
          item={{ id: w.root, from: { route: [], position: 0 } }}
          seen={seen}
          depth={0}
        />
      </ul>
    </div>
  );
}
