// The desk's programs, as the source each program node holds. A JavaScript
// program is one module, exporting compute and effect, held as both parts'
// code, so the loader imports it once and both parts are there together.
// The same-thread loader imports it from a data: URL, so a program edited in the panel is new source, and a
// process started after the edit runs it.
//
// Programs reach the page only through what the graph hands them: the live
// screen and frames, read through the lasting interface. They never touch a
// global document, so a headless test can give them a fake one.

/**
 * The desk: lists the cards, gives each a frame on the screen and starts its
 * program there, and keeps which process it started for which card in its
 * own ephemeral node ./pid/children. Its compute reads those processes, so
 * each frame can show the items in front of their values: waiting, stopped,
 * error, newer.
 */
export const desk = module(
  `// reads: cards/ (names and each card's {show}), status, the screen found by lookup,
// its own children node, and every process at each card (its items come first)
export function compute({ api, name, pending }) {
  const listing = api.directory({ address: ["cards"] });
  const children = api.read({ address: [name, "children"] })[0]?.value ?? {};
  const pids = /^@[0-9]+-[a-z]{5}$/;
  const cards = listing.directory.map(([card]) => {
    const show = api.read({ address: ["cards", card] })[0]?.value?.show ?? null;
    const mine = children[card] ?? null;
    // the processes at this card, as the graph has them: the one this desk started, and any
    // other whose value says it drew in this card's frame (a restart, a start by hand).
    // hello and twin are one node, so a process's frame, not its node, says whose it is.
    const inside = api.directory({ address: ["cards", card] });
    const here = [];
    for (const [entry] of inside.directory ?? []) {
      if (!pids.test(entry)) continue;
      const items = api.read({ address: ["cards", card, entry] });
      const frame = items.find((i) => "value" in i)?.value?.frame;
      if (entry !== mine && !(Array.isArray(frame) && frame[frame.length - 1] === card)) continue;
      const own = items.filter((i) => !("value" in i)).map((i) =>
        "waiting" in i ? "⧗ waiting: changes [" + i.waiting.join(", ") + "]"
        : "stopped" in i ? "■ stopped"
        : "error" in i ? "✕ error: " + i.error.why.code
        : "↑ newer program"
      );
      here.push([entry, ...own].join(" · "));
    }
    const alive = mine !== null && inside.directory?.some(([entry]) => entry === mine);
    return { name: card, show, pid: alive ? mine : null, here };
  });
  const status = api.read({ address: ["status"] })[0]?.value ?? null;
  const screen = api.lookup({ name: "screen" }).find((i) => "id" in i);
  if (!screen) return pending;
  return { cards, status, screen: screen.from.path };
}

// draws the header; for each card with no frame yet, a frame and a child process there;
// then each frame's line: the processes at the card, and the items in front of their values
export function effect({ api, lasting, self, name, value }) {
  const screen = lasting.read({ address: value.screen })[0]?.value;
  if (!screen) return;
  const doc = screen.ownerDocument;
  let head = lasting.read({ address: [name, "head"] })[0]?.value;
  if (!head) {
    head = doc.createElement("header");
    head.className = "desk-head";
    screen.append(head);
    api.place({ address: [name], name: "head", id: self + "/head", value: head, ephemeral: true });
  }
  const n = value.status?.cards;
  head.textContent = n === undefined ? "counting cards…" : n + (n === 1 ? " card" : " cards");
  const started = {};
  for (const card of value.cards) {
    let frame = lasting.read({ address: [...value.screen, card.name] })[0]?.value;
    if (!frame && card.show) {
      // a card with no frame: a new frame, and a new process to draw in it. A process this
      // desk started for the card's old frame (a screen made again) is replaced: unplaced.
      if (card.pid) api.unplace({ address: ["cards", card.name], name: card.pid, id: card.pid });
      frame = doc.createElement("section");
      frame.className = "frame";
      const label = doc.createElement("h3");
      label.textContent = card.name;
      const line = doc.createElement("p");
      line.className = "frame-line";
      frame.append(label, line);
      screen.append(frame);
      api.place({
        address: value.screen, name: card.name, id: self + "/frame:" + card.name,
        value: frame, ephemeral: true,
      });
      const answer = api.start({ address: ["cards", card.name], program: ["programs", card.show] });
      started[card.name] = answer.change.id;
    }
    const line = frame?.children[1];
    if (line) line.textContent = card.here.length ? card.here.join(" / ") : "starting…";
  }
  if (Object.keys(started).length) {
    if (lasting.read({ address: [name, "children"] }).length) {
      api.write({
        address: [name, "children"],
        patches: Object.entries(started).map(([key, pid]) => ({ type: "set", path: [], key, value: pid })),
      });
    } else {
      api.place({ address: [name], name: "children", id: self + "/children", value: started, ephemeral: true });
    }
  }
}
`,
);

