// the party on an edge (Netlify's): no ermine lives between requests. LLM generated: a prototype.
// each request makes one from what is kept, as the page last saw it (seen, a version), renders the
// visitor's page, replays what came after, does what was asked, keeps what changed as the next
// version, and answers with what the page missed: { from, to, updates }, as the GET and POST
// version does
//   kept   entries/<v>    { at, sets: { path: node }, gone: [path] }: version v's change to the kept
//                         nodes: /shared but who's here and what time works out, and each visitor's
//                         own (OWN). a node: { v: value }, or {} a folder
//          snapshots/<v>  { v, values } every SNAPSHOT versions; snapshots/0 the first state
//          head           { v }: a hint; the truth is the entries there are
//          here/<id>      { at }: when a visitor's page last asked (who's here: not a version)
//   time   no clocks: the playhead and the pet's hunger are worked out from the time; life is
//          stepped when a request comes, the steps due (at most STEPS)
//   ids    handler ids by place (@ermine/render/html): a click is found in the page as it was
//          when clicked, then done once the page has caught up
//   pages  GET  /?v=poll (the default)   a page, GET and POST: client/live-edge.js
//          GET  /?v=plain                no script: a document held open HOLD ms, sent each unit
//                                        that changes, then a refresh to carry on
//          POST /event                   { p, h, t, …, seen } or a form's post: done, answered
//          GET  /missed?p=…&seen=…       held a moment (WAIT), answered the same way
//   a visitor is ?p=/visitors/<id>; a page given p carries on as that visitor
import {
	createErmine,
	ensureNode,
	executeAction,
	hasNode,
	list,
	patch,
	peep,
	pulse,
	read,
	remove,
} from "@ermine/system"
import type { Options } from "@ermine/render"
import { createRoot, type Element, fire, html, quoted, sent, take } from "@ermine/render/html"
import { plain, unitName, units } from "./plain.ts"
import { PICKER, picker, PLAIN, posted, type Said, standIn, tagOf } from "./live.ts"
import { party, setupShared, stepLife } from "./party.tsx"

// what is kept, on Netlify Blobs or (run here) in a Map
export type Kept = {
	get(key: string): Promise<unknown>
	// only if there is none yet; false: someone else's is there
	add(key: string, value: unknown): Promise<boolean>
	put(key: string, value: unknown): Promise<void>
	list(prefix: string): Promise<string[]>
}

export function memoryKept(): Kept {
	const kept = new Map<string, string>()
	return {
		get: (key) => Promise.resolve(kept.has(key) ? JSON.parse(kept.get(key)!) : null),
		add(key, value) {
			if (kept.has(key)) return Promise.resolve(false)
			kept.set(key, JSON.stringify(value))
			return Promise.resolve(true)
		},
		put: (key, value) => Promise.resolve(void kept.set(key, JSON.stringify(value))),
		list: (prefix) => Promise.resolve([...kept.keys()].filter((k) => k.startsWith(prefix))),
	}
}

// the kept node: a value, or a folder
type Node = { v?: unknown }
type Values = Record<string, Node>
type Entry = { at: number; sets: Values; gone: string[] }

// a snapshot every this many versions; life's steps at most this many a request; a GET /missed
// held at most WAIT ms, looking every LOOK ms; a page with no script held HOLD ms, looking every
// LOOK_PLAIN ms, a turn at least every TURN_PLAIN ms; who's here: away after AWAY, gone after GONE
const SNAPSHOT = 50
const STEPS = 5
const WAIT = 1_000
const LOOK = 250
const HOLD = 20_000
const LOOK_PLAIN = 500
const TURN_PLAIN = 3_000
const AWAY = 5_000
const GONE = 30_000
// the clocks' periods, as party.tsx's are (life, the playhead, hunger), and the hungriest
const LIFE_MS = 600
const BEAT_MS = 250
const PET_MS = 6000
const STEPS_IN_BEAT = 8
const HUNGRY = 10
// a visitor's own nodes that are kept
const OWN = ["tool", "asked", "sticker"]
// worked out each request, never kept
const WORKED_OUT = ["/shared/here", "/shared/beat-step", "/shared/pet/hunger"]
const DONE = 204
const MISSING = 404
const GONE_STATUS = 410
// the pet's hunger at first, as party.tsx's
const FIRST_HUNGER = 4
const AGAIN = 3

