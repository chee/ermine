// The ermine panel: the graph of the inspected page, by address. A tree of
// directories from the root, each slot followed down to the node its address
// reaches; what an address reads as, every item with its route and change;
// its directory; a lookup from it; and the changes and records heard on every
// address the panel has listed.

import { createSignal, createStore, flush, For, Show } from "solid-js";
import { render } from "@solidjs/web";
import type {
  Address,
  Change,
  ErrorJson,
  Event,
  Header,
  Id,
  Json,
  Record as Run,
  RefusedItem,
  Route,
  SlotItem,
  ValueItem,
} from "../../src/types.ts";
import { call, evaluate, theme } from "./bridge.ts";

type Attempt<T> = { ok: T } | { error: ErrorJson };
type Listing = {
  read: Attempt<ValueItem[]>;
  directory: Attempt<[string, SlotItem[]][]>;
};
type Status = {
  version: number;
  graphs: { name: string; gen: number; events: number }[];
};
type Heard = Event & { n: number; key: string };

const POLL = 250;
const key = (a: Address) => JSON.stringify(a);
const J = (v: unknown) => JSON.stringify(v);
const pretty = (v: unknown) => JSON.stringify(v, null, 2);

const [status, setStatus] = createSignal<Status | undefined>();
const [problem, setProblem] = createSignal<string | undefined>();
const [graph, setGraph] = createSignal<string | undefined>();
const [selected, setSelected] = createSignal<Address>([]);
const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set([key([])]));
const [listings, setListings] = createStore<{ [k: string]: Listing }>({});
const [events, setEvents] = createSignal<Heard[]>([]);
const [filter, setFilter] = createSignal("");
const [paused, setPaused] = createSignal(false);
const [looked, setLooked] = createSignal<
  { name: string; result: Attempt<(SlotItem | RefusedItem)[]> }
>();

/** Where each id was last seen in a listing, so a change can be followed to its node. */
const where = new Map<Id, Address>();

// ---- talking to the page

let source: Promise<string> | undefined;
const agentSource = () => (source ??= fetch("page.js").then((r) => r.text()));

let seen = -1;
let gen = 0;
let after = 0;

async function poll() {
  try {
    let s = await call<Status | undefined>("status");
    if (!s) {
      await evaluate(await agentSource());
      s = await call<Status>("status");
    }
    setProblem(undefined);
    setStatus(s);
    const names = s!.graphs.map((g) => g.name);
    if (!graph() || !names.includes(graph()!)) {
      if (graph() !== names[0]) reset(names[0]);
    }
    if (s!.version !== seen && !paused()) {
      seen = s!.version;
      await refresh();
    }
  } catch (e) {
    setProblem(String((e as Error).message ?? e));
    seen = -1;
  }
  setTimeout(poll, POLL);
}

function reset(name: string | undefined) {
  setGraph(name);
  setListings((s) => {
    for (const k of Object.keys(s)) delete s[k];
  });
  setEvents([]);
  where.clear();
  after = 0;
  seen = -1;
}

async function refresh() {
  const name = graph();
  if (name === undefined) return;
  const addresses = new Map<string, Address>();
  for (const k of open()) addresses.set(k, JSON.parse(k));
  addresses.set(key(selected()), selected());
  const got = await Promise.all(
    [...addresses].map(async ([k, a]) => [k, await call<Listing>("listing", name, a)] as const),
  );
  setListings((s) => {
    for (const [k, l] of got) {
      if (!("gone" in l)) s[k] = l;
    }
  });
  for (const [k, l] of got) {
    for (const [slot, items] of ok(l.directory) ?? []) {
      for (const item of items) where.set(item.id, [...JSON.parse(k), slot]);
    }
  }
  const r = await call<{ gen: number; events: Heard[] } | { gone: true }>(
    "events",
    name,
    after,
  );
  if ("gone" in r) return;
  if (r.gen !== gen) {
    gen = r.gen;
    after = 0;
    setEvents([]);
    return refresh();
  }
  if (r.events.length) {
    after = r.events[r.events.length - 1].n;
    const log = document.querySelector(".log-list");
    const bottom = !log ||
      log.scrollHeight - log.scrollTop - log.clientHeight < 8;
    setEvents((es) => [...es, ...r.events].slice(-5000));
    flush();
    if (log && bottom) log.scrollTop = log.scrollHeight;
  }
}

