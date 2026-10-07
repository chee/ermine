/// <reference lib="dom" />
// Links: sharing a node's subtree on a channel, and mounting one. Both are
// processes running programs built into the host (loaders/host): a share
// serves a subtree as src/link/serve.ts does; a mount keeps a copy of the
// owner's subtree in a folder here, wherever the person puts it, of one of two
// kinds:
//   - live only (programs/mirror, src/link/mirror.ts): the copy is the
//     mount's ephemeral nodes, so nobody keeps it and it goes with the mount;
//   - keep a copy (programs/mirror-kept, src/link/kept.ts): the copy is
//     ordinary nodes, kept here as any other, there after a reload as it was
//     last seen, until the mount follows the owner again.
// A write there is sent to the owner and shows at once as a layer in front of
// the copy, until the owner's change comes back, or its refusal.
//
// Sharing asks what to share first: the whole workspace (programs, loaders,
// shares and all: whole workspace shares are whole workspace shares), the
// node selected, or a folder in the root. Then on what: a fresh random
// channel, or a name ("kitchen"), whose channel anyone who knows the name
// finds (src/link/name.ts). Mounting asks where to put the copy: the selected
// node by default, or the root. A channel can be given as its 64 hex digits
// or as a name, wherever one is asked for. Every act here is a line in the
// workspace: share(node, {url?, name?}) and mount(channel, {url?, kind?, at?}).
//
// A reload: no processes are kept; the boot image starts the share and the
// mount again, on the same channel, so a mount finds its owner again if the
// owner still serves it, and is gone if not. A live mount's copy was not kept
// (it is ephemeral) and comes again; a kept mount's copy is there at once,
// and the mount started again reconciles it with the owner's, making nothing
// twice.

import { signal } from "@preact/signals";
import { useState } from "preact/hooks";
import type { Header, Id, Json, ValueItem } from "../../../src/mod.ts";
import { Section } from "./bits.tsx";
import { act, select, selected, world } from "./state.ts";
import { J, type LinkInfo, ROOT, SERVER, siteOf } from "./world.ts";
import type { Selection } from "./state.ts";
import { routeOf } from "./palette.tsx";

const SERVER_KEY = "ermine-link-server";

/** The server shares and mounts go through, as this browser last set it. */
export const server = signal<string>((() => {
  try {
    return localStorage.getItem(SERVER_KEY) || SERVER;
  } catch {
    return SERVER;
  }
})());

export function setServer(url: string) {
  server.value = url.trim() || SERVER;
  try {
    localStorage.setItem(SERVER_KEY, server.value);
  } catch { /* no storage */ }
}

/** The channel last shared from this page, and the name it was shared as, to copy. */
export const lastShared = signal<{ channel: string; named?: string } | undefined>(undefined);

/**
 * Whether the link menu is open, and what the share picker has chosen first:
 * the palette's "share…" opens it with the node it was opened on.
 */
export const linkMenu = signal<{ what?: Id } | undefined>(undefined);

const KIND_KEY = "ermine-link-kind";

/** Whether a new mount keeps a copy, as this browser last chose. */
export const mountKind = signal<"live" | "kept">((() => {
  try {
    return localStorage.getItem(KIND_KEY) === "kept" ? "kept" : "live";
  } catch {
    return "live";
  }
})());

export function setMountKind(kind: "live" | "kept") {
  mountKind.value = kind;
  try {
    localStorage.setItem(KIND_KEY, kind);
  } catch { /* no storage */ }
}

/** A share or a mount's options, as the line in the workspace gives them: only what is not the default. */
function options(o: { [k: string]: string | undefined }): string {
  const given = Object.entries({ ...o, url: server.value === SERVER ? undefined : server.value })
    .filter(([, v]) => v !== undefined && v !== "");
  return given.length ? `, { ${given.map(([k, v]) => `${k}: ${J(v)}`).join(", ")} }` : "";
}

