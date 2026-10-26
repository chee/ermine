// design E, "an explicit e": every function handed to ermine gets its own e first (the program,
// a memo's f, an effect's f and act, a handler). four kinds of e: program, compute, act, call.
// built over today's ambient api: an e checks its own rules (kind, lifetime, the e running now)
// and calls the real words. what the real api can't do throws NotInApi, never differs quietly.
// decisions (the designer's, from E-design.md, except where marked "mine"):
//   paths: "/x" the root, "~/x" the program's own node, "x" or "./x" the current dir. mine: the
//     current dir is the process's cwd (the designer has it as the own folder; the real api keeps
//     them apart, and the tasks' "./" is the cwd)
//   node(p, start?): program, act, call: made with start (or null) when missing. compute: never
//     made, a missing node reads as pending, start there: NotHere
//   a handle has no public properties; printing it, or .value .length .map .then, throws "this is
//     a node, not its value: use e.read(node)"
//   mine: memo, effect and handler names are paths as any (the parent folder made when missing)
//   mine: words take a handle or a path string
//   mine: e.patch takes { op: "remove" | "replace", at, value? } (or today's { path, value })
//   NotInApi: a compute's reads (and teardown) after an await; e.caller; e.path of an id handle;
//     a call's teardown is the adapter's own list (run as the call ends)
import type { NodeData as Node } from "@ermine/ermine"
import type { Adapter } from "../../lib/trial.ts"
import { NODE } from "../../lib/handles.ts"
import {
	abs,
	Ctx,
	idOf,
	isThen,
	missing,
	named,
	notInApi,
	resolvePath,
	sendWaiting,
	top,
	TrialError,
	where,
	within,
} from "../../lib/contexts.ts"

const NOT_VALUE = "this is a node, not its value: use e.read(node)"
const notValue = () => {
	throw new TrialError("NotAValue", NOT_VALUE)
}

// a node: a handle with no public properties
class ENode {
	declare readonly [NODE]: Node
	constructor(n: Node) {
		Object.defineProperty(this, NODE, { value: n })
	}
	get value() {
		return notValue()
	}
	get length() {
		return notValue()
	}
	get map() {
		return notValue()
	}
	get then() {
		return notValue()
	}
	toString() {
		return notValue()
	}
	toJSON() {
		return notValue()
	}
	[Symbol.toPrimitive]() {
		return notValue()
	}
}

type Kind = "program" | "compute" | "act" | "call"
type Status = { state: string; waiting?: unknown; error?: unknown }

