// Boot images: each is a workspace snippet, so every change it makes from
// outside carries its site, and the transcript can show the line that made it.
//
// Every node is made by placing it, as CORE.tex has it, and programs find what
// they read by lookup from their place, so everything is in the tree and every
// dependency shows in a run's record as a search.
//
// Programs are nodes too (SCHEDULER.tex, Programs): {kind, compute, effect?},
// under programs/. Each kind is run by the loader found under loaders/, by its
// name (LOADERS.tex): "js" by the same-thread loader, "steps" by the steps
// loader. start(where, program) places a process in the node where reaches,
// under a pid the scheduler picks, and runs there the program found by
// searching up from it, such as programs/editor.
//
// A JS part is a module whose default export is the function the scheduler
// calls, with what it gives and nothing else: a compute gets {api, self, cwd,
// name, changes, pending}, and its api only reads; an effect gets {api,
// lasting, self, cwd, name, value, previous, handler}, and its api only
// writes. A module imports what it uses: { h, screen, fire } from "demo",
// this host, where screen(self) is the element an effect draws on.

export type Example = { id: string; title: string; blurb: string; code: string };

const B = "`";

/** The runtime every example places first: the loaders, and the folder programs are found in. */
const runtime = String.raw`
// The loaders a process finds, by its program's kind, searching up from where
// it runs; and the folder programs are found in, the same way.
make("root", "loaders", "loaders", {})
make("loaders", "js", "loader-js", { loader: "same-thread" })
make("loaders", "steps", "loader-steps", { loader: "steps" })
make("root", "programs", "programs", {})
`;

const hello = String.raw`
// The host gave the root. Every other node is made by placing it somewhere:
// make(parent, name, id, value).
make("root", "clicks", "clicks", 0)

// A program is a node: its kind, which names the loader that runs it, and a
// compute, which only reads. A lookup's item says the address it was found
// at, and a read is a list of items, the first the node the address reaches.
// With no effect, a process running it is a derived value.
program("programs", "double", ${B}
export default function ({ api }) {
  const [clicks] = api.lookup({ name: "clicks" })
  return api.read({ address: clicks.from.path })[0].value * 2
}
${B})

// start places a process in the root, under a pid the scheduler picks, and
// runs it there: it looks "clicks" up from the root.
start("root", "double")

// The counter keeps the address it found "clicks" at, so its effect can
// write it. A press is a handler call, as whoever pressed. Its write marks the
// counter too, since the counter read clicks, and the counter draws again
// what it read: the number its screen already shows. Like SCHEDULER.tex's
// editor, nothing echoes. A write from anyone else draws the new number.
program("programs", "counter", ${B}
export default function ({ api }) {
  const [clicks] = api.lookup({ name: "clicks" })
  return { n: api.read({ address: clicks.from.path })[0].value, at: clicks.from.path }
}
${B}, ${B}
import { h, screen, fire } from "demo"
export default function ({ self, value, lasting, handler }) {
  let n = value.n
  const big = h("div", { class: "big" }, n)
  handler("press", () => {
    lasting.write({ address: value.at, patches: [{ type: "snapshot", value: ++n }] })
    big.textContent = n
  })
  screen(self).replaceChildren(
    big,
    h("div", { class: "label" }, "clicks"),
    h("button", { class: "bun", onclick: () => fire(self, "press") }, "🐇 hop!"),
  )
}
${B})
start("root", "counter")

// Then try, in the workspace:
//   write("clicks", 41)
// or edit the counter program in the inspector: the process shows newer, and
// replace starts the new one where the old one was.
`;

const typing = String.raw`
// SCHEDULER.tex's editor. The editor's compute finds the document and returns
// it; its effect makes a textarea once, and later puts new values into it.
// Typing writes splices through the lasting interface. Those changes name the
// editor, and mark it, since it read doc: it runs again, finds the textarea
// already shows the document, and leaves it alone, so nothing echoes back.
// Everyone else who read doc runs too.
make("root", "doc", "doc", "the quick brown ermine hops over the lazy rabbit")

program("programs", "editor", ${B}
export default function ({ api }) {
  const [doc] = api.lookup({ name: "doc" })
  return { text: api.read({ address: doc.from.path })[0].value, at: doc.from.path }
}
${B}, ${B}
import { h, screen } from "demo"
export default function ({ self, value, lasting }) {
  const s = screen(self)
  let ta = s.querySelector("textarea")
  if (!ta) {
    ta = h("textarea", { class: "ed", spellcheck: false })
    s.replaceChildren(h("div", { class: "label" }, "✎ editor — type here"), ta)
  }
  ta.oninput = () => {
    const was = [...ta.dataset.was], now = [...ta.value]
    let a = 0; while (a < was.length && a < now.length && was[a] === now[a]) a++
    let b = 0; while (b < was.length - a && b < now.length - a && was[was.length-1-b] === now[now.length-1-b]) b++
    ta.dataset.was = ta.value
    lasting.write({ address: value.at, patches: [
      { type: "splice", path: [], range: [a, was.length - b], value: now.slice(a, now.length - b).join("") },
    ] })
  }
  if (ta.value !== value.text) { ta.value = value.text; ta.dataset.was = value.text }
}
${B})

program("programs", "words", ${B}
export default function ({ api }) {
  const [doc] = api.lookup({ name: "doc" })
  const d = api.read({ address: doc.from.path })[0].value
  return d.trim() ? d.trim().split(/\\s+/).length : 0
}
${B}, ${B}
import { h, screen } from "demo"
export default ({ self, value }) =>
  screen(self).replaceChildren(h("div", { class: "big" }, value), h("div", { class: "label" }, "words"))
${B})

program("programs", "shout", ${B}
export default function ({ api }) {
  const [doc] = api.lookup({ name: "doc" })
  return api.read({ address: doc.from.path })[0].value.toUpperCase()
}
${B}, ${B}
import { h, screen } from "demo"
export default ({ self, value }) =>
  screen(self).replaceChildren(h("div", { class: "label" }, "shout"), h("p", { class: "shout" }, value))
${B})

start("root", "editor")
start("root", "words")
start("root", "shout")
`;

