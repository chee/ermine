// Boot images: each is a workspace snippet, so every change it makes from
// outside carries its site, and the transcript can show the line that made it.
//
// Every node is made by placing it, as CORE.tex has it, and programs find what
// they read by lookup from their place, so everything is in the tree and every
// dependency shows in a run's record as a search.

export type Example = { id: string; title: string; blurb: string; code: string };

const B = "`";

const hello = String.raw`
// The host gave the root. Every other node is made by placing it somewhere:
// make(parent, name, id, value).
make("root", "clicks", "clicks", 0)

// A process's place is where it is put, so it finds "clicks" by looking up
// from there: the root. A compute only reads; with no effect, a process is a
// derived value.
process("root", "double", "double", { compute: "return find('clicks') * 2" })

// The counter learns which node it found, so its effect can write it. A press
// writes through the lasting interface, as the counter, so the change names
// it, and a process is not marked by its own changes: no echo. Like CORE.tex's
// editor, the screen keeps the count it shows. A write from anyone else marks
// the counter, and it draws again from what it read.
process("root", "counter", "counter", {
  compute: "const at = where('clicks'); return { n: read(at), at }",
  effect: ${B}
let n = value.n
const big = h("div", { class: "big" }, n)
handler("press", () => { later.write(value.at, ++n); big.textContent = n })
screen().replaceChildren(
  big,
  h("div", { class: "label" }, "clicks"),
  h("button", { class: "bun", onclick: () => fire("press") }, "🐇 hop!"),
)
${B},
})

// Placing a process under the root started it. Then try, in the workspace:
//   write("clicks", 41)
`;

const typing = String.raw`
// CORE.tex's editor. The editor's compute finds the document and returns it;
// its effect makes a textarea once, and later puts new values into it. Typing
// writes splices through the lasting interface. Those changes name the editor,
// so they do not mark it: no echo. Everyone else who read doc runs.
make("root", "doc", "doc", "the quick brown ermine hops over the lazy rabbit")

process("root", "editor", "editor", {
  compute: "const at = where('doc'); return { text: read(at), at }",
  effect: ${B}
const s = screen()
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
  later.patch(value.at, { type: "splice", path: [], range: [a, was.length - b], value: now.slice(a, now.length - b).join("") })
}
if (ta.value !== value.text) { ta.value = value.text; ta.dataset.was = value.text }
${B},
})

process("root", "words", "words", {
  compute: "const d = find('doc'); return d.trim() ? d.trim().split(/\\s+/).length : 0",
  effect: "screen().replaceChildren(h('div', { class: 'big' }, value), h('div', { class: 'label' }, 'words'))",
})

process("root", "shout", "shout", {
  compute: "return find('doc').toUpperCase()",
  effect: "screen().replaceChildren(h('div', { class: 'label' }, 'shout'), h('p', { class: 'shout' }, value))",
})
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

// Programs live in the tree too: one card program, run in two places.
make("root", "programs", "programs", {})
program("programs", "card", ${B}
const theme = find("theme") ?? { bg: "#eee", fg: "#333", name: "none" }
return { text: read(path[path.length - 1].node), theme }
${B})
program("programs", "draw", ${B}
const { text, theme } = value
screen().replaceChildren(h("div", { class: "card", style: { background: theme.bg, color: theme.fg } },
  h("div", { class: "label" }, "theme: " + theme.name), h("p", {}, text)))
${B})

// Two processes, each placed under the root to run, with a place that says
// what it shows: lookups search from there.
process("root", "show-note", "show-note", { path: path("root", "home", "note"), compute: "card", effect: "draw" })
process("root", "show-readme", "show-readme", { path: path("root", "home", "docs", "readme"), compute: "card", effect: "draw" })

// Try: unplace("docs", "theme", "mint")   — the readme falls back to pink
//      place("docs", "theme", "mint")     — and back
`;

