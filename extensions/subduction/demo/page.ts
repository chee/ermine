/// <reference lib="dom" />
// the page of one device. A tab is a device: its own key (kept in this tab's IndexedDB, named by
// ?as=), its own copy of the folder, its own storage. Open the invite link in another tab (or
// another browser) and that device joins the same folder through the server.
import { indexeddb } from "./indexeddb.ts"
import { newSeed, type Note, type Notes, type Peer, start, type View } from "./node.ts"

const $ = <T extends HTMLElement>(q: string) => document.querySelector(q) as T
const params = new URLSearchParams(location.search)
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const colour = (name: string) => {
	let h = 0
	for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
	return `hsl(${h % 360} 70% 55%)`
}

// which device: ?as=name, or a new name, written into the address so a reload is the same device
let as = params.get("as")
if (!as) {
	as = "d" + hex(crypto.getRandomValues(new Uint8Array(2)))
	params.set("as", as)
	history.replaceState(null, "", `?${params}${location.hash}`)
}
const config = await fetch("config").then((r) => r.json()).catch(() => ({}))
const server: string | undefined = params.get("server") ?? config.server ?? undefined
const service: string | undefined = params.get("service") ?? config.service ?? undefined
const zeros = params.has("zeros") ? params.get("zeros") !== "0" : !!config.zeros

const backend = indexeddb("ermine-notes-" + as)
let seed = await backend.host("seed")
if (!seed) await backend.setHost("seed", seed = newSeed())
const given = decodeURIComponent(location.hash.slice(1)) || undefined
const kept = await backend.host("folder")
const folder = given ?? (kept ? new TextDecoder().decode(kept) : undefined)

let current: string | undefined
const textarea = $<HTMLTextAreaElement>("#text")
let shown: View | undefined
let text = ""

const notes: Notes = await start({
	backend,
	seed,
	name: as,
	colour: colour(as),
	folder,
	server,
	service,
	zeros,
	render,
	status: ({ server, detail }) => {
		const el = $("#status")
		el.textContent = server === "none"
			? "no server"
			: server === "online"
			? "server: online"
			: server === "joining"
			? "joining…"
			: "server: can't reach"
		el.className = "pill " +
			(server === "online" ? "online" : server === "offline" ? "offline" : "")
		el.title = detail ?? ""
	},
	log: (l) => console.log(l),
})
await backend.setHost("folder", new TextEncoder().encode(notes.folder))
if (!given) history.replaceState(null, "", `?${params}#${notes.folder}`)
;(globalThis as Record<string, unknown>).notes = notes
$("#who").textContent = as
const invite = () => `${location.origin}${location.pathname}#${notes.folder}`
$("#copy").onclick = () => {
	navigator.clipboard?.writeText(invite())
	$("#copy").textContent = "copied"
	setTimeout(() => $("#copy").textContent = "copy invite", 1200)
}
$<HTMLAnchorElement>("#another").href = `${location.pathname}?${new URLSearchParams(
	[...params].filter(([k]) => k !== "as"),
)}#${notes.folder}`

$<HTMLFormElement>("#make").onsubmit = (e) => {
	e.preventDefault()
	const input = $<HTMLInputElement>("#title")
	const title = input.value.trim()
	if (!title || shown?.notes.some((n) => n.title === title)) return
	input.value = ""
	notes.make(title).then(() => (current = title, render()))
}
$("#drop").onclick = () => current && notes.remove(current)

textarea.addEventListener("input", () => {
	if (!current) return
	const old = text
	text = textarea.value
	notes.edit(current, old, text)
})
document.addEventListener("selectionchange", () => {
	if (document.activeElement !== textarea || !current) return
	const cp = (u: number) => Array.from(textarea.value.slice(0, u)).length
	notes.at(current, cp(textarea.selectionStart), cp(textarea.selectionEnd))
})
textarea.addEventListener("blur", () => notes.at(current, undefined, undefined))

function esc(s: string) {
	return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)
}

// where the caret was in `a` is, in `b`: the unchanged start and end hold it, the middle moves it
function carry(a: string, b: string, pos: number) {
	let p = 0
	while (p < a.length && p < b.length && a[p] === b[p]) p++
	let q = 0
	while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++
	if (pos <= p) return pos
	if (pos >= a.length - q) return pos + (b.length - a.length)
	return p
}

