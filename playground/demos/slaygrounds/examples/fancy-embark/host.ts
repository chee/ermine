import { createWorld } from "@ermine/slaygrounds/world"
import { ensureNode, executeAction, hasNode, list, patch, read, remove } from "@ermine/system"
import { trace } from "@ermine/core/scheduler/trace"
import * as lib from "@ermine/core/places/lib"
import { render } from "ermine-h"

// fancy-embark's host: the world (@ermine/slaygrounds/world), one process, embark, and what only a
// host can give it (each in extend below, with what it is for):
//   ask            a request to a public api is a node at /cache/<api>/<hash of its url>, which the
//                  program reads (a node not there throws PENDING, and the run reads it again when it
//                  lands). ask gives the key, and when the node is not there the request is queued (one
//                  server at a time, each at its own polite rate). the answer lands as that node. a
//                  failure lands too, as a node saying so: the program shows it in place, until retry
//                  (or the browser being online again) takes it out
//   retry          the failure nodes taken out, so whoever read them asks again
//   ended          told how each memo ended a run, what it read named (paths: nodes, and /cache keys):
//                  the host runs an action of the program's with it (a program has no listener to
//                  give: nothing is open in one)
// the request is the host's: a browser can not set User-Agent, so each fetch says where it is from
// with its referrer (Nominatim asks for one naming the application)
// before the program runs, /cache is filled from seed.json (committed beside this file: the default
// trip's lookups) and from this browser's localStorage (what was fetched here before; answers
// only, never failures). /net is what the network did

const APIS = ["geocode", "route", "weather"]
// one queue per server, each at its own rate (their usage policies: Nominatim at most 1/s, the
// OSRM demo and FOSSGIS servers light use, Open-Meteo is generous). one request at a time each
const RATE: Record<string, number> = {
	"nominatim.openstreetmap.org": 1100,
	"router.project-osrm.org": 1000,
	"routing.openstreetmap.de": 1000,
	"api.open-meteo.com": 300,
	"historical-forecast-api.open-meteo.com": 300,
}
// the playground's own folder, worked out by the editor (/ locally, /slaygrounds/ on the site)
const BASE = (parent as unknown as { __base?: string }).__base ?? document.baseURI
const REFERRER = new URL("examples/fancy-embark/?app=ermine-slaygrounds-fancy-embark", BASE).href
const SAVE = "fancy-embark:cache:v1"

type Entry = {
	api?: string
	url?: string
	at?: string
	ms?: number
	from?: string
	result?: unknown
	error?: string
}
const queues = new Map<string, { jobs: (() => Promise<void>)[]; last: number; busy: boolean }>()
const inflight = new Set<string>() // api/key asked and not landed

function fresh() {
	return {
		requests: 0,
		hits: 0,
		misses: 0,
		failed: 0,
		landed: 0,
		waiting: {} as Record<string, number>,
		recent: [] as unknown[],
		kept: { seed: 0, saved: 0, live: 0 },
	}
}
let stats = fresh()

// what was kept: seed.json and this browser's own
function saved(): Record<string, Entry> {
	try {
		return JSON.parse(localStorage.getItem(SAVE) ?? "{}")
	} catch {
		return {}
	}
}
function save(api: string, key: string, entry: Entry) {
	try {
		const all = saved()
		all[`${api}/${key}`] = entry
		localStorage.setItem(SAVE, JSON.stringify(all))
	} catch { /* no storage, or full: only this session keeps it */ }
}
const seedFile: Record<string, Entry> = await fetch(
	new URL("examples/fancy-embark/seed.json", BASE),
)
	.then((r) => (r.ok ? r.json() : {}))
	.catch(() => ({}))