function ok<T>(a: Attempt<T> | undefined): T | undefined {
  return a && "ok" in a ? a.ok : undefined;
}

function toggle(a: Address) {
  const k = key(a);
  const next = new Set(open());
  if (next.has(k)) next.delete(k);
  else next.add(k);
  setOpen(next);
  seen = -1;
}

function select(a: Address) {
  setSelected(a);
  setLooked(undefined);
  seen = -1;
}

// ---- words for things

function site(cause: Json | undefined): string | undefined {
  if (cause === null || typeof cause !== "object" || Array.isArray(cause)) {
    return;
  }
  const { file, line, column } = cause as { [k: string]: Json };
  if (typeof file !== "string" || typeof line !== "number") return;
  return `${file}:${line}:${column}`;
}

function cause(c: Change | Header): string {
  if (c.cause === undefined) return "";
  return site(c.cause) ?? J(c.cause);
}

/** A change, or the header an item carries: a change without its patches or value. */
function what(c: Change | Header): string {
  switch (c.kind) {
    case "write":
      if (!("patches" in c)) return "write";
      return `write ${c.patches.length} patch${c.patches.length === 1 ? "" : "es"}`;
    case "place":
      return `place ${c.name} ← ${c.id}${"value" in c && c.value !== undefined ? " (made)" : ""}`;
    case "unplace":
      return `unplace ${c.name} ✕ ${c.id}`;
  }
}

const addressText = (a: Address) => "/" + a.join("/");

function errorText(e: ErrorJson): string {
  return `${e.kind}${e.op ? ` ${e.op}` : ""}: ${e.why.code}${e.why.text ? ` — ${e.why.text}` : ""}`;
}

// ---- views

function ChangeLine(props: { change: Change | Header }) {
  return (
    <span class="change">
      <span class="time">t{props.change.time}</span>
      <span class="kind">{what(props.change)}</span>
      <span class="agent">{J(props.change.agent)}</span>
      <Show when={props.change.process}>
        {(p) => <span class="process">in {p()}</span>}
      </Show>
      <Show when={cause(props.change)}>
        {(c) => <span class="cause">{c()}</span>}
      </Show>
    </span>
  );
}

function RouteLine(props: { route: Route }) {
  return (
    <span class="route">
      <span class="sep">/</span>
      <For each={props.route}>
        {(step, i) => (
          <>
            <Show when={i() > 0}>
              <span class="sep">/</span>
            </Show>
            <span class="name">{step.name}</span>
            <Show when={step.position > 0}>
              <sup>{step.position}</sup>
            </Show>
            <span class="id">({step.node})</span>
          </>
        )}
      </For>
    </span>
  );
}

function Tree(props: { address: Address; above: Id[] }) {
  const listing = () => listings[key(props.address)];
  return (
    <ul class="tree">
      <Show when={listing()?.directory}>
        {(d) => (
          <Show
            when={ok(d())}
            fallback={
              <li class="err">
                {errorText((d() as { error: ErrorJson }).error)}
              </li>
            }
          >
            {(slots) => (
              <For each={slots()} fallback={<li class="empty">empty</li>}>
                {([slot, items]) => (
                  <Row
                    address={[...props.address, slot]}
                    items={items}
                    above={props.above}
                  />
                )}
              </For>
            )}
          </Show>
        )}
      </Show>
    </ul>
  );
}

function Row(props: { address: Address; items: SlotItem[]; above: Id[] }) {
  const here = () => props.items.filter((i) => !i.pending);
  const first = () => here()[0]?.id;
  const cycle = () => first() !== undefined && props.above.includes(first()!);
  const isOpen = () => open().has(key(props.address));
  const isSelected = () => key(selected()) === key(props.address);
  return (
    <li>
      <div
        class={`row${isSelected() ? " selected" : ""}`}
        onClick={() => select(props.address)}
      >
        <button
          type="button"
          class="twisty"
          disabled={first() === undefined || cycle()}
          onClick={(e) => {
            e.stopPropagation();
            toggle(props.address);
          }}
        >
          {cycle() ? "↻" : first() === undefined ? "·" : isOpen() ? "▾" : "▸"}
        </button>
        <span class="name">{props.address[props.address.length - 1]}</span>
        <span class="ids">
          <For each={props.items}>
            {(i) => <span class={`id${i.pending ? " pending" : ""}`}>{i.id}</span>}
          </For>
        </span>
        <Show when={listings[key(props.address)]?.read}>
          {(r) => <span class="preview">{preview(ok(r())?.[0]?.value)}</span>}
        </Show>
      </div>
      <Show when={isOpen() && !cycle()}>
        <Tree address={props.address} above={[...props.above, first()!]} />
      </Show>
    </li>
  );
}