const adapter: Adapter = (api, extras) => {
	const { own, cwd } = where(api)
	// memo and effect nodes, by id: what why says, and what read checks the status of
	// each memo and effect by its path (explain gives a writer by path)
	const kinds = new Map<string, "memo" | "effect">()
	// a call's promise: how it is going
	const calls = new WeakMap<Promise<unknown>, Status>()

	const handleOf = (n: Node) => new ENode(n)
	const nodeOf = (x: unknown, dir: readonly string[]): Node => {
		if (x instanceof ENode) return x[NODE]
		if (typeof x === "string") return { path: resolvePath(x, dir, own), part: "value" }
		throw new TrialError("NotANode", `not a node or a path: ${typeof x}`)
	}
	const pathOf = (x: unknown, dir: readonly string[]) => {
		const n = nodeOf(x, dir)
		if (n.path === undefined) throw notInApi("a path for a node known by its id")
		return abs(n.path)
	}
	// the parent folder of a computer's or handler's path, made when missing
	const folder = (path: string[]) => {
		const up = path.slice(0, -1)
		if (up.length && missing(api, { path: up, part: "value" })) api.make(abs(up))
	}
	const real = <T>(f: () => T): T => {
		try {
			return f()
		} catch (e) {
			throw e === api.PENDING ? e : named(e)
		}
	}

	function make(kind: Kind, state: Ctx, dir: readonly string[]): Record<string, unknown> {
		// every word checks: this e not over, not another e's run going on, a compute's after an await
		const use = (
			word: string,
			allowed: readonly Kind[] = ["program", "compute", "act", "call"],
		) => {
			if (state.ended) throw new TrialError("Ended", `this ${kind} e is over (${word})`)
			const now = top()
			if (now !== undefined && now !== state && now.kind === "compute") {
				throw new TrialError(
					"WrongE",
					`${word}: a ${kind} e used while a compute runs; use its own e`,
				)
			}
			if (kind === "compute" && !state.sync) {
				throw notInApi(`${word} in a compute after an await (it can't be tracked)`)
			}
			if (!allowed.includes(kind)) throw new TrialError("NotHere", `${word} in a ${kind} e`)
		}
		const pend = () => {
			state.pended = true
			return api.PENDING
		}
		const writer: Kind[] = ["program", "act", "call"]

		// a child e: the same kind rules, over its own lifetime
		const child = (k: Kind) => {
			const c = new Ctx(k)
			return { c, e: make(k, c, dir) }
		}

		function read(x: unknown, path?: (string | number)[]) {
			use("read")
			const n = nodeOf(x, dir)
			if (kind === "compute" && missing(api, n)) throw pend()
			const id = kinds.size ? idOf(api, n) : undefined
			const st = id !== undefined && kinds.has(id) ? api.status(n as never) : undefined
			if (st?.state === "failed") throw st.error
			if (st?.state === "looping") throw new TrialError("Looping", `${abs(n.path ?? [])} loops`)
			if (st?.state === "pending") {
				if (kind === "compute") throw pend()
				throw new TrialError("Pending", "not ready yet", { waiting: st.waiting })
			}
			try {
				return api.read(n as never, path as never)
			} catch (e) {
				if (e === api.PENDING && kind !== "compute") {
					throw new TrialError("Pending", "not ready yet", { waiting: [handleOf(n)] })
				}
				throw e === api.PENDING ? pend() : named(e)
			}
		}

		const computer = (which: "memo" | "effect", name: unknown) => {
			use(which, ["program"])
			const path = resolvePath(name, dir, own)
			folder(path)
			return path
		}
		// f(e) for one run: the run before ends as this one starts
		const runner = (f: (e: unknown) => unknown) => {
			let last: Ctx | undefined
			return () => {
				last?.end()
				const { c, e } = child("compute")
				last = c
				api.teardown(() => c.end())
				try {
					const r = within(c, () => f(e))
					// pending is sticky: a try/catch can't swallow it
					if (c.pended) throw api.PENDING
					return r
				} finally {
					c.sync = false
				}
			}
		}

		const words: Record<string, unknown> = {
			node(p: unknown, start?: unknown) {
				use("node")
				const path = resolvePath(p, dir, own)
				if (kind === "compute") {
					if (start !== undefined) {
						throw new TrialError("NotHere", "node(path, start) in a compute")
					}
					return handleOf({ path, part: "value" })
				}
				return handleOf(real(() => api.open(abs(path), start === undefined ? null : start)))
			},
			byId(id: string) {
				use("byId")
				return handleOf({ id, part: "value" })
			},
			at(p: unknown) {
				use("at")
				return make(kind, state, resolvePath(p, dir, own))
			},
			path: (x: unknown) => (use("path"), pathOf(x, dir)),
			id: (x: unknown) => (use("id"), idOf(api, nodeOf(x, dir))),

			read,
			peep(x: unknown, path?: (string | number)[]) {
				use("peep")
				return api.peep(nodeOf(x, dir) as never, path as never)
			},
			reads: (x: unknown) => (use("reads"), real(() => api.reads(nodeOf(x, dir) as never))),
			list(x: unknown) {
				use("list")
				const n = nodeOf(x, dir)
				const names = [...real(() => api.list(n as never))].sort()
				if (n.path === undefined) return names.map((name) => ({ name, node: undefined }))
				return names.map((name) => ({
					name,
					node: handleOf({ path: [...n.path!, name], part: "value" }),
				}))
			},
			attributes: (
				x: unknown,
			) => (use("attributes"), api.read(api.info(nodeOf(x, dir) as never)) ?? {}),

			write(x: unknown, a: unknown, b?: unknown) {
				use("write", writer)
				const n = nodeOf(x, dir)
				const patches = arguments.length > 2
					? [{ path: a, value: b }]
					: [{ path: [], value: a }]
				real(() => api.edit(n as never, patches as never))
			},
			edit(x: unknown, recipe: (d: unknown) => unknown) {
				use("edit", writer)
				if (typeof recipe !== "function") {
					throw new TrialError("BadRecipe", "edit takes a recipe")
				}
				real(() =>
					api.edit(
						nodeOf(x, dir) as never,
						((d: unknown, h: unknown) => {
							const r = (recipe as (d: unknown, h: unknown) => unknown)(d, h)
							if (isThen(r)) throw new TrialError("BadRecipe", "a recipe is sync")
							return r
						}) as never,
					)
				)
			},
			patch(
				x: unknown,
				patches: { op?: string; at?: unknown; path?: unknown; value?: unknown }[],
			) {
				use("patch", writer)
				const out = patches.map((p) => {
					if (p.op === undefined && Array.isArray(p.path)) return p
					if (p.op === "remove") return { path: p.at }
					if (p.op === "replace") return { path: p.at, value: p.value }
					throw new TrialError("BadPatch", `no patch op ${p.op}`)
				})
				real(() => api.edit(nodeOf(x, dir) as never, out as never))
			},
			remove: (
				x: unknown,
			) => {
				use("remove", writer)
				// a process deletes nothing (10-25): the name out
				const n = nodeOf(x, dir) as { path?: readonly string[] }
				if (n.path === undefined) throw notInApi("removing a node known only by its id")
				real(() => api.unplace(abs(n.path!)))
			},
			move: (
				a: unknown,
				b: unknown,
			) => (use("move", writer), real(() => api.move(pathOf(a, dir), pathOf(b, dir)))),
			place: (
				x: unknown,
				p: unknown,
			) => (use("place", writer),
				real(() => api.place(pathOf(p, dir), nodeOf(x, dir) as never))),
			unplace: (p: unknown) => (use("unplace", writer), real(() => api.unplace(pathOf(p, dir)))),

			memo(name: unknown, f: (e: unknown) => unknown) {
				const path = computer("memo", name)
				const n = real(() => api.memo(abs(path), runner(f) as never))
				kinds.set(abs(path), "memo")
				return handleOf(n)
			},
			effect(
				name: unknown,
				f: (e: unknown) => unknown,
				act: (e: unknown, now: unknown, before: unknown) => unknown,
			) {
				const path = computer("effect", name)
				let acting: Ctx | undefined
				const n = real(() =>
					api.effect(abs(path), runner(f) as never, (now: unknown, before: unknown) => {
						acting?.end()
						const { c, e } = child("act")
						acting = c
						const r = within(c, () => act(e, now, before))
						if (isThen(r)) Promise.resolve(r).finally(() => c.end())
						else c.end()
					})
				)
				kinds.set(abs(path), "effect")
				return handleOf(n)
			},

			handler(p: unknown, fn: (e: unknown, ...args: unknown[]) => unknown) {
				use("handler", ["program"])
				const path = resolvePath(p, dir, own)
				return handleOf(real(() =>
					api.method(abs(path), (...args: unknown[]) => {
						const { c, e } = child("call")
						let r: unknown
						try {
							r = within(c, () => fn(e, ...args))
						} catch (err) {
							c.end()
							throw err
						}
						if (isThen(r)) Promise.resolve(r).then(() => c.end(), () => c.end())
						else c.end()
						return r
					})
				))
			},
			call(p: unknown, ...args: unknown[]) {
				use("call", writer)
				if (args.some((a) => typeof a === "function")) {
					throw new TrialError("NotAValue", "a function can't be sent")
				}
				const n = nodeOf(p, dir)
				const st: Status = { state: "pending", waiting: [handleOf(n)] }
				const out = sendWaiting(api, n, args, named)
				calls.set(out, st)
				out.then(
					() => Object.assign(st, { state: "done", waiting: undefined }),
					(error) => Object.assign(st, { state: "failed", waiting: undefined, error }),
				)
				return out
			},

			status(x: unknown) {
				use("status")
				if (x instanceof Promise) {
					return calls.get(x) ?? notInApi("status of a promise e.call didn't give")
				}
				const n = nodeOf(x, dir)
				const st = api.status(n as never)
				if (st === undefined) return { state: "pending", waiting: [handleOf(n)] }
				return { state: st.state, waiting: st.waiting, error: st.error }
			},
			teardown(fn: () => void) {
				use("teardown")
				if (kind === "call" || kind === "act") state.cleanups.push(fn)
				else api.teardown(() => fn())
			},
			why(x: unknown) {
				use("why")
				const b = api.explain(nodeOf(x, dir) as never)
				const w = b?.writer
				if (w === undefined) return undefined
				const at = b?.change?.time
				// the writer by its path as this process sees it (none: outside its box)
				const node = (p?: readonly string[]) =>
					p === undefined ? undefined : handleOf({ path: p, part: "value" })
				const kind = (p?: readonly string[], none = "memo") =>
					p === undefined ? none : kinds.get(abs(p)) ?? none
				if (w.kind === "computer") return { by: kind(w.path), writer: node(w.path), at }
				if (w.kind === "method") {
					return w.call === undefined
						? { by: kind(w.path, "call"), writer: node(w.path), at }
						: { by: "call", writer: node(w.path), at }
				}
				return { by: "outside", site: w.site && `${w.site.file}:${w.site.line}`, at }
			},
			...extras,
		}
		Object.defineProperty(words, "caller", {
			get: () => {
				throw notInApi("e.caller: a program can't see who sent")
			},
		})
		return words
	}

	const program = new Ctx("program")
	api.teardown(() => program.end())
	return make("program", program, cwd)
}
export default adapter