const guarded = String.raw`
// protect asks may() before every operation. Rules live in the Protect tab:
// the first rule that matches wins; none matching allows.
make("root", "diary", "diary", "dear diary, today i hopped")
make("root", "public", "public", "hello everyone")

process("root", "reader", "reader", {
  compute: "return { diary: find('diary'), public: find('public') }",
  effect: "screen().replaceChildren(h('div', { class: 'label' }, 'reader'), h('pre', {}, JSON.stringify(value, null, 1)))",
})

// Now act as bun (the pills at the top) and try:  write("diary", "bun was here")
// Or start a process as hop, who may not read the diary:
//   as("hop", () => process("root", "snoop", "snoop", { compute: "return find('diary')" }))
`;

const guardedRules = [
  { agent: "bun", op: "write", node: "diary", allow: false, on: true },
  { agent: "hop", op: "read", node: "diary", allow: false, on: true },
];

const slow = String.raw`
// A compute that found nothing yet returns PENDING. It wrote nothing, so its
// effect does not run and nothing needs undoing. Its lookup read the slot
// "weather" in the root, so it is marked when that name appears, and runs
// again. Slow work is something that writes later.
process("root", "forecast", "forecast", {
  compute: "const w = find('weather'); if (w === undefined) return PENDING; return w",
  effect: "screen().replaceChildren(h('div', { class: 'big' }, value.sky), h('div', { class: 'label' }, value.temp + '° in ' + value.town))",
})

process("root", "fetcher", "fetcher", {
  compute: "return 'soon'",
  effect: ${B}
const t = setTimeout(() => later.make("root", "weather", "weather", { sky: "☁︎ → ☀︎", temp: 19, town: "the burrow" }), 2000)
screen().replaceChildren(h('div', { class: 'label' }, 'fetching the weather… (2s)'))
return () => clearTimeout(t)
${B},
})
`;

const data = String.raw`
// Programs as data: the small language of PROTOCOL.tex, which every harness
// interprets, so one scenario runs in every language. The loader takes a
// string as JS, and a list as steps. Reads are lists of items: $ids takes
// the ids of a lookup's items, and $value the value of a read's first item.
make("root", "a", "a", 20)
make("root", "b", "b", 22)
make("root", "programs", "programs", {})
program("programs", "sum", [
  { do: "lookup", name: "a", as: "la" },
  { do: "lookup", name: "b", as: "lb" },
  { do: "read", node: { $get: [{ $ids: { $: "la" } }, 0] }, as: "x" },
  { do: "read", node: { $get: [{ $ids: { $: "lb" } }, 0] }, as: "y" },
  { do: "return", value: { $add: [{ $value: { $: "x" } }, { $value: { $: "y" } }] } },
])
process("root", "adder", "adder", { compute: "sum" })
// write("a", 100) and watch adder's value in the inspector.
`;