// ---- kept nodes, as data ----
const inside = (path: string, folder: string) => path === folder || path.startsWith(folder + "/")
const kept = (path: string, id: string) =>
	!WORKED_OUT.some((w) => inside(path, w)) &&
	(inside(path, "/shared") || OWN.some((o) => inside(path, `/visitors/${id}/${o}`)))
const shared = (path: string) => inside(path, "/shared")
const only = (values: Values, keep: (path: string) => boolean): Values =>
	Object.fromEntries(Object.entries(values).filter(([p]) => keep(p)))

// values with entries over them
function over(values: Values, entries: readonly Entry[]): Values {
	const out = { ...values }
	for (const e of entries) {
		for (const g of e.gone) for (const p of Object.keys(out)) if (inside(p, g)) delete out[p]
		Object.assign(out, e.sets)
	}
	return out
}

// what changed from before to after: each node set, and the highest of each gone
function diff(before: Values, after: Values): Entry & { empty: boolean } {
	const sets = Object.fromEntries(
		Object.entries(after).filter(([p, n]) => JSON.stringify(before[p]) !== JSON.stringify(n)),
	)
	const gone = Object.keys(before).filter((p) => !(p in after))
		.filter((p, _, all) => !all.some((q) => q !== p && inside(p, q)))
	return { at: Date.now(), sets, gone, empty: !Object.keys(sets).length && !gone.length }
}

// ---- kept nodes, in an ermine (as the host: inside ermine.within) ----
const sorted = (values: Values) => Object.entries(values).sort(([a], [b]) => a < b ? -1 : 1)

function restore(values: Values) {
	for (const [path, node] of sorted(values)) {
		if (!hasNode(path)) ensureNode(path, node.v)
		else if ("v" in node && JSON.stringify(peep(() => read(path))) !== JSON.stringify(node.v)) {
			patch(path, [{ path: [], value: node.v }])
		}
	}
}

function replay(entry: Entry, keep: (path: string) => boolean) {
	for (const g of entry.gone) if (keep(g) && hasNode(g)) remove(g)
	restore(only(entry.sets, keep))
}

// the kept nodes now: /shared, and the visitor's own
function dump(id: string): Values {
	const out: Values = {}
	const walk = (path: string) => {
		if (!kept(path, id) && !inside(path, "/shared")) return
		if (kept(path, id)) {
			const v = peep(() => read(path))
			out[path] = v === undefined ? {} : { v }
		}
		for (const name of peep(() => list(path))) walk(`${path}/${name}`)
	}
	walk("/shared")
	for (const o of OWN) if (hasNode(`/visitors/${id}/${o}`)) walk(`/visitors/${id}/${o}`)
	return out
}

const set = (path: string, value: unknown) =>
	hasNode(path) ? patch(path, [{ path: [], value }]) : ensureNode(path, value)
const now_ = <T>(path: string) => peep(() => read(path)) as T

// ---- versions ----
async function first(store: Kept): Promise<Values> {
	const there = await store.get("snapshots/0") as { values: Values } | null
	if (there) return there.values
	// the first state: the party's shared nodes, life's last step, the pet's last feed
	const e = createErmine({
		host: {
			setup: () => {
				setupShared()
				ensureNode("/shared/life-at", Date.now())
				ensureNode("/shared/pet/level", FIRST_HUNGER)
				ensureNode("/shared/pet/at", Date.now())
			},
		},
	})
	const values = e.within(() => dump(""))
	e.close()
	if (await store.add("snapshots/0", { v: 0, values })) return values
	return (await store.get("snapshots/0") as { values: Values }).values
}

