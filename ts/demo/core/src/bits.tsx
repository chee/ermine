/// <reference lib="dom" />
// Small pieces every pane uses.

import type { ComponentChildren } from "preact";
import type { ChangeRef, Id, Json, Site } from "../../../src/mod.ts";
import { focus, pointAt, select, world } from "./state.ts";
import { J } from "./world.ts";

export function Agent({ agent }: { agent: Json }) {
  world.version.value;
  const name = typeof agent === "string" ? agent : J(agent);
  return <span class={`agent c-${world.colorOf(agent)}`}>{name}</span>;
}

export function NodeLink({ id, route }: { id: Id; route?: import("../../../src/mod.ts").Step[] }) {
  world.version.value;
  const exists = world.made.has(id);
  return (
    <button
      type="button"
      class={`nodelink${exists ? "" : " ghost"}${world.isProcess(id) ? " proc" : ""}`}
      title={exists ? `inspect ${id}` : `${id} is absent`}
      onClick={(e) => {
        e.stopPropagation();
        select(id, route ?? []);
      }}
    >
      {world.isProcess(id) ? "◉ " : ""}
      {id}
    </button>
  );
}

export function Ref({ r }: { r: ChangeRef }) {
  world.version.value;
  return (
    <button
      type="button"
      class="ref"
      title="why? explain this change"
      onClick={(e) => {
        e.stopPropagation();
        focus.value = { t: "change", ref: r };
      }}
    >
      {r.node}
      <span class="at">@{r.time}</span>
    </button>
  );
}

export function SiteLink({ site }: { site: Site }) {
  world.version.value;
  const m = site.file.match(/^snippet-(\d+)$/);
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

/** The line of a snippet's code a site names. */
export function siteLine(site: Site): string | undefined {
  const m = site.file.match(/^snippet-(\d+)$/);
  if (!m) return;
  const s = world.snippets[Number(m[1]) - 1];
  return s?.code.split("\n")[site.line - 1];
}

export function Json({ value, depth = 0 }: { value: Json | undefined; depth?: number }) {
  world.version.value;
  if (depth === 0 && value !== null && typeof value === "object") {
    const short = JSON.stringify(value).length <= 56;
    return (
      <span class={short ? "j-inline" : ""}>
        <Json value={value} depth={1} />
      </span>
    );
  }
  if (value === undefined) return <span class="j-absent">absent</span>;
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
export function peek(v: Json | undefined, max = 32): string {
  if (v === undefined) return "absent";
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
