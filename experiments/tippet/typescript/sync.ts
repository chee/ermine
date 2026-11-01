// Sync catches a log's steps up over links (WIRE.md). A link is anything that carries bytes both
// ways (see carriers/). Each side says what it has and is sent what it lacks, a run at a time.
import { decode, encode, type Value } from "@ermine/encoding/cbor"
import type { Fork, Log } from "./log.ts"
import { firstOf, pack, type Packed, RUN, stepsIn, unpack as unpackAll } from "./pack.ts"
import { hex, key, unhex, whole } from "./step.ts"

export type Link = {
	send(bytes: Uint8Array): void
	onMessage(fn: (bytes: Uint8Array) => void): void
	onClose?(fn: () => void): void
	close?(): void
	many?: boolean
	wait?(): Promise<void>
	keeper?: boolean
}

type Linked = {
	link: Link
	theirs: Map<string, number>
	pushing: Map<string, boolean>
	refused: Set<string>
	// devices the other side lacked memory for: nothing more of them is sent until it has said
	waits: Set<string>
	// devices this side refused a run of, its host told
	told: Set<string>
	tailed: Set<string>
	proved: Set<string>
	turn: Promise<void>
	said?: number
}
export type Proof = { sig: Uint8Array; pack: Packed }
export type Message =
	| { t: "have"; have: Record<string, number> }
	| { t: "run"; device: string; sig: Uint8Array; pack: Packed }
	| { t: "refused"; device: string; n: number; why?: string }
	| { t: "fork"; device: string; a: Proof; b: Proof }
	| { t: "live"; id: string; data: Uint8Array }

const sized = (x: unknown, n: number) => x instanceof Uint8Array && x.length === n
export function read(b: Uint8Array): Message | undefined {
	let m: unknown
	try {
		m = decode(b)
	} catch {
		return undefined
	}
	if (!Array.isArray(m)) return undefined
	const [t, x, y, z] = m
	if (t === "have" && m.length === 2 && Array.isArray(x)) {
		const have: Record<string, number> = {}
		for (const e of x) {
			if (!Array.isArray(e) || e.length !== 2 || !key(e[0]) || !whole(e[1])) return undefined
			have[hex(e[0])] = e[1]
		}
		return { t, have }
	}
	if (t === "run" && m.length === 4 && key(x) && sized(y, 64) && Array.isArray(z)) {
		return { t, device: hex(x), sig: y, pack: z as Packed }
	}
	if (
		t === "fork" && m.length === 6 && key(x) && sized(y, 64) && Array.isArray(z) &&
		sized(m[4], 64) && Array.isArray(m[5])
	) {
		return {
			t,
			device: hex(x),
			a: { sig: y, pack: z as Packed },
			b: { sig: m[4], pack: m[5] as Packed },
		}
	}
	if (t === "refused" && (m.length === 3 || m.length === 4) && key(x) && whole(y)) {
		if (m.length === 3) return { t, device: hex(x), n: y }
		return typeof z === "string" ? { t, device: hex(x), n: y, why: z } : undefined
	}
	if (t === "live" && m.length === 3 && sized(x, 8) && y instanceof Uint8Array) {
		return { t, id: hex(x), data: y }
	}
}

export function wire(m: Message): Uint8Array {
	const a = m.t === "have"
		? [m.t, Object.entries(m.have).map(([d, n]) => [unhex(d), n])]
		: m.t === "run"
		? [m.t, unhex(m.device), m.sig, m.pack]
		: m.t === "fork"
		? [m.t, unhex(m.device), m.a.sig, m.a.pack, m.b.sig, m.b.pack]
		: m.t === "refused"
		? [m.t, unhex(m.device), m.n, ...(m.why === undefined ? [] : [m.why])]
		: [m.t, unhex(m.id), m.data]
	return encode(a as Value)
}

export type Sync = {
	link(link: Link): () => void
	readonly links: number
	onLinks(f: () => void): () => void
	live(data: Uint8Array): void
	onLive(f: (data: Uint8Array) => void): () => void
	passed(): Record<string, number>
	// told when a run is refused: by this side (taker) or by the other (the writer's)
	onRefused(f: (r: Refusal) => void): () => void
}
export type Refusal = { device: string; n: number; why: string; taker: boolean }