/**
 * Shares a node's subtree, by a line in the workspace: on a fresh channel, or
 * on the channel a name stands for. Answers with the channel, and copies it,
 * or the name.
 */
export function shareNode(id: Id, name?: string): string | undefined {
  const as = name?.trim() || undefined;
  const s = act(
    `return share(${J(id)}${options({ name: as })})`,
    `${id === ROOT ? "share: workspace" : "share"}${as ? ` as ${as}` : ""}`,
  );
  if (!s.ok || !s.result) return;
  const channel = JSON.parse(s.result) as string;
  lastShared.value = { channel, ...(as ? { named: as } : {}) };
  copy(as ?? channel);
  return channel;
}

/**
 * Mounts a channel, given as its digits or a name, by a line in the
 * workspace, with its copy in the folder at (the root if not given), and
 * selects the mount.
 */
export function mountChannel(
  given: string,
  kind = mountKind.value,
  at: Id = ROOT,
): Id | undefined {
  const s = act(
    `return mount(${J(given.trim())}${
      options({ kind: kind === "kept" ? "kept" : undefined, at: at === ROOT ? undefined : at })
    })`,
    kind === "kept" ? "mount: keep a copy" : "mount",
  );
  if (!s.ok || !s.result) return;
  const pid = JSON.parse(s.result) as Id;
  select(pid, routeOf(pid));
  return pid;
}

function copy(text: string) {
  try {
    navigator.clipboard?.writeText(text).catch(() => {});
  } catch { /* no clipboard here */ }
}

/** A key or a channel, short: its first eight digits. */
export const short = (key: unknown) => typeof key === "string" ? key.slice(0, 8) : "?";

/** A link's state in a word, and the colour class it shows in. */
export function stateOf(l: LinkInfo): { word: string; cls: string; why?: string } {
  if (l.joining.state === "failed") {
    return { word: "no server", cls: "b-stop", why: l.joining.why };
  }
  const s = l.status?.state;
  if (l.joining.state === "connecting" || s === undefined || s === "connecting") {
    return { word: "connecting", cls: "b-prog" };
  }
  if (s === "dialing") return { word: "finding the owner", cls: "b-prog" };
  if (s === "gone") {
    return {
      word: "gone",
      cls: "b-stop",
      ...(typeof l.status?.why === "string" ? { why: l.status.why } : {}),
    };
  }
  if (l.role === "share") {
    const n = (l.status?.mounters as Json[] | undefined)?.length ?? 0;
    return { word: n ? `serving · ${n} mounted` : "serving", cls: "b-run" };
  }
  const sending = Number(l.status?.sending ?? 0);
  if (l.status?.refused) return { word: "the owner refused", cls: "b-stop" };
  return { word: sending ? `connected · ${sending} sending` : "connected", cls: "b-run" };
}

/** What a mount's node is, from the change that made what a read gives: the owner's copy, or a layer. */
export function linkOf(change: Header | undefined): "copy" | "layer" | undefined {
  const cause = change?.cause;
  if (!cause || typeof cause !== "object" || Array.isArray(cause)) return;
  if ("sending" in cause) return "layer";
  if ("link" in cause || "owner" in cause) return "copy";
}

/**
 * The owner's change a copy's change copies: a live mount's change has the
 * owner's agent, its cause {"link", "time", "process"?, "cause"?}; a kept
 * mount's change is its own, its cause {"owner": {"node", "time", "agent",
 * "process"?, "cause"?}}.
 */
export function ownerChange(
  change: Header | undefined,
): { time?: number; agent?: Json; process?: Json; cause?: Json } | undefined {
  const cause = change?.cause;
  if (!cause || typeof cause !== "object" || Array.isArray(cause)) return;
  if ("owner" in cause && cause.owner && typeof cause.owner === "object") {
    return cause.owner as { time?: number; agent?: Json; process?: Json; cause?: Json };
  }
  if ("link" in cause) {
    const c = cause as { time?: number; process?: Json; cause?: Json };
    return { ...c, agent: change?.agent };
  }
}

