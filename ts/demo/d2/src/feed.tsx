// The feed: every change the tap saw, in bursts (one outside act, and what it
// settled), each line with its path, actor, code chain, cause or site, and
// the processes it marked. Runs of ephemeral changes fold into one line.

import { useEffect, useRef, useState } from "preact/hooks";
import { isObject, type Line } from "./stack.ts";
import { Agent, Cause, colourOf, Path, selectProcess, ui, world as w } from "./view.tsx";

function sym(line: Line) {
  const c = line.change;
  if (c.kind === "write") return "✎";
  if (c.kind === "place") return "+";
  return isObject(c.cause) && "killed" in c.cause ? "⤓" : "−";
}

function LineRow({ line, lit }: { line: Line; lit?: boolean }) {
  const c = line.change;
  const path = c.kind === "write" ? line.at : line.at && [...line.at, c.name];
  return (
    <li class={`line ${c.ephemeral ? "eph" : ""} ${lit ? "lit" : ""}`}>
      <span class="sym" title={c.kind}>{sym(line)}</span>
      <span class="t">{c.time}</span>
      <button
        type="button"
        class="pathbtn"
        onClick={() => {
          const id = c.kind === "write" ? c.node : c.id;
          if (w.pathOf(id) || w.started.has(id)) ui.selected.value = { node: id };
          ui.tab.value = "why";
        }}
      >
        <Path path={path} id={c.kind === "write" ? c.node : c.id} />
      </button>
      {c.kind === "place" && c.value !== undefined && <span class="made">made</span>}
      <Agent agent={c.agent} />
      <Cause cause={c.cause} />
      {line.marked.length > 0 && (
        <span class="marks" title="the processes this change marked">
          ⇢{line.marked.map((p) => (
            <button
              type="button"
              key={p}
              class="markbtn"
              onClick={() => selectProcess(p)}
            >
              {p}
            </button>
          ))}
        </span>
      )}
      {line.gone.length > 0 && <span class="gone">let go: {line.gone.length}</span>}
    </li>
  );
}

/** Folds each run of ephemeral changes into one counted group. */
function fold(lines: Line[]): (Line | Line[])[] {
  const out: (Line | Line[])[] = [];
  for (const l of lines) {
    const last = out[out.length - 1];
    if (l.change.ephemeral && Array.isArray(last)) last.push(l);
    else if (l.change.ephemeral) out.push([l]);
    else out.push(l);
  }
  return out.map((x) => Array.isArray(x) && x.length === 1 ? x[0] : x);
}

function Folded({ lines, lit }: { lines: Line[]; lit?: number }) {
  const [open, setOpen] = useState(false);
  const has = lit !== undefined && lines.some((l) => l.change.time === lit);
  if (open || has) {
    return (
      <>
        {lines.map((l) => <LineRow key={l.change.time} line={l} lit={l.change.time === lit} />)}
        {!has && (
          <li class="line fold">
            <button type="button" class="small" onClick={() => setOpen(false)}>fold</button>
          </li>
        )}
      </>
    );
  }
  const kinds = new Set(lines.map((l) => l.change.kind));
  return (
    <li class="line eph fold">
      <span class="sym">⋯</span>
      <button type="button" class="small" onClick={() => setOpen(true)}>
        ×{lines.length} ephemeral changes ({[...kinds].join(", ")}) · t={lines[0].change.time}…
        {lines[lines.length - 1].change.time}
      </button>
    </li>
  );
}

function label(b: (typeof w.bursts)[number]) {
  if (b.by === "host") return b.label;
  const c = b.lines[0]?.change;
  if (!c) return "later";
  const code = isObject(c.agent) && Array.isArray(c.agent.code) ? c.agent.code : [];
  const step = code[code.length - 1];
  if (isObject(c.agent) && typeof c.agent.peer === "string") {
    return `later: from a mount, peer ${c.agent.peer.slice(0, 10)}…`;
  }
  if (c.kind === "place" && c.name === "loaded") {
    return `later: a loader answered (${c.node}/loaded)`;
  }
  if (isObject(step) && "lasting" in step) {
    return `later: ${String(step.process)} through its lasting interface`;
  }
  return "later: with no act open";
}

export function Feed() {
  void ui.version.value;
  const replay = ui.replay.value;
  const box = useRef<HTMLDivElement>(null);
  // follows the newest burst until the person scrolls up
  const held = useRef(false);
  const bursts = w.bursts.slice(-80);
  useEffect(() => {
    if (replay) {
      box.current?.querySelector(".line.lit, .replay-bar")?.scrollIntoView({ block: "nearest" });
    } else if (!held.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  });
  const lit = replay ? w.bursts[replay.burst - 1]?.lines[replay.at]?.change.time : undefined;
  return (
    <div
      class="feed"
      ref={box}
      onWheel={() => {
        const el = box.current!;
        requestAnimationFrame(
          () => (held.current = el.scrollTop + el.clientHeight < el.scrollHeight - 8),
        );
      }}
    >
      {bursts.map((b) => (
        <div key={b.n} class={`burst ${replay?.burst === b.n ? "replaying" : ""}`}>
          <div class="burst-head">
            <span class="n">#{b.n}</span>
            {b.actor !== undefined && (
              <span
                class="dot"
                style={{ background: colourOf(b.actor) }}
              />
            )}
            <span class="label">{label(b)}</span>
            <span class="muted">{b.lines.length} changes</span>
            {b.error && (
              <span class="chip refused" title={b.error.why.text ?? ""}>
                {b.error.why.rule !== undefined
                  ? `refused by rule ${b.error.why.rule}`
                  : `${b.error.kind}: ${b.error.why.code}`}
                {b.lines.length === 0 && " · nothing changed"}
              </span>
            )}
            {b.lines.length > 1 && (
              <button
                type="button"
                class="small"
                onClick={() => (ui.replay.value = replay?.burst === b.n
                  ? undefined
                  : { burst: b.n, at: 0 })}
              >
                {replay?.burst === b.n ? "stop" : "step"}
              </button>
            )}
          </div>
          {replay?.burst === b.n && (
            <div class="replay-bar">
              replay, in the order the graph returned it · {replay.at + 1}/{b.lines.length}
              <button
                type="button"
                class="small"
                onClick={() => (ui.replay.value = { burst: b.n, at: Math.max(0, replay.at - 1) })}
              >
                ‹ back
              </button>
              <button
                type="button"
                class="small"
                onClick={() => (ui.replay.value = {
                  burst: b.n,
                  at: Math.min(b.lines.length - 1, replay.at + 1),
                })}
              >
                next ›
              </button>
            </div>
          )}
          <ul class="lines">
            {fold(b.lines).map((x, i) =>
              Array.isArray(x)
                ? <Folded key={`f${i}`} lines={x} lit={lit} />
                : <LineRow key={x.change.time} line={x} lit={x.change.time === lit} />
            )}
          </ul>
        </div>
      ))}
    </div>
  );
}