const themes = String.raw`
// Configuration is placement. A process looks a name up along its place,
// nearest directory first, the way node_modules is searched.
make("root", "home", "home", {})
make("home", "docs", "docs", {})
make("home", "note", "note", "a note at home")
make("docs", "readme", "readme", "the readme, deep in docs")
make("home", "theme", "pink", { bg: "#ffe3ef", fg: "#7a1f4b", name: "pink" })
make("docs", "theme", "mint", { bg: "#dcf7ec", fg: "#155c45", name: "mint" })

// One card program, in the tree like everything else, run in two places.
program("programs", "card", ${B}
export default function ({ api }) {
  const [theme] = api.lookup({ name: "theme" })
  return {
    text: api.read({ address: [] })[0].value,
    theme: theme ? api.read({ address: theme.from.path })[0].value : { bg: "#eee", fg: "#333", name: "none" },
  }
}
${B}, ${B}
import { h, screen } from "demo"
export default function ({ self, value: { text, theme } }) {
  screen(self).replaceChildren(h("div", { class: "card", style: { background: theme.bg, color: theme.fg } },
    h("div", { class: "label" }, "theme: " + theme.name), h("p", {}, text)))
}
${B})

// Two processes, each started in what it shows: a process runs where it is
// placed, so that node is its ".", the address [], and lookups search from
// there. Each finds programs/card by searching up, as it finds the theme.
start("note", "card")
start("readme", "card")

// Try: unplace("docs", "theme", "mint")   — the readme falls back to pink
//      place("docs", "theme", "mint")     — and back
`;

const guarded = String.raw`
// protect asks may() before every operation. Rules live in the Protect tab:
// the first rule that matches wins; none matching allows.
make("root", "diary", "diary", "dear diary, today i hopped")
make("root", "public", "public", "hello everyone")

program("programs", "reader", ${B}
export default function ({ api }) {
  const find = (name) => {
    const [it] = api.lookup({ name })
    return it && api.read({ address: it.from.path })[0].value
  }
  return { diary: find("diary"), public: find("public") }
}
${B}, ${B}
import { h, screen } from "demo"
export default ({ self, value }) =>
  screen(self).replaceChildren(h("div", { class: "label" }, "reader"), h("pre", {}, JSON.stringify(value, null, 1)))
${B})
start("root", "reader")

// Now act as bun (the pills at the top) and try:  write("diary", "bun was here")
// Or start a process as hop, who may not read the diary: a process acts for
// whoever started it, and its run is refused, and says so.
//   as("hop", () => process("root", "snoop", { compute: "export default ({ api }) => api.read({ address: api.lookup({ name: 'diary' })[0].from.path })[0].value" }))
`;

const guardedRules = [
  { agent: "bun", op: "write", node: "diary", allow: false, on: true },
  { agent: "hop", op: "read", node: "diary", allow: false, on: true },
];

const slow = String.raw`
// A compute that found nothing yet returns pending, which it is given. It
// wrote nothing, so its effect does not run and nothing needs undoing; the
// process reads as waiting. Its lookup read the slot "weather" in the root,
// so it is marked when that name appears, and runs again. Slow work is
// something that writes later.
program("programs", "forecast", ${B}
export default function ({ api, pending }) {
  const [weather] = api.lookup({ name: "weather" })
  if (!weather) return pending
  return api.read({ address: weather.from.path })[0].value
}
${B}, ${B}
import { h, screen } from "demo"
export default ({ self, value }) =>
  screen(self).replaceChildren(h("div", { class: "big" }, value.sky), h("div", { class: "label" }, value.temp + "° in " + value.town))
${B})

// The fetcher's effect sets a timer; when it fires, it writes through the
// lasting interface, as the fetcher. Its cleanup stops the timer if the
// fetcher is killed first.
program("programs", "fetcher", ${B}
export default () => "soon"
${B}, ${B}
import { h, screen } from "demo"
export default function ({ self, lasting }) {
  const weather = { sky: "☁︎ → ☀︎", temp: 19, town: "the burrow" }
  const t = setTimeout(() => {
    if (lasting.read({ address: ["/", "weather"] }).length) {
      lasting.write({ address: ["/", "weather"], patches: [{ type: "snapshot", value: weather }] })
    } else lasting.place({ address: ["/"], name: "weather", id: "weather", value: weather })
  }, 2000)
  screen(self).replaceChildren(h("div", { class: "label" }, "fetching the weather… (2s)"))
  return () => clearTimeout(t)
}
${B})

start("root", "forecast")
start("root", "fetcher")
`;

const data = String.raw`
// Programs as data: the small language of PROTOCOL.tex, which every harness
// interprets, so one scenario runs in every language. A program of kind
// "steps" is run by the loader at loaders/steps. Reads are lists of items: a
// lookup's item says the path it was found at, which reads straight back, and
// $value takes the value of a read's first item.
make("root", "a", "a", 20)
make("root", "b", "b", 22)
program("programs", "sum", [
  { do: "lookup", name: "a", as: "la" },
  { do: "lookup", name: "b", as: "lb" },
  { do: "read", address: { $get: [{ $: "la" }, 0, "from", "path"] }, as: "x" },
  { do: "read", address: { $get: [{ $: "lb" }, 0, "from", "path"] }, as: "y" },
  { do: "return", value: { $add: [{ $value: { $: "x" } }, { $value: { $: "y" } }] } },
])
start("root", "sum")
// write("a", 100) and watch the process's value in the inspector.
`;