/** A note: its text, in the theme it finds, in the frame the desk gave it. */
export const note = module(
  `// reads: ./text; looks up theme (every member of the union) and screen; reads its frame
export function compute({ api, cwd, pending }) {
  const text = api.read({ address: ["text"] })[0]?.value;
  if (typeof text !== "string") return pending;
  const found = api.lookup({ name: "theme" }).find((i) => "id" in i);
  const layers = found ? api.read({ address: found.from.path }).map((i) => i.value) : [];
  // the first member wins, key by key; the rest fall through
  const theme = Object.assign({}, ...layers.slice().reverse());
  const screen = api.lookup({ name: "screen" }).find((i) => "id" in i);
  if (!screen) return pending;
  const frame = [...screen.from.path, cwd[cwd.length - 1]];
  if (!api.read({ address: frame }).length) return pending;
  return { text, theme, frame };
}

// makes its surface once, then shows the text; typing fires the handler "edit"
export function effect({ api, lasting, self, name, value, handler }) {
  const frame = lasting.read({ address: value.frame })[0]?.value;
  if (!frame) return;
  let surface = lasting.read({ address: [name, "surface"] })[0]?.value;
  if (!surface) {
    surface = frame.ownerDocument.createElement("div");
    surface.className = "surface note";
    const area = frame.ownerDocument.createElement("textarea");
    area.dataset.fire = "input:edit";
    area.spellcheck = false;
    surface.append(area);
    frame.append(surface);
    api.place({ address: [name], name: "surface", id: self + "/surface", value: surface, ephemeral: true });
  }
  const area = surface.firstChild;
  if (area.value !== value.text) area.value = value.text;
  surface.style.setProperty("--accent", value.theme.accent ?? "");
  surface.style.setProperty("--ink", value.theme.ink ?? "");
  surface.style.setProperty("--paper", value.theme.paper ?? "");
  surface.style.setProperty("--font", value.theme.font ?? "");
  surface.style.setProperty("--size", "15px");
  handler("edit", (input) => {
    const now = lasting.read({ address: ["text"] })[0]?.value ?? "";
    const was = Array.from(now), next = Array.from(String(input?.value ?? ""));
    let a = 0;
    while (a < was.length && a < next.length && was[a] === next[a]) a++;
    let b = 0;
    while (b < was.length - a && b < next.length - a && was[was.length - 1 - b] === next[next.length - 1 - b]) b++;
    try {
      lasting.write({ address: ["text"], patches: [{
        type: "splice", path: [], range: [a, was.length - b], value: next.slice(a, next.length - b).join(""),
      }] });
    } catch (e) {
      area.value = now; // refused: show what the graph holds, not what was typed
      throw e;
    }
  });
}
`,
);

/** Numbers: a Float64Array of samples, drawn as a sparkline on a live canvas. */
export const numbers = module(`// reads: ./samples, a Float64Array; returns them with a summary
export function compute({ api, cwd, pending }) {
  const samples = api.read({ address: ["samples"] })[0]?.value;
  if (!(samples instanceof Float64Array)) return pending;
  let min = Infinity, max = -Infinity, sum = 0;
  for (const x of samples) { min = Math.min(min, x); max = Math.max(max, x); sum += x; }
  const screen = api.lookup({ name: "screen" }).find((i) => "id" in i);
  if (!screen) return pending;
  const frame = [...screen.from.path, cwd[cwd.length - 1]];
  if (!api.read({ address: frame }).length) return pending;
  return { samples, n: samples.length, mean: samples.length ? sum / samples.length : 0, min, max, frame };
}

// a canvas (its own ephemeral node) and a button that fires "add"
export function effect({ api, lasting, self, name, value, handler }) {
  const frame = lasting.read({ address: value.frame })[0]?.value;
  if (!frame) return;
  const doc = frame.ownerDocument;
  let surface = lasting.read({ address: [name, "surface"] })[0]?.value;
  let canvas = lasting.read({ address: [name, "surface", "canvas"] })[0]?.value;
  if (!surface) {
    surface = doc.createElement("div");
    surface.className = "surface numbers";
    canvas = doc.createElement("canvas");
    canvas.width = 240; canvas.height = 64;
    const line = doc.createElement("p");
    const add = doc.createElement("button");
    add.textContent = "add a sample";
    add.dataset.fire = "click:add";
    surface.append(canvas, line, add);
    frame.append(surface);
    api.place({ address: [name], name: "surface", id: self + "/surface", value: surface, ephemeral: true });
    api.place({ address: [name, "surface"], name: "canvas", id: self + "/canvas", value: canvas, ephemeral: true });
  }
  surface.children[1].textContent =
    value.n + " samples · mean " + value.mean.toFixed(2) + " · " + value.min.toFixed(2) + "…" + value.max.toFixed(2);
  const g = canvas.getContext && canvas.getContext("2d");
  if (g) {
    const w = canvas.width, h = canvas.height, s = value.samples, span = (value.max - value.min) || 1;
    g.clearRect(0, 0, w, h);
    g.strokeStyle = doc.defaultView?.getComputedStyle?.(canvas).color || "#888"; g.lineWidth = 1.5; g.beginPath();
    for (let i = 0; i < s.length; i++) {
      const x = s.length > 1 ? (i / (s.length - 1)) * (w - 4) + 2 : w / 2;
      const y = h - 4 - ((s[i] - value.min) / span) * (h - 8);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  }
  handler("add", () => {
    const now = lasting.read({ address: ["samples"] })[0]?.value;
    const last = now.length ? now[now.length - 1] : 0;
    const next = new Float64Array([last + (Math.random() - 0.5) * 2]);
    lasting.write({ address: ["samples"], patches: [{ type: "splice", path: [], range: [now.length, now.length], value: next }] });
  });
}
`);

