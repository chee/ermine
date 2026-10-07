/// <reference lib="dom" />
// Small pieces every pane uses.

import type { ComponentChildren } from "preact";
import { type Id, isBytes, type Json, kindOf, type Site, type Step } from "../../../src/mod.ts";
import { consoleAt, consoleOpen, focus, pointAt, select, shell, world } from "./state.ts";
import { actorOf, J, peerOf } from "./world.ts";

/** One step of a process agent's code: the process, and what it was doing. */
type CodeStep = {
  process?: string;
  program?: { node: string; time: number };
  run?: number;
  handler?: string;
  lasting?: number;
  item?: string;
  cleanup?: true;
};

function doing(s: CodeStep): string {
  if (s.run !== undefined) return `#${s.run}`;
  if (s.handler !== undefined) return `↯ ${s.handler}`;
  if (s.lasting !== undefined) return `lasting #${s.lasting}`;
  if (s.item !== undefined) return `item ${s.item}`;
  if (s.cleanup) return "cleanup";
  return "";
}

/**
 * An agent: its actor, and, for a process's, the code the change went
 * through, outermost first (SCHEDULER.tex, What a process acts as).
 */
export function Agent({ agent }: { agent: Json }) {
  world.version.value;
  const actor = actorOf(agent);
  const name = typeof actor === "string" ? actor : J(actor);
  // a mounter's: the owner stamped the key it came from
  const peer = peerOf(agent);
  const code = agent && typeof agent === "object" && !Array.isArray(agent) &&
      Array.isArray((agent as { code?: unknown }).code)
    ? (agent as unknown as { code: CodeStep[] }).code
    : [];
  return (
    <span class="agent-with">
      <span class={`agent c-${world.colorOf(agent)}`}>{name}</span>
      {peer === undefined ? null : (
        <span
          class="via"
          title={`a mounter's change: the key it came from on the channel, ${peer}`}
        >
          {` ⇄ ${peer.slice(0, 8)}…`}
        </span>
      )}
      {code.map((s, i) => (
        <span
          class="via"
          key={i}
          title={`through ${s.process}, running ${s.program?.node}@${s.program?.time}`}
        >
          {` › ◉ ${s.process} ${doing(s)}`}
        </span>
      ))}
    </span>
  );
}

export function NodeLink({ id, route }: { id: Id; route?: Step[] }) {
  world.version.value;
  const exists = world.made.has(id);
  const proc = world.isProcess(id);
  const eph = world.ephemeral.has(id);
  return (
    <button
      type="button"
      class={`nodelink${exists ? "" : " ghost"}${proc ? " proc" : ""}`}
      title={exists
        ? `inspect ${id}${eph ? " (ephemeral: nobody keeps it)" : ""}`
        : `${id} is absent`}
      style={eph ? { fontStyle: "italic" } : undefined}
      onClick={(e) => {
        e.stopPropagation();
        select(id, route ?? []);
      }}
    >
      {proc ? "◉ " : eph ? "~ " : ""}
      {id}
    </button>
  );
}

/** A change, named by its time: the node it changed, and when. */
export function Ref({ r }: { r: number }) {
  world.version.value;
  const c = world.header(r);
  return (
    <button
      type="button"
      class="ref"
      title={c?.ephemeral
        ? "why? an ephemeral change: nobody keeps it"
        : "why? explain this change"}
      style={c?.ephemeral ? { fontStyle: "italic" } : undefined}
      onClick={(e) => {
        e.stopPropagation();
        focus.value = { t: "change", ref: r };
      }}
    >
      {c?.node ?? "?"}
      <span class="at">@{r}</span>
    </button>
  );
}