const embark = String.raw`
// A trip planner in the spirit of Ink & Switch's Embark: one outline that you
// write, and views computed from it. Each view is a process that looks up what
// it needs from its place, trip/plan, so nearer settings shadow farther ones.
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

// the views' programs, kept in the tree like everything else
make("root", "programs", "programs", {})

// the outline editor: splices through the lasting interface, no echo
program("programs", "outline-editor", ${B}
const s = screen()
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
  later.patch(value.at, { type: "splice", path: [], range: [a, was.length - b], value: now.slice(a, now.length - b).join("") })
}
if (ta.value !== value.text) { ta.value = value.text; ta.dataset.was = value.text }
${B})

// stops: the outline's lines that name a day and a place
program("programs", "parse-stops", ${B}
const places = find("places") ?? {}
const stops = []
for (const line of String(find("plan") ?? "").split("\\n")) {
  const m = line.match(/^\\s*day\\s+(\\d+)\\s*[—–-]+\\s*([^:]+?)\\s*(?::\\s*(.*))?$/i)
  if (!m) continue
  const at = places[m[2]]
  stops.push({ day: Number(m[1]), name: m[2], note: m[3] ?? "", ...(at ?? { unknown: true }) })
}
return stops
${B})

// legs: the distance between each stop and the next, in the units found
program("programs", "measure-legs", ${B}
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
${B})

// forecasts: what is known so far, by place; null is still coming
program("programs", "read-weather", ${B}
const folder = where("weather")
const known = folder ? dir(folder) ?? {} : {}
const out = {}
for (const s of find("stops") ?? []) {
  const [id] = known[s.name] ?? []
  out[s.name] = id ? read(id) : null
}
return out
${B})

// the slow work, in a process of its own: a process is not marked by its own
// changes, so the one that fetches cannot be the one that waits for the answer
program("programs", "missing-weather", ${B}
const folder = where("weather")
const known = folder ? dir(folder) ?? {} : {}
const missing = (find("stops") ?? []).filter((s) => !s.unknown && !known[s.name]).map((s) => s.name)
return { folder, missing }
${B})
program("programs", "fetch-weather", ${B}
const skies = ["☀︎", "⛅︎", "☁︎", "🌧", "☀︎", "⛅︎"]
const timers = value.missing.map((name) => {
  const n = [...name].reduce((h, c) => (h * 31 + c.codePointAt(0)) >>> 0, 7)
  return setTimeout(() => {
    later.make(value.folder, name, "wx-" + name, { sky: skies[n % 6], high: 14 + (n % 15) })
  }, 500 + (n % 9) * 240)
})
screen().replaceChildren(h("div", { class: "label" }, value.missing.length
  ? "fetching weather for " + value.missing.join(", ") + "…" : "weather: all fetched"))
return () => timers.forEach(clearTimeout)
${B})

program("programs", "draw-map", ${B}
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
screen().innerHTML = '<div class="label">map · ' + pts.length + " stops</div>" + svg +
  (lost.length ? '<div class="lost">not on the map: ' + lost.join(", ") + ' — add it to places</div>' : "")
${B})

program("programs", "draw-itinerary", ${B}
const { stops, legs, weather } = value
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
screen().replaceChildren(
  h("div", { class: "label" }, "itinerary · " + legs.total + " " + legs.units + " overland"),
  h("table", { class: "itin" }, ...rows))
${B})

// the processes: each placed under the root to run, each at trip/plan to look up
const at = path("root", "trip", "plan")
process("root", "plan-editor", "plan-editor", {
  path: at, compute: "const at = where('plan'); return { text: read(at), at }", effect: "outline-editor" })
process("root", "stops", "stops", { path: at, compute: "parse-stops" })
process("root", "legs", "legs", { path: at, compute: "measure-legs" })
process("root", "forecasts", "forecasts", { path: at, compute: "read-weather" })
process("root", "weatherman", "weatherman", { path: at, compute: "missing-weather", effect: "fetch-weather" })
process("root", "map", "map", {
  path: at, compute: "return { places: find('places'), stops: find('stops'), weather: find('forecasts') }", effect: "draw-map" })
process("root", "itinerary", "itinerary", {
  path: at, compute: "return { stops: find('stops'), legs: find('legs'), weather: find('forecasts') }", effect: "draw-itinerary" })

// Try: type "Day 12 — Bordeaux" in the plan; the map, legs, weather and itinerary follow.
//      unplace("trip", "units", "units-km")  — the root's miles show through
//      set("places", [], "Nice", { lat: 43.7, lon: 7.27 }) after writing a day in Nice
// Then explode the graph to see who reads what.
`;

