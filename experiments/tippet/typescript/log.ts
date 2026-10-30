// The log: every device's steps this device holds, stored as the signed runs they came in
// (WIRE.md). It knows nothing of the graph, so galaxy can hold logs without one.
import { decode, encode, type Value } from "@ermine/encoding/cbor"
import { decodeStep, encodeStep, hashStep, hex, rest, same, type Step, unhex } from "./step.ts"
import { createSigner, type Signer, verify } from "./sign.ts"
import { firstOf, pack, type Packed, type Prior, priorOf, RUN, stepsIn, unpack } from "./pack.ts"

export type Run = { device: string; steps: Uint8Array[]; sig: Uint8Array; message?: Uint8Array }

export type At = [device: string, first: number, last: number]

// A run as a store keeps it: its run message. A pack against the step before it has that step's
// prior (48 bytes: hash, lamport, when) after it, so a step can be read out of it alone.
const PRIOR = 50
function record(device: string, sig: Uint8Array, p: Packed, prior?: Prior) {
	const parts: unknown[] = ["run", unhex(device), sig, p]
	if (typeof p[0] === "number") {
		if (!prior) throw new RangeError("the step before is not held")
		const b = new Uint8Array(48), view = new DataView(b.buffer)
		b.set(prior.hash),
			view.setBigUint64(32, BigInt(prior.lamport)),
			view.setBigUint64(40, BigInt(prior.when))
		parts.push(b)
	}
	return encode(parts as Value)
}
export const isRun = (record: Uint8Array) => record[0] === 0x84 || record[0] === 0x85
const opened = (record: Uint8Array) =>
	decode(record) as [string, Uint8Array, Uint8Array, Packed, Uint8Array?]
function stepsOf(record: Uint8Array): Uint8Array[] {
	const [, device, , p, b] = opened(record)
	if (!b) return unpack(p)
	const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
	const prior: Prior = {
		device: hex(device),
		n: (p[0] as number) - 1,
		hash: b.slice(0, 32),
		lamport: Number(view.getBigUint64(32)),
		when: Number(view.getBigUint64(40)),
	}
	return unpack(p, prior)
}
function withPrior(message: Uint8Array, prior?: Prior) {
	const [, device, sig, p] = decode(message) as [string, Uint8Array, Uint8Array, Packed]
	return typeof p[0] === "number" ? record(hex(device), sig, p, prior) : message
}
const messageOf = (record: Uint8Array) => {
	if (record[0] === 0x84) return record
	const m = record.slice(0, record.length - PRIOR)
	m[0] = 0x84
	return m
}

export type Store = {
	load(read: (record: Uint8Array) => At | undefined): Promise<Uint8Array | undefined>
	append(record: Uint8Array, at?: At): Promise<void>
	open?(step: Uint8Array, at: At): void
	run(device: string, n: number): { record: Uint8Array; first: number; last: number } | undefined
	get(device: string, n: number): Uint8Array
	snapshot(bytes: Uint8Array): Promise<void>
	key(seed: Uint8Array): Promise<Uint8Array>
	sync?(): Promise<void>
	close?(): void
	drop?(device: string, n: number): number
}

export type Open = { device: string; first: number; steps: Uint8Array[] }