const world = createWorld({
	render,
	processes: [{ name: "embark" }],
	extend: () => ({
		ask,
		retry,
		// action: the path of an action of the program's (a program is not given a function to call
		// from here: nothing is open in one). it is run with { name, of, run, ended, error, ms,
		// values, keys } each time a memo of this process ends a run: name and of are the last two
		// names of the memo's place (result/<id>), values the paths of the nodes it read, keys the
		// /cache keys ("geocode/<hash>"). gives back the stop
		ended(action: string) {
			const started = new Map<unknown, number>()
			return trace(world.world.s, (m) => {
				if ("starts" in m) started.set(m.starts, performance.now())
				if (!("ends" in m) || m.ended === "stopped") return
				const part = world.world.parts.get(m.ends)
				if (!part) return
				const at = part.entry.path
				if (!at) return
				const values: string[][] = [], keys: string[] = []
				for (const k of m.reads) {
					const w = world.world.places.describe(k)
					if (!w) continue
					if (w.part === "value") {
						const p = pathOfId(w.id)
						if (p) values.push(p)
					} else if (w.part === "children" && w.path?.length === 1) {
						const api = APIS.find((a) => String(w.id) === folders.get(a))
						if (api) keys.push(`${api}/${w.path[0]}`)
					}
				}
				const t0 = started.get(m.ends)
				const run = {
					name: at[at.length - 2],
					of: at[at.length - 1],
					run: m.run,
					ended: m.ended,
					error: m.error === undefined ? undefined : said(m.error),
					ms: t0 === undefined ? undefined : +(performance.now() - t0).toFixed(1),
					values,
					keys,
				}
				// after the run that ended is over: an action is a write
				queueMicrotask(() => {
					try {
						as(() => executeAction(action, run))
					} catch { /* the program has stopped */ }
				})
			})
		},
	}),
})
// the host acts as the host (process 0): its calls run inside ermine.within
const as = <T>(f: () => T) => world.ermine.within(f)
const folders = new Map<string, string>() // api -> the id of /cache/<api>
// the names from the root to a node, by its id: up through the names it has (places' namesOf), the
// first each time (the program reaches nodes by path, the host's table by id)
function pathOfId(id: unknown): string[] | undefined {
	const { places } = world.world
	const names: string[] = []
	let at = id as never
	for (let i = 0; i < 24; i++) {
		if (at === places.root) return names
		const slot = places.namesOf(at)[0]
		if (!slot) return undefined
		names.unshift(slot.name)
		at = slot.folder as never
	}
}
world.seed(() => {
	ensureNode("/cache", "every lookup, by the hash of its url")
	for (const api of APIS) ensureNode(`/cache/${api}`)
	ensureNode("/net", stats)
	for (const [from, all] of [["seed", seedFile], ["saved", saved()]] as const) {
		for (const [k, entry] of Object.entries(all)) {
			const [api, key] = k.split("/")
			if (!APIS.includes(api) || entry?.error !== undefined) continue
			if (from === "saved" && hasNode(`/cache/${api}/${key}`)) continue
			ensureNode(`/cache/${api}/${key}`, { ...entry, from })
			stats.kept[from]++
		}
	}
	patch("/net", [{ path: [], value: structuredClone(stats) }])
	for (const api of APIS) folders.set(api, String(lib.get(world.ermine.places, ["cache", api])))
})

// the network's node is written after the run that asked is over (a run never writes), at most
// four times a second: a hit is told on every run that finds its answer
let telling = false
function tell(change: (n: typeof stats) => void) {
	change(stats)
	if (telling) return
	telling = true
	setTimeout(() => {
		telling = false
		as(() => patch("/net", [{ path: [], value: structuredClone(stats) }]))
	}, 250)
}
const said = (e: unknown) => String((e as Error)?.message ?? e)

// the key of url's answer in /cache/<api>, asked for: the node is there (a hit), or the request is
// queued. the program reads the node (a node not there throws PENDING in its run)
function ask(api: string, url: string): string {
	const key = hash(url)
	if (!APIS.includes(api)) return key
	if (as(() => hasNode(`/cache/${api}/${key}`))) tell((n) => n.hits++)
	else enqueue(api, url, key)
	return key
}