/** A photo: bytes, shown through a Blob URL. */
export const photo = module(`// reads: ./image, bytes (an ArrayBuffer)
export function compute({ api, cwd, pending }) {
  const image = api.read({ address: ["image"] })[0]?.value;
  if (!(image instanceof ArrayBuffer)) return pending;
  const screen = api.lookup({ name: "screen" }).find((i) => "id" in i);
  if (!screen) return pending;
  const frame = [...screen.from.path, cwd[cwd.length - 1]];
  if (!api.read({ address: frame }).length) return pending;
  const found = api.lookup({ name: "theme" }).find((i) => "id" in i);
  const layers = found ? api.read({ address: found.from.path }).map((i) => i.value) : [];
  const theme = Object.assign({}, ...layers.slice().reverse());
  return { size: image.byteLength, image, theme, frame };
}

// an <img> from a Blob URL; the URL is let go in the cleanup
export function effect({ api, lasting, self, name, value }) {
  const frame = lasting.read({ address: value.frame })[0]?.value;
  if (!frame) return;
  const doc = frame.ownerDocument;
  let surface = lasting.read({ address: [name, "surface"] })[0]?.value;
  if (!surface) {
    surface = doc.createElement("div");
    surface.className = "surface photo";
    const img = doc.createElement("img");
    img.alt = "the picture's bytes";
    const line = doc.createElement("p");
    surface.append(img, line);
    frame.append(surface);
    api.place({ address: [name], name: "surface", id: self + "/surface", value: surface, ephemeral: true });
  }
  surface.style.setProperty("--accent", value.theme.accent ?? "");
  surface.children[1].textContent = value.size + " bytes · drop an image here";
  let url;
  try { url = URL.createObjectURL(new Blob([value.image], { type: "image/png" })); } catch { url = ""; }
  surface.firstChild.src = url;
  return () => { if (url) URL.revokeObjectURL(url); };
}
`);

/** Hush: looks up the secret, and shows it, or where the search was refused. */
export const hush = module(`// looks up secret: its value, or the refused item's path
export function compute({ api, cwd, pending }) {
  const items = api.lookup({ name: "secret" });
  const last = items[items.length - 1];
  let secret = null, refused = null;
  if (last && last.refused) refused = last.from.path;
  else if (last) secret = api.read({ address: last.from.path })[0]?.value ?? null;
  const screen = api.lookup({ name: "screen" }).find((i) => "id" in i);
  if (!screen) return pending;
  const frame = [...screen.from.path, cwd[cwd.length - 1]];
  if (!api.read({ address: frame }).length) return pending;
  return { secret, refused, frame };
}

// shows the secret, or that something farther up was not searched
export function effect({ api, lasting, self, name, value }) {
  const frame = lasting.read({ address: value.frame })[0]?.value;
  if (!frame) return;
  let surface = lasting.read({ address: [name, "surface"] })[0]?.value;
  if (!surface) {
    surface = frame.ownerDocument.createElement("div");
    surface.className = "surface hush";
    frame.append(surface);
    api.place({ address: [name], name: "surface", id: self + "/surface", value: surface, ephemeral: true });
  }
  surface.classList?.toggle("refused", !!value.refused);
  surface.textContent = value.refused
    ? "lookup secret: refused at " + value.refused.join("/") + " (something farther up was not searched)"
    : "secret: " + JSON.stringify(value.secret);
}
`);

/** Tally: a program as data. Counts the cards, and writes the count to ../../status. */
export const tally = {
  kind: "steps",
  compute: [
    { do: "directory", address: [".."], as: "cards" },
    { do: "return", value: { $len: { $: "cards" } } },
  ],
  effect: [
    {
      do: "write",
      address: ["..", "..", "status"],
      patches: [{ type: "snapshot", value: { cards: { $: "value" } } }],
    },
  ],
};

/** The page: the host's own program, the one place the page hands itself to the graph. */
export const page = { kind: "host", compute: "page", effect: "page" };

/** A JavaScript program whose two parts are one module's compute and effect exports. */
function module(source: string) {
  return { kind: "js", compute: source, effect: source };
}