async function latest(store: Kept): Promise<number> {
	let v = (await store.get("head") as { v: number } | null)?.v ?? 0
	while (await store.get(`entries/${v + 1}`)) v++
	return v
}

async function at(store: Kept, seen: number): Promise<{ v: number; values: Values }> {
	for (let s = Math.floor(seen / SNAPSHOT) * SNAPSHOT; s > 0; s -= SNAPSHOT) {
		const got = await store.get(`snapshots/${s}`) as { values: Values } | null
		if (got) return { v: s, values: got.values }
	}
	return { v: 0, values: await first(store) }
}

const entries = (store: Kept, from: number, to: number) =>
	Promise.all(
		Array.from(
			{ length: Math.max(0, to - from + 1) },
			(_, i) => store.get(`entries/${from + i}`) as Promise<Entry>,
		),
	)

// who's here: each visitor's last ask, away after AWAY, gone after GONE
async function presence(store: Kept, now: number): Promise<Map<string, boolean>> {
	const keys = await store.list("here/")
	const all = await Promise.all(keys.map(async (k) => [k, await store.get(k)] as const))
	return new Map(
		all.filter(([, h]) => h && now - (h as { at: number }).at < GONE)
			.map(([k, h]) => [k.slice("here/".length), now - (h as { at: number }).at > AWAY]),
	)
}

// ---- a turn: one request's ermine ----
type Turn = { to: number; into: Element; path: string; close: () => void }

// what the visitor at id missed since seen; asked: an event to do. a version taken by another
// request meanwhile: again from the start (at most AGAIN times)
async function turn(store: Kept, id: string, seen: number, asked?: Said, again = 0): Promise<Turn> {
	const now = Date.now()
	const head = await latest(store)
	const from = Math.min(Math.max(0, seen), head)
	const base = await at(store, from)
	const after = await entries(store, base.v + 1, head)
	const atSeen = over(base.values, after.slice(0, from - base.v))
	const path = `/visitors/${id}`
	const e = createErmine({ host: { setup: () => restore(only(atSeen, shared)) } })
	const into = createRoot({ ids: "place" })
	// deno-lint-ignore prefer-const
	let context: ReturnType<typeof e.getProcessContext>
	// the click asked, while it is found: its call kept for later
	let asking = false
	let call: (() => unknown) | undefined
	const options: Options = {
		name: path,
		call: (action, ...args) => {
			const go = () => context!.within(() => executeAction(action, ...args))
			if (!asking) return go()
			call = go
		},
	}
	// what time works out, unknown as the page was: so always sent
	e.within(() => {
		set("/shared/beat-step", -1)
		set("/shared/pet/hunger", -1)
	})
	const started = e.start(party({ into, options }), path)
	if ("refused" in started) throw new Error(`refused: ${started.refused}`)
	context = e.getProcessContext(started.process)
	e.within(() => {
		restore(only(atSeen, (p) => kept(p, id) && !shared(p)))
		pulse()
	})
	// what setup made (a new visitor's name, its own nodes), kept with this turn's change
	const made = diff(only(atSeen, (p) => kept(p, id)), e.within(() => dump(id)))
	// the page as it was at seen: what changes from here, it is told; the click found in it, its
	// args made now
	sent(into)
	asking = true
	if (asked) fire(into, asked.h, standIn(asked))
	asking = false
	e.within(() => {
		for (const entry of after.slice(from - base.v)) replay(entry, (p) => kept(p, id))
		pulse()
	})
	const before = e.within(() => dump(id))
	e.within(() => {
		// the pet's hunger now, from its last feed; the steps of life due
		const hunger = Math.min(
			HUNGRY,
			now_<number>("/shared/pet/level") +
				Math.floor((now - now_<number>("/shared/pet/at")) / PET_MS),
		)
		set("/shared/pet/hunger", hunger)
		const lifeAt = now_<number>("/shared/life-at")
		const due = Math.floor((now - lifeAt) / LIFE_MS)
		for (let i = 0; i < Math.min(due, STEPS); i++) stepLife()
		if (due > 0) set("/shared/life-at", due > STEPS ? now : lifeAt + due * LIFE_MS)
		pulse()
		call?.()
		pulse()
		// a feed: the hunger it left is the level from now
		const left = now_<number>("/shared/pet/hunger")
		if (left !== hunger) {
			set("/shared/pet/level", left)
			set("/shared/pet/at", now)
		}
	})
	const change = diff(before, e.within(() => dump(id)))
	let to = head
	if (!change.empty || !made.empty) {
		to = head + 1
		const entry: Entry = {
			at: now,
			sets: { ...made.sets, ...change.sets },
			gone: [...made.gone, ...change.gone],
		}
		if (!await store.add(`entries/${to}`, entry)) {
			e.close()
			if (again >= AGAIN) throw new Error("the party is too busy: try again")
			return turn(store, id, seen, asked, again + 1)
		}
		await store.put("head", { v: to })
		if (to % SNAPSHOT === 0) {
			await store.put(`snapshots/${to}`, { v: to, values: over(base.values, [...after, entry]) })
		}
	}
	// who's here, and the playhead, now
	await store.put(`here/${id}`, { at: now })
	const here = await presence(store, now)
	e.within(() => {
		const names = peep(() => list("/shared/names")) as string[]
		for (const name of peep(() => list("/shared/here")) as string[]) {
			if (!here.has(name)) remove(`/shared/here/${name}`)
		}
		for (const [who, away] of here) {
			if (!names.includes(who)) continue
			set(`/shared/here/${who}`, { ...now_<object>(`/shared/names/${who}`), away })
		}
		set("/shared/beat-step", Math.floor(now / BEAT_MS) % STEPS_IN_BEAT)
		pulse()
	})
	return { to, into, path, close: () => e.close() }
}