const embark = String.raw`
// A trip planner in the spirit of Ink & Switch's Embark: one outline that you
// write, and views computed from it. Each view is a process started in
// trip/plan, where it looks up what it needs, so nearer settings shadow
// farther ones.
make("root", "trip", "trip", {})
make("trip", "plan", "plan", [
  "iberia, slowly",
  "Day 1 — Lisbon: pastéis de nata in Belém",
  "Day 3 — Porto: port lodges, then the train",
  "Day 5 — Salamanca",
  "Day 6 — Madrid: the Prado",
  "Day 8 — Valencia: paella on the beach",
  "Day 10 — Barcelona",
].join("\n"))
make("trip", "places", "places", {
  Lisbon: { lat: 38.72, lon: -9.14 }, Porto: { lat: 41.15, lon: -8.61 }, Coimbra: { lat: 40.21, lon: -8.43 },
  Faro: { lat: 37.02, lon: -7.93 }, Seville: { lat: 37.39, lon: -5.98 }, Granada: { lat: 37.18, lon: -3.6 },
  "Córdoba": { lat: 37.88, lon: -4.78 }, Toledo: { lat: 39.86, lon: -4.02 }, Salamanca: { lat: 40.97, lon: -5.66 },
  Madrid: { lat: 40.42, lon: -3.7 }, Valencia: { lat: 39.47, lon: -0.38 }, Zaragoza: { lat: 41.65, lon: -0.89 },
  Barcelona: { lat: 41.39, lon: 2.17 }, Bilbao: { lat: 43.26, lon: -2.93 }, "San Sebastián": { lat: 43.32, lon: -1.98 },
  Bordeaux: { lat: 44.84, lon: -0.58 }, Toulouse: { lat: 43.6, lon: 1.44 }, Marseille: { lat: 43.3, lon: 5.37 },
})
make("trip", "weather", "weather", {})
// a setting: the trip's own units shadow the root's
make("root", "units", "units-mi", "mi")
make("trip", "units", "units-km", "km")

// What the views work out from the plan, and read from each other, by name. A
// process is placed under its pid, and nothing can place it under another
// name, so a derived value others look up is a node its process writes: the
// process's effect writes what its compute returned, when it changed.
make("plan", "stops", "stops", [])
make("plan", "legs", "legs", { units: "km", legs: [], total: 0 })
make("plan", "forecasts", "forecasts", {})

// each view finds its inputs by name, nearest first: the value of the first
// item of reading the address the lookup found it at
const finding = ${B}
export default function ({ api }) {
  const find = (name) => {
    const [it] = api.lookup({ name })
    return it && api.read({ address: it.from.path })[0].value
  }
${B}
// an effect that writes the process's value into the node of a name, in the plan
const publish = (name) => "export default function ({ api, value, previous }) {\n" +
  "  if (JSON.stringify(value) !== JSON.stringify(previous))\n" +
  "    api.write({ address: [" + JSON.stringify(name) + "], patches: [{ type: \"snapshot\", value }] })\n}"

// the outline editor: splices through the lasting interface, no echo
program("programs", "plan-editor", ${B}
export default function ({ api }) {
  const [plan] = api.lookup({ name: "plan" })
  return { text: api.read({ address: plan.from.path })[0].value, at: plan.from.path }
}
${B}, ${B}
import { h, screen } from "demo"
export default function ({ self, value, lasting }) {
  const s = screen(self)
  let ta = s.querySelector("textarea")
  if (!ta) {
    ta = h("textarea", { class: "ed tall", spellcheck: false })
    s.replaceChildren(h("div", { class: "label" }, "✎ plan — write Day N — Place: note"), ta)
  }
  ta.oninput = () => {
    const was = [...ta.dataset.was], now = [...ta.value]
    let a = 0; while (a < was.length && a < now.length && was[a] === now[a]) a++
    let b = 0; while (b < was.length - a && b < now.length - a && was[was.length-1-b] === now[now.length-1-b]) b++
    ta.dataset.was = ta.value
    lasting.write({ address: value.at, patches: [
      { type: "splice", path: [], range: [a, was.length - b], value: now.slice(a, now.length - b).join("") },
    ] })
  }
  if (ta.value !== value.text) { ta.value = value.text; ta.dataset.was = value.text }
}
${B})

// stops: the outline's lines that name a day and a place
program("programs", "parse-stops", finding + ${B}
  const places = find("places") ?? {}
  const stops = []
  for (const line of String(find("plan") ?? "").split("\\n")) {
    const m = line.match(/^\\s*day\\s+(\\d+)\\s*[—–-]+\\s*([^:]+?)\\s*(?::\\s*(.*))?$/i)
    if (!m) continue
    const at = places[m[2]]
    stops.push({ day: Number(m[1]), name: m[2], note: m[3] ?? "", ...(at ?? { unknown: true }) })
  }
  return stops
}
${B}, publish("stops"))

// legs: the distance between each stop and the next, in the units found
program("programs", "measure-legs", finding + ${B}
  const stops = (find("stops") ?? []).filter((s) => !s.unknown)
  const units = find("units") ?? "km"
  const r = units === "mi" ? 3958.8 : 6371
  const rad = (d) => d * Math.PI / 180
  const legs = []
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i]
    const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2
    legs.push({ from: a.name, to: b.name, d: Math.round(2 * r * Math.asin(Math.sqrt(h))) })
  }
  return { units, legs, total: legs.reduce((t, l) => t + l.d, 0) }
}
${B}, publish("legs"))

// forecasts: what is known so far, by place; null is still coming. A read of
// a name the folder lacks reads as none, and the run is marked when it appears
program("programs", "read-weather", finding + ${B}
  const [weather] = api.lookup({ name: "weather" })
  const out = {}
  for (const s of find("stops") ?? []) {
    out[s.name] = weather ? api.read({ address: [...weather.from.path, s.name] })[0]?.value ?? null : null
  }
  return out
}
${B}, publish("forecasts"))

// the slow work, in a process of its own: what it fetches is placed later,
// through its lasting interface, and marks whoever looked for it
program("programs", "fetch-weather", finding + ${B}
  const [weather] = api.lookup({ name: "weather" })
  const folder = weather?.from.path
  const known = folder ? api.directory({ address: folder }).directory.map(([name]) => name) : []
  const missing = (find("stops") ?? []).filter((s) => !s.unknown && !known.includes(s.name)).map((s) => s.name)
  return { folder, missing }
}
${B}, ${B}
import { h, screen } from "demo"
export default function ({ self, value, lasting }) {
  const skies = ["☀︎", "⛅︎", "☁︎", "🌧", "☀︎", "⛅︎"]
  const timers = value.missing.map((name) => {
    const n = [...name].reduce((h, c) => (h * 31 + c.codePointAt(0)) >>> 0, 7)
    return setTimeout(() => {
      lasting.place({ address: value.folder, name, id: "wx-" + name, value: { sky: skies[n % 6], high: 14 + (n % 15) } })
    }, 500 + (n % 9) * 240)
  })
  screen(self).replaceChildren(h("div", { class: "label" }, value.missing.length
    ? "fetching weather for " + value.missing.join(", ") + "…" : "weather: all fetched"))
  return () => timers.forEach(clearTimeout)
}
${B})

program("programs", "map", finding + ${B}
  return { places: find("places"), stops: find("stops"), weather: find("forecasts") }
}
${B}, ${B}
import { screen } from "demo"
export default function ({ self, value }) {
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => "&#" + c.charCodeAt(0) + ";")
  const W = 460, H = 330, box = { w: -10.5, e: 6, s: 36.2, n: 46 }
  const x = (lon) => ((lon - box.w) / (box.e - box.w) * W).toFixed(1)
  const y = (lat) => ((box.n - lat) / (box.n - box.s) * H).toFixed(1)
  let svg = '<svg class="map" viewBox="0 0 ' + W + " " + H + '">'
  for (let lon = -10; lon <= 6; lon += 2) svg += '<line class="grat" x1="' + x(lon) + '" x2="' + x(lon) + '" y1="0" y2="' + H + '"/>'
  for (let lat = 37; lat <= 46; lat += 1) svg += '<line class="grat" y1="' + y(lat) + '" y2="' + y(lat) + '" x1="0" x2="' + W + '"/>'
  for (const [n, p] of Object.entries(value.places)) {
    svg += '<circle class="town" cx="' + x(p.lon) + '" cy="' + y(p.lat) + '" r="2.4"/>'
    svg += '<text class="town-label" x="' + (+x(p.lon) + 5) + '" y="' + (+y(p.lat) + 3) + '">' + esc(n) + "</text>"
  }
  const pts = value.stops.filter((s) => !s.unknown)
  svg += '<polyline class="route" points="' + pts.map((s) => x(s.lon) + "," + y(s.lat)).join(" ") + '"/>'
  pts.forEach((s, i) => {
    const wx = value.weather[s.name]
    svg += '<circle class="stop" cx="' + x(s.lon) + '" cy="' + y(s.lat) + '" r="9"/>'
    svg += '<text class="stop-n" x="' + x(s.lon) + '" y="' + (+y(s.lat) + 3.5) + '">' + (i + 1) + "</text>"
    svg += '<text class="stop-label" x="' + (+x(s.lon) + 12) + '" y="' + (+y(s.lat) - 8) + '">' + esc(s.name) + " " + (wx ? wx.sky + " " + wx.high + "°" : "…") + "</text>"
  })
  svg += "</svg>"
  const lost = value.stops.filter((s) => s.unknown).map((s) => esc(s.name))
  screen(self).innerHTML = '<div class="label">map · ' + pts.length + " stops</div>" + svg +
    (lost.length ? '<div class="lost">not on the map: ' + lost.join(", ") + ' — add it to places</div>' : "")
}
${B})

program("programs", "itinerary", finding + ${B}
  return { stops: find("stops"), legs: find("legs"), weather: find("forecasts") }
}
${B}, ${B}
import { h, screen } from "demo"
export default function ({ self, value: { stops, legs, weather } }) {
  const rows = stops.map((s, i) => {
    const wx = weather[s.name]
    const leg = legs.legs.find((l) => l.to === s.name)
    return h("tr", { class: s.unknown ? "unknown" : "" },
      h("td", { class: "day" }, "day " + s.day),
      h("td", { class: "place" }, s.name),
      h("td", { class: "wx" }, s.unknown ? "?" : wx ? wx.sky + " " + wx.high + "°" : h("span", { class: "dots" }, "…")),
      h("td", { class: "leg" }, leg ? "+" + leg.d + " " + legs.units : ""),
      h("td", { class: "note" }, s.note))
  })
  screen(self).replaceChildren(
    h("div", { class: "label" }, "itinerary · " + legs.total + " " + legs.units + " overland"),
    h("table", { class: "itin" }, ...rows))
}
${B})

// the processes: each started in trip/plan, where it runs and looks up from
start("plan", "plan-editor")
start("plan", "parse-stops")
start("plan", "measure-legs")
start("plan", "read-weather")
start("plan", "fetch-weather")
start("plan", "map")
start("plan", "itinerary")

// Try: type "Day 12 — Bordeaux" in the plan; the map, legs, weather and itinerary follow.
//      unplace("trip", "units", "units-km")  — the root's miles show through
//      set("places", [], "Nice", { lat: 43.7, lon: 7.27 }) after writing a day in Nice
// Then explode the graph to see who reads what.
`;

