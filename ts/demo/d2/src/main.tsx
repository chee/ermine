// d2: a desk that explains itself. The page builds the stack over its stage,
// boots it, and draws the chrome: the toolbar, the why panel and map, and the
// feed. The stage itself is drawn only by processes; the page's one hand-over
// is its stage element, which the host program "page" places as /desk/screen.
//
// The host's single listener on the stage does three things: a click selects
// the nearest element that is an ephemeral node's live value; an element
// with data-fire="event:handler" fires that handler on the process that placed
// the element's node, as the actor the host vouches for; a dropped file's
// bytes are written by the host, as that actor, since a handler's input is
// JSON.

import { render } from "preact";
import { effect, signal } from "@preact/signals";
import { indexeddb } from "d2/ermine";
import { openStack, type World } from "./stack.ts";
import { boot } from "./boot.ts";
import { dropBytes } from "./actions.ts";
import { colourOf, setWorld, ui } from "./view.tsx";
import { SitePopover, WhyPanel } from "./why.tsx";
import { MapPanel } from "./map.tsx";
import { Feed } from "./feed.tsx";
import { halos, ring, xray } from "./xray.ts";
import { view } from "./viewer.ts";

const DB = "ermine-d2";

type ShareModule = typeof import("./share.ts");
/** share.js, built apart and imported only when asked for; undefined if it would not load */
const sharing = signal<
  { state: "idle" } | { state: "connecting" } | { state: "on"; link: string } | {
    state: "failed";
    why: string;
  }
>({ state: "idle" });
const loadShare = () => import(new URL("./share.js", import.meta.url).href) as Promise<ShareModule>;

function ShareButton({ w }: { w: World }) {
  const s = sharing.value;
  if (s.state === "on") {
    return (
      <span class="stat">
        shared: <a href={s.link} target="_blank" rel="noopener">{s.link.slice(0, 48)}…</a>
      </span>
    );
  }
  if (s.state === "failed") return <span class="stat muted" title={s.why}>share failed</span>;
  return (
    <button
      type="button"
      class="small"
      disabled={s.state === "connecting"}
      title="serve /desk on a new channel through wss://galaxy.observer"
      onClick={async () => {
        sharing.value = { state: "connecting" };
        try {
          const mod = await loadShare();
          const { channel } = await mod.share(w.s);
          sharing.value = {
            state: "on",
            link: `${location.origin}${location.pathname}#mount=${channel}`,
          };
        } catch (e) {
          sharing.value = { state: "failed", why: String(e) };
        }
      }}
    >
      {s.state === "connecting" ? "connecting…" : "share"}
    </button>
  );
}

function Toolbar({ w, idb }: { w: World; idb: { close(): void } }) {
  void ui.version.value;
  const kept = w.k.kept();
  // checked, not claimed: the ephemeral nodes the tap saw made, against what the keeper keeps
  let fleeting = 0;
  for (const [id, node] of kept.nodes) {
    if (w.ephemeral.has(id)) fleeting++;
    for (const ids of node.directory.values()) {
      fleeting += ids.filter((i) => w.ephemeral.has(i)).length;
    }
  }
  return (
    <div class="bar">
      <span class="title">
        <b>d2</b> · why is this here?
      </span>
      <span class="stat" title="the scheduler's clock: the time of the last change it stamped">
        t={w.s.time}
      </span>
      <span
        class={`stat ${fleeting ? "bad" : ""}`}
        title="what keeping the graph keeps now (keeper.kept()), and how many of the ephemeral nodes here it holds, as nodes or in slots"
      >
        kept {kept.nodes.size} · {fleeting} ephemeral
      </span>
      {w.loaded && (
        <span class="stat muted" title="what the load brought back">
          loaded from IndexedDB · t={w.loaded.time} · {w.loaded.nodes} nodes
        </span>
      )}
      <span class="spacer" />
      <span class="actor">
        acting as
        {(["you", "guest"] as const).map((a) => (
          <button
            type="button"
            key={a}
            class={`small ${w.actor === a ? "on" : ""}`}
            onClick={() => {
              w.actor = a;
              ui.version.value++;
            }}
          >
            <span class="dot" style={{ background: colourOf(a) }} />
            {a}
          </button>
        ))}
      </span>
      <ShareButton w={w} />
      <button
        type="button"
        class={`small ${ui.xray.value ? "on" : ""}`}
        onClick={() => (ui.xray.value = !ui.xray.value)}
        title="or hold Alt"
      >
        x-ray
      </button>
      <button
        type="button"
        class="small"
        onClick={async () => {
          await w.k.flush();
          location.reload();
        }}
      >
        reload
      </button>
      <button
        type="button"
        class="small"
        onClick={async () => {
          if (!confirm("Forget everything kept for d2 and start from the seed?")) return;
          idb.close();
          await new Promise((r) => {
            const req = indexedDB.deleteDatabase(DB);
            req.onsuccess = req.onerror = req.onblocked = r;
          });
          location.reload();
        }}
      >
        forget everything
      </button>
    </div>
  );
}