/** One line about an item a read of a mounted node gives. */
export function itemNote(item: ValueItem): string {
  const k = linkOf(item.change);
  if (k === "layer") return " · a layer: sent to the owner, not answered yet";
  if (k === "copy") {
    const t = ownerChange(item.change)?.time;
    return ` · the owner's copy${t === undefined ? "" : `, set @${t} there`}`;
  }
  return "";
}

/** A channel as it shows: the name the person gave it, if any, and its first digits. */
export function ChannelName({ l }: { l: { channel: string; named?: string } }) {
  return (
    <span class="channel-name" title={l.channel}>
      {l.named ? <b class="channel-word">{l.named}</b> : null}
      <code class="muted">{short(l.channel)}…</code>
    </span>
  );
}

/** The top bar's control: share, mount, the server, and the links running. */
export function LinkButton() {
  world.version.value;
  const links = world.links();
  const live = links.filter((l) => stateOf(l).cls === "b-run").length;
  const open = linkMenu.value !== undefined;
  return (
    <div class="boot">
      <button
        type="button"
        class="boot-btn"
        title="share what you choose on a channel or a name, or mount one: a link to another page's graph"
        onClick={() => (linkMenu.value = open ? undefined : {})}
      >
        ⇄ link{links.length ? ` · ${live}/${links.length}` : ""} <span class="caret-down">▾</span>
      </button>
      {open ? <LinkMenu close={() => (linkMenu.value = undefined)} /> : null}
    </div>
  );
}