function preview(v: Json | undefined): string {
  if (v === undefined) return "";
  const s = J(v);
  return s.length > 60 ? s.slice(0, 59) + "…" : s;
}

function Inspector() {
  const listing = () => listings[key(selected())];
  let input!: HTMLInputElement;
  const look = async (e: SubmitEvent) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name || graph() === undefined) return;
    const result = await call<Attempt<(SlotItem | RefusedItem)[]>>(
      "lookup",
      graph(),
      selected(),
      name,
    );
    setLooked({ name, result });
  };
  return (
    <div class="inspector">
      <h2>{addressText(selected())}</h2>
      <Show when={listing()} fallback={<p class="empty">reading…</p>}>
        {(l) => (
          <>
            <h3>read</h3>
            <Show
              when={ok(l().read)}
              fallback={
                <p class="err">
                  {errorText((l().read as { error: ErrorJson }).error)}
                </p>
              }
            >
              {(items) => (
                <For
                  each={items()}
                  fallback={<p class="empty">reaches nothing</p>}
                >
                  {(item, i) => (
                    <div class={`item${i() === 0 ? " first" : ""}`}>
                      <div class="from">
                        <RouteLine route={item.from.route} />
                      </div>
                      <pre class="value">{pretty(item.value)}</pre>
                      <Show when={item.ephemeral}>
                        <div class="meta">ephemeral</div>
                      </Show>
                      <Show when={item.change} fallback={<div class="meta">no change</div>}>
                        {(c) => (
                          <div class="meta">
                            <ChangeLine change={c()} />
                          </div>
                        )}
                      </Show>
                    </div>
                  )}
                </For>
              )}
            </Show>
            <h3>directory</h3>
            <Show
              when={ok(l().directory)}
              fallback={
                <p class="err">
                  {errorText((l().directory as { error: ErrorJson }).error)}
                </p>
              }
            >
              {(slots) => (
                <table class="dir">
                  <tbody>
                    <For
                      each={slots()}
                      fallback={
                        <tr>
                          <td class="empty">no names</td>
                        </tr>
                      }
                    >
                      {([slot, items]) => (
                        <For each={items}>
                          {(item, i) => (
                            <tr>
                              <td class="name">
                                <Show when={i() === 0}>
                                  <a
                                    onClick={() => select([...selected(), slot])}
                                  >
                                    {slot}
                                  </a>
                                </Show>
                              </td>
                              <td class="pos">
                                {"position" in item.from ? item.from.position : ""}
                              </td>
                              <td class={`id${item.pending ? " pending" : ""}`}>
                                {item.id}
                                {item.pending ? " (pending)" : ""}
                              </td>
                              <td>
                                {item.ephemeral ? "ephemeral " : ""}
                                <Show when={item.change}>{(c) => <ChangeLine change={c()} />}</Show>
                              </td>
                            </tr>
                          )}
                        </For>
                      )}
                    </For>
                  </tbody>
                </table>
              )}
            </Show>
            <h3>lookup from here</h3>
            <form class="lookup" onSubmit={look}>
              <input ref={input} placeholder="name" spellcheck={false} />
              <button type="submit">look up</button>
            </form>
            <Show when={looked()}>
              {(lk) => (
                <Show
                  when={ok(lk().result)}
                  fallback={
                    <p class="err">
                      {errorText((lk().result as { error: ErrorJson }).error)}
                    </p>
                  }
                >
                  {(items) => (
                    <For
                      each={items()}
                      fallback={<p class="empty">{lk().name}: nothing</p>}
                    >
                      {(item) =>
                        "refused" in item
                          ? (
                            <div class="item err">
                              refused reading {addressText(item.from.path)}
                            </div>
                          )
                          : (
                            <div class="item">
                              <span class="id">{item.id}</span>{" "}
                              <span class="route">
                                {"path" in item.from ? addressText(item.from.path) : ""}
                              </span>{" "}
                              <Show when={item.change}>{(c) => <ChangeLine change={c()} />}</Show>
                            </div>
                          )}
                    </For>
                  )}
                </Show>
              )}
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

function matches(e: Heard, f: string): boolean {
  return !f || J(e).toLowerCase().includes(f.toLowerCase());
}

function Log() {
  const shown = () => events().filter((e) => matches(e, filter()));
  return (
    <div class="log">
      <div class="bar">
        <input
          placeholder="filter"
          spellcheck={false}
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
        <button type="button" onClick={() => setPaused(!paused())}>
          {paused() ? "resume" : "pause"}
        </button>
        <button type="button" onClick={() => setEvents([])}>clear</button>
        <span class="count">{shown().length} events</span>
      </div>
      <div class="log-list">
        <For each={shown()}>
          {(e) => ("change" in e
            ? <ChangeEntry change={e.change} />
            : <RecordEntry record={e.record} />)}
        </For>
      </div>
    </div>
  );
}

function ChangeEntry(props: { change: Change }) {
  const [more, setMore] = createSignal(false);
  const at = () => where.get(props.change.node);
  return (
    <div class="entry change-entry">
      <div class="head" onClick={() => setMore(!more())}>
        <span class="tag">change</span>
        <a
          class="node"
          onClick={(e) => {
            e.stopPropagation();
            const a = at();
            if (a) select(a);
          }}
          title={at() ? addressText(at()!) : "not listed yet"}
        >
          {props.change.node}
        </a>
        <ChangeLine change={props.change} />
      </div>
      <Show when={more()}>
        <pre>{pretty(props.change)}</pre>
      </Show>
    </div>
  );
}

function RecordEntry(props: { record: Run }) {
  const [more, setMore] = createSignal(false);
  const r = () => props.record;
  return (
    <div class={`entry record-entry ${r().ending}`}>
      <div class="head" onClick={() => setMore(!more())}>
        <span class="tag">record</span>
        <span class="node">{r().process}</span>
        <span>run {r().run}</span>
        <span class="ending">{r().ending}</span>
        <span class="agent">{J(r().agent)}</span>
        <span class="counts">
          marked {r().marked.length} · looked up {r().lookups.length} · read {r().reads.length}{" "}
          · wrote {r().changes.length}
          {r().errors.length ? ` · ${r().errors.length} errors` : ""}
        </span>
      </div>
      <Show when={more()}>
        <pre>{pretty(r())}</pre>
      </Show>
    </div>
  );
}

function App() {
  return (
    <div class="app">
      <header>
        <strong>ermine</strong>
        <Show when={(status()?.graphs.length ?? 0) > 0}>
          <select
            value={graph()}
            onChange={(e) => reset(e.currentTarget.value)}
          >
            <For each={status()!.graphs}>
              {(g) => <option value={g.name}>{g.name}</option>}
            </For>
          </select>
        </Show>
        <Show when={problem()}>{(p) => <span class="err">{p()}</span>}</Show>
      </header>
      <Show
        when={graph() !== undefined}
        fallback={
          <div class="none">
            <p>No graph on this page.</p>
            <p>
              A host shows its graph to devtools by pushing it onto a global:
            </p>
            <pre>(globalThis.__ermine ??= []).push(&#123; name: "app", api &#125;);</pre>
          </div>
        }
      >
        <main>
          <section class="left">
            <div
              class={`row root${selected().length === 0 ? " selected" : ""}`}
              onClick={() => select([])}
            >
              <span class="twisty">▾</span>
              <span class="name">/</span>
            </div>
            <Tree address={[]} above={[]} />
          </section>
          <section class="right">
            <Inspector />
          </section>
        </main>
        <Log />
      </Show>
    </div>
  );
}

const t = theme();
if (t) document.documentElement.dataset.theme = t === "dark" ? "dark" : "light";

render(() => <App />, document.getElementById("app")!);
poll();