const sheet = String.raw`
// A spreadsheet: cells are nodes, formulas are processes. Each formula is a
// process started in the sheet, where it looks its inputs up, and its effect
// writes what it works out into its own cell. The grid is a process too: it
// reads every cell, and a cell whose value a process wrote is a formula, as
// the change that last set it says.
make("root", "sheet", "sheet", {})
const cell = (name, v) => make("sheet", name, "cell-" + name, v)
cell("A1", "apples"); cell("B1", 12); cell("C1", 0.5)
cell("A2", "pears");  cell("B2", 7);  cell("C2", 0.8)
cell("A3", "plums");  cell("B3", 20); cell("C3", 0.25)

// the grid: reads every cell the sheet holds, by name, and draws it; typing in
// a plain cell writes it through the lasting interface. It runs in the sheet,
// so [] is the sheet, and a cell is ["A1"]
program("programs", "grid", ${B}
export default function ({ api }) {
  const cells = {}
  for (const [cell, items] of api.directory({ address: [] }).directory) {
    if (!/^[A-Z][0-9]+$/.test(cell)) continue
    const [it] = api.read({ address: [cell] }).filter((i) => "value" in i)
    cells[cell] = { id: items[0].id, at: [cell], v: it?.value, by: it?.change?.process ?? null }
  }
  return cells
}
${B}, ${B}
import { h, screen } from "demo"
export default function ({ self, value, lasting }) {
  const cols = ["A", "B", "C", "D"], rows = [1, 2, 3, 4]
  const head = h("tr", {}, h("th", {}), ...cols.map((c) => h("th", {}, c)))
  const body = rows.map((r) => h("tr", {}, h("th", {}, r), ...cols.map((c) => {
    const cell = value[c + r]
    if (!cell) return h("td", { class: "blank" })
    if (cell.by) return h("td", { class: "formula", title: "written by the process " + cell.by }, String(cell.v ?? "…"))
    const input = h("input", { value: String(cell.v ?? ""), class: typeof cell.v === "number" ? "num" : "" })
    input.onchange = () => {
      const n = Number(input.value)
      const v = input.value.trim() !== "" && !isNaN(n) ? n : input.value
      lasting.write({ address: cell.at, patches: [{ type: "snapshot", value: v }] })
    }
    return h("td", {}, input)
  })))
  screen(self).replaceChildren(h("div", { class: "label" }, "sheet · formulas are processes"), h("table", { class: "sheet-grid" }, head, ...body))
}
${B})
start("sheet", "grid")

// a formula is a program, and a process started in the sheet; its cell is a
// node it writes, so the grid and other formulas find it by name
const finding = ${B}
export default function ({ api }) {
  const find = (name) => {
    const [it] = api.lookup({ name })
    return it && api.read({ address: it.from.path }).find((i) => "value" in i)?.value
  }
${B}
const formula = (name, body) => {
  cell(name, null)
  program("programs", "f-" + name, finding + "  " + body + "\n}",
    "export default function ({ api, value, previous }) {\n" +
    "  if (value !== previous) api.write({ address: [" + JSON.stringify(name) + "], patches: [{ type: \"snapshot\", value }] })\n}")
  start("sheet", "f-" + name)
}
formula("D1", "return +(find('B1') * find('C1')).toFixed(2)")
formula("D2", "return +(find('B2') * find('C2')).toFixed(2)")
formula("D3", "return +(find('B3') * find('C3')).toFixed(2)")
formula("A4", "return 'total'")
formula("B4", "return find('B1') + find('B2') + find('B3')")
formula("D4", "return +(find('D1') + find('D2') + find('D3')).toFixed(2)")
formula("C4", "return +(find('D4') / find('B4')).toFixed(3)")

// Try: change B2 in the grid, then explode the graph and watch the marks travel.
`;

