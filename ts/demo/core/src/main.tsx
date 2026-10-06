/// <reference lib="dom" />
// ermine core: a place to play with the graph, protect and drive.

import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Browser } from "./browser.tsx";
import { Canvas } from "./canvas.tsx";
import { Dock } from "./dock.tsx";
import { Gutter } from "./gutter.tsx";
import { examples, rulesFor } from "./examples.ts";
import { Inspector } from "./inspector.tsx";
import {
  draft,
  explode,
  focus,
  panels,
  select,
  selected,
  size,
  tall,
  theme,
  undo,
  world,
} from "./state.ts";
import { Right } from "./transcript.tsx";
import { Palette, palette } from "./palette.tsx";
import { AskPopover } from "./ask.tsx";
import { current, fresh, last, open, rename, save, savedAt } from "./projects.ts";
import { ROOT } from "./world.ts";

function Ermine({ size = 34 }: { size?: number }) {
  return (
    <svg class="ermine" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path
        class="e-tail"
        d="M50 44c8-2 11-10 8-17"
        fill="none"
        stroke-width="6"
        stroke-linecap="round"
      />
      <path
        class="e-tip"
        d="M58 27c1-3 0-6-2-8"
        fill="none"
        stroke-width="6"
        stroke-linecap="round"
      />
      <ellipse class="e-body" cx="34" cy="44" rx="18" ry="13" />
      <circle class="e-ear" cx="17" cy="17" r="6" />
      <circle class="e-ear" cx="35" cy="15" r="6" />
      <circle class="e-ear-in" cx="17" cy="17" r="3" />
      <circle class="e-ear-in" cx="35" cy="15" r="3" />
      <ellipse class="e-head" cx="26" cy="28" rx="15" ry="13" />
      <circle class="e-eye" cx="21" cy="27" r="2.2" />
      <circle class="e-eye" cx="31" cy="27" r="2.2" />
      <ellipse class="e-nose" cx="26" cy="33" rx="2.4" ry="1.7" />
      <ellipse class="e-cheek" cx="16" cy="32" rx="3" ry="2" />
      <ellipse class="e-cheek" cx="36" cy="32" rx="3" ry="2" />
    </svg>
  );
}

/** Opens an example as a project of its own. */
function boot(id: string) {
  const ex = examples.find((e) => e.id === id)!;
  open({ name: fresh(ex.title), image: ex.code, rules: rulesFor[id] ?? [] }, "example");
  draft.value = ex.code;
}

function ProjectName() {
  world.version.value;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  if (editing) {
    return (
      <input
        class="code project-input"
        autoFocus
        value={name}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim()) {
            rename(name.trim());
            setEditing(false);
          }
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }
  return (
    <button
      type="button"
      class="project-name"
      title="this project: it saves itself, as a boot image. click to rename"
      onClick={() => {
        setName(current.value);
        setEditing(true);
      }}
    >
      {current.value}
      <span class="saved">{savedAt.value ? "saved" : ""}</span>
    </button>
  );
}