const sheet = String.raw`
// A spreadsheet: cells are nodes, formulas are processes. The sheet is a
// process too; cells live in its directory, and formula processes placed there
// are started by it. A formula looks its inputs up from its place in the sheet.
make("root", "programs", "programs", {})

// the grid: reads every cell the sheet holds, by name, and draws it; typing
// in a plain cell writes it through the lasting interface
program("programs", "grid", ${B}
const cells = {}
for (const [name, ids] of Object.entries(dir(self) ?? {})) {
  if (!/^[A-Z][0-9]+$/.test(name)) continue
  const id = ids[0]
  cells[name] = { id, v: read(id), formula: data(id)?.path !== undefined }
}
return cells
${B})
program("programs", "draw-grid", ${B}
const cols = ["A", "B", "C", "D"], rows = [1, 2, 3, 4]
const head = h("tr", {}, h("th", {}), ...cols.map((c) => h("th", {}, c)))
const body = rows.map((r) => h("tr", {}, h("th", {}, r), ...cols.map((c) => {
  const cell = value[c + r]
  if (!cell) return h("td", { class: "blank" })
  if (cell.formula) return h("td", { class: "formula", title: cell.id + " is a process" }, String(cell.v ?? "…"))
  const input = h("input", { value: String(cell.v), class: typeof cell.v === "number" ? "num" : "" })
  input.onchange = () => {
    const n = Number(input.value)
    later.write(cell.id, input.value.trim() !== "" && !isNaN(n) ? n : input.value)
  }
  return h("td", {}, input)
})))
screen().replaceChildren(h("div", { class: "label" }, "sheet · formulas are processes"), h("table", { class: "sheet-grid" }, head, ...body))
${B})

// the sheet runs the grid; its directory holds the cells
process("root", "sheet", "sheet", { compute: "grid", effect: "draw-grid" })
const cell = (name, v) => make("sheet", name, "cell-" + name, v)
cell("A1", "apples"); cell("B1", 12); cell("C1", 0.5)
cell("A2", "pears");  cell("B2", 7);  cell("C2", 0.8)
cell("A3", "plums");  cell("B3", 20); cell("C3", 0.25)

// a formula is a process placed in the sheet, which starts it; it looks its
// inputs up from its place there
const formula = (name, code) => process("sheet", name, "f-" + name, {
  path: path("root", "sheet").concat([{ parent: "sheet", name, node: "f-" + name }]),
  compute: code,
})
formula("D1", "return +(find('B1') * find('C1')).toFixed(2)")
formula("D2", "return +(find('B2') * find('C2')).toFixed(2)")
formula("D3", "return +(find('B3') * find('C3')).toFixed(2)")
formula("A4", "return 'total'")
formula("B4", "return find('B1') + find('B2') + find('B3')")
formula("D4", "return +(find('D1') + find('D2') + find('D3')).toFixed(2)")
formula("C4", "return +(find('D4') / find('B4')).toFixed(3)")

// Try: change B2 in the grid, then explode the graph and watch the marks travel.
`;

const blank = String.raw`
// The host gave the root. Make something by placing it:
//   make("root", "hello", "hello", "world")
`;

export const examples: Example[] = [
  {
    id: "hello",
    title: "hello, ermine",
    blurb: "a node, a derived value, a counter with a button",
    code: hello.trim(),
  },
  {
    id: "typing",
    title: "typing",
    blurb: "core.tex's editor: splices through the lasting interface, no echo",
    code: typing.trim(),
  },
  {
    id: "themes",
    title: "configuration is placement",
    blurb: "lookup searches up the place; nearer names shadow farther ones",
    code: themes.trim(),
  },
  {
    id: "guarded",
    title: "protect",
    blurb: "rules ask may() before every operation; refusals are recorded",
    code: guarded.trim(),
  },
  {
    id: "slow",
    title: "pending",
    blurb: "a compute waits for a name that slow work places later",
    code: slow.trim(),
  },
  {
    id: "data",
    title: "programs as data",
    blurb: "the steps language of the conformance protocol",
    code: data.trim(),
  },
  {
    id: "embark",
    title: "a trip, à la embark",
    blurb: "an outline you write; a map, distances, weather and an itinerary follow",
    code: embark.trim(),
  },
  {
    id: "sheet",
    title: "a spreadsheet",
    blurb: "cells are nodes, formulas are processes, the grid reads them all",
    code: sheet.trim(),
  },
  { id: "blank", title: "blank", blurb: "just the root", code: blank.trim() },
];

export const rulesFor: {
  [id: string]: { agent?: string; op?: string; node?: string; allow: boolean; on: boolean }[];
} = {
  guarded: guardedRules,
};
