// The ermine panel: the graph of the inspected page, as the page's own host reads it. Everything
// comes from the agent (page.js) through inspectedWindow.eval, as JSON: a tree from the root you
// fold and search; pick a node and the tree lights up what it reads (blue) and the processes that
// read it (cherry); its detail: where it is placed, its value (a process's status in front) and the
// change that made it, infos, children; a process's status and latest run, with kill and replace;
// a handler's call; a value written. Below, what the scheduler did, in words. The same tree as a
// map of cards, and the scheduler's own shape (computers by rank, the keys they read and write,
// who made whom). Time travel when the host offers it.
//
// A page is seen only when it answers the agent's request (answer.ts); the panel asks again when
// it opens and while the page shows none, so a page that answers late is found.

import { createSignal, For, Show } from "solid-js";
import { render } from "@solidjs/web";
import { call, evaluate, theme } from "./bridge.ts";

// ---- what the agent gives ----

type Shown = [string, string];
type Can = { kill?: boolean; replace?: boolean; call?: boolean; write?: boolean };
type Graph = {
  name: string;
  gen: number;
  kind: string;
  time: number;
  version?: number;
  events: number;
  can: Can & { scheduler?: boolean };
  travel: boolean;
  travelError?: string;
};
type Status = { v: number; version: number; graphs: Graph[] };
type Path = string[];
type Pick = { path: Path; k: number; id: string };
type Row = {
  key: string;
  path: Path;
  k: number;
  id: string;
  name: string;
  depth: number;
  kind: string;
  error?: string;
  refused?: string;
  loaded: boolean;
  value?: Shown;
  status: string;
  run?: number;
  infos: [string, Shown][];
  count: number;
  mount?: string;
  offpath: boolean;
  canOpen: boolean;
  folded: boolean;
  kids: number;
  fresh: boolean;
  hit: boolean;
};
type Detail = {
  path: Path;
  k: number;
  id: string;
  title: string;
  error?: string;
  gone?: boolean;
  refused?: string;
  unloaded?: boolean;
  kind?: string;
  tags?: Shown[];
  status?: { cls: string; text: string };
  can?: Can;
  run?: { run?: number; ended?: string; error?: string; by?: string; byName?: string };
  reads?: { id: string; name: string; parts: string }[];
  readers?: { id: string; name: string; path: Path }[];
  lit?: { reads: string[]; readers: string[] };
  placed?: { path: Path; text: string }[];
  versions?: { text: string; status: boolean; conflict: boolean; gone: boolean; meta: string }[];
  json?: string;
  infos?: { name: string; text: string; meta: string }[];
  children?: { name: string; slot: string; id?: string }[];
};
type Tree = { rows: Row[]; capped: boolean; procs: number; time: number; detail?: Detail };
type Card = Omit<Row, "infos" | "mount" | "offpath" | "kids" | "fresh"> & {
  more: number;
  x: number;
  y: number;
};
type MapModel = {
  cards: Card[];
  links: { from: string; to: string; kind: "child" | "mount" }[];
  reads: { from: string; to: string; reader: string; read: string }[];
  capped: boolean;
  procs: number;
  time: number;
  W: number;
  H: number;
  detail?: Detail;
};
type Box = {
  key: string;
  kind: string;
  label: string;
  sub: string;
  flags: string[];
  place?: string;
  placeName?: string;
  up: string[];
  x: number;
  y: number;
};
type ShapeModel = {
  none?: boolean;
  mode: string;
  counts: string;
  capped: boolean;
  W: number;
  H: number;
  boxes: Box[];
  arrows: { from: string; to: string; kind: string }[];
  about?: string;
};
type Line = { n: number; round: number; when: string; id: string; cls: string; text: string };
type Attempt = { ok?: unknown; error?: string };
type Failed = { gone?: true; error?: string };

const POLL = 250;
const LINES = 400;
const J = (v: unknown) => JSON.stringify(v);
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const failed = (r: unknown): r is Failed =>
  !!r && typeof r === "object" && ("gone" in r || ("error" in r && !("ok" in r)));

// ---- state: what the panel keeps itself, and the signals the view draws from ----

type View = "tree" | "map" | "scheduler";
const ui = {
  graph: undefined as string | undefined,
  gen: 0,
  view: "tree" as View,
  mode: "values",
  open: new Set<string>(),
  folded: new Set<string>(),
  search: "",
  only: false,
  picked: undefined as Pick | undefined,
  box: undefined as string | undefined,
  after: 0,
  seen: -1,
  dirty: true,
  asked: 0,
  paused: false,
};

const [status, setStatus] = createSignal<Status | undefined>();
const [problem, setProblem] = createSignal<string | undefined>();
const [graph, setGraph] = createSignal<string | undefined>();
const [view, setView] = createSignal<View>("tree");
const [mode, setMode] = createSignal("values");
const [tree, setTree] = createSignal<Tree | undefined>();
const [model, setModel] = createSignal<MapModel | undefined>();
const [shape, setShape] = createSignal<ShapeModel | undefined>();
const [detail, setDetail] = createSignal<Detail | undefined>();
const [lines, setLines] = createSignal<Line[]>([]);
const [said, setSaid] = createSignal<{ cls: string; text: string } | undefined>();
const [picked, setPicked] = createSignal<Pick | undefined>();
const [box, setBox] = createSignal<string | undefined>();
const [only, setOnly] = createSignal(false);
const [paused, setPaused] = createSignal(false);
const [panes, setPanes] = createSignal({ detail: true, activity: true });
const [times, setTimes] = createSignal<
  { times: { time: number; label: string }[]; note?: string }
