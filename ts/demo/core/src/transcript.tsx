/// <reference lib="dom" />
// The transcript: every change, run, stop and error, newest first. And the
// why pane: a change or a run explained, back to the line of code it came from.

import { useState } from "preact/hooks";
import type { Change, ChangeRef, Record as Run } from "../../../src/mod.ts";
import {
  Agent,
  Empty,
  Ending,
  Json as JsonView,
  NodeLink,
  peek,
  Ref,
  siteLine,
  SiteLink,
} from "./bits.tsx";
import { describe } from "./inspector.tsx";
import { dock, draft, focus, pointAt, selected, world } from "./state.ts";
import { type Entry, key } from "./world.ts";

type Filter = "all" | "changes" | "runs" | "trouble" | "here";

export function Right() {
  world.version.value;
  return (
    <aside class="pane right">
      {focus.value ? <Why /> : null}
      <Transcript />
    </aside>
  );
}

function Transcript() {
  world.version.value;
  const [filter, setFilter] = useState<Filter>("all");
  const here = selected.value?.id;
  const keep = (e: Entry) => {
    switch (filter) {
      case "all":
        return true;
      case "changes":
        return e.t === "change";
      case "runs":
        return e.t === "record" || e.t === "stopped";
      case "trouble":
        return e.t === "error" ||
          (e.t === "record" && (e.record.ending === "failed" || e.record.ending === "refused"));
      case "here":
        return (e.t === "change" && e.change.node === here) ||
          (e.t === "record" && e.record.process === here) ||
          (e.t === "stopped" && e.process === here);
    }
  };
  const shown = world.log.filter(keep).slice(-400).reverse();
  return (
    <div class="transcript">
      <div class="pane-head">
        <span class="pane-title">transcript</span>
        <div class="seg small">
          {(["all", "changes", "runs", "trouble", "here"] as Filter[]).map((f) => (
            <button
              type="button"
              class={filter === f ? "on" : ""}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      <div class="entries">
        {shown.length === 0 ? <Empty>nothing has happened yet.</Empty> : null}
        {shown.map((e) => <EntryRow e={e} key={e.n} />)}
      </div>
    </div>
  );
}

function EntryRow({ e }: { e: Entry }) {
  world.version.value;
  const f = focus.value;
  switch (e.t) {
    case "change": {
      const c = e.change;
      const sel = f?.t === "change" && f.ref.node === c.node && f.ref.time === c.time;
      return (
        <div
          class={`entry ch${sel ? " sel" : ""}`}
          onClick={() => (focus.value = { t: "change", ref: c })}
        >
          <span class="t">@{c.time}</span>
          <span class={`kind-tag kt-${c.kind}`}>{c.kind}</span>
          <span class="entry-node">{c.node}</span>
          <span class="entry-what">{describe(c)}</span>
          <span class="entry-who">
            <Agent agent={c.agent} />
            {c.process ? <span class="via">◉ {c.process}</span> : null}
            {c.site ? <span class="via">✎ {c.site.file}:{c.site.line}</span> : null}
          </span>
        </div>
      );
    }
    case "record": {
      const r = e.record;
      const sel = f?.t === "record" && f.process === r.process && f.run === r.run;
      return (
        <div
          class={`entry rec e-${r.ending}${sel ? " sel" : ""}`}
          onClick={() => (focus.value = { t: "record", process: r.process, run: r.run })}
        >
          <span class="t">▷</span>
          <span class="entry-node">{r.process}</span>
          <span class="muted">#{r.run}</span>
          <Ending ending={r.ending} />
          <span class="entry-what">{"value" in r ? peek(r.value, 26) : ""}</span>
          <span class="entry-who">
            {r.marked.length
              ? <span class="via">← {r.marked.map((m) => `${m.node}@${m.time}`).join(" ")}</span>
              : null}
          </span>
        </div>
      );
    }
    case "stopped":
      return (
        <div class="entry stop">
          <span class="t">■</span>
          <span class="entry-node">{e.process}</span>
          <span class="muted">stopped</span>
        </div>
      );
    case "error":
      return (
        <div
          class="entry err"
          onClick={() => e.snippet && (focus.value = { t: "snippet", n: e.snippet })}
        >
          <span class="t">✕</span>
          <span class={`kind-tag kt-${e.error.kind}`}>{e.error.kind}</span>
          <span class="entry-what">{e.error.op ? <b>{e.error.op}:</b> : null}{e.error.why}</span>
          {e.snippet ? <span class="via">✎ snippet-{e.snippet}</span> : null}
        </div>
      );
    case "snippet": {
      const s = world.snippets[e.snippet - 1];
      return (
        <div class="entry snip" onClick={() => (focus.value = { t: "snippet", n: e.snippet })}>
          <span class="t">✎</span>
          <span class="entry-node">snippet-{e.snippet}</span>
          <span class="entry-what muted">
            {s?.label ?? s?.code.split("\n").find((l) => l.trim() && !l.trim().startsWith("//"))}
          </span>
          <Agent agent={s?.agent ?? ""} />
        </div>
      );
    }
  }
}

// --- why ---

function Why() {
  world.version.value;
  const f = focus.value!;
  return (
    <div class="why">
      <div class="pane-head">
        <span class="pane-title">why</span>
        <button type="button" class="mini" onClick={() => (focus.value = undefined)}>
          close ✕
        </button>
      </div>
      <div class="why-body">
        {f.t === "change" ? <WhyChange r={f.ref} /> : null}
        {f.t === "record" ? <WhyRun process={f.process} run={f.run} /> : null}
        {f.t === "snippet" ? <WhySnippet n={f.n} line={f.line} /> : null}
      </div>
    </div>
  );
}

/** From a change back to where it came from: runs that made it, and what marked them. */
function chain(r: ChangeRef): { change?: Change; ref: ChangeRef; run?: Run }[] {
  const out: { change?: Change; ref: ChangeRef; run?: Run }[] = [];
  const seen = new Set<string>();
  let cur: ChangeRef | undefined = r;
  while (cur && !seen.has(key(cur)) && out.length < 24) {
    seen.add(key(cur));
    const change = world.changes.get(key(cur));
    const run: Run | undefined = change?.process ? world.producedBy.get(key(cur)) : undefined;
    out.push({ change, ref: cur, run });
    cur = run?.marked[0];
  }
  return out;
}

function WhyChange({ r }: { r: ChangeRef }) {
  world.version.value;
  const c = world.changes.get(key(r));
  if (!c) return <Empty>no change {r.node}@{r.time} in this graph.</Empty>;
  const links = chain(r);
  const marked = world.marked.get(key(r)) ?? [];
  return (
    <div class="why-change">
      <div class="why-title">
        <span class={`kind-tag kt-${c.kind}`}>{c.kind}</span> <NodeLink id={c.node} />
        <span class="at">@{c.time}</span>
      </div>
      <div class="why-what">{describe(c)}</div>
      {c.kind === "write"
        ? (
          <div class="value-view small">
            <JsonView value={c.patches as never} />
          </div>
        )
        : null}
      {c.kind === "make" && "data" in c
        ? (
          <div class="kv">
            <span class="k">data</span>
            <span class="v">
              <JsonView value={c.data} />
            </span>
          </div>
        )
        : null}
      {"cause" in c
        ? (
          <div class="kv">
            <span class="k">cause</span>
            <span class="v">
              <JsonView value={c.cause} />
            </span>
          </div>
        )
        : null}
      <div class="because">
        {links.map((l, i) => {
          const ch = l.change;
          return (
            <div class="link">
              <div class="link-dot" />
              <div class="link-body">
                {i > 0 ? <div class="link-why">because it was marked by</div> : null}
                <div>
                  <Ref r={l.ref} /> {ch ? <span class="muted">{describe(ch)}</span> : null}
                </div>
                {ch
                  ? (
                    <div class="link-who">
                      by <Agent agent={ch.agent} />
                      {ch.process
                        ? (
                          <>
                            {" "}as process <NodeLink id={ch.process} />
                            {l.run
                              ? (
                                <button
                                  type="button"
                                  class="ref"
                                  onClick={() => (focus.value = {
                                    t: "record",
                                    process: l.run!.process,
                                    run: l.run!.run,
                                  })}
                                >
                                  run #{l.run.run}
                                </button>
                              )
                              : (
                                <span class="muted">
                                  (through its lasting interface, outside any run)
                                </span>
                              )}
                          </>
                        )
                        : null}
                    </div>
                  )
                  : null}
                {ch?.site
                  ? (
                    <div class="origin">
                      <SiteLink site={ch.site} />
                      {siteLine(ch.site)
                        ? <pre class="code-line">{siteLine(ch.site)!.trim()}</pre>
                        : null}
                    </div>
                  )
                  : null}
              </div>
            </div>
          );
        })}
      </div>
      <div class="sub-title">it marked</div>
      {marked.length
        ? marked.map((m) => (
          <button
            type="button"
            class="run-chip"
            onClick={() => (focus.value = { t: "record", process: m.process, run: m.run })}
          >
            ◉ {m.process} #{m.run} <Ending ending={m.ending} />
          </button>
        ))
        : <Empty>no process read what it changed, or none has run since.</Empty>}
    </div>
  );
}

function WhyRun({ process, run }: { process: string; run: number }) {
  world.version.value;
  const r = (world.records.get(process) ?? []).find((x) => x.run === run);
  if (!r) return <Empty>no record of {process} run {run}.</Empty>;
  /** The node's latest change, if it is newer than what the run saw. */
  const since = (node: string, saw: number | null) => {
    const latest = world.latest.get(node);
    return latest !== undefined && (saw === null || latest > saw) ? latest : undefined;
  };
  const prog = (label: string, p: Run["compute"]) =>
    p
      ? (
        <div class="kv">
          <span class="k">{label}</span>
          <span class="v">
            <NodeLink id={p.node} />
            {"saw" in p ? <span class="at">saw @{p.saw}</span> : null}
            {"absent" in p ? <span class="muted">absent</span> : null}
            {"refused" in p ? <span class="refused">🔒 refused</span> : null}
            {p.slot.length > 1
              ? <span class="muted">(also in the slot: {p.slot.slice(1).join(", ")})</span>
              : null}
          </span>
        </div>
      )
      : null;
  return (
    <div class="why-run">
      <div class="why-title">
        <NodeLink id={r.process} /> <span class="muted">run #{r.run}</span>{" "}
        <Ending ending={r.ending} />
      </div>
      <div class="kv">
        <span class="k">as</span>
        <span class="v">
          <Agent agent={r.agent} />
        </span>
      </div>
      <div class="sub-title">marked by</div>
      <div class="chips">
        {r.marked.length
          ? r.marked.map((m) => <Ref key={`${m.node}@${m.time}`} r={m} />)
          : <span class="muted">nothing</span>}
      </div>
      {prog("compute", r.compute)}
      {prog("effect", r.effect)}
      {"value" in r
        ? (
          <>
            <div class="sub-title">returned</div>
            <div class="value-view small">
              <JsonView value={r.value} />
            </div>
          </>
        )
        : null}
      {r.lookups.length
        ? (
          <>
            <div class="sub-title">looked up</div>
            {r.lookups.map((l) => (
              <div class="lookup-row">
                <code class="lname">{l.name}</code>
                <span class="searched">
                  {l.searched.map((s) => (
                    <span class={`searched-dir${"refused" in s ? " refused" : ""}`}>
                      {s.node}
                      {"refused" in s ? " 🔒" : <span class="at">@{s.saw ?? "∅"}</span>}
                    </span>
                  ))}
                </span>
                <span class="found">
                  → {l.found.length
                    ? l.found.map((x) => <NodeLink key={x} id={x} />)
                    : <span class="muted">nothing</span>}
                </span>
              </div>
            ))}
          </>
        )
        : null}
      {r.reads.length
        ? (
          <>
            <div class="sub-title">
              read <span class="muted">which change of each node it saw</span>
            </div>
            {r.reads.map((x) => (
              <div class="read-row">
                <NodeLink id={x.node} />
                {x.saw === null
                  ? <span class="muted">absent</span>
                  : <Ref r={{ node: x.node, time: x.saw }} />}
                {since(x.node, x.saw)
                  ? (
                    <span class="since" title="the node has changed since this run read it">
                      changed since <Ref r={{ node: x.node, time: since(x.node, x.saw)! }} />
                    </span>
                  )
                  : null}
              </div>
            ))}
          </>
        )
        : null}
      {r.directories.length
        ? (
          <>
            <div class="sub-title">directories</div>
            {r.directories.map((x) => (
              <div class="read-row">
                <NodeLink id={x.node} />
                {x.name !== undefined ? <code>.{x.name}</code> : <span class="muted">whole</span>}
                {x.saw === null
                  ? <span class="muted">absent</span>
                  : <span class="at">@{x.saw}</span>}
              </div>
            ))}
          </>
        )
        : null}
      {r.cleanup.length
        ? (
          <>
            <div class="sub-title">its last cleanup made</div>
            <div class="chips">
              {r.cleanup.map((c) => <Ref key={`${c.node}@${c.time}`} r={c} />)}
            </div>
          </>
        )
        : null}
      <div class="sub-title">changes it made</div>
      <div class="chips">
        {r.changes.length
          ? r.changes.map((c) => <Ref key={`${c.node}@${c.time}`} r={c} />)
          : <span class="muted">none</span>}
      </div>
      {r.errors.length
        ? (
          <>
            <div class="sub-title">errors</div>
            {r.errors.map((e) => (
              <div class="error-line">
                <span class={`kind-tag kt-${e.kind}`}>{e.kind}</span> <b>{e.op}</b> {e.why}
              </div>
            ))}
          </>
        )
        : null}
    </div>
  );
}

function WhySnippet({ n, line }: { n: number; line?: number }) {
  world.version.value;
  const s = world.snippets[n - 1];
  if (!s) return <Empty>no snippet {n}.</Empty>;
  const lines = s.code.split("\n");
  return (
    <div class="why-snippet">
      <div class="why-title">
        ✎ snippet-{n} {s.label ? <span class="muted">{s.label}</span> : null}{" "}
        <Agent agent={s.agent} />
        {s.ok === false
          ? <span class="ending e-failed">✕ {s.error?.kind}</span>
          : <span class="ending e-done">✓</span>}
      </div>
      <pre class="listing">
        {lines.map((l, i) => (
          <div class={`ln${line === i + 1 ? " hot" : ""}`}>
            <span class="lno">{i + 1}</span>
            <span>{l || " "}</span>
          </div>
        ))}
      </pre>
      {s.error ? <div class="error-line">✕ {s.error.why}</div> : null}
      {s.result !== undefined ? <pre class="result">{s.result}</pre> : null}
      <div class="sub-title">changes made from it</div>
      <div class="chips">
        {s.times.length
          ? s.times.map((t) => {
            const c = [...world.changes.values()].find((x) => x.time === t);
            return c ? <Ref key={t} r={c} /> : null;
          })
          : <span class="muted">none</span>}
      </div>
      <div class="row-actions">
        <button
          type="button"
          class="primary"
          onClick={() => {
            draft.value = s.code;
            pointAt.value = line ? { n, line } : undefined;
            dock.value = "workspace";
          }}
        >
          open in the workspace
        </button>
      </div>
    </div>
  );
}