// Per device, each record holding steps as [first, last, where]; the last run read stays unpacked.
export function createIndex<W>(read: (where: W) => Uint8Array) {
	let runs = new Map<string, [number, number, W][]>()
	let last: { device: string; first: number; steps: Uint8Array[] } | undefined
	let open: Open | undefined
	const find = (device: string, n: number) => {
		const list = runs.get(device) ?? []
		let lo = 0, hi = list.length
		while (lo < hi) {
			const mid = (lo + hi) >> 1
			if (list[mid][0] <= n) lo = mid + 1
			else hi = mid
		}
		const r = list[lo - 1]
		return r && n <= r[1] ? r : undefined
	}
	return {
		clear: () => void (runs = new Map(), last = undefined, open = undefined),
		open(step: Uint8Array, [device, n]: At) {
			if (open?.device !== device || n !== open.first + open.steps.length) {
				open = { device, first: n, steps: [] }
			}
			open.steps.push(step)
		},
		opened: (): Open | undefined => open && { ...open, steps: [...open.steps] },
		hold([device, first, end]: At, where: W) {
			if (open?.device === device && end >= open.first) {
				const k = Math.min(open.steps.length, end - open.first + 1)
				open.steps.splice(0, k), open.first += k
			}
			let list = runs.get(device)
			if (!list) runs.set(device, list = [])
			let i = list.length
			while (i > 0 && list[i - 1][0] >= first) i--
			let j = i
			while (j < list.length && list[j][1] <= end) j++
			list.splice(i, j - i, [first, end, where])
		},
		run(device: string, n: number) {
			const r = find(device, n)
			return r && { record: read(r[2]), first: r[0], last: r[1] }
		},
		get(device: string, n: number): Uint8Array {
			const o = open
			if (o?.device === device && n >= o.first && n < o.first + o.steps.length) {
				return o.steps[n - o.first]
			}
			const l = last
			if (l?.device === device && n >= l.first && n < l.first + l.steps.length) {
				return l.steps[n - l.first]
			}
			const r = find(device, n)
			if (!r) throw new RangeError(`step ${n} is not held`)
			const record = read(r[2])
			if (!isRun(record)) return record
			last = { device, first: r[0], steps: stepsOf(record) }
			return last.steps[n - r[0]]
		},
		drop(device: string, n: number) {
			const list = runs.get(device) ?? [], kept = list.filter((r) => r[1] > n)
			runs.set(device, kept)
			return list.length - kept.length
		},
	}
}

export function createMemoryStore(): Store {
	const records: Uint8Array[] = []
	const index = createIndex<Uint8Array>((r) => r)
	let snap: Uint8Array | undefined, key: Uint8Array
	return {
		load(read) {
			const open = index.opened()
			index.clear()
			for (const r of records) {
				const at = read(r)
				if (at) index.hold(at, r)
			}
			for (const s of open?.steps ?? []) {
				const at = read(s)
				if (at) index.open(s, at)
			}
			return Promise.resolve(snap)
		},
		append(r, at) {
			records.push(r)
			if (at) index.hold(at, r)
			return Promise.resolve()
		},
		open: index.open,
		run: index.run,
		get: index.get,
		snapshot: (b) => (snap = b, Promise.resolve()),
		key: (seed) => Promise.resolve(key ??= seed),
		drop: index.drop,
	}
}

const EVERY = 32, BYTES = 2048
const JUMP = 2 ** 20

type Feed = { count: number; last: Uint8Array | null; lamport: number; when: number }
type Chained = { steps: Step[]; last: Uint8Array | null }
export type Taken = { added: number } | { refused: string }
type Told = (device: string, steps: Step[], from?: unknown) => void

export type Log = {
	readonly device: string | undefined
	readonly lamport: number
	have(): Record<string, number>
	count: (device: string) => number
	step: (device: string, n: number) => Uint8Array
	prior: (device: string, n: number) => Prior | undefined
	steps: (device: string) => Uint8Array[]
	on(t: Told): () => void
	write(s: Omit<Step, "device" | "n" | "before" | "lamport" | "relative">): Step
	run(device: string, from: number): Promise<Run | undefined>
	take(b: Run, from?: unknown): Promise<Taken>
	takePack(
		m: { device: string; sig: Uint8Array; pack: Packed; message?: Uint8Array },
		from?: unknown,
	): Promise<Taken>
	load(): Promise<Uint8Array | undefined>
	snapshot: (bytes: Uint8Array) => Promise<unknown>
	drop(through: Record<string, number>): void
	saved: () => Promise<unknown>
	close(): Promise<void>
}