>();

const current = () => status()?.graphs.find((g) => g.name === graph());
/** is this the picked node, where it was picked */
const isPicked = (x: { path: Path; k: number; id: string }) => {
  const p = picked();
  return !!p && p.id === x.id && p.k === x.k && J(p.path) === J(x.path);
};

// ---- talking to the page ----

let source: Promise<string> | undefined;
const agentSource = () => (source ??= fetch("page.js").then((r) => r.text()));
let lastPoll = 0;
let lastTimes = 0;

async function poll() {
  try {
    let s = await call<Status | undefined>("status");
    if (!s) {
      await evaluate(await agentSource());
      s = await call<Status>("status");
      ui.asked = 0;
    }
    // the request fired again: when the panel opens or the page came back, and now and then
    // while the page shows no graph, so one that answers late is found
    const now = Date.now();
    if (ui.asked === 0 || (!s!.graphs.length && now - ui.asked > 1000)) {
      ui.asked = now;
      await call("ask");
      s = await call<Status>("status");
    }
    setProblem(undefined);
    setStatus(s);
    const names = s!.graphs.map((g) => g.name);
    if (!ui.graph || !names.includes(ui.graph)) choose(names[0]);
    const g = s!.graphs.find((x) => x.name === ui.graph);
    if (g && g.gen !== ui.gen) choose(g.name);
    if (g && !ui.paused) {
      const v = g.version ?? -2;
      if (ui.dirty || v !== ui.seen || (v === -2 && now - lastPoll > 1000)) {
        ui.dirty = false;
        ui.seen = v;
        lastPoll = now;
        await refresh(g);
      }
      if (g.events > ui.after) await take(g);
      if (g.travel && now - lastTimes > 1500) {
        lastTimes = now;
        const t = await call<{ times: { time: number; label: string }[]; note?: string }>(
          "times",
          g.name,
        );
        if (!failed(t)) setTimes(t);
      }
    }
  } catch (e) {
    setProblem(String((e as Error).message ?? e));
    ui.seen = -1;
  }
  setTimeout(poll, POLL);
}

function choose(name: string | undefined) {
  const g = status()?.graphs.find((x) => x.name === name);
  ui.graph = name;
  ui.gen = g?.gen ?? 0;
  ui.picked = undefined;
  ui.box = undefined;
  ui.after = 0;
  ui.seen = -1;
  ui.dirty = true;
  setGraph(name);
  setPicked(undefined);
  setBox(undefined);
  setTree(undefined);
  setModel(undefined);
  setShape(undefined);
  setDetail(undefined);
  setLines([]);
  setTimes(undefined);
}

const viewOf = () => ({
  open: [...ui.open],
  folded: [...ui.folded],
  search: ui.search,
  only: ui.only,
  picked: ui.picked,
});

// the detail as it is while someone types in it (a value to write, a call's args)
const typing = () => {
  const a = document.activeElement;
  return !!a?.closest(".detail") && a.tagName !== "BUTTON";
};
const setDetailSoft = (d: Detail | undefined) => typing() || setDetail(d);
// done typing: a pick or an act moves on (Safari keeps the focus where it was on a click)
const done = () => typing() && (document.activeElement as HTMLElement).blur();

async function refresh(g: Graph) {
  if (ui.view === "tree") {
    const t = await call<Tree | Failed>("tree", g.name, viewOf());
    if (failed(t)) return say("err", t.error ?? "gone");
    setTree(t);
    setDetailSoft(t.detail);
  } else if (ui.view === "map") {
    const m = await call<MapModel | Failed>("map", g.name, viewOf());
    if (failed(m)) return say("err", m.error ?? "gone");
    setModel(m);
    setDetailSoft(m.detail);
  } else {
    const s = await call<ShapeModel | Failed>("shape", g.name, ui.mode, ui.box);
    if (failed(s)) return say("err", s.error ?? "gone");
    setShape(s);
    if (ui.picked) {
      const d = await call<Detail | Failed>("pick", g.name, ui.picked);
      if (!failed(d)) setDetailSoft(d);
    }
  }
}

async function take(g: Graph) {
  const r = await call<{ gen: number; last: number; list: Line[] } | Failed>(
    "moments",
    g.name,
    ui.after,
  );
  if (failed(r)) return;
  ui.after = r.last;
  if (!r.list.length) return;
  const list = document.querySelector(".mo");
  const bottom = !list || list.scrollHeight - list.scrollTop - list.clientHeight < 8;
  setLines((ls) => [...ls, ...r.list].slice(-LINES));
  if (list && bottom) requestAnimationFrame(() => (list.scrollTop = list.scrollHeight));
}

const again = () => (ui.dirty = true);