export function SiteLink({ site, remote }: { site: Site; remote?: boolean }) {
  world.version.value;
  const m = site.file.match(/^snippet-(\d+)$/);
  if (remote) {
    // a mounter's change, through a share: the site is on the mounter's page, not this one
    return (
      <span
        class="site"
        title="a mounter made this change, through a share: the site is on its page"
      >
        ⇄ {site.file}:{site.line}:{site.column} on a mounter's page
      </span>
    );
  }
  const c = site.file.match(/^console-(\d+)$/);
  if (c) {
    const n = Number(c[1]);
    return (
      <button
        type="button"
        class="site"
        title="the console line that made this change"
        onClick={(e) => {
          e.stopPropagation();
          consoleOpen.value = true;
          consoleAt.value = n;
        }}
      >
        › {site.file}:{site.line}:{site.column}
      </button>
    );
  }
  if (!m) {
    return <span class="site">{site.file}:{site.line}:{site.column}</span>;
  }
  const n = Number(m[1]);
  return (
    <button
      type="button"
      class="site"
      title="the line in the workspace that made this change"
      onClick={(e) => {
        e.stopPropagation();
        focus.value = { t: "snippet", n, line: site.line };
        pointAt.value = { n, line: site.line };
      }}
    >
      ✎ {site.file}:{site.line}:{site.column}
    </button>
  );
}

/** The line of a snippet's code a site names, or the console line. */
export function siteLine(site: Site): string | undefined {
  const c = site.file.match(/^console-(\d+)$/);
  if (c) return shell.line(Number(c[1]));
  const m = site.file.match(/^snippet-(\d+)$/);
  if (!m) return;
  const s = world.snippets[Number(m[1]) - 1];
  return s?.code.split("\n")[site.line - 1];
}

export function Json({ value, depth = 0 }: { value: Json | undefined; depth?: number }) {
  world.version.value;
  if (depth === 0 && value !== null && typeof value === "object" && plainish(value)) {
    const short = JSON.stringify(value).length <= 56;
    return (
      <span class={short ? "j-inline" : ""}>
        <Json value={value} depth={1} />
      </span>
    );
  }
  if (value === undefined) return <span class="j-absent">absent</span>;
  if (isBytes(value)) return <Bytes value={value} />;
  if (kindOf(value)) return <Typed value={value as ArrayLike<number | bigint>} />;
  if (
    value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null
  ) {
    return <span class="j-absent">live · {value.constructor?.name ?? "thing"}</span>;
  }
  if (value === null) return <span class="j-null">null</span>;
  if (typeof value === "string") {
    return <span class="j-str">{J(value)}</span>;
  }
  if (typeof value === "number") return <span class="j-num">{value}</span>;
  if (typeof value === "boolean") return <span class="j-bool">{String(value)}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span class="j-punct">[]</span>;
    if (depth > 4) return <span class="j-punct">[…{value.length}]</span>;
    return (
      <span class="j-list">
        <span class="j-punct">[</span>
        <span class="j-body">
          {value.map((v, i) => (
            <span class="j-row" key={i}>
              <Json value={v} depth={depth + 1} />
              {i < value.length - 1 ? <span class="j-punct">,</span> : null}
            </span>
          ))}
        </span>
        <span class="j-punct">]</span>
      </span>
    );
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return <span class="j-punct">{"{}"}</span>;
  if (depth > 4) return <span class="j-punct">{`{…${entries.length}}`}</span>;
  return (
    <span class="j-obj">
      <span class="j-punct">{"{"}</span>
      <span class="j-body">
        {entries.map(([k, v], i) => (
          <span class="j-row" key={k}>
            <span class="j-key">{k}</span>
            <span class="j-punct">:</span> <Json value={v} depth={depth + 1} />
            {i < entries.length - 1 ? <span class="j-punct">,</span> : null}
          </span>
        ))}
      </span>
      <span class="j-punct">{"}"}</span>
    </span>
  );
}

/** A short, one-line look at a value. */
/** Whether a node's value is code: it is in a program or renderer slot, or reads as code. */
export function codeLike(id: Id, v: Json | undefined): v is string {
  if (typeof v !== "string") return false;
  for (const p of world.placements().get(id) ?? []) {
    if (p.name === "compute" || p.name === "effect" || p.name.startsWith("render-")) return true;
  }
  return /\breturn\b|=>|\bexport default\b|\bconst\b|\bfunction\b/.test(v);
}