const desk = String.raw`
// A desk of things in folders. Nothing here knows how to draw anything: each
// thing says what it is ("@type"), and is drawn by the nearest renderer named
// "render-" and its type, looked up from where the thing is placed.
//
// Drag a thing from the inbox to the archive, in the browser or on the canvas,
// and the archive draws it its own way. Shift-drag to mount it in both: edit it
// in one, watch the other. Drag a renderer from the drawer into a folder, and
// everything there of that type is drawn anew. Edit a renderer's code in the
// inspector and every thing it draws redraws.
make("root", "desk", "desk", {})
make("desk", "inbox", "inbox", {})
make("desk", "archive", "archive", {})
make("inbox", "groceries", "groceries", { "@type": "list", title: "groceries", items: [
  { text: "carrots, a lot", done: false }, { text: "dandelion greens", done: true },
  { text: "oat milk", done: false }, { text: "a little cake", done: false } ] })
make("inbox", "haiku", "haiku", { "@type": "text",
  text: "white coat in winter / the ermine keeps its black tip / so you know it's there" })
make("inbox", "mood", "mood", { "@type": "color", hex: "#ff7aa8", name: "bubblegum" })
make("inbox", "steps", "steps", { "@type": "count", n: 7120, of: 10000, unit: "hops" })
make("archive", "letter", "letter", { "@type": "text",
  text: "dear bun, the burrow is warm and the snow is deep. come home soon." })

// the renderers: plain nodes of code, placed by name, which a card runs with
// thing, el, h and save. The desk's serve everything on the desk; the
// archive's text renderer is nearer for its things.
make("desk", "render-text", "text-card", ${B}
const p = h("p", { class: "r-text", contenteditable: "true", spellcheck: "false" }, thing.text)
p.onblur = () => p.textContent !== thing.text && save({ ...thing, text: p.textContent })
el.replaceChildren(p)
${B})
make("desk", "render-list", "checklist", ${B}
const draw = () => el.replaceChildren(
  h("div", { class: "r-list-title" }, thing.title),
  ...thing.items.map((it, i) => {
    const box = h("input", { type: "checkbox", checked: it.done })
    box.onchange = () => {
      thing = { ...thing, items: thing.items.map((x, j) => j === i ? { ...x, done: box.checked } : x) }
      draw()
      save(thing)
    }
    return h("label", { class: "r-item" + (it.done ? " done" : "") }, box, " " + it.text)
  }))
draw()
${B})
make("desk", "render-color", "swatch", ${B}
const pal = ["#ff7aa8", "#a78bff", "#4fd4a4", "#f2c94c", "#6bb5f5", "#ff9a6a"]
const draw = () => {
  const sw = h("div", { class: "r-swatch", style: { background: thing.hex } })
  sw.title = "click: the next colour"
  sw.onclick = () => {
    thing = { ...thing, hex: pal[(pal.indexOf(thing.hex) + 1) % pal.length] }
    draw()
    save(thing)
  }
  el.replaceChildren(sw, h("div", { class: "r-caption" }, thing.name + " · " + thing.hex))
}
draw()
${B})
make("desk", "render-count", "ring", ${B}
const draw = () => {
  const f = Math.min(1, thing.n / thing.of), c = 2 * Math.PI * 34
  el.innerHTML = '<svg class="r-ring" viewBox="0 0 90 90"><circle cx="45" cy="45" r="34" class="bg"/>' +
    '<circle cx="45" cy="45" r="34" class="fg" stroke-dasharray="' + f * c + " " + c + '"/>' +
    '<text x="45" y="50">' + Math.round(f * 100) + '%</text></svg><div class="r-caption">' +
    thing.n.toLocaleString() + " " + thing.unit + " · click to hop</div>"
  el.querySelector("svg").onclick = () => { thing = { ...thing, n: thing.n + 450 }; draw(); save(thing) }
}
draw()
${B})
make("desk", "render-json", "plain", ${B}
el.replaceChildren(h("pre", { class: "r-json" }, JSON.stringify(thing, null, 1)))
${B})
make("archive", "render-text", "typewriter", ${B}
el.replaceChildren(h("p", { class: "r-typewriter" }, thing.text), h("div", { class: "r-stamp" }, "archived"))
${B})

// a drawer of other renderers, placed nowhere that anything looks: drag one
// into a folder to change how that folder draws
make("root", "drawer", "drawer", {})
make("drawer", "render-list", "stickers", ${B}
el.replaceChildren(h("div", { class: "r-stickers" }, ...thing.items.map((it) =>
  h("span", { class: "r-sticker" + (it.done ? " done" : "") }, it.done ? "✓ " + it.text : it.text))))
${B})
make("drawer", "render-color", "palette", ${B}
const n = parseInt(thing.hex.slice(1), 16)
const mix = (t) => "#" + [16, 8, 0].map((s) => Math.round(((n >> s) & 255) * (1 - t) + 255 * t).toString(16).padStart(2, "0")).join("")
el.replaceChildren(h("div", { class: "r-palette" }, ...[0, 0.25, 0.5, 0.7, 0.85].map((t) =>
  h("span", { style: { background: mix(t) } }))), h("div", { class: "r-caption" }, thing.name))
${B})
make("drawer", "render-text", "shouty", ${B}
el.replaceChildren(h("p", { class: "r-shouty" }, thing.text.toUpperCase() + "!!"))
${B})

// a folder view: what its folder holds, and a card for each thing. It runs in
// its folder, so [] is the folder, and [name] its own node. A directory item
// carries the change that last set its slot: a thing dragged away and back is
// a new placement, and gets a new card. Each card runs in a node of its own,
// made in the view's node by the thing's name, so the card's place says which
// thing it draws; a card for a thing that left goes with its node, since a
// process whose address reaches nothing is killed
program("programs", "folder", ${B}
export default function ({ api, cwd, name }) {
  const items = api.directory({ address: [] }).directory
    .filter(([slot]) => !slot.startsWith("render-") && !slot.startsWith("@"))
    .flatMap(([slot, found]) => found.map((item) => ({ name: slot, id: item.id, since: item.change?.time ?? 0 })))
  const kids = Object.fromEntries(
    api.directory({ address: [name] }).directory.map(([slot, found]) => [slot, found.map((item) => item.id)]))
  return { title: cwd[cwd.length - 1], items, kids }
}
${B}, ${B}
import { h, screen } from "demo"
export default function ({ api, self, name, value }) {
  screen(self).replaceChildren(h("div", { class: "folder-title" }, "▤ " + value.title,
    h("span", { class: "muted" }, "  " + value.items.length + " things")))
  const want = new Set(value.items.map((t) => self + ":" + t.id + "@" + t.since))
  for (const [slot, ids] of Object.entries(value.kids)) {
    for (const id of ids) if (id.startsWith(self + ":") && !want.has(id)) api.unplace({ address: [name], name: slot, id })
  }
  for (const t of value.items) {
    const id = self + ":" + t.id + "@" + t.since
    if ((value.kids[t.name] ?? []).includes(id)) continue
    api.place({ address: [name], name: t.name, id, value: t.id })
    api.start({ address: [name, t.name], program: ["programs", "card"] })
  }
}
${B})
// a thing's card: the thing, and the renderer found for it. It runs in its
// node, in the view, in the folder, so the thing is ["..", "..", its name]
program("programs", "card", ${B}
export default function ({ api, cwd }) {
  const name = cwd[cwd.length - 1]
  const at = ["..", "..", name]
  const thing = api.read({ address: at })[0]?.value
  const type = (thing && typeof thing === "object" && thing["@type"]) || "json"
  const by = api.lookup({ name: "render-" + type })[0] ?? api.lookup({ name: "render-json" })[0]
  return { name, at, thing: thing ?? null, type, renderer: by?.id ?? null,
    code: by ? api.read({ address: by.from.path })[0].value : null }
}
${B}, ${B}
import { h, screen } from "demo"
export default function ({ self, value, lasting }) {
  const el = screen(self)
  const body = h("div", { class: "thing-body" })
  el.replaceChildren(h("div", { class: "thing-head" },
    h("span", { class: "thing-name" }, value.name),
    h("span", { class: "thing-by" }, "drawn by " + (value.renderer ?? "nothing"))), body)
  const save = (v) => lasting.write({ address: value.at, patches: [{ type: "snapshot", value: v }] })
  try {
    new Function("thing", "el", "h", "save", value.code ?? "")(value.thing, body, h, save)
  } catch (e) {
    body.replaceChildren(h("div", { class: "oops" }, "the renderer threw: " + e.message))
  }
}
${B})

start("inbox", "folder")
start("archive", "folder")
`;