// ---- the server ----
export type EdgeOptions = {
	// where things are kept, per request (Blobs' tokens go stale across requests)
	readonly kept: () => Kept | Promise<Kept>
	readonly client: string
	readonly style: string
	readonly head?: string
	readonly title?: string
}

export function createEdge(options: EdgeOptions) {
	const { client, style, title = "ermine party" } = options
	const offered = ["poll", "plain"] as const
	const top = (more = "") =>
		`<!doctype html><html lang="en"><head><meta charset="utf-8">` +
		`<meta name="viewport" content="width=device-width,initial-scale=1">` +
		`<title>${title}</title>${options.head ?? ""}<style>${style}${more}${PICKER}</style></head>`
	const idOf = (p: string | null) =>
		p?.startsWith("/visitors/") ? p.slice("/visitors/".length) : undefined
	const json = (t: Turn, seen: number) =>
		Response.json({ from: seen, to: t.to, updates: take(t.into) })

	async function page(store: Kept, id: string): Promise<Response> {
		const t = await turn(store, id, Number.MAX_SAFE_INTEGER)
		sent(t.into)
		const root = t.into.kids[0]
		if (root && "tag" in root) root.attrs.set("data-ermine-seen", String(t.to))
		const body = top() + `<body>${picker("poll", offered)}${html(t.into)}` +
			`<script src="/live-edge.js" defer></script></body></html>`
		t.close()
		return new Response(body, {
			headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
		})
	}

	// no script: the document, then each unit that changes, held HOLD ms; then a refresh carries
	// on as the same visitor
	function plainPage(store: Kept, id: string): Response {
		const encoder = new TextEncoder()
		const sentAgain = new Set<string>()
		let open = true
		const body = new ReadableStream<Uint8Array>({
			async start(c) {
				const send = (s: string) => open && c.enqueue(encoder.encode(s))
				const t = await turn(store, id, Number.MAX_SAFE_INTEGER)
				sent(t.into)
				let seen = t.to
				const form = `<form id="f" method="post" action="/event" target="ermine-sink">` +
					`<input type="hidden" name="p" value="${t.path}"></form>`
				send(
					top(PLAIN) + `<body>${picker("plain", offered)}` +
						`<iframe name="ermine-sink" hidden></iframe>${form}<div id="ermine">` +
						`<template shadowrootmode="open"><style>${style}${PLAIN}</style>${form}` +
						`${plain(t.into, { process: t.path, slots: true })}</template>`,
				)
				t.close()
				const end = Date.now() + HOLD
				let turned = Date.now()
				while (open && Date.now() < end) {
					await new Promise((r) => setTimeout(r, LOOK_PLAIN))
					if ((await latest(store)) === seen && Date.now() - turned < TURN_PLAIN) continue
					const next = await turn(store, id, seen)
					send(again(next, sentAgain))
					seen = next.to
					turned = Date.now()
					next.close()
				}
				send(`<meta http-equiv="refresh" content="0;url=/?v=plain&amp;p=${t.path}">`)
				if (open) c.close()
			},
			cancel() {
				open = false
			},
		})
		return new Response(body, {
			headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
		})
	}

	// each unit something changed in, sent again whole in a tag of its own (live.ts's again)
	function again(t: Turn, sentAgain: Set<string>): string {
		const all = units(t.into)
		const done = new Set<Element>()
		let out = ""
		for (const [b] of take(t.into)) {
			const unit = all.get(b)
			if (unit === undefined || done.has(unit)) continue
			done.add(unit)
			const name = unitName(unit)
			const tag = tagOf(name)
			if (!sentAgain.has(tag)) out += `<style>${tag}:has(~ ${tag}) { display: none }</style>`
			sentAgain.add(tag)
			out += `<${tag} slot="${quoted(name)}">${
				plain(unit, { process: t.path, slots: false })
			}</${tag}>`
		}
		return out
	}

	async function event(store: Kept, request: Request): Promise<Response> {
		const form = request.headers.get("content-type")?.includes("form")
		const e = form
			? posted(await request.formData())
			: await request.json() as Said & { seen?: number }
		const id = idOf(e.p)
		if (id === undefined) return new Response(null, { status: GONE_STATUS })
		// a form (no script) says no version: the click is found in the page as it is now
		const seen = (e as { seen?: number }).seen ?? Number.MAX_SAFE_INTEGER
		const t = await turn(store, id, seen, e)
		t.close()
		return form ? new Response(null, { status: DONE }) : json(t, seen)
	}

	async function missed(store: Kept, id: string, seen: number): Promise<Response> {
		const end = Date.now() + WAIT
		while (Date.now() < end && (await latest(store)) <= seen) {
			await new Promise((r) => setTimeout(r, LOOK))
		}
		const t = await turn(store, id, seen)
		t.close()
		return json(t, seen)
	}

	return {
		async fetch(request: Request): Promise<Response> {
			const url = new URL(request.url)
			const get = request.method === "GET"
			const store = await options.kept()
			if (get && url.pathname === "/") {
				const id = idOf(url.searchParams.get("p")) ?? crypto.randomUUID()
				return url.searchParams.get("v") === "plain" ? plainPage(store, id) : page(store, id)
			}
			if (request.method === "POST" && url.pathname === "/event") return event(store, request)
			if (get && url.pathname === "/missed") {
				const id = idOf(url.searchParams.get("p"))
				if (id === undefined) return new Response(null, { status: GONE_STATUS })
				return missed(store, id, Number(url.searchParams.get("seen") ?? 0))
			}
			if (get && url.pathname === "/live-edge.js") {
				return new Response(client, { headers: { "content-type": "text/javascript" } })
			}
			return new Response("not found", { status: MISSING })
		},
	}
}