function TopBar() {
  world.version.value;
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [menu, setMenu] = useState(false);
  const time = Math.max(0, ...world.latest.values());
  const running = world.running().size;
  return (
    <header class="top">
      <div class="brand">
        <Ermine />
        <div>
          <div class="wordmark">ermine</div>
          <div class="tagline">a graph of values that says why</div>
        </div>
      </div>
      <ProjectName />
      <div class="history-btns">
        <button
          type="button"
          class="iconbtn"
          title="undo (⌘Z): a new change that reverses the last"
          disabled={!world.undoable.length}
          onClick={() => undo()}
        >
          ↶
        </button>
        <button
          type="button"
          class="iconbtn"
          title="redo (⇧⌘Z)"
          disabled={!world.redoable.length}
          onClick={() => undo(true)}
        >
          ↷
        </button>
      </div>
      <button type="button" class="palette-btn" onClick={() => (palette.value = {})}>
        make, find, open… <kbd>⌘K</kbd>
      </button>
      <div class="boot">
        <button type="button" class="boot-btn" onClick={() => setMenu(!menu)}>
          ✿ examples <span class="caret-down">▾</span>
        </button>
        {menu
          ? (
            <div class="menu" onMouseLeave={() => setMenu(false)}>
              {examples.map((e) => (
                <button
                  type="button"
                  class="menu-item"
                  onClick={() => {
                    setMenu(false);
                    boot(e.id);
                  }}
                >
                  <span class="menu-title">{e.title}</span>
                  <span class="menu-blurb">{e.blurb}</span>
                </button>
              ))}
            </div>
          )
          : null}
      </div>
      <div class="agents" title="who you act as: every operation carries an agent">
        <span class="muted">acting as</span>
        {world.agents.map((a) => (
          <button
            type="button"
            class={`agent-pill c-${world.colorOf(a)}${world.agent === a ? " on" : ""}`}
            onClick={() => {
              world.agent = a;
              world.bump();
            }}
          >
            {a}
          </button>
        ))}
        {adding
          ? (
            <input
              class="code agent-new"
              autoFocus
              placeholder="name"
              value={name}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
              onBlur={() => setAdding(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) {
                  world.agents = [...world.agents, name.trim()];
                  world.agent = name.trim();
                  setName("");
                  setAdding(false);
                  world.bump();
                }
              }}
            />
          )
          : (
            <button
              type="button"
              class="agent-add"
              onClick={() => setAdding(true)}
              title="another agent"
            >
              ＋
            </button>
          )}
      </div>
      <button
        type="button"
        class={`explode-btn${explode.value ? " on" : ""}`}
        title="see the whole graph on a canvas"
        onClick={() => (explode.value = !explode.value)}
      >
        {explode.value ? "✕ gather" : "✺ explode"}
      </button>
      <div class="facts">
        <label class="see" title="read beneath protect, as the host that built the stack may">
          <input
            type="checkbox"
            checked={world.seeAll}
            onChange={() => {
              world.seeAll = !world.seeAll;
              world.bump();
            }}
          />
          host's eye
        </label>
        <span class="fact">
          <b>{world.made.size}</b> nodes
        </span>
        <span class="fact">
          <b>{running}</b> running
        </span>
        <span class="fact time">
          t = <b>{time}</b>
        </span>
        <button
          type="button"
          class="iconbtn"
          title="light / dark"
          onClick={() => (theme.value = theme.value === "dark" ? "light" : "dark")}
        >
          {theme.value === "dark" ? "☀︎" : "☾"}
        </button>
      </div>
    </header>
  );
}

/** The dragged panels' sizes, as the stylesheet's variables; the rest keep its defaults. */
function vars(names: { [k in keyof typeof panels.value]: string }) {
  const out: { [v: string]: string } = {};
  for (const [k, v] of Object.entries(names)) {
    const px = panels.value[k as keyof typeof panels.value];
    if (px !== undefined) out[v] = `${px}px`;
  }
  return out;
}

function App() {
  useEffect(() => {
    document.documentElement.dataset.theme = theme.value;
    try {
      localStorage.setItem("ermine-theme", theme.value);
    } catch { /* no storage */ }
  }, [theme.value]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const typing = (e.target as HTMLElement)?.closest?.(
        "input, textarea, [contenteditable], .cm-editor",
      );
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        palette.value = palette.value ? undefined : {};
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      } else if (mod && e.key.toLowerCase() === "z" && !typing) {
        e.preventDefault();
        undo(e.shiftKey);
      } else if (e.key === "Escape" && !palette.value) focus.value = undefined;
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  return (
    <div class="app">
      <TopBar />
      <div
        class={`grid${explode.value ? " exploded" : ""}${tall.value ? " tall" : ""}`}
        style={vars({ left: "--left", right: "--right", dock: "--dock", why: "--why" })}
      >
        <Browser />
        <Gutter
          axis="x"
          side="before"
          min={160}
          keep={660}
          set={(px) => size("left", px)}
          reset={() => size("left", undefined)}
        />
        <div class="center">
          {explode.value ? <Canvas /> : <Inspector />}
          <Gutter
            axis="y"
            side="after"
            min={120}
            keep={160}
            set={(px) => {
              tall.value = false;
              size("dock", px);
            }}
            reset={() => {
              tall.value = false;
              size("dock", undefined);
            }}
          />
          <Dock />
        </div>
        <Gutter
          axis="x"
          side="after"
          min={240}
          keep={580}
          set={(px) => size("right", px)}
          reset={() => size("right", undefined)}
        />
        <Right />
      </div>
      <Palette />
      <AskPopover />
    </div>
  );
}

// open the project last open here, or a fresh one with just the root
const was = last();
open(was ?? { name: "untitled", image: "" }, "open");
if (!was) palette.value = { only: "examples" };
if (!selected.value) select(ROOT, []);
render(<App />, document.getElementById("app")!);