const essays = String.raw`
// Two documents made of the same paragraphs. A paragraph is a node; a document
// is a folder whose "sections" slot lists paragraphs in order. One node can be
// placed in many slots, so the intro is in both: edit it in one, and the other
// changes. Drag paragraphs between documents, or along a slot to reorder;
// drag one from the library into a document to add it. Each document is drawn
// in the style it finds nearest.
//
// Reading a document's "sections" slot gives every paragraph in it, but a
// write reaches only the first, so to be edited each paragraph is in the
// library under a name of its own too (CORE.tex: to write one, mount it
// somewhere under a name of its own); its "sections" slot is to drag from.
make("root", "library", "library", {})
const para = (id, text) => { make("library", id, id, { "@type": "para", text }); place("library", "sections", id) }
para("p-intro", "The ermine is a stoat in its winter coat: white all over, but for the black tip of its tail.")
para("p-tail", "The black tip is a decoy. A hawk strikes at the dark spot it can see, and the ermine slips away.")
para("p-snow", "In spring it browns again, molting from the back down, a little at a time.")
para("p-burrow", "It does not dig its own burrow. It takes one, usually from whoever it has just eaten.")
para("p-bun", "Rabbits, for their part, would like everyone to know they had nothing to do with this.")

make("root", "style", "plain-style", { font: "var(--sans)", size: 14, ink: "var(--ink-2)", paper: "var(--panel-2)" })
make("root", "essay", "essay", { title: "On the ermine" })
make("essay", "style", "serif-style", { font: "var(--serif)", size: 16, ink: "var(--ink)", paper: "var(--panel)" })
place("essay", "sections", "p-intro"); place("essay", "sections", "p-tail"); place("essay", "sections", "p-snow")

make("root", "letter", "letter", { title: "a letter to bun" })
make("letter", "style", "note-style", { font: "var(--mono)", size: 13, ink: "#7a1f4b", paper: "#fff3f8" })
place("letter", "sections", "p-intro"); place("letter", "sections", "p-bun")

program("programs", "typeset", ${B}
export default function ({ api }) {
  const doc = api.read({ address: [] })[0]?.value ?? {}
  // reading the slot gives an item for each paragraph in it that is here, in order
  const items = api.read({ address: ["sections"] })
  const [library] = api.lookup({ name: "library" })
  const lib = library?.from.path ?? []
  // nearest first: the document's own style if it has one, else one above it
  const [style] = api.lookup({ name: "style" })
  // each item's route ends at its paragraph; a write goes through the library
  const paras = items.map((item) => {
    const id = item.from.route.at(-1).node
    return { id, at: [...lib, id], text: item.value?.text ?? "" }
  })
  return { title: doc.title, style: style && api.read({ address: style.from.path })[0].value, paras }
}
${B}, ${B}
import { h, screen } from "demo"
export default function ({ self, value, lasting }) {
  const s = value.style ?? {}
  const art = h("article", { class: "doc", style: { fontFamily: s.font, fontSize: s.size + "px", color: s.ink, background: s.paper } },
    h("h3", {}, value.title),
    ...value.paras.map((p) => {
      const el = h("p", { contenteditable: "true", spellcheck: "false", title: p.id }, p.text)
      el.onblur = () => el.textContent !== p.text && lasting.write({
        address: p.at, patches: [{ type: "snapshot", value: { "@type": "para", text: el.textContent } }],
      })
      return el
    }))
  screen(self).replaceChildren(art)
}
${B})
start("essay", "typeset")
start("letter", "typeset")

// Try: drag p-bun from the library into the essay; drag p-snow above p-tail.
//      edit the intro in the letter, and watch the essay.
//      drag the letter's style into the essay, and the essay is a note now;
//      the letter, with none of its own, takes the plain style from the root.
`;