function enqueue(api: string, url: string, key: string) {
	if (inflight.has(api + "/" + key)) return
	inflight.add(api + "/" + key)
	const server = new URL(url).host
	const q = queues.get(server) ?? { jobs: [], last: 0, busy: false }
	queues.set(server, q)
	tell((n) => (n.misses++, n.waiting[server] = (n.waiting[server] ?? 0) + 1))
	q.jobs.push(async () => {
		const t0 = performance.now()
		let entry: Entry
		try {
			if (navigator.onLine === false) throw new Error("offline: the browser has no network")
			const r = await fetch(url, {
				headers: { accept: "application/json" },
				referrer: REFERRER,
				referrerPolicy: "no-referrer-when-downgrade",
				signal: AbortSignal.timeout(15000),
			})
			if (!r.ok) throw new Error(`${server} said ${r.status} ${r.statusText}`.trim())
			const result = await r.json()
			entry = {
				api,
				url,
				at: new Date().toISOString(),
				ms: Math.round(performance.now() - t0),
				from: "live",
				result,
			}
			save(api, key, entry)
		} catch (e) {
			const why = (e as Error)?.name === "TimeoutError"
				? `${server} did not answer in 15s`
				: e instanceof TypeError
				? `could not reach ${server} (offline?)`
				: said(e)
			entry = { api, url, at: new Date().toISOString(), error: why, from: "live" }
		}
		inflight.delete(api + "/" + key)
		// an answer (or a failure) as the node at /cache/<api>/<key>: a new one, or the one there
		const at = `/cache/${api}/${key}`
		if (as(() => hasNode(at))) as(() => patch(at, [{ path: [], value: entry }]))
		else as(() => ensureNode(at, entry))
		tell((n) => {
			n.waiting[server] = Math.max(0, (n.waiting[server] ?? 1) - 1)
			if (entry.error) n.failed++
			else (n.landed++, n.kept.live++)
			n.requests++
			n.recent = [
				{ api, key, server, ms: entry.ms, error: entry.error, at: entry.at, url },
				...n.recent,
			].slice(0, 30)
		})
	})
	pump(server)
}

function pump(server: string) {
	const q = queues.get(server)!
	if (q.busy || !q.jobs.length) return
	q.busy = true
	const wait = Math.max(0, q.last + (RATE[server] ?? 1000) - performance.now())
	setTimeout(async () => {
		q.last = performance.now()
		await q.jobs.shift()!()
		q.busy = false
		pump(server)
	}, wait)
}

// failures taken out, so whoever read them asks again (all, or one api's)
function retry(api?: string) {
	for (const a of api ? [api] : APIS) {
		for (const name of as(() => list(`/cache/${a}`))) {
			const at = `/cache/${a}/${name}`
			if ((as(() => read(at)) as Entry | undefined)?.error !== undefined) as(() => remove(at))
		}
	}
}
addEventListener("online", () => retry())

// the cache as seed.json has it: every answer, by api/key (for the console: ermine.embark.dump())
function dump() {
	const out: Record<string, unknown> = {}
	for (const api of APIS) {
		for (const name of as(() => list(`/cache/${api}`))) {
			const v = as(() => read(`/cache/${api}/${name}`)) as Entry | undefined
			if (v?.result !== undefined) {
				out[`${api}/${name}`] = { api, url: v.url, at: v.at, ms: v.ms, result: v.result }
			}
		}
	}
	return JSON.stringify(out)
}
;(world.world as unknown as Record<string, unknown>).embark = { dump, retry, stats: () => stats }

// a hash of a string (53 bits, as hex): prog-build's, copied
function hash(v: string) {
	let h1 = 0xdeadbeef, h2 = 0x41c6ce57
	for (let i = 0; i < v.length; i++) {
		const c = v.charCodeAt(i)
		h1 = Math.imul(h1 ^ c, 2654435761)
		h2 = Math.imul(h2 ^ c, 1597334677)
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
	return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0")
}

export const reload = world.reload