function Panel() {
  const tab = ui.tab.value;
  const v = ui.version.value;
  return (
    <div class="panel-inner">
      <nav class="tabs">
        <button
          type="button"
          class={tab === "why" ? "on" : ""}
          onClick={() => (ui.tab.value = "why")}
        >
          why
        </button>
        <button
          type="button"
          class={tab === "map" ? "on" : ""}
          onClick={() => (ui.tab.value = "map")}
        >
          map
        </button>
        {ui.selected.value && (
          <button type="button" class="small clear" onClick={() => (ui.selected.value = undefined)}>
            clear
          </button>
        )}
      </nav>
      <div class="tab-body">{tab === "why" ? <WhyPanel v={v} /> : <MapPanel v={v} />}</div>
    </div>
  );
}

/** The ephemeral node whose live value is el or holds it, nearest first. */
function ownerOf(w: World, el: Element | null, stop: Element): string | undefined {
  for (let at = el; at && at !== stop.parentElement; at = at.parentElement) {
    const id = w.owner.get(at);
    if (id !== undefined) return id;
  }
}

async function main() {
  const mounting = /^#mount=([0-9a-f]{64})$/.exec(location.hash);
  if (mounting) {
    document.body.classList.add("viewing");
    const mod = await loadShare();
    await view(mounting[1], document.getElementById("stage")!, mod.join);
    return;
  }
  const stage = document.getElementById("stage")!;
  const layer = document.getElementById("layer")!;
  const idb = indexeddb(DB);
  const w = await openStack(idb, { stage });
  setWorld(w);
  // the host lets a gone node's element go; the stage itself is the host's
  w.onGone((_id, live) => {
    if (live instanceof Element && live !== stage) live.remove();
  });

  const drawX = xray(w, layer);
  let seen = 0;
  const drawSel = () => {
    for (const old of layer.querySelectorAll(".selring")) old.remove();
    const id = ui.selected.value?.node;
    const live = id === undefined ? undefined : w.ephemeral.get(id);
    if (live instanceof HTMLElement && live.isConnected) {
      ring(layer, live, "var(--accent)", "selring");
    }
  };
  w.listen(() => {
    ui.version.value++;
    seen = halos(w, layer, seen);
    requestAnimationFrame(() => {
      drawX();
      drawSel();
    });
  });
  effect(() => {
    void ui.xray.value;
    void ui.selected.value;
    drawX();
    drawSel();
  });

  // the one listener: select, fire, drop
  stage.addEventListener("click", (e) => {
    const target = e.target as Element;
    const id = ownerOf(w, target, stage);
    const fire = target.closest("[data-fire]")?.getAttribute("data-fire");
    if (fire?.startsWith("click:") && id) {
      const pid = w.made.get(id)?.process;
      if (pid) w.fire(pid, fire.slice(6), {});
    }
    if (id) {
      ui.selected.value = { node: id };
      ui.tab.value = "why";
    }
  });
  stage.addEventListener("input", (e) => {
    const target = e.target as HTMLTextAreaElement;
    const fire = target.closest("[data-fire]")?.getAttribute("data-fire");
    const id = ownerOf(w, target, stage);
    if (!fire?.startsWith("input:") || !id) return;
    const pid = w.made.get(id)?.process;
    if (pid) w.fire(pid, fire.slice(6), { value: target.value });
  });
  stage.addEventListener("dragover", (e) => e.preventDefault());
  stage.addEventListener("drop", async (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    const id = ownerOf(w, e.target as Element, stage);
    const pid = id && w.made.get(id)?.process;
    const start = pid ? w.started.get(pid) : undefined;
    const place = start && w.pathOf(start.node);
    if (!file || !place) return;
    if (!w.tap.read({ agent: "host", address: [...place, "image"] }).length) return;
    dropBytes(w, [...place, "image"], await file.arrayBuffer());
  });
  addEventListener("keydown", (e) => {
    if (e.key === "Alt") ui.xray.value = true;
  });
  addEventListener("keyup", (e) => {
    if (e.key === "Alt") ui.xray.value = false;
  });
  addEventListener("blur", () => (ui.xray.value = false));
  addEventListener("resize", () => {
    drawX();
    drawSel();
  });
  document.getElementById("stage-wrap")!.addEventListener("scroll", () => drawSel());

  render(<Toolbar w={w} idb={idb} />, document.getElementById("bar")!);
  render(<Panel />, document.getElementById("panel")!);
  render(<Feed />, document.getElementById("feed")!);
  render(<SitePopover />, document.getElementById("popover")!);

  boot(w);
  (globalThis as { d2?: World }).d2 = w;
}

main().catch((e) => {
  console.error(e);
  document.getElementById("stage")!.textContent = `the desk did not boot: ${e}`;
});