// writes: this log writes steps of its own, under its store's key. Without it the log is a relay.
export function createLog(o: { store?: Store; writes?: boolean; seed?: Uint8Array } = {}): Log {
	const store = o.store ?? createMemoryStore()
	let me: Signer | undefined
	const feeds = new Map<string, Feed>()
	const told: Told[] = []
	let lamport = 0
	let saving: Promise<unknown> = Promise.resolve()
	let taking: Promise<unknown> = Promise.resolve()
	let signing: Promise<unknown> = Promise.resolve()
	let asked = 0, closed = 0, loose = 0
	let failure: unknown
	const track = (p: Promise<unknown>) => {
		saving = p
		p.catch((e) => failure ??= e)
	}
	const save = (record: Uint8Array, at?: At) => {
		track(Promise.all([saving, store.append(record, at)]))
	}
	const count = (d: string) => feeds.get(d)?.count ?? 0

	function chain(device: string, bytes: Uint8Array[]): Chained | "gap" | "chain" {
		const f = feeds.get(device)
		let n = f?.count ?? 0, before = f?.last ?? null
		const first = decodeStep(bytes[0]).n, steps: Step[] = []
		if (first > n + 1) return "gap"
		for (const b of bytes.slice(n - first + 1)) {
			const s = decodeStep(b)
			if (s.device !== device || s.n !== n + 1 || !same(s.before, before)) return "chain"
			steps.push(s), before = hashStep(b)
			n++
		}
		return { steps, last: before }
	}
	function keep(device: string, c: Chained) {
		if (!c.steps.length) return
		const end = c.steps[c.steps.length - 1]
		feeds.set(device, {
			count: count(device) + c.steps.length,
			last: c.last,
			lamport: end.lamport,
			when: end.when,
		})
		for (const s of c.steps) lamport = Math.max(lamport, s.lamport)
	}
	function add(device: string, record: Uint8Array, c: Chained, from?: unknown, open?: boolean) {
		const n = count(device), at: At = [device, n + 1, n + c.steps.length]
		keep(device, c)
		if (open && store.open) store.open(record, at)
		else save(record, at)
		for (const t of told) {
			try {
				t(device, c.steps, from)
			} catch {
			}
		}
	}

	function close(n: number): Promise<void> {
		const device = me!.device
		if (n === count(device)) loose = 0
		asked = Math.max(asked, n)
		const p = signing.then(async () => {
			for (let first = closed + 1; first <= n; first = closed + 1) {
				const last = Math.min(n, first + EVERY - 1)
				const steps = Array.from(
					{ length: last - first + 1 },
					(_, i) => store.get(device, first + i),
				)
				const sig = await me!.sign(hashStep(steps[steps.length - 1]))
				const prior = prior_(device, first - 1)
				save(record(device, sig, pack(steps, prior), prior), [device, first, last])
				closed = last
			}
		})
		signing = p.catch(() => {})
		return p
	}

	// Never this device's own. Stored as it came when every step is new, else what is new is
	// repacked.
	async function taken(b: Run, from?: unknown): Promise<Taken> {
		if (b.device === me?.device) return { refused: "own" }
		if (!b.steps.length) return { added: 0 }
		let c
		try {
			c = chain(b.device, b.steps)
		} catch {
			return { refused: "chain" }
		}
		if (typeof c === "string") return { refused: c }
		if (c.steps.some((s) => s.lamport > lamport + JUMP)) return { refused: "lamport" }
		if (!c.steps.length) return { added: 0 }
		if (!(await verify(b.device, c.last!, b.sig))) return { refused: "signature" }
		const fresh = b.steps.slice(b.steps.length - c.steps.length), held = count(b.device)
		const prior = prior_(b.device, held)
		const r = fresh.length === b.steps.length && b.message
			? withPrior(b.message, prior)
			: record(b.device, b.sig, pack(fresh, prior), prior)
		add(b.device, r, c, from)
		return { added: c.steps.length }
	}
	function serial(f: () => Taken | Promise<Taken>): Promise<Taken> {
		const p = taking.then(f, f)
		taking = p
		return p
	}

	function prior_(device: string, n: number): Prior | undefined {
		const f = feeds.get(device)
		if (!f || n < 1 || n > f.count) return
		if (n === f.count) return { device, n, hash: f.last!, lamport: f.lamport, when: f.when }
		try {
			return priorOf(store.get(device, n))
		} catch {
			return
		}
	}

	function dropped(r: Uint8Array) {
		if (r[0] !== 0x83) return false
		const [t, d, n] = decode(r) as [string, Uint8Array, number]
		if (t === "drop") store.drop?.(hex(d), n)
		return true
	}

	return {
		get device() {
			return me?.device
		},
		get lamport() {
			return lamport
		},
		have(): Record<string, number> {
			const h: Record<string, number> = {}
			for (const [d, f] of feeds) h[d] = f.count
			return h
		},
		count,
		step: (device: string, n: number) => store.get(device, n),
		prior: (device: string, n: number) => prior_(device, n),
		steps: (device: string): Uint8Array[] =>
			Array.from({ length: count(device) }, (_, i) => store.get(device, i + 1)),
		on(t: Told) {
			told.push(t)
			return () => void told.splice(told.indexOf(t), 1)
		},

		// A step decodeStep rejects throws and is never sent; nothing is sent that isn't on disk.
		write(s: Omit<Step, "device" | "n" | "before" | "lamport" | "relative">): Step {
			if (!me) throw new Error("this log writes nothing, or is not loaded")
			if (failure !== undefined) throw new Error("the store failed", { cause: failure })
			if (lamport >= Number.MAX_SAFE_INTEGER) throw new RangeError("lamport is at its end")
			const n = count(me.device) + 1
			const step: Step = {
				...s,
				device: me.device,
				n,
				before: feeds.get(me.device)?.last ?? null,
				lamport: lamport + 1,
			}
			if (rest(me.device, step.node) !== undefined) step.relative = true
			else delete step.relative
			const bytes = encodeStep(step)
			decodeStep(bytes)
			if (bytes.length > RUN) throw new RangeError("a step past a run's most bytes")
			// no run past RUN: the open one closed first
			if (loose && loose + bytes.length > RUN) close(n - 1).catch(() => {})
			add(me.device, bytes, { steps: [step], last: hashStep(bytes) }, undefined, true)
			loose += bytes.length
			if (n - asked >= EVERY || loose >= BYTES) close(n).catch(() => {})
			return step
		},

		async run(device: string, from: number): Promise<Run | undefined> {
			if (from < 1 || from > count(device)) return undefined
			// A run's steps are on disk before any of it leaves, so a power cut can't reuse an n.
			if (device === me?.device) {
				await signing
				if (from > closed && !await close(count(device)).then(() => true, () => false)) {
					return undefined
				}
				if (!await saving.then(() => store.sync?.()).then(() => true, () => false)) {
					return undefined
				}
			}
			const r = store.run(device, from)
			if (!r || !isRun(r.record)) return undefined
			const sig = opened(r.record)[2]
			const steps = stepsOf(r.record).slice(from - r.first)
			return { device, steps, sig, ...(from === r.first && { message: messageOf(r.record) }) }
		},

		take(b: Run, from?: unknown): Promise<Taken> {
			return serial(() => taken(b, from))
		},
		// A pack against the step before needs that step held; if it was let go it is refused as
		// "before".
		takePack(
			m: { device: string; sig: Uint8Array; pack: Packed; message?: Uint8Array },
			from?: unknown,
		): Promise<Taken> {
			return serial(() => {
				let steps
				try {
					const first = firstOf(m.pack)
					if (first.prior && first.n + stepsIn(m.pack) - 1 <= count(m.device)) {
						return { added: 0 }
					}
					if (first.prior && first.n - 1 > count(m.device)) return { refused: "gap" }
					const prior = first.prior ? prior_(m.device, first.n - 1) : undefined
					if (first.prior && !prior) return { refused: "before" }
					steps = unpack(m.pack, prior)
				} catch {
					return { refused: "pack" }
				}
				return taken({ device: m.device, steps, sig: m.sig, message: m.message }, from)
			})
		},

		async load() {
			if (o.writes || o.seed) {
				const key = await store.key(o.seed ?? crypto.getRandomValues(new Uint8Array(32)))
				if (o.seed && !same(key, o.seed)) throw new Error("this store has a key of its own")
				me = await createSigner(key)
			}
			const snapshot = await store.load((r): At | undefined => {
				try {
					if (dropped(r)) return
					const steps = isRun(r) ? stepsOf(r) : [r]
					const s = decodeStep(steps[0]), c = chain(s.device, steps)
					if (
						typeof c === "string" ||
						(!isRun(r) && (s.device !== me?.device || !c.steps.length))
					) {
						return
					}
					keep(s.device, c)
					const last = s.n + steps.length - 1
					if (isRun(r) && s.device === me?.device) closed = Math.max(closed, last)
					return [s.device, s.n, last]
				} catch {
					return
				}
			})
			asked = closed
			return snapshot
		},
		snapshot: (bytes: Uint8Array) => (track(saving.then(() => store.snapshot(bytes))), saving),
		drop(through: Record<string, number>) {
			for (const [d, n] of Object.entries(through)) {
				if (n > 0 && store.drop?.(d, n)) save(encode(["drop", unhex(d), n]))
			}
		},
		saved: () => saving,
		async close() {
			try {
				await saving
				await store.sync?.()
			} finally {
				store.close?.()
			}
		},
	}
}