export function peek(v: Json | undefined, max = 32): string {
  if (v === undefined) return "absent";
  if (isBytes(v)) return `bytes · ${size(v.byteLength)}`;
  const kind = kindOf(v);
  if (kind) return `${kind}[${(v as ArrayLike<unknown>).length}]`;
  if (!plainish(v)) {
    return typeof v === "object" && v !== null && !Array.isArray(v) &&
        Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null
      ? `live · ${(v as object).constructor?.name ?? "thing"}`
      : (Array.isArray(v) ? `[…${v.length}]` : `{…}`);
  }
  const s = typeof v === "string" ? J(v) : JSON.stringify(v);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function Ending({ ending }: { ending: string }) {
  world.version.value;
  const glyph = { done: "✓", pending: "…", failed: "✕", refused: "⊘" }[ending] ?? "?";
  return <span class={`ending e-${ending}`}>{glyph} {ending}</span>;
}

export function Section(
  { title, children, aside, open = true }: {
    title: ComponentChildren;
    children: ComponentChildren;
    aside?: ComponentChildren;
    open?: boolean;
  },
) {
  world.version.value;
  return (
    <details class="section" open={open}>
      <summary>
        <span class="section-title">{title}</span>
        {aside ? <span class="section-aside">{aside}</span> : null}
      </summary>
      <div class="section-body">{children}</div>
    </details>
  );
}

export function Empty({ children }: { children: ComponentChildren }) {
  world.version.value;
  return <div class="empty">{children}</div>;
}

/** A field that commits on enter, for code-shaped input. */
export function parseJson(text: string): { ok: true; value: Json } | { ok: false; why: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }
}

/** A JSON literal for code: valid JSON stays as written, anything else becomes a string. */
export function literal(text: string): string {
  const t = text.trim();
  if (t === "") return "null";
  try {
    JSON.parse(t);
    return t;
  } catch {
    return J(text);
  }
}

/** Whether JSON.stringify shows a value as it is: nothing in it is bytes, a typed array or live. */
function plainish(v: unknown): boolean {
  if (v === null || typeof v !== "object") return typeof v !== "function";
  if (Array.isArray(v)) return v.every(plainish);
  const proto = Object.getPrototypeOf(v);
  return (proto === Object.prototype || proto === null) && Object.values(v).every(plainish);
}

function size(n: number): string {
  return n < 1024
    ? `${n} B`
    : n < 1048576
    ? `${(n / 1024).toFixed(1)} KB`
    : `${(n / 1048576).toFixed(1)} MB`;
}

/** The kind of image some bytes are, by their first bytes, if they are one. */
function imageKind(b: Uint8Array): string | undefined {
  const at = (...xs: number[]) => xs.every((x, i) => b[i] === x);
  if (at(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
}

const thumbs = new WeakMap<ArrayBuffer, string>();

/** Bytes: how many, the first of them, and an image's as a thumbnail. */
function Bytes({ value }: { value: ArrayBuffer }) {
  const u = new Uint8Array(value);
  const kind = imageKind(u);
  let url = kind ? thumbs.get(value) : undefined;
  if (kind && !url) {
    url = URL.createObjectURL(new Blob([value], { type: kind }));
    thumbs.set(value, url);
  }
  const hex = [...u.subarray(0, 12)].map((x) => x.toString(16).padStart(2, "0")).join(" ");
  return (
    <span class="j-bytes" title={`${value.byteLength} bytes${kind ? ", " + kind : ""}`}>
      {url
        ? (
          <img
            src={url}
            alt=""
            style={{
              height: "48px",
              imageRendering: "pixelated",
              verticalAlign: "middle",
              marginRight: "6px",
              background: "var(--sunk)",
            }}
          />
        )
        : null}
      <span class="j-num">bytes</span> <span class="j-punct">· {size(value.byteLength)}</span>{" "}
      <span class="j-str">{hex}{u.length > 12 ? " …" : ""}</span>
    </span>
  );
}

/** A typed array: its kind, how many elements, and the first of them. */
function Typed({ value }: { value: ArrayLike<number | bigint> }) {
  const kind = kindOf(value)!;
  const first = Array.from({ length: Math.min(8, value.length) }, (_, i) => String(value[i]));
  return (
    <span class="j-typed" title={`a typed array of ${value.length} ${kind} elements`}>
      <span class="j-num">{kind}</span>
      <span class="j-punct">[{value.length}]</span>{" "}
      <span class="j-str">{first.join(", ")}{value.length > 8 ? ", …" : ""}</span>
    </span>
  );
}
