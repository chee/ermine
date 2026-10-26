// design F, "me": every callback's first argument is me, whoever is acting now: the setup, one
// run of a compute or an effect's f, one act, one call. built over today's ambient api: a me
// checks its own rules (kind, lifetime, the me running now) and calls the real words. what the
// real api can't do throws NotInApi, never differs quietly.
// decisions (the designer's, from F-design.md, except where marked "mine"):
//   paths: "/x" the root, "~/x" the program's own node, "x" or "./x" the current dir. mine: the
//     current dir is the process's cwd (the real api keeps it apart from the own node; the
//     tasks' "./" is the cwd)
//   node(p, from?) makes nothing; make(p, start?) makes it and its parents (not in a run)
//   a string is always a path: words that use a node take a handle. mine: a string there throws
//     NotANode ("a string is a path: use me.node(path)")
//   a handle is a Proxy: any property throws NotAValue "this is a node; use me.read(node)";
//     String(h) and `${h}` are "[node /abs/path]"; valueOf, toJSON, other conversions throw
//   WrongMe: while a callback runs synchronously, any me but its own throws
//   edit's recipe must return undefined (BadRecipe: d => d + 1, async)
//   mine: compute, effect and answer paths' parent folders made when missing
//   NotInApi: a run's reads (and cleanup) after an await; me.caller; info's names; a path for an
//     id handle; Taken for answer (the real method replaces quietly; not checked)
//   ready(node) and send's wait: a hidden effect in the own folder (today's api waits only that
//     way); an act's and a call's cleanups: the adapter's own lists
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
	whenReady,
	where,
	within,
} from "../../lib/contexts.ts"

const NOT_VALUE = "this is a node; use me.read(node)"
const notValue = (): never => {
	throw new TrialError("NotAValue", NOT_VALUE)
}

// a handle: opaque. only NODE and string conversion are answered
function handleOf(n: Node): object {
	const name = n.path === undefined ? `#${String(n.id)}` : abs(n.path)
	return new Proxy({ [NODE]: n }, {
		get(t, k) {
			if (k === NODE) return t[NODE]
			if (k === Symbol.toPrimitive) {
				return (hint: string) => hint === "string" ? `[node ${name}]` : notValue()
			}
			if (k === "toString") return () => `[node ${name}]`
			return notValue()
		},
		set: () => notValue(),
	})
}
const isHandle = (x: unknown): x is { [NODE]: Node } =>
	typeof x === "object" && x !== null && NODE in x

type Kind = "setup" | "run" | "act" | "call"