async function act(op: string, args: unknown) {
  if (!ui.graph) return;
  done();
  const r = await call<Attempt | Failed>("act", ui.graph, op, args);
  if ("error" in r && r.error !== undefined) say("err", r.error);
  else if ("ok" in r) say("ok", r.ok === null ? `${op}: done` : `→ ${cut(J(r.ok), 200)}`);
  again();
}

let sayTimer = 0;
function say(cls: string, text: string) {
  setSaid({ cls, text });
  clearTimeout(sayTimer);
  sayTimer = setTimeout(() => setSaid(undefined), 6000);
}

// ---- picking and folding ----

function pick(p: Pick | undefined) {
  done();
  ui.picked = p;
  setPicked(p);
  again();
}
/** a node picked by id, where the last tree or map saw it; else searched for */
function show(id: string) {
  const rows: { path: Path; k: number; id: string }[] = ui.view === "map"
    ? model()?.cards ?? []
    : tree()?.rows ?? [];
  const found = rows.find((r) => r.id === id);
  if (found) return pick({ path: found.path, k: found.k, id });
  if (ui.view === "scheduler") {
    setViewTo("tree");
    ui.search = id;
    const input = document.querySelector<HTMLInputElement>("#find");
    if (input) input.value = id;
  }
}
function toggle(key: string, folded: boolean) {
  if (folded) (ui.folded.delete(key), ui.open.add(key));
  else (ui.open.delete(key), ui.folded.add(key));
  again();
}
function setViewTo(v: View) {
  ui.view = v;
  setView(v);
  again();
}

// ---- the tree ----

function TreeView() {
  const lit = () => {
    const d = detail();
    return {
      reads: new Set(d?.lit?.reads ?? []),
      readers: new Set(d?.lit?.readers ?? []),
    };
  };
  return (
    <div class="tree">
      <For each={tree()?.rows ?? []} keyed={(r: Row) => r.key}>
        {(r) => {
          const sel = () => isPicked(r());
          const mark = () =>
            sel()
              ? ""
              : lit().reads.has(r().id)
              ? "reads"
              : lit().readers.has(r().id)
              ? "readby"
              : "";
          return (
            <div
              class={`r${sel() ? " sel" : ""}${mark() ? ` ${mark()}` : ""}${r().hit ? " hit" : ""}${
                r().fresh ? " flash" : ""
              }`}
              style={{ "padding-left": `${4 + r().depth * 12}px` }}
              onClick={() => pick({ path: r().path, k: r().k, id: r().id })}
            >
              <span
                class="tw"
                onClick={(e) => {
                  if (!r().canOpen) return;
                  e.stopPropagation();
                  toggle(r().key, r().folded);
                }}
              >
                {r().canOpen ? (r().folded ? "▸" : "▾") : ""}
              </span>
              <Show when={r().kind === "proc"}>
                <span class="ok">⚙</span>
              </Show>
              <Show when={r().kind === "comp"}>
                <span class="ok">◇</span>
              </Show>
              <Show when={r().kind === "fn"}>
                <span class="vfn">ƒ</span>
              </Show>
              <span class={`nm${r().kind === "eph" ? " eph" : ""}`}>{r().name}</span>
              <Show when={r().count > 1}>
                <span class="k">{r().k + 1}/{r().count}</span>
              </Show>
              <Show when={r().error}>
                <span class="err">{r().error}</span>
              </Show>
              <Show when={r().refused}>
                <span class="pill err" title={r().refused}>refused</span>
              </Show>
              <Show when={!r().loaded && !r().refused && !r().error}>
                <span class="dim">not loaded</span>
              </Show>
              <Show when={r().status}>
                <span class={`pill ${r().status === "pending" ? "pend" : "err"}`}>
                  {r().status}
                </span>
              </Show>
              <Show when={r().run !== undefined}>
                <span class="k">run {r().run}</span>
              </Show>
              <Show when={r().value}>{(v) => <span class={`v ${v()[0]}`}>{v()[1]}</span>}</Show>
              <For each={r().infos}>
                {([name, v]) => (
                  <span class="k">
                    {name}=<span class={v[0]}>{v[1]}</span>
                  </span>
                )}
              </For>
              <Show when={r().mount}>
                <span class="ph">↺ same node as {r().mount}</span>
              </Show>
              <Show when={r().offpath}>
                <span class="dim">off-path</span>
              </Show>
              <Show when={r().folded && r().canOpen}>
                <span class="k">{r().kids} inside</span>
              </Show>
              <Show when={mark()}>
                <span class={`tag ${mark() === "reads" ? "rd" : "rb"}`}>
                  {mark() === "reads" ? "read" : "reads it"}
                </span>
              </Show>
              <span class="id">{r().id}</span>
            </div>
          );
        }}
      </For>
      <Show when={tree()?.capped}>
        <div class="dim">… more than the tree shows: fold, or search</div>
      </Show>
    </div>
  );
}

// ---- a pannable, zoomable sheet: the map and the scheduler's shape ----

type Sheet = {
  el: HTMLElement;
  world: HTMLElement;
  fit: (b: { x: number; y: number; w: number; h: number }[]) => void;
  moved: () => boolean;
};