function render(v: View | undefined = shown) {
	if (!v) return
	shown = v
	const list = $("#notes")
	list.replaceChildren()
	$("#empty").hidden = v.notes.length > 0
	if (!v.notes.some((n) => n.title === current)) current = v.notes[0]?.title
	const peersAt = (t: string) => v.peers.filter((p) => !p.self && p.live && p.note === t)
	for (const n of v.notes) {
		const li = document.createElement("li")
		li.className = n.title === current ? "on" : ""
		li.innerHTML = `<span class="n">${esc(n.title)}</span>` +
			(n.versions.length > 1 ? `<span class="badge">${n.versions.length}</span>` : "") +
			peersAt(n.title).map((p) =>
				`<span class="dot" style="background:${p.colour}" title="${esc(p.name)}"></span>`
			).join("")
		if (!n.loaded) li.title = "placed in the folder, not here yet"
		li.onclick = () => (current = n.title, render())
		list.append(li)
	}
	const note: Note | undefined = v.notes.find((n) => n.title === current)
	$("#editor").hidden = !note
	if (note) editor(note, v)
	peers(v.peers)
}

function editor(note: Note, v: View) {
	$("#name").textContent = note.title + (note.loaded ? "" : "  (not here yet)")
	$("#versions").textContent = note.versions.length > 1
		? `${note.versions.length} versions: edited at once, the others are in the conflicts table`
		: ""
	const incoming = note.versions[0] ?? ""
	if (incoming !== text || textarea.dataset.note !== note.title) {
		const focus = document.activeElement === textarea && textarea.dataset.note === note.title
		const s = textarea.selectionStart, e = textarea.selectionEnd
		textarea.value = incoming
		if (focus) textarea.setSelectionRange(carry(text, incoming, s), carry(text, incoming, e))
		text = incoming
		textarea.dataset.note = note.title
	}
	// others' selections and carets, drawn in a mirror of the text behind it (code point positions)
	const chars = Array.from(incoming)
	const marks = v.peers.filter((p) =>
		!p.self && p.live && p.note === note.title && p.from !== undefined
	)
		.map((p) => ({ at: Math.min(p.from!, p.to!), end: Math.max(p.from!, p.to!), p }))
		.sort((a, b) => a.at - b.at)
	let out = "", i = 0
	for (const m of marks) {
		if (m.at < i) continue
		out += esc(chars.slice(i, m.at).join(""))
		if (m.end > m.at) {
			out += `<mark style="background:color-mix(in srgb, ${m.p.colour} 40%, transparent)">${
				esc(chars.slice(m.at, m.end).join(""))
			}</mark>`
		}
		out += `<span class="caret" data-name="${
			esc(m.p.name)
		}" style="border-color:${m.p.colour};background:${m.p.colour}"></span>`
		i = m.end
	}
	$("#mirror").innerHTML = out + esc(chars.slice(i).join("")) + "\n"
	const forks = $("#forks")
	forks.replaceChildren()
	if (note.versions.length > 1) {
		note.versions.forEach((t, k) => {
			const d = document.createElement("div")
			d.className = "fork"
			d.innerHTML = `<button>keep this</button>${esc(t)}`
			d.querySelector("button")!.onclick = () => notes.keep(note.title, k)
			forks.append(d)
		})
	}
}

function peers(list: Peer[]) {
	const ul = $("#peers")
	ul.replaceChildren()
	for (
		const p of [...list].sort((a, b) =>
			Number(b.self) - Number(a.self) || Number(b.live) - Number(a.live)
		)
	) {
		const li = document.createElement("li")
		const where = p.note
			? `in ${p.note}${
				p.from !== undefined ? ` ${p.from}${p.to !== p.from ? "–" + p.to : ""}` : ""
			}`
			: "here"
		li.innerHTML = `<span class="dot" style="background:${p.colour}"></span><b>${esc(p.name)}${
			p.self ? " (you)" : ""
		}</b><span class="w">${esc(where)}</span>`
		ul.append(li)
	}
}