const adapter: Adapter = (api, extras) => {
	const { own, cwd } = where(api)
	// compute and effect nodes, by id: write refuses them, read checks their status
	const computed = new Map<string, "compute" | "effect">()

	const nodeOf = (x: unknown): Node => {
		if (isHandle(x)) return x[NODE]
		if (typeof x === "string") {
			throw new TrialError("NotANode", "a string is a path: use me.node(path)")
		}
		throw new TrialError("NotANode", `not a node: ${typeof x}`)
	}
	const pathOf = (x: unknown) => {
		const n = nodeOf(x)
		if (n.path === undefined) throw notInApi("a path for a node known by its id")
		return n.path
	}
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
	const failed = (e: unknown) =>
		new TrialError("Failed", e instanceof Error ? e.message : String(e), { cause: e })

	function make(kind: Kind, state: Ctx, who: Record<string, unknown>): Record<string, unknown> {
		const use = (word: string, allowed: readonly Kind[] = ["setup", "run", "act", "call"]) => {
			if (state.ended) throw new TrialError("Ended", `this ${kind} me is over (${word})`)
			const now = top()
			if (now !== undefined && now !== state) {
				throw new TrialError(
					"WrongMe",
					`${word}: a ${kind} me used inside a ${now.kind}; use its own me`,
				)
			}
			if (kind === "run" && !state.sync) {
				throw notInApi(`${word} in a run after an await (it can't be tracked)`)
			}
			if (!allowed.includes(kind)) throw new TrialError("NotHere", `${word} in a ${kind}`)
		}
		const pend = () => {
			state.pended = true
			return api.PENDING
		}
		const writer: Kind[] = ["setup", "act", "call"]
		const child = (k: Kind, w: Record<string, unknown>) => {
			const c = new Ctx(k)
			return { c, me: make(k, c, w) }
		}
		const statusOf = (n: Node) => {
			const id = computed.size ? idOf(api, n) : undefined
			return id !== undefined && computed.has(id) ? api.status(n as never) : undefined
		}
		const writable = (n: Node, word: string) => {
			const id = idOf(api, n)
			if (id === undefined) {
				throw new TrialError("Missing", `${word}: nothing there: me.make it first`)
			}
			if (computed.has(id)) throw new TrialError("Computed", `${word}: a computed node`)
		}
		const runner = (f: (me: unknown) => unknown, w: Record<string, unknown>) => {
			let last: Ctx | undefined
			return () => {
				last?.end()
				const { c, me } = child("run", w)
				last = c
				api.teardown(() => c.end())
				try {
					const r = within(c, () => f(me))
					// pending is sticky: a try/catch can't swallow it
					if (c.pended) throw api.PENDING
					return r
				} finally {
					c.sync = false
				}
			}
		}
		const computer = (word: string, p: unknown) => {
			use(word, ["setup", "run"])
			const path = resolvePath(p, cwd, own)
			folder(path)
			return path
		}

		const words: Record<string, unknown> = {
			node(p: unknown, from?: unknown) {
				use("node")
				const dir = from === undefined ? cwd : pathOf(from)
				return handleOf({ path: resolvePath(p, dir, own), part: "value" })
			},
			byId: (id: string) => (use("byId"), handleOf({ id, part: "value" })),
			make(p: unknown, start?: unknown) {
				use("make", writer)
				const at = abs(resolvePath(p, cwd, own))
				return handleOf(real(() => start === undefined ? api.make(at) : api.open(at, start)))
			},
			info(x: unknown) {
				use("info")
				const n = nodeOf(x)
				const out = { id: idOf(api, n), path: n.path && abs(n.path), exists: !missing(api, n) }
				return Object.defineProperty(out, "names", {
					get: () => {
						throw notInApi("every name of a node")
					},
					enumerable: true,
				})
			},

			read(x: unknown) {
				use("read")
				const n = nodeOf(x)
				const st = statusOf(n)
				if (st?.state === "failed") {
					throw new TrialError("Failed", String((st.error as Error)?.message ?? st.error), {
						cause: st.error,
					})
				}
				if (st?.state === "looping") throw new TrialError("Looping", "it loops")
				const notReady = () =>
					new TrialError("NotReady", "not ready: await me.ready(node)", { waits: st?.waiting })
				if (st?.state === "pending") {
					if (kind === "run") throw pend()
					throw notReady()
				}
				try {
					return api.read(n as never)
				} catch (e) {
					if (e === api.PENDING && kind !== "run") throw notReady()
					throw e === api.PENDING ? pend() : named(e)
				}
			},
			peek: (x: unknown) => (use("peek"), api.peep(nodeOf(x) as never)),
			values: (x: unknown) => (use("values"), real(() => api.reads(nodeOf(x) as never))),
			children(x: unknown) {
				use("children")
				const n = nodeOf(x)
				const names = [...real(() => api.list(n as never))].sort()
				return names.map((name) => ({
					name,
					node: n.path === undefined
						? undefined
						: handleOf({ path: [...n.path, name], part: "value" }),
				}))
			},
			attributes: (
				x: unknown,
			) => (use("attributes"), api.read(api.info(nodeOf(x) as never)) ?? {}),

			write(x: unknown, v: unknown) {
				use("write", writer)
				const n = nodeOf(x)
				writable(n, "write")
				real(() => api.edit(n as never, [{ path: [], value: v }] as never))
			},
			writeAt(x: unknown, keys: unknown[], v: unknown) {
				use("writeAt", writer)
				const n = nodeOf(x)
				writable(n, "writeAt")
				real(() => api.edit(n as never, [{ path: keys, value: v }] as never))
			},
			edit(x: unknown, recipe: (d: unknown) => unknown) {
				use("edit", writer)
				const n = nodeOf(x)
				writable(n, "edit")
				if (typeof recipe !== "function") {
					throw new TrialError("BadRecipe", "edit takes a recipe")
				}
				real(() =>
					api.edit(
						n as never,
						((d: unknown) => {
							if (recipe(d) !== undefined) {
								throw new TrialError(
									"BadRecipe",
									"a recipe changes the draft and returns nothing (use me.write for a new value)",
								)
							}
						}) as never,
					)
				)
			},
			remove(x: unknown) {
				use("remove", writer)
				const n = nodeOf(x)
				// a process deletes nothing (10-25): the name out; a node known by its id has none to take
				if (n.path === undefined) throw notInApi("removing a node known only by its id")
				real(() => api.unplace(abs(n.path!)))
			},
			move: (
				x: unknown,
				p: unknown,
			) => (use("move", writer),
				real(() => api.move(abs(pathOf(x)), abs(resolvePath(p, cwd, own))))),
			place: (
				x: unknown,
				p: unknown,
			) => (use("place", writer),
				real(() => api.place(abs(resolvePath(p, cwd, own)), nodeOf(x) as never))),

			compute(p: unknown, f: (me: unknown) => unknown) {
				const path = computer("compute", p)
				const w = { kind: "run", node: handleOf({ path, part: "value" }) }
				const n = real(() => api.memo(abs(path), runner(f, w) as never))
				const id = idOf(api, n)
				if (id !== undefined) computed.set(id, "compute")
				return handleOf(n)
			},
			effect(
				p: unknown,
				f: (me: unknown) => unknown,
				act: (now: unknown, before: unknown, me: unknown) => unknown,
			) {
				const path = computer("effect", p)
				const node = handleOf({ path, part: "value" })
				let acting: Ctx | undefined
				const n = real(() =>
					api.effect(
						abs(path),
						runner(f, { kind: "run", node }) as never,
						(now: unknown, before: unknown) => {
							acting?.end()
							const { c, me } = child("act", { kind: "act", node })
							acting = c
							within(c, () => act(now, before, me))
						},
					)
				)
				const id = idOf(api, n)
				if (id !== undefined) computed.set(id, "effect")
				return handleOf(n)
			},

			answer(p: unknown, fn: (me: unknown, ...args: unknown[]) => unknown) {
				use("answer", ["setup", "run"])
				const path = resolvePath(p, cwd, own)
				const node = handleOf({ path, part: "value" })
				return handleOf(real(() =>
					api.method(abs(path), (...args: unknown[]) => {
						const { c, me } = child("call", { kind: "call", node })
						let r: unknown
						try {
							r = within(c, () => fn(me, ...args))
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
			send(x: unknown, ...args: unknown[]) {
				use("send", writer)
				const n = nodeOf(x)
				const out = sendWaiting(api, n, args, failed)
				// the sender's me ending first rejects with Ended
				return new Promise((resolve, reject) => {
					state.cleanups.push(() =>
						reject(new TrialError("Ended", "the sender's me ended before the answer"))
					)
					out.then(resolve, reject)
				})
			},

			status(x: unknown) {
				use("status")
				const st = api.status(nodeOf(x) as never)
				if (st === undefined) return { state: "pending", waits: [], loop: false }
				return {
					state: st.state,
					waits: st.waiting,
					error: st.error,
					loop: st.state === "looping",
				}
			},
			ready(x: unknown) {
				use("ready", writer)
				const n = nodeOf(x)
				return new Promise((resolve, reject) =>
					whenReady(api, () => {
						const st = api.status(n as never)
						return st === undefined || st.state === "pending" ? api.PENDING : { st }
					}, ({ st }: { st: { state: string; error?: unknown } }) =>
						st.state === "done" ? resolve(api.peep(n as never)) : reject(failed(st.error)))
				)
			},
			cleanup(fn: () => void) {
				use("cleanup")
				if (kind === "act" || kind === "call") state.cleanups.push(fn)
				else api.teardown(() => fn())
			},
			why(x: unknown) {
				use("why")
				const w = api.explain(nodeOf(x) as never)?.writer
				if (w === undefined) return undefined
				// the writer by its path as this process sees it (none: outside its box)
				const at = (p?: readonly string[]) =>
					p === undefined ? undefined : handleOf({ path: p, part: "value" })
				if (w.kind === "computer") return { kind: "run", node: at(w.path) }
				if (w.kind === "method") {
					return w.call === undefined
						? { kind: "run", node: at(w.path) }
						: { kind: "call", node: at(w.path) }
				}
				return { kind: "outside", site: w.site && `${w.site.file}:${w.site.line}` }
			},
			...extras,
		}
		Object.defineProperty(words, "who", { value: who, enumerable: true })
		Object.defineProperty(words, "caller", {
			get: () => {
				throw notInApi("me.caller: a program can't see who sent")
			},
		})
		return words
	}

	const setup = new Ctx("setup")
	api.teardown(() => setup.end())
	return make("setup", setup, { kind: "setup", node: handleOf({ path: own, part: "value" }) })
}
export default adapter