function LinkMenu({ close }: { close: () => void }) {
  world.version.value;
  const [given, setGiven] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState(server.value);
  const sel = selectedFolder();
  const choices = shareable(sel);
  const asked = linkMenu.value?.what;
  const [what, setWhat] = useState<Id>(asked ?? sel);
  const chosen = choices.some((c) => c.id === what) ? what : choices[0].id;
  const places = mountable(sel);
  const [where, setWhere] = useState<Id>(sel);
  const into = places.some((c) => c.id === where) ? where : ROOT;
  const links = world.links();
  const shareAs = () => {
    if (name.trim() && shareNode(chosen, name)) setName("");
  };
  const mount = () => {
    if (given.trim() && mountChannel(given, mountKind.value, into)) setGiven("");
  };
  return (
    <div
      class="menu link-menu"
      onKeyDown={(e) => e.key === "Escape" && close()}
    >
      <div class="sub-title" style={{ marginTop: 0, display: "flex" }}>
        <span style={{ flex: 1 }}>share</span>
        <button type="button" class="ghostbtn" title="close" onClick={close}>✕</button>
      </div>
      <div class="link-step">
        <span class="link-step-n">1</span> what to share
      </div>
      <div class="link-pick" role="radiogroup" aria-label="what to share">
        {choices.map((c) => (
          <button
            type="button"
            key={c.id}
            role="radio"
            aria-checked={c.id === chosen}
            class={`link-choice${c.id === chosen ? " on" : ""}`}
            onClick={() => setWhat(c.id)}
          >
            <span class="pick-dot" />
            <span class="link-choice-label">{c.label}</span>
            {c.note ? <span class="muted">{c.note}</span> : null}
          </button>
        ))}
      </div>
      <div class="link-step">
        <span class="link-step-n">2</span> on what
      </div>
      <div class="row-actions" style={{ marginTop: 0 }}>
        <button
          type="button"
          class="mini go"
          title="a fresh random channel: only whoever you give it to can find it"
          onClick={() => shareNode(chosen)}
        >
          a fresh channel
        </button>
        <span class="muted">or</span>
        <input
          class="code"
          style={{ flex: 1, minWidth: 0 }}
          placeholder="share as a name… (kitchen)"
          title="a name stands for a channel: anyone who knows the name can mount it"
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === "Enter" && shareAs()}
        />
        <button type="button" class="mini go" disabled={!name.trim()} onClick={shareAs}>
          share
        </button>
      </div>
      {lastShared.value
        ? (
          <div class="kv">
            <span class="k">shared on</span>
            <span class="v">
              {lastShared.value.named ? <b class="channel-word">{lastShared.value.named}</b> : null}
              <code style={{ wordBreak: "break-all", fontSize: "11px" }}>
                {lastShared.value.channel}
              </code>
              <button
                type="button"
                class="mini"
                onClick={() => copy(lastShared.value!.named ?? lastShared.value!.channel)}
              >
                copy
              </button>
            </span>
          </div>
        )
        : null}
      <div class="hint">
        whoever has the channel can mount it, read and write what it shares: the channel is the key,
        and a name is a meeting place, not a secret. the whole workspace shares everything in it
      </div>
      <div class="sub-title">mount</div>
      <div class="row-actions" style={{ marginTop: 0 }}>
        <input
          class="code"
          style={{ flex: 1, minWidth: 0 }}
          placeholder="a channel (64 hex digits), or a name"
          value={given}
          onInput={(e) => setGiven((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === "Enter" && mount()}
        />
      </div>
      <div class="row-actions">
        <span class="muted">put the copy in</span>
        <select
          class="code"
          style={{ flex: 1, minWidth: 0 }}
          title="where the copy goes: any folder"
          value={into}
          onChange={(e) => setWhere((e.target as HTMLSelectElement).value)}
        >
          {places.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </div>
      <div
        class="row-actions"
        role="radiogroup"
        title="what a new mount does"
      >
        {(["live", "kept"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={mountKind.value === k}
            class={`mini${mountKind.value === k ? " go" : ""}`}
            title={k === "kept"
              ? "the copy is ordinary nodes, kept here: there after a reload as last seen"
              : "the copy is the mount's own, ephemeral: nobody keeps it, it goes with the mount"}
            onClick={() => setMountKind(k)}
          >
            {k === "kept" ? "keep a copy" : "live only"}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button type="button" class="mini go" disabled={!given.trim()} onClick={mount}>
          mount
        </button>
      </div>
      <div class="sub-title">server</div>
      <div class="row-actions" style={{ marginTop: 0 }}>
        <input
          class="code"
          style={{ flex: 1, minWidth: 0 }}
          value={url}
          onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
          onBlur={() => setServer(url)}
          onKeyDown={(e) => e.key === "Enter" && setServer(url)}
        />
        {server.value === SERVER ? null : (
          <button
            type="button"
            class="mini"
            onClick={() => {
              setServer(SERVER);
              setUrl(SERVER);
            }}
          >
            default
          </button>
        )}
      </div>
      <div class="hint">a Subduction server: new shares and mounts go through it</div>
      {links.length
        ? (
          <>
            <div class="sub-title">running</div>
            {links.map((l) => <LinkRow key={l.pid} l={l} />)}
          </>
        )
        : null}
    </div>
  );
}

function LinkRow({ l }: { l: LinkInfo }) {
  const s = stateOf(l);
  return (
    <div class="kv" title={s.why}>
      <span class="k">{l.role}{l.kind === "kept" ? " · kept" : ""}</span>
      <span class="v">
        <button
          type="button"
          class="mini"
          title={`select ${l.pid}`}
          onClick={() => select(l.pid, routeOf(l.pid))}
        >
          /{l.address.join("/")}
        </button>
        <ChannelName l={l} />
        <span class={`badge ${s.cls}`}>{s.word}</span>
        <button
          type="button"
          class="mini"
          title={l.named ? `copy the name: ${l.named}` : `copy the channel: ${l.channel}`}
          onClick={() => copy(l.named ?? l.channel)}
        >
          copy
        </button>
      </span>
    </div>
  );
}

/** The node selected: the root if nothing is. */
function selectedFolder(): Id {
  const id = selected.value?.id;
  return id && world.made.has(id) ? id : ROOT;
}

/** A node as a choice: its address from the root, or its id if none reaches it. */
function labelOf(id: Id): string {
  const a = world.addressOf(id);
  return a ? "/" + a.join("/") : id;
}

/**
 * What the share picker offers: the whole workspace, the node selected, and
 * each folder in the root. Nothing is left out.
 */
function shareable(sel: Id): { id: Id; label: string; note?: string }[] {
  const out: { id: Id; label: string; note?: string }[] = [
    { id: ROOT, label: "the whole workspace", note: "everything: programs, loaders and all" },
  ];
  if (sel !== ROOT) out.push({ id: sel, label: labelOf(sel), note: "selected" });
  for (const [name, ids] of world.slotsOf(ROOT)) {
    const id = ids[0];
    if (id === undefined || id === sel || !world.made.has(id)) continue;
    out.push({ id, label: `/${name}` });
  }
  return out;
}

/** Where a mount's copy can go: the node selected, the root, and each folder in the root. */
function mountable(sel: Id): { id: Id; label: string }[] {
  const out: { id: Id; label: string }[] = [];
  if (sel !== ROOT) out.push({ id: sel, label: `${labelOf(sel)} (selected)` });
  out.push({ id: ROOT, label: "/ (the root)" });
  for (const [name, ids] of world.slotsOf(ROOT)) {
    const id = ids[0];
    if (id === undefined || id === sel || !world.made.has(id)) continue;
    out.push({ id, label: `/${name}` });
  }
  return out;
}

/** The palette's commands for links, where the palette was opened. */
export function linkCommands(where: Selection) {
  const here = where.id === ROOT ? "the root" : labelOf(where.id);
  return [
    {
      group: "link",
      title: "share…",
      hint: "choose what to share, then a fresh channel or a name",
      run: () => (linkMenu.value = { what: where.id }),
    },
    {
      group: "link",
      title: `mount a channel or a name in ${here}, live only`,
      hint: "a copy of what another page shares, kept in step; nobody keeps it",
      ask: { prompt: "a channel (64 hex digits), or a name", initial: "" },
      run: (c?: string) => c && mountChannel(c, "live", where.id),
    },
    {
      group: "link",
      title: `mount a channel or a name in ${here}, keeping a copy`,
      hint: "a copy of what another page shares, kept here: there after a reload",
      ask: { prompt: "a channel (64 hex digits), or a name", initial: "" },
      run: (c?: string) => c && mountChannel(c, "kept", where.id),
    },
  ];
}

/** The inspector's part for a link: a share or a mount's process, or a node of a mount. */
export function LinkPart({ id }: { id: Id }) {
  world.version.value;
  const role = world.builtinOf(id);
  if (role === "share" || role === "mirror" || role === "mirror-kept") {
    const l = world.links().find((x) => x.pid === id);
    if (!l) return null;
    return <ProcessLink l={l} />;
  }
  const m = world.mountOf(id);
  if (!m) return null;
  const made = world.made.get(id);
  const layer = linkOf(made) === "layer";
  // the change that set what it reads now: the copy's last, not the placement that made it
  const now = world.read(id);
  const last = "items" in now ? now.items[0]?.change : undefined;
  const value = "value" in now ? now.value : undefined;
  return (
    <Section title={layer ? "a layer" : "mounted"}>
      <div class="hint">
        {layer
          ? "what was sent to the owner, shown at once in front of the copy: it goes when the owner answers, and the copy takes the owner's value, or the refusal shows on the mount"
          : m.kind === "kept"
          ? "a copy of the owner's node, kept here: an ordinary node, there after a reload as it was last seen. a write here is sent to the owner, and shows at once as a layer in front"
          : "a copy of the owner's node, kept by the mount: ephemeral, so nobody keeps it here. a write here is sent to the owner, and shows at once as a layer in front"}
      </div>
      {m.path
        ? (
          <div class="kv">
            <span class="k">at the owner</span>
            <span class="v">
              <code>/{m.path.join("/")}</code>
            </span>
          </div>
        )
        : null}
      {layer ? null : <OwnerChange change={last ?? made} />}
      <Screen value={value} />
      <div class="kv">
        <span class="k">mount</span>
        <span class="v">
          <button type="button" class="mini" onClick={() => select(m.pid, routeOf(m.pid))}>
            {m.pid}
          </button>
        </span>
      </div>
    </Section>
  );
}

/**
 * Who changed a copy at the owner, and why: the copy's change has the owner's
 * agent, and its cause {"link", "time", "process"?, "cause"?} says the
 * owner's time, process, and cause (its site, for a change from outside any
 * process there): a site on the owner's page, not this one.
 */
function OwnerChange({ change }: { change: Header | undefined }) {
  const c = ownerChange(change);
  if (!c) return null;
  const agent = c.agent;
  const site = siteOf(c.cause);
  return (
    <>
      <div class="kv">
        <span class="k">there</span>
        <span class="v">
          <code>{J(agent ?? null)}</code>
          {c.time === undefined ? null : <span class="at">@{c.time}</span>}
          {c.process === undefined
            ? null
            : <span class="muted">as process {String(c.process)}</span>}
        </span>
      </div>
      {site
        ? (
          <div class="kv">
            <span class="k">site</span>
            <span class="v">
              <span class="site" title="where the owner's change was made: on the owner's page">
                ⇄ {site.file}:{site.line}:{site.column} on the owner's page
              </span>
            </span>
          </div>
        )
        : c.cause === undefined
        ? null
        : (
          <div class="kv">
            <span class="k">cause</span>
            <span class="v">
              <code>{J(c.cause)}</code>
            </span>
          </div>
        )}
    </>
  );
}

function ProcessLink({ l }: { l: LinkInfo }) {
  const s = stateOf(l);
  const st = l.status ?? {};
  // a live mount lists the last ten; a kept one says the last, until the owner next takes something
  type Refusal = { cmd: string; address: string[]; error: Json };
  const r = st.refused as Refusal[] | Refusal | undefined;
  const refused = Array.isArray(r) ? r : r ? [r] : [];
  return (
    <Section title={l.role === "share" ? "sharing" : "mounted"}>
      <div class="kv">
        <span class="k">state</span>
        <span class="v">
          <span class={`badge ${s.cls}`}>{s.word}</span>
          {s.why ? <span class="muted">{s.why}</span> : null}
        </span>
      </div>
      <div class="kv">
        <span class="k">channel</span>
        <span class="v">
          {l.named
            ? (
              <>
                <b class="channel-word">{l.named}</b>
                <button type="button" class="mini" onClick={() => copy(l.named!)}>
                  copy the name
                </button>
              </>
            )
            : null}
          <code style={{ wordBreak: "break-all", fontSize: "11px" }}>{l.channel}</code>
          <button type="button" class="mini" onClick={() => copy(l.channel)}>copy</button>
        </span>
      </div>
      <div class="kv">
        <span class="k">server</span>
        <span class="v">
          <code>{l.url}</code>
        </span>
      </div>
      <div class="kv">
        <span class="k">{l.role === "share" ? "serves" : "copy at"}</span>
        <span class="v">
          <code>/{l.address.join("/")}</code>
        </span>
      </div>
      {l.role === "mount"
        ? (
          <div class="kv">
            <span class="k">kind</span>
            <span class="v">
              {l.kind === "kept"
                ? "keeps a copy: ordinary nodes, kept here, there after a reload"
                : "live only: the mount's ephemeral nodes, nobody keeps them"}
            </span>
          </div>
        )
        : null}
      {l.joining.state === "connected"
        ? (
          <div class="kv" title={l.joining.self}>
            <span class="k">this peer</span>
            <span class="v">
              <code>{short(l.joining.self)}…</code>
            </span>
          </div>
        )
        : null}
      {l.role === "mount" && st.owner
        ? (
          <div class="kv" title={String(st.owner)}>
            <span class="k">owner</span>
            <span class="v">
              <code>{short(st.owner)}…</code>
            </span>
          </div>
        )
        : null}
      {l.role === "share"
        ? (
          <div class="kv">
            <span class="k">mounters</span>
            <span class="v">
              {((st.mounters as string[] | undefined) ?? []).length
                ? (st.mounters as string[]).map((p) => <code key={p} title={p}>{short(p)}…</code>)
                : <span class="muted">nobody yet</span>}
            </span>
          </div>
        )
        : null}
      {refused.length
        ? (
          <>
            <div class="sub-title">the owner refused</div>
            {refused.map((r, i) => (
              <div key={i} class="error-line">
                ✕ {r.cmd} /{r.address.join("/")}: {errorText(r.error)}
              </div>
            ))}
          </>
        )
        : null}
      <div class="row-actions">
        <button
          type="button"
          class="mini danger"
          onClick={() => act(`stop(${J(l.pid)})`, l.role === "share" ? "stop sharing" : "unmount")}
        >
          {l.role === "share" ? "stop sharing" : "unmount"}
        </button>
        {st.state === "gone" || l.joining.state === "failed"
          ? (
            <button
              type="button"
              class="mini go"
              title="start its program again where it was, on the same channel"
              onClick={() => {
                const s = act(`return replace(${J(l.pid)})`, "link again");
                if (s.ok && s.result) {
                  const pid = JSON.parse(s.result) as Id;
                  select(pid, routeOf(pid));
                }
              }}
            >
              again
            </button>
          )
          : null}
      </div>
    </Section>
  );
}

function errorText(e: Json): string {
  if (!e || typeof e !== "object" || Array.isArray(e)) return J(e);
  const why = (e as { why?: { code?: string; text?: string } }).why;
  return `${(e as { kind?: string }).kind ?? "error"}: ${why?.text ?? why?.code ?? ""}`;
}

/**
 * A screen, as the C terminal's windows have it ({"rows", "cols", "lines":
 * [text…]}): its lines as a grid, so a mounted window reads as it shows.
 */
function Screen({ value }: { value: Json | undefined }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const lines = (value as { lines?: unknown }).lines;
  if (!Array.isArray(lines) || !lines.every((l) => typeof l === "string")) return null;
  const cols = (value as { cols?: unknown }).cols;
  return (
    <div class="kv">
      <span class="k">screen</span>
      <span class="v">
        <pre
          class="code"
          style={{
            margin: 0,
            padding: "4px 6px",
            lineHeight: 1.2,
            fontSize: "11px",
            overflowX: "auto",
            maxWidth: "100%",
            whiteSpace: "pre",
            ...(typeof cols === "number" ? { minWidth: `min(${cols}ch, 100%)` } : {}),
          }}
        >{(lines as string[]).join("\n")}</pre>
      </span>
    </div>
  );
}

/** The browser's mark for a node of a link: a layer, a mount's copy, or a link's process. */
export function linkMark(id: Id): { glyph: string; title: string; word?: string } | undefined {
  const role = world.builtinOf(id);
  if (role === "share" || role === "mirror" || role === "mirror-kept") {
    const l = world.links().find((x) => x.pid === id);
    if (!l) return;
    const s = stateOf(l);
    return {
      glyph: role === "share" ? "⇡" : "⇣",
      title: `${l.role}${l.kind === "kept" ? " (keeping a copy)" : ""} on ${
        l.named ? `"${l.named}" (${short(l.channel)}…)` : `${short(l.channel)}…`
      }: ${s.word}${s.why ? ` (${s.why})` : ""}`,
      word: s.word,
    };
  }
  const m = world.mountOf(id);
  if (!m) return;
  return linkOf(world.made.get(id)) === "layer"
    ? { glyph: "◌", title: "a layer: sent to the owner, not answered yet" }
    : {
      glyph: "⇄",
      title: m.kind === "kept"
        ? "mounted, kept: a copy of the owner's node, kept here"
        : "mounted: a copy of the owner's node",
    };
}
