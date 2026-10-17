// scheduler's streams: a few roots and scopes; computes over the host's keys and earlier
// computes (sums, mods, choices, a throw at one value; some with a cleanup, a set, equal "json",
// a declared key; some waiting on a promise, then reading); effects over them logging their value
// and the previous, some early, some writing a sink key only a sink compute reads (so no loop
// is endless); then steps: host writes and changed, promises resolved and rejected, computations
// and scopes disposed, new ones made, cleanups, runs in a scope, a pulse after most; moments
// (with reads now and then), log, get, tick, started, forgotten and current asked between.
// wild: writes of keys that are no strings, mods by 0, sums of strings, a write naming no scope,
// -0 results under equal "json", run() of a pending
import { type Generator, picker, type Request } from "./kit.ts"

const HOST = ["h0", "h1", "h2", "h3"]
const SINKS = ["x0", "x1"]

const generator: Generator = {
	streams(seed, o) {
		const { pick, one } = picker(seed)
		const out: Request[] = []
		const scopes: string[] = []
		const alive = new Set<string>()
		const promises: string[] = []
		for (let i = 0; i < 3; i++) {
			const name = `o${i}`
			scopes.push(name)
			alive.add(name)
			if (i === 0 || pick(2)) out.push({ op: "root", name, info: [["actor", name]] })
			else out.push({ op: "scope", name, parent: `o${pick(i)}`, info: [["why", name]] })
		}
		const values: Record<string, number> = {}
		for (const h of HOST) values[h] = pick(6)
		out.push({ op: "write", values })

		const keys = [...HOST]
		const read = () => ({ read: one(keys) })
		const expr = (depth: number): unknown => {
			const k = pick(depth > 0 ? 10 : 3)
			if (k < 2) return read()
			if (k < 3) return pick(4)
			if (k < 6) return { sum: Array.from({ length: 1 + pick(3) }, () => expr(depth - 1)) }
			if (k < 7) return { mod: [expr(depth - 1), 2 + pick(2)] }
			if (k < 9) {
				return { if: [{ eq: [{ mod: [read(), 2] }, 0] }, expr(depth - 1), expr(depth - 1)] }
			}
			return { if: [{ eq: [{ read: one(HOST) }, 5] }, { throw: "five" }, expr(depth - 1)] }
		}
		let computes = 0, effects = 0
		const compute = (scope: string) => {
			const name = `c${computes++}`
			let f = expr(2)
			const k = pick(10)
			if (k === 0) {
				const p = `p${name}`
				promises.push(p)
				f = pick(2) ? { wait: [p] } : { wait: [p, f] }
			} else if (k === 1) f = { do: [{ cleanup: [null, { log: ["undo", name] }] }, f] }
			else if (k === 2) f = { do: [{ log: ["run", name] }, f] }
			const r: Request = { op: "compute", name, scope, f, to: name }
			if (pick(5) === 0) r.equal = "json"
			if (pick(8) === 0) r.declared = true
			if (pick(6) === 0) r.set = { log: ["set", name, { given: "value" }] }
			out.push(r)
			alive.add(name)
			keys.push(name)
		}
		const effect = (scope: string) => {
			const name = `e${effects++}`
			const f = { sum: Array.from({ length: 1 + pick(2) }, read) }
			const act = pick(4) === 0
				? { write: [one(SINKS), { given: "value" }] }
				: { log: [name, { given: "value" }, { given: "previous" }] }
			const r: Request = { op: "effect", name, scope, f, act }
			if (pick(5) === 0) r.early = true
			if (pick(6) === 0) r.equal = "json"
			out.push(r)
			alive.add(name)
		}
		const living = (xs: string[]) => xs.filter((x) => alive.has(x))
		for (let i = 2 + pick(5); i > 0; i--) compute(one(scopes))
		for (let i = 1 + pick(3); i > 0; i--) effect(one(scopes))
		// sinks: read by no effect
		for (const x of SINKS) {
			out.push({
				op: "compute",
				name: `s${x}`,
				scope: "o0",
				f: { sum: [{ read: x }] },
				to: `s${x}`,
			})
		}
		const ask = () => {
			const k = pick(12)
			if (k < 4) out.push(pick(4) === 0 ? { op: "moments", reads: true } : { op: "moments" })
			else if (k < 6) out.push({ op: "log" })
			else if (k < 8) out.push({ op: "get", key: one(keys) })
			else if (k < 9) out.push({ op: "tick" })
			else if (k < 10) out.push({ op: "started" })
			else if (k < 11) out.push({ op: "forgotten" })
			else out.push({ op: "current" })
		}
		out.push({ op: "pulse" })
		ask()
		for (let step = 0; step < 14; step++) {
			const k = pick(20)
			if (k < 8) {
				const w: Record<string, number> = {}
				for (let i = 1 + pick(2); i > 0; i--) w[one(HOST)] = pick(6)
				out.push({ op: "write", values: w })
			} else if (k < 9) out.push({ op: "changed", keys: [one(HOST), one(keys)] })
			else if (k < 11 && promises.length) {
				const p = one(promises)
				out.push(
					pick(4)
						? { op: "resolve", promise: p, value: pick(6) }
						: { op: "reject", promise: p, error: "no" },
				)
			} else if (k < 13) {
				const c = living([...keys.filter((x) => x.startsWith("c")), "e0", "e1", "e2"])
				if (c.length) {
					const x = one(c)
					alive.delete(x)
					out.push({ op: "dispose", scope: x })
				}
			} else if (k < 14) {
				const s = living(["o1", "o2"])
				if (s.length) {
					const x = one(s)
					alive.delete(x)
					out.push({ op: "dispose", scope: x })
				}
			} else if (k < 16) {
				const s = living(scopes)
				if (s.length) pick(2) ? compute(one(s)) : effect(one(s))
			} else if (k < 17) {
				const s = living(scopes)
				if (s.length) out.push({ op: "cleanup", scope: one(s), do: { log: ["cleanup", step] } })
			} else if (k < 18) {
				const s = living(scopes)
				if (s.length) {
					out.push({
						op: "run",
						scope: one(s),
						do: pick(2)
							? { sum: [read(), 1] }
							: { do: [{ write: [one(HOST), pick(6)] }, read()] },
					})
				}
			} else if (o.wild) {
				out.push(
					one<Request>([
						{ op: "changed", keys: [1] },
						{ op: "run", scope: "o0", do: { mod: [1, 0] } },
						{ op: "run", scope: "o0", do: { sum: ["a", 1] } },
						{ op: "run", scope: "o0", do: { write: ["h0", 1, "nobody"] } },
						{ op: "run", scope: "o0", do: { pending: null } },
						{ op: "run", scope: "o0", do: { wait: ["pw"] } },
						{
							op: "compute",
							name: `z${step}`,
							scope: "o0",
							f: { sum: [{ read: "h0" }, -0] },
							to: `z${step}`,
							equal: "json",
						},
					]),
				)
			}
			if (pick(5)) out.push({ op: "pulse" })
			ask()
			if (pick(2)) ask()
		}
		out.push({ op: "pulse" }, { op: "moments", reads: true }, { op: "log" })
		for (const c of keys.filter((x) => x.startsWith("c"))) out.push({ op: "get", key: c })
		return [out]
	},
}
export default generator