const pixels = String.raw`
// A pipeline is a slot: the lens looks up "filter" and runs every filter in
// the nearest slot of that name, in order. Drag filters from the drawer into
// the studio's filter slot, or along it to reorder, and watch the bunny change.
// The night corner has a filter slot of its own, so it shadows the studio's.
make("root", "studio", "studio", {})
make("studio", "sprite", "bunny", [
  "..p......p..",
  ".pwp....pwp.",
  ".pwp....pwp.",
  ".pwp....pwp.",
  "..wwwwwwww..",
  ".wwwwwwwwww.",
  ".wwkwwwwkww.",
  ".wwwwnnwwww.",
  "..wwwwwwww..",
  "...wwwwww...",
  "..ww.ww.ww..",
  ".ww..ww..ww.",
])
make("studio", "palette", "candy", { w: "#ffffff", p: "#ffb3cf", k: "#2c2231", n: "#e2457c" })

// Reading a slot gives every filter in it, but a write reaches only the first,
// so to be edited each filter is in the drawer under a name of its own too;
// its "filter" slot is to drag from. A filter is code the lens runs with g.
make("root", "drawer", "drawer", {})
const filter = (id, code) => { make("drawer", id, id, code); place("drawer", "filter", id) }
filter("mirror", "return g.map((row) => [...row].reverse())")
filter("flip", "return [...g].reverse()")
filter("rotate", "return g[0].map((_, x) => g.map((row) => row[x]).reverse())")
filter("outline", "return g.map((row, y) => row.map((c, x) => c ?? ([[0, 1], [1, 0], [0, -1], [-1, 0]].some(([dx, dy]) => g[y + dy]?.[x + dx]) ? '#7b5ce6' : null)))")
filter("invert", "return g.map((row) => row.map((c) => c && '#' + (0xffffff ^ parseInt(c.slice(1), 16)).toString(16).padStart(6, '0')))")
filter("pinkify", "return g.map((row) => row.map((c) => c && (c === '#ffffff' ? '#ffd6e7' : c)))")
filter("frame", "const w = g[0].length; const edge = Array(w + 2).fill('#f2c94c'); return [edge, ...g.map((row) => ['#f2c94c', ...row, '#f2c94c']), edge]")
filter("double", "return g.flatMap((row) => { const r = row.flatMap((c) => [c, c]); return [r, r] })")

place("studio", "filter", "outline")
place("studio", "filter", "frame")

make("studio", "night", "night", {})
make("night", "palette", "dusk", { w: "#c9c2ff", p: "#7b5ce6", k: "#fdf6fa", n: "#ff7aa8" })
place("night", "filter", "mirror")

program("programs", "lens", ${B}
export default function ({ api }) {
  const find = (name) => {
    const [it] = api.lookup({ name })
    return it && api.read({ address: it.from.path })[0].value
  }
  const pal = find("palette") ?? {}
  let g = (find("sprite") ?? []).map((row) => [...row].map((ch) => pal[ch] ?? null))
  const stages = [{ name: "sprite", g }]
  // reading the nearest filter slot gives an item for each filter in it that is here, in order
  const [filter] = api.lookup({ name: "filter" })
  for (const item of filter ? api.read({ address: filter.from.path }) : []) {
    const id = item.from.route.at(-1).node
    try {
      g = new Function("g", item.value)(g)
      stages.push({ name: id, g })
    } catch (e) {
      stages.push({ name: id + " ✕", g })
    }
  }
  return stages
}
${B}, ${B}
import { h, screen } from "demo"
export default function ({ self, value }) {
  const paint = (g, px) => {
    const c = h("canvas", { width: (g[0]?.length ?? 0) * px, height: g.length * px })
    const cx = c.getContext("2d")
    g.forEach((row, y) => row.forEach((col, x) => { if (col) { cx.fillStyle = col; cx.fillRect(x * px, y * px, px, px) } }))
    return c
  }
  const strip = []
  value.forEach((s, i) => {
    if (i) strip.push(h("span", { class: "px-arrow" }, "→"))
    strip.push(h("figure", { class: "px-stage" + (i === value.length - 1 ? " last" : "") },
      paint(s.g, i === value.length - 1 ? 12 : 5), h("figcaption", {}, s.name)))
  })
  screen(self).replaceChildren(h("div", { class: "px-strip" }, ...strip))
}
${B})
start("studio", "lens")
start("night", "lens")

// Try: drag "invert" from the drawer onto the studio's filter slot (drop on
// the edge of "outline" or "frame" to choose where). Drag "frame" above
// "outline". Unplace the night's filter and its mirror is gone: the studio's
// pipeline shows through.
`;