function sheet(el: HTMLElement, world: HTMLElement, tap: (t: HTMLElement) => void): Sheet {
  let v = { x: 16, y: 16, k: 1 };
  let moved = false;
  const apply = () => (world.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.k})`);
  let down: { x: number; y: number; t: HTMLElement; moved: boolean } | undefined;
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    down = { x: e.clientX, y: e.clientY, t: e.target as HTMLElement, moved: false };
  });
  addEventListener("pointermove", (e) => {
    if (!down) return;
    const dx = e.clientX - down.x;
    const dy = e.clientY - down.y;
    if (!down.moved && Math.hypot(dx, dy) < 4) return;
    down.moved = moved = true;
    down.x = e.clientX;
    down.y = e.clientY;
    v.x += dx;
    v.y += dy;
    el.classList.add("drag");
    apply();
  });
  addEventListener("pointerup", () => {
    if (!down) return;
    el.classList.remove("drag");
    if (!down.moved) tap(down.t);
    down = undefined;
  });
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    moved = true;
    const r = el.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const k = Math.min(3, Math.max(0.05, v.k * Math.exp(-e.deltaY * 0.0015)));
    v = { k, x: mx - (mx - v.x) * k / v.k, y: my - (my - v.y) * k / v.k };
    apply();
  }, { passive: false });
  apply();
  return {
    el,
    world,
    moved: () => moved,
    fit(bs) {
      if (!bs.length || !el.clientWidth) return;
      let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
      for (const x of bs) {
        a = Math.min(a, x.x);
        b = Math.min(b, x.y);
        c = Math.max(c, x.x + x.w);
        d = Math.max(d, x.y + x.h);
      }
      const k = Math.min(
        1.4,
        Math.max(
          0.15,
          Math.min(
            (el.clientWidth - 32) / (c - a),
            (el.clientHeight - 40) / (d - b),
          ),
        ),
      );
      v = { k, x: (el.clientWidth - (c - a) * k) / 2 - a * k, y: 24 - b * k };
      moved = false;
      apply();
    },
  };
}

/** a curve from a's right side to b's left; one going back, out to the right and round */
function edge(
  a: { x: number; y: number },
  b: { x: number; y: number },
  W: number,
  H: number,
  fy = 0,
  ty = 0,
) {
  const y1 = a.y + H / 2 + fy, y2 = b.y + H / 2 + ty;
  if (b.x > a.x + W / 2) {
    const x1 = a.x + W, x2 = b.x, mx = (x1 + x2) / 2;
    return `M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
  }
  const x1 = a.x + W, x2 = b.x + W, o = 40 + Math.abs(y2 - y1) * 0.15;
  return `M${x1} ${y1}C${Math.max(x1, x2) + o} ${y1} ${Math.max(x1, x2) + o} ${y2} ${x2} ${y2}`;
}