// max: the most bytes of steps in a run this side takes (RUN); a run past it is refused `bound`
export function createSync(o: { log: Log; relay?: boolean; max?: number }): Sync {
	const { log } = o
	const max = Math.min(o.max ?? RUN, RUN), refusals: ((r: Refusal) => void)[] = []
	const refuse = (r: Refusal) => {
		for (const f of refusals) {
			try {
				f(r)
			} catch {
				// the host's own
			}
		}
	}
	const links = new Set<Linked>()
	const lives: ((data: Uint8Array) => void)[] = []
	const linked: (() => void)[] = []
	const tell = () => linked.forEach((f) => f())
	const seen = new Set<string>()
	const mark = (id: string) => {
		seen.add(id)
		if (seen.size > 1024) seen.delete(seen.values().next().value!)
	}
	const drop = (l: Linked) => links.delete(l) && tell()
	const send = (l: Linked, bytes: Uint8Array) => {
		try {
			l.link.send(bytes)
		} catch {
			drop(l)
			l.link.close?.()
		}
	}
	const say = (l: Linked, m: Message) => send(l, wire(m))
	const have = (): Message => ({ t: "have", have: log.have() })
	const proof = (f: Fork): Message => ({
		t: "fork",
		device: f.device,
		a: { sig: f.runs[0].sig, pack: pack(f.runs[0].steps) },
		b: { sig: f.runs[1].sig, pack: pack(f.runs[1].steps) },
	})

	async function one(l: Linked, device: string): Promise<boolean> {
		await l.link.wait?.()
		const from = (l.theirs.get(device) ?? 0) + 1
		if (!links.has(l) || l.refused.has(device) || l.waits.has(device)) return false
		if (from > log.count(device)) return false
		const b = await log.run(device, from)
		if (!b) return false
		// They said what they have meanwhile, so this run may not be what they lack.
		if (!links.has(l) || (l.theirs.get(device) ?? 0) !== from - 1) return true
		const p = () => pack(b.steps, from > 1 ? log.prior(device, from - 1) : undefined)
		send(l, b.message ?? wire({ t: "run", device, sig: b.sig, pack: p() }))
		l.theirs.set(device, from + b.steps.length - 1)
		return true
	}
	function push(l: Linked, device: string) {
		if (l.pushing.has(device)) return void l.pushing.set(device, true)
		l.pushing.set(device, false)
		const turn = async () => {
			let more = false
			try {
				more = await one(l, device)
			} catch {
				// a failed turn: more stays false
			}
			if (more || l.pushing.get(device)) {
				l.pushing.set(device, false)
				l.turn = l.turn.then(turn)
			} else l.pushing.delete(device)
		}
		l.turn = l.turn.then(turn)
	}

	// A run refused that the taker may hold another chain of: its own run from the step before
	// the refused one, whole, so the other side can see where the two differ.
	async function answer(l: Linked, device: string, why: string, p: Packed) {
		if (
			(why !== "chain" && why !== "signature") || l.tailed.has(device) ||
			log.forks().some((f) => f.device === device)
		) return
		const at = firstOf(p).n - 1
		if (at < 1 || at > log.count(device)) return
		const b = await log.run(device, at)
		if (!b || !links.has(l)) return
		l.tailed.add(device)
		say(l, { t: "run", device, sig: b.sig, pack: pack(b.steps) })
	}

	async function receive(l: Linked, bytes: Uint8Array) {
		const m = read(bytes)
		if (!m) return
		const many = l.link.many
		if (m.t === "have") {
			const me = log.device
			if (many) {
				if (me === undefined) return
				l.theirs.set(me, Math.min(l.theirs.get(me) ?? 0, m.have[me] ?? 0))
				return push(l, me)
			}
			l.theirs = new Map(Object.entries(m.have))
			l.waits.clear()
			l.said = me === undefined ? 0 : m.have[me] ?? 0
			for (const [d, n] of Object.entries(log.have())) if ((m.have[d] ?? 0) < n) push(l, d)
			// proofs of devices they hold steps of, once
			for (const f of log.forks()) {
				if (f.device in m.have && !l.proved.has(f.device)) {
					l.proved.add(f.device), say(l, proof(f))
				}
			}
		} else if (m.t === "run") {
			let last = 0
			try {
				last = firstOf(m.pack).n + stepsIn(m.pack) - 1
			} catch {
				// an unreadable pack: last stays 0
			}
			const r = await log.takePack({ ...m, message: bytes }, l, max)
			if ("added" in r) {
				l.theirs.set(m.device, Math.max(l.theirs.get(m.device) ?? 0, last))
			} else if (r.refused === "gap") say(l, have())
			else {
				if (r.refused !== "own" && !l.told.has(m.device)) {
					l.told.add(m.device)
					refuse({ device: m.device, n: log.count(m.device), why: r.refused, taker: true })
				}
				if (many) return
				say(l, {
					t: "refused",
					device: m.device,
					n: log.count(m.device),
					...(r.refused === "bound" && { why: "bound" }),
				})
				await answer(l, m.device, r.refused, m.pack)
			}
		} else if (m.t === "fork") {
			const open = (p: Proof) => ({ sig: p.sig, steps: unpackAll(p.pack) })
			try {
				await log.fork(m.device, open(m.a), open(m.b), l)
			} catch {
				// not a proof
			}
		} else if (m.t === "refused") {
			if (!many && log.count(m.device) && !l.refused.has(m.device)) {
				if (m.why === "memory") {
					// for now: what it holds is what it has, and more is sent after its next have
					if (!l.waits.has(m.device)) {
						refuse({ device: m.device, n: m.n, why: m.why, taker: false })
					}
					l.waits.add(m.device)
					l.theirs.set(m.device, m.n)
				} else {
					l.refused.add(m.device)
					refuse({ device: m.device, n: m.n, why: m.why ?? "refused", taker: false })
				}
			}
		} else {
			if (seen.has(m.id)) return
			mark(m.id)
			for (const f of lives) f(m.data)
			if (o.relay) { for (const other of links) if (other !== l) send(other, bytes) }
		}
	}

	log.onFork((f, from) => {
		const m = wire(proof(f))
		;(from as Linked | undefined)?.proved.add(f.device)
		for (const l of links) if (l !== from) l.proved.add(f.device), send(l, m)
	})
	log.on((device, _, from) => {
		for (const l of links) if (l !== from) l.waits.delete(device), push(l, device)
	})

	return {
		link(link: Link): () => void {
			const theirs = new Map(
				link.many ? Object.keys(log.have()).map((d) => [d, log.count(d)]) : [],
			)
			const l: Linked = {
				link,
				theirs,
				pushing: new Map(),
				refused: new Set(),
				waits: new Set(),
				told: new Set(),
				tailed: new Set(),
				proved: new Set(),
				turn: Promise.resolve(),
			}
			links.add(l)
			link.onMessage((b) => void receive(l, b).catch(() => {}))
			link.onClose?.(() => drop(l))
			say(l, have())
			tell()
			return () => {
				drop(l)
				link.close?.()
			}
		},
		get links() {
			return links.size
		},
		onLinks(f: () => void) {
			linked.push(f)
			return () => void linked.splice(linked.indexOf(f), 1)
		},
		live(data: Uint8Array) {
			const id = crypto.getRandomValues(new Uint8Array(8))
			mark(hex(id))
			const b = wire({ t: "live", id: hex(id), data })
			for (const l of links) send(l, b)
		},
		onLive(f: (data: Uint8Array) => void) {
			lives.push(f)
			return () => void lives.splice(lives.indexOf(f), 1)
		},
		onRefused(f: (r: Refusal) => void) {
			refusals.push(f)
			return () => void refusals.splice(refusals.indexOf(f), 1)
		},
		passed(): Record<string, number> {
			const out: Record<string, number> = {}
			const all = [...links]
			for (const d of Object.keys(log.have())) {
				if (d === log.device) {
					out[d] = Math.max(0, ...all.map((l) => l.link.keeper ? l.said ?? 0 : 0))
				} else {
					const to = all.filter((l) => !l.link.many && !l.refused.has(d))
					out[d] = to.length ? Math.min(...to.map((l) => l.theirs.get(d) ?? 0)) : 0
				}
			}
			return out
		},
	}
}