const values = String.raw`
// Values are more than JSON (CORE.tex, Values): bytes, as a file or an image
// holds them, and typed arrays, as samples are held, never as strings or
// lists of numbers. bytes(base64) and typed(kind, elements) make them here.
make("root", "sprite", "sprite-png", bytes("iVBORw0KGgoAAAANSUhEUgAAAAwAAAAMCAYAAABWdVznAAAARUlEQVR42mNggIL/m8//Z8ABMORAAmCARRNWOdprAEsQACQpxtAEE9BRMsRQhCyG04ZHrjVgTJGzsEcQOYrxsbEqJsQHAEiVQEhLVgYYAAAAAElFTkSuQmCC"))
make("root", "samples", "samples", typed("float32", Array.from({ length: 64 }, (_, i) =>
  Math.round(Math.sin(i / 5) * 1000) / 1000)))

// a process reads both: a typed array stays one in a compute, and a value it
// returns may hold one, as the process's value does
program("programs", "scope", ${B}
export default function ({ api }) {
  const find = (name) => {
    const [it] = api.lookup({ name })
    return it && api.read({ address: it.from.path })[0].value
  }
  const s = find("samples")
  let lo = Infinity, hi = -Infinity, sum = 0
  for (const x of s) { lo = Math.min(lo, x); hi = Math.max(hi, x); sum += x * x }
  return { n: s.length, lo, hi, rms: Math.sqrt(sum / s.length), samples: s, png: find("sprite") }
}
${B}, ${B}
import { h, screen } from "demo"
export default function ({ self, value }) {
  const w = 240, ht = 60
  const pts = Array.from(value.samples, (x, i) => (i * w / (value.n - 1)).toFixed(1) + "," + ((1 - (x - value.lo) / (value.hi - value.lo || 1)) * ht).toFixed(1))
  const svg = '<svg viewBox="0 0 ' + w + " " + ht + '" width="' + w + '" height="' + ht + '"><polyline fill="none" stroke="var(--rose)" stroke-width="2" points="' + pts.join(" ") + '"/></svg>'
  const img = h("img", { src: URL.createObjectURL(new Blob([value.png], { type: "image/png" })), width: 96, height: 96, style: { imageRendering: "pixelated" } })
  const line = h("div", {})
  line.innerHTML = svg
  screen(self).replaceChildren(img, line,
    h("div", { class: "label" }, value.n + " float32 samples · rms " + value.rms.toFixed(3)))
}
${B})
start("root", "scope")

// Try: set("samples", [], ...) cannot go into a typed array, but a splice can:
//   splice("samples", [], 0, 8, typed("float32", [1, 1, 1, 1, 1, 1, 1, 1]))
`;

const blank = String.raw`
// The host gave the root. Make something by placing it:
//   make("root", "hello", "hello", "world")
// process(parent, name, { compute, effect? }) makes the loaders and the
// programs folder if the root has none, a program, and a process running it.
`;

const withRuntime = (code: string) => (runtime + code).trim();

export const examples: Example[] = [
  {
    id: "hello",
    title: "hello, ermine",
    blurb: "a node, a derived value, a counter with a button",
    code: withRuntime(hello),
  },
  {
    id: "typing",
    title: "typing",
    blurb: "scheduler.tex's editor: splices through the lasting interface, no echo",
    code: withRuntime(typing),
  },
  {
    id: "themes",
    title: "configuration is placement",
    blurb: "lookup searches up the place; nearer names shadow farther ones",
    code: withRuntime(themes),
  },
  {
    id: "guarded",
    title: "protect",
    blurb: "rules ask may() before every operation; refusals are recorded",
    code: withRuntime(guarded),
  },
  {
    id: "slow",
    title: "pending",
    blurb: "a compute waits for a name that slow work places later",
    code: withRuntime(slow),
  },
  {
    id: "data",
    title: "programs as data",
    blurb: "the steps language of the conformance protocol",
    code: withRuntime(data),
  },
  {
    id: "embark",
    title: "a trip, à la embark",
    blurb: "an outline you write; a map, distances, weather and an itinerary follow",
    code: withRuntime(embark),
  },
  {
    id: "sheet",
    title: "a spreadsheet",
    blurb: "cells are nodes, formulas are processes, the grid reads them all",
    code: withRuntime(sheet),
  },
  {
    id: "desk",
    title: "a desk of things",
    blurb: "drag things between folders; renderers are found by lookup",
    code: withRuntime(desk),
  },
  {
    id: "essays",
    title: "one paragraph, two documents",
    blurb: "a node placed in two slots: edit once, both change; drag to reorder",
    code: withRuntime(essays),
  },
  {
    id: "pixels",
    title: "a pipeline is a slot",
    blurb: "drop filters into a slot, drag them to reorder, shadow it nearer",
    code: withRuntime(pixels),
  },
  {
    id: "values",
    title: "bytes and typed arrays",
    blurb: "an image's bytes and float32 samples, held as the machine holds them",
    code: withRuntime(values),
  },
  { id: "blank", title: "blank", blurb: "just the root", code: blank.trim() },
];

export const rulesFor: {
  [id: string]: { agent?: string; op?: string; node?: string; allow: boolean; on: boolean }[];
} = {
  guarded: guardedRules,
};