function Arrows() {
  return (
    <defs>
      <For
        each={[["rd", "var(--sky)"], ["rb", "var(--cherry)"], ["all", "var(--sky)"], [
          "value",
          "var(--soft)",
        ], ["wrote", "var(--leaf)"]]}
      >
        {([id, col]) => (
          <marker
            id={`ar-${id}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0L10 5L0 10z" style={{ fill: col }} />
          </marker>
        )}
      </For>
    </defs>
  );
}

function MapView() {
  let el!: HTMLDivElement;
  let world!: HTMLDivElement;
  let s: Sheet | undefined;
  let fitted = "";
  const cards = () => model()?.cards ?? [];
  const byKey = () => new Map(cards().map((c) => [c.key, c]));
  const W = () => model()?.W ?? 150;
  const H = () => model()?.H ?? 40;
  // the read edges classed by the pick: what it reads, who reads it, the rest faint
  const reads = () => {
    const p = picked();
    const by = byKey();
    const out = (model()?.reads ?? []).flatMap((r) => {
      const from = by.get(r.from), to = by.get(r.to);
      if (!from || !to) return [];
      const cls = !p ? "all" : r.reader === p.id ? "rd" : r.read === p.id ? "rb" : "faint";
      return [{ from, to, cls, fy: 0, ty: 0 }];
    });
    // the ends fanned along each card's side, so every arrow shows
    for (const side of ["from", "to"] as const) {
      const groups = new Map<Card, typeof out>();
      for (const e of out) groups.set(e[side], [...(groups.get(e[side]) ?? []), e]);
      for (const list of groups.values()) {
        list.forEach((e, i) => {
          const off = ((i + 0.5) / list.length - 0.5) * (H() - 10);
          if (side === "from") e.fy = off;
          else e.ty = off;
        });
      }
    }
    return out;
  };
  const marks = () => {
    const p = picked();
    const mine = new Set<string>(), readers = new Set<string>();
    if (p) {
      for (const r of model()?.reads ?? []) {
        if (r.reader === p.id) mine.add(r.read);
        if (r.read === p.id) readers.add(r.reader);
      }
    }
    return { mine, readers };
  };
  const fit = () => s?.fit(cards().map((c) => ({ x: c.x, y: c.y, w: W(), h: H() })));
  const after = () => {
    const m = model();
    const key = `${m?.cards.length}`;
    if (m && key !== fitted && !s?.moved()) requestAnimationFrame(fit);
    fitted = key;
    return "";
  };
  return (
    <div
      class="vw"
      ref={(e) => {
        el = e;
        queueMicrotask(() => {
          s = sheet(el, world, (t) => {
            const fold = t.closest<HTMLElement>("[data-fold]");
            const card = cards().find((c) => c.key === t.closest<HTMLElement>(".mc")?.dataset.key);
            if (!card) return;
            if (fold) toggle(card.key, card.folded);
            else pick({ path: card.path, k: card.k, id: card.id });
          });
          fit();
        });
      }}
    >
      <div class="world" ref={world}>
        <svg width="1" height="1">
          <Arrows />
          <For each={model()?.links ?? []}>
            {(l) => {
              const a = byKey().get(l.from), b = byKey().get(l.to);
              return (
                <Show when={a && b}>
                  <path class={l.kind === "mount" ? "mo" : "ch"} d={edge(a!, b!, W(), H())} />
                </Show>
              );
            }}
          </For>
          <For each={reads()}>
            {(r) => (
              <path
                class={r.cls}
                d={edge(r.from, r.to, W(), H(), r.fy, r.ty)}
                marker-end={`url(#ar-${r.cls === "faint" ? "all" : r.cls})`}
              />
            )}
          </For>
        </svg>
        <For each={cards()} keyed={(c: Card) => c.key}>
          {(c) => {
            const sel = () => isPicked(c());
            const mark = () =>
              sel()
                ? "sel"
                : marks().mine.has(c().id)
                ? "reads"
                : marks().readers.has(c().id)
                ? "readby"
                : "";
            return (
              <div
                class={`mc k-${c().kind || "data"} ${mark()}${c().hit ? " hit" : ""}`}
                data-key={c().key}
                style={{
                  left: `${c().x}px`,
                  top: `${c().y}px`,
                  width: `${W()}px`,
                  height: `${H()}px`,
                }}
              >
                <div class="mt">
                  <span class="mi">
                    {c().kind === "proc"
                      ? "⚙"
                      : c().kind === "comp"
                      ? "◇"
                      : c().kind === "fn"
                      ? "ƒ"
                      : ""}
                  </span>
                  <span class={`mn${c().kind === "eph" ? " eph" : ""}`}>{c().name}</span>
                  <Show when={c().count > 1}>
                    <span class="mk">{c().k + 1}/{c().count}</span>
                  </Show>
                  <Show when={c().status}>
                    <span class={`mp ${c().status}`}>{c().status}</span>
                  </Show>
                  <Show when={c().run !== undefined}>
                    <span class="mk">r{c().run}</span>
                  </Show>
                </div>
                <div class="mb">
                  <Show when={c().refused}>
                    <span class="err">refused</span>
                  </Show>
                  <Show when={!c().loaded && !c().refused}>
                    <span class="dim">not loaded</span>
                  </Show>
                  <Show when={c().value}>{(v) => <span class={v()[0]}>{v()[1]}</span>}</Show>
                  <Show when={c().more}>
                    <span class="mk">+{c().more}</span>
                  </Show>
                </div>
                <Show when={c().canOpen}>
                  <span class="mf" data-fold="1">{c().folded ? "▸" : "▾"}</span>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
      <div class="help">
        drag: pan · wheel: zoom · click: pick · ▸ folds{after()}
        <button type="button" onClick={(e) => (e.stopPropagation(), fit())}>fit</button>
      </div>
    </div>
  );
}

function ShapeView() {
  let el!: HTMLDivElement;
  let world!: HTMLDivElement;
  let s: Sheet | undefined;
  let fitted = "";
  const boxes = () => shape()?.boxes ?? [];
  const byKey = () => new Map(boxes().map((b) => [b.key, b]));
  const W = () => shape()?.W ?? 170;
  const H = () => shape()?.H ?? 40;
  // the picked box: what it waits on / reads / is owned by (blue), what waits on it (cherry)
  const lit = () => {
    const sel = box();
    const up = new Set<string>(), down = new Set<string>();
    const sh = shape();
    if (!sel || !sh) return { up, down };
    if (sh.mode === "owners") {
      for (const a of sh.arrows) if (a.from === sel) down.add(a.to);
      for (const k of byKey().get(sel)?.up ?? []) up.add(k);
    } else {
      for (const a of sh.arrows) {
        if (a.to === sel) up.add(a.from);
        if (a.from === sel) down.add(a.to);
      }
    }
    return { up, down };
  };
  const fit = () => s?.fit(boxes().map((b) => ({ x: b.x, y: b.y, w: W(), h: H() })));
  const after = () => {
    const sh = shape();
    const key = `${sh?.mode}:${sh?.boxes.length}`;
    if (sh && key !== fitted && !s?.moved()) requestAnimationFrame(fit);
    fitted = key;
    return "";
  };
  const legend: Record<string, [string, string][]> = {
    values: [["ku", "waits on (its values)"], ["kd", "waited on by"]],
    keys: [["ku", "reads"], ["kw", "wrote"], ["kd", "read by / written by"]],
    owners: [["ku", "owners above"], ["kd", "made under it"]],
  };
  const about = () => byKey().get(box() ?? "");
  return (
    <div
      class="vw sv"
      ref={(e) => {
        el = e;
        queueMicrotask(() => {
          s = sheet(el, world, (t) => {
            if (t.closest(".about,.modes")) return;
            const key = t.closest<HTMLElement>(".sb")?.dataset.key;
            ui.box = key === ui.box ? undefined : key;
            setBox(ui.box);
            again();
          });
          fit();
        });
      }}
    >
      <div class="world" ref={world}>
        <svg width="1" height="1">
          <Arrows />
          <For each={shape()?.arrows ?? []}>
            {(a) => {
              const f = byKey().get(a.from), t = byKey().get(a.to);
              const cls = () => {
                const sel = box();
                if (!sel) return a.kind;
                const l = lit();
                if (a.from === sel || a.to === sel) {return `${a.kind} ${
                    a.to === sel ? "up" : "down"
                  }`;}
                if (shape()?.mode === "owners" && l.up.has(a.to)) return `${a.kind} up`;
                return `${a.kind} faint`;
              };
              return (
                <Show when={f && t}>
                  <path
                    class={cls()}
                    d={edge(f!, t!, W(), H())}
                    marker-end={`url(#ar-${
                      a.kind === "read" ? "all" : a.kind === "wrote" ? "wrote" : "value"
                    })`}
                  />
                </Show>
              );
            }}
          </For>
        </svg>
        <For each={boxes()} keyed={(b: Box) => b.key}>
          {(b) => {
            const cls = () => {
              const sel = box();
              if (!sel) return "";
              if (b().key === sel) return " sel";
              const l = lit();
              return l.up.has(b().key) ? " up" : l.down.has(b().key) ? " down" : " faint";
            };
            return (
              <div
                class={`sb ${b().kind}${cls()}`}
                data-key={b().key}
                style={{
                  left: `${b().x}px`,
                  top: `${b().y}px`,
                  width: `${W()}px`,
                  height: `${H()}px`,
                }}
              >
                <div class="t">
                  <span class="n">{b().label}</span>
                  <For each={b().flags}>{(f) => <span class={`f ${f}`}>{f}</span>}</For>
                </div>
                <div class="u">{b().sub}</div>
              </div>
            );
          }}
        </For>
      </div>
      <div class="modes">
        <For each={["values", "keys", "owners"]}>
          {(m) => (
            <button
              type="button"
              class={mode() === m ? "on" : ""}
              onClick={(e) => {
                e.stopPropagation();
                ui.mode = m;
                ui.box = undefined;
                setMode(m);
                setBox(undefined);
                fitted = "";
                again();
              }}
            >
              {m}
            </button>
          )}
        </For>
      </div>
      <Show when={box() && shape()?.about}>
        <div class="about">
          {shape()!.about}
          <Show when={about()?.place}>
            <button type="button" onClick={() => show(about()!.place!)}>
              show {about()!.placeName ?? about()!.place} in the tree
            </button>
          </Show>
        </div>
      </Show>
      <div class="say">
        <span>
          {shape()?.counts ?? ""}
          {shape()?.capped ? " (capped)" : ""}
          {after()}
        </span>
        <span class="sp" />
        <For each={legend[mode()] ?? []}>{([c, t]) => <b class={c}>{t}</b>}</For>
        <button type="button" onClick={(e) => (e.stopPropagation(), fit())}>fit</button>
      </div>
      <Show when={shape()?.none}>
        <div class="none">this host gives no scheduler to look at</div>
      </Show>
    </div>
  );
}

// ---- the detail pane ----

function DetailPane() {
  let args!: HTMLInputElement;
  let text!: HTMLTextAreaElement;
  const chip = (c: { id: string; name: string; parts?: string }, cls: string) => (
    <span
      class={`chip ${cls}`}
      title={c.parts ? `${c.id}: ${c.parts}` : c.id}
      onClick={() => show(c.id)}
    >
      {c.name}
    </span>
  );
  return (
    <div class="detail">
      <Show
        when={detail()}
        fallback={
          <div class="tip">
            <b>pick a node.</b>{" "}
            you'll see where it sits, every version and who made it, and — lit in the tree — what it
            reads and who reads it.<br />
            <span class="ok">⚙</span> process · <span class="ok">◇</span> memo or effect ·{" "}
            <span class="vfn">ƒ</span> handler · <i>italic</i> ephemeral, never kept ·{" "}
            <span class="ph">↺</span> the same node placed again
          </div>
        }
      >
        {(d) => (
          <>
            <h3>
              <span>{d().title}</span>
              <span class="k">{d().id}</span>
            </h3>
            <Show when={d().error}>
              <div class="err">{d().error}</div>
            </Show>
            <Show when={d().gone}>
              <div class="dim">no longer here</div>
            </Show>
            <Show when={d().refused}>
              <div class="err">refused: {d().refused}</div>
            </Show>
            <Show when={d().unloaded}>
              <div class="dim">not loaded</div>
            </Show>
            <div class="row2">
              <For each={d().tags ?? []}>
                {([cls, t]) => <span class={`pill ${cls}`}>{t}</span>}
              </For>
            </div>
            <Show when={d().status}>
              {(st) => <div class={st().cls}>{st().text}</div>}
            </Show>
            <Show when={d().can?.kill || d().can?.replace}>
              <div class="row2">
                <Show when={d().can?.kill}>
                  <button type="button" onClick={() => act("kill", { id: d().id })}>
                    kill (outro)
                  </button>
                </Show>
                <Show when={d().can?.replace}>
                  <button type="button" onClick={() => act("replace", { path: d().path })}>
                    replace
                  </button>
                </Show>
              </div>
            </Show>
            <Show when={d().run || d().reads}>
              <h4>
                reads · from its latest run ({d().run?.run ?? "?"}
                {d().run?.ended ? `, ${d().run!.ended}` : ""})
              </h4>
              <div>
                <For each={d().reads ?? []}>{(r) => chip(r, "rd")}</For>
                <Show when={!(d().reads ?? []).length}>
                  <span class="dim">nothing tracked: it never reruns by itself</span>
                </Show>
              </div>
              <div class="k">
                {d().run?.byName
                  ? `woken by a change ${d().run!.byName} made`
                  : "a first run, or woken from outside"}
              </div>
              <Show when={d().run?.error}>
                <div class="err">{d().run!.error}</div>
              </Show>
            </Show>
            <Show when={(d().readers ?? []).length}>
              <h4>
                read by · {d().readers!.length} process{d().readers!.length === 1 ? "" : "es"}{" "}
                rerun when it changes
              </h4>
              <div>
                <For each={d().readers ?? []}>{(r) => chip(r, "rb")}</For>
              </div>
            </Show>
            <Show when={(d().placed ?? []).length}>
              <h4>placed at</h4>
              <div>
                <For each={d().placed ?? []}>
                  {(p) => (
                    <span
                      class="chip"
                      onClick={() => pick({ path: p.path, k: 0, id: d().id })}
                    >
                      {p.text}
                    </span>
                  )}
                </For>
              </div>
            </Show>
            <Show when={d().can?.call}>
              <div class="row2">
                <input ref={args} placeholder="args as JSON (optional)" spellcheck={false} />
                <button
                  type="button"
                  onClick={() => {
                    let a: unknown;
                    try {
                      a = args.value.trim() ? JSON.parse(args.value) : undefined;
                    } catch (e) {
                      return say("err", `args: ${(e as Error).message}`);
                    }
                    act("call", { path: d().path, args: a });
                  }}
                >
                  call as host
                </button>
              </div>
            </Show>
            <Show when={d().versions}>
              <h4>value</h4>
              <Show when={!d().versions!.length}>
                <div class="dim">no value: a node holds children either way</div>
              </Show>
              <For each={d().versions ?? []}>
                {(v) => (
                  <div class={`ver${v.status ? " status" : ""}${v.conflict ? " conflict" : ""}`}>
                    <pre>{v.gone ? "(gone)" : v.text}</pre>
                    <div class="meta">{v.meta}</div>
                  </div>
                )}
              </For>
            </Show>
            <Show when={d().can?.write}>
              <textarea ref={text} spellcheck={false} value={d().json ?? ""} />
              <div class="row2">
                <button
                  type="button"
                  onClick={() => {
                    let value: unknown;
                    try {
                      value = JSON.parse(text.value);
                    } catch (e) {
                      return say("err", `not JSON: ${(e as Error).message}`);
                    }
                    act("write", { path: d().path, k: d().k, id: d().id, value });
                  }}
                >
                  write as host
                </button>
                <span class="k">one change; its readers wake</span>
              </div>
            </Show>
            <Show when={(d().infos ?? []).length}>
              <h4>info</h4>
              <For each={d().infos ?? []}>
                {(i) => (
                  <div class="ver">
                    <b>{i.name}</b>
                    <pre>{i.text}</pre>
                    <Show when={i.meta}>
                      <div class="meta">{i.meta}</div>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
            <Show when={(d().children ?? []).length}>
              <h4>children</h4>
              <div>
                <For each={d().children ?? []}>
                  {(c) => (
                    <span
                      class="chip"
                      title={c.id}
                      onClick={() => pick({ path: [...d().path, c.slot], k: 0, id: c.id ?? "" })}
                    >
                      {c.name} <span class="k">{c.id ?? ""}</span>
                    </span>
                  )}
                </For>
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

// ---- what the scheduler did ----

function Activity() {
  return (
    <div class="mo">
      <button type="button" class="clear" onClick={() => setLines([])}>clear</button>
      <For each={lines()}>
        {(l, i) => (
          <>
            <Show when={i() === 0 || lines()[i() - 1]?.round !== l.round}>
              <div class="round">— {l.when}</div>
            </Show>
            <div class={l.cls} onClick={() => show(l.id)} title={l.id}>{l.text}</div>
          </>
        )}
      </For>
      <Show when={!lines().length}>
        <div class="dim">nothing yet: what the scheduler does shows here, in words</div>
      </Show>
    </div>
  );
}

// ---- travel: a slider over the host's moments, resting on now ----

function Travel() {
  const [at, setAt] = createSignal<number | undefined>();
  const list = () => times()?.times ?? [];
  const shownAt = () => at() ?? list().length - 1;
  const label = () => {
    const m = list()[shownAt()];
    if (current()?.travelError) return current()!.travelError!;
    if (!m) return "no history yet";
    return shownAt() === list().length - 1 ? `now · ${m.label}` : `back to t${m.time} · ${m.label}`;
  };
  return (
    <div
      class="tt"
      title={`go back in time: pick a moment, the graph is set back to how it was then${
        times()?.note ? `. ${times()!.note}` : ""
      }`}
    >
      <span class="k">⟲</span>
      <input
        type="range"
        min="0"
        max={String(Math.max(0, list().length - 1))}
        value={String(shownAt())}
        disabled={list().length < 2}
        onInput={(e) => setAt(+e.currentTarget.value)}
        onChange={(e) => {
          const i = +e.currentTarget.value;
          setAt(undefined);
          const m = list()[i];
          if (m && i !== list().length - 1) act("go", { time: m.time });
        }}
      />
      <span class={`tl${shownAt() !== list().length - 1 || current()?.travelError ? " back" : ""}`}>
        {label()}
      </span>
    </div>
  );
}

// ---- the panel ----

function App() {
  const stat = () => {
    const g = current();
    if (!g) return "";
    if (view() === "tree") {
      const t = tree();
      return t
        ? `${t.rows.length} rows · ${t.procs} computers${g.kind === "host" ? ` · t${t.time}` : ""}`
        : "";
    }
    if (view() === "map") {
      const m = model();
      return m
        ? `${m.cards.length} cards${m.capped ? " (capped)" : ""} · ${m.procs} computers`
        : "";
    }
    return "";
  };
  const pane = (k: "detail" | "activity") => (
    <button
      type="button"
      class={panes()[k] ? "on" : ""}
      onClick={() => setPanes({ ...panes(), [k]: !panes()[k] })}
    >
      {k}
    </button>
  );
  return (
    <div class="app">
      <header>
        <strong>ermine</strong>
        <Show when={(status()?.graphs.length ?? 0) > 1}>
          <select value={graph()} onChange={(e) => choose(e.currentTarget.value)}>
            <For each={status()!.graphs}>{(g) => <option value={g.name}>{g.name}</option>}</For>
          </select>
        </Show>
        <Show when={(status()?.graphs.length ?? 0) === 1}>
          <span class="gname">{graph()}</span>
        </Show>
        <Show when={current()}>
          <span class="tabs">
            <For each={["tree", "map", "scheduler"] as View[]}>
              {(v) => (
                <Show when={v !== "scheduler" || current()?.can.scheduler}>
                  <button
                    type="button"
                    class={view() === v ? "on" : ""}
                    onClick={() => setViewTo(v)}
                  >
                    {v}
                  </button>
                </Show>
              )}
            </For>
          </span>
          <Show when={view() !== "scheduler"}>
            <input
              id="find"
              placeholder="find a name or id…"
              spellcheck={false}
              onInput={(e) => {
                ui.search = e.currentTarget.value;
                again();
              }}
            />
          </Show>
          <Show when={view() === "tree"}>
            <button
              type="button"
              class={only() ? "on" : ""}
              title="only computers and what holds them"
              onClick={() => {
                ui.only = !ui.only;
                setOnly(ui.only);
                again();
              }}
            >
              ⚙ only
            </button>
          </Show>
          <Show when={view() !== "scheduler"}>
            <button
              type="button"
              title="back to the first folding"
              onClick={() => {
                ui.open.clear();
                ui.folded.clear();
                again();
              }}
            >
              fold
            </button>
          </Show>
          <Show when={view() !== "scheduler"}>
            <span class="key">
              <b class="kr">reads</b>
              <b class="kb">read by</b>
            </span>
          </Show>
          <span class="stat">{stat()}</span>
        </Show>
        <span class="grow">
          <Show when={said()}>{(s) => <span class={s().cls}>{s().text}</span>}</Show>
          <Show when={problem()}>{(p) => <span class="err">{p()}</span>}</Show>
        </span>
        <Show when={current()}>
          <button
            type="button"
            class={paused() ? "on" : ""}
            title="stop following the page"
            onClick={() => {
              ui.paused = !ui.paused;
              setPaused(ui.paused);
              again();
            }}
          >
            {paused() ? "paused" : "pause"}
          </button>
          {pane("detail")}
          {pane("activity")}
        </Show>
      </header>
      <Show
        when={current()}
        fallback={
          <div class="none">
            <p>No graph on this page answers.</p>
            <p>
              A page shows its graph to devtools by answering the request, with the layer it picks:
            </p>
            <pre>
              {`import { devtools } from "playground/devtools/answer.ts"
const stop = devtools(host, { name: "app" })`}
            </pre>
            <p class="dim">
              The extension fires <code>ermine:devtools</code>{" "}
              on window; nothing is read from window.
            </p>
          </div>
        }
      >
        <Show when={current()?.travel}>
          <Travel />
        </Show>
        <main>
          <section class="left">
            <Show when={view() === "tree"}>
              <TreeView />
            </Show>
            <Show when={view() === "map"}>
              <MapView />
            </Show>
            <Show when={view() === "scheduler"}>
              <ShapeView />
            </Show>
          </section>
          <Show when={panes().detail}>
            <section class="right">
              <DetailPane />
            </section>
          </Show>
        </main>
        <Show when={panes().activity}>
          <Activity />
        </Show>
      </Show>
    </div>
  );
}

const t = theme();
if (t) document.documentElement.dataset.theme = t === "dark" ? "dark" : "light";

render(() => <App />, document.getElementById("app")!);
poll();
