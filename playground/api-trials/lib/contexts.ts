// what designs E and F share: a context object given to every callback, over today's ambient api.
// paths ("~/" own folder, "x" or "./x" the current dir, "/" the root, ".." up), the context
// stack (which context runs synchronously now), lifetimes, errors with codes, and waiting
// (a call to a handler not there yet, a node not ready yet) built from a hidden effect
import type { NodeData as Node } from "@ermine/ermine"
import type { DataAPI } from "./compat.ts"

export class TrialError extends Error {
	constructor(readonly code: string, message: string, extra: Record<string, unknown> = {}) {
		super(message)
		this.name = code
		Object.assign(this, extra)
	}
}

// something the design promises that today's process api can't give: loud
export const notInApi = (what: string) =>
	new TrialError("NotInApi", `${what} (today's process api has no way to do this)`)

export const isThen = (v: unknown): v is PromiseLike<unknown> =>
	(typeof v === "object" || typeof v === "function") && v !== null &&
	typeof (v as PromiseLike<unknown>).then === "function"

// the process's own folder and cwd, as paths: what the real api resolves bare and ./ names to
export function where(api: DataAPI) {
	return {
		own: api.open("_").path!.slice(0, -1) as string[],
		cwd: api.open("./_").path!.slice(0, -1) as string[],
	}
}

export function resolvePath(p: unknown, cwd: readonly string[], own: readonly string[]): string[] {
	if (typeof p !== "string" || p === "") {
		throw new TrialError("BadPath", `not a path: ${String(p)}`)
	}
	let base: string[]
	let rest: string
	if (p.startsWith("/")) [base, rest] = [[], p.slice(1)]
	else if (p === "~" || p.startsWith("~/")) [base, rest] = [[...own], p.slice(2)]
	else [base, rest] = [[...cwd], p]
	for (const step of rest.split("/")) {
		if (step === "" || step === ".") continue
		if (step === "..") {
			if (base.length === 0) throw new TrialError("OutsideRoot", `${p} goes above the root`)
			base.pop()
		} else base.push(step)
	}
	return base
}

export const abs = (path: readonly string[]) => "/" + path.join("/")

// a real error as the design's: places' codes named
export function named(e: unknown): unknown {
	const code = (e as { code?: unknown })?.code
	if (e instanceof TrialError || typeof code !== "string") return e
	const map: Record<string, string> = {
		"nothing-there": "Missing",
		"already-there": "Taken",
		"not-a-method": "NotAMethod",
	}
	return new TrialError(map[code] ?? code, (e as Error).message, { cause: e })
}

// one context: its kind, whether it is over, its cleanups
export class Ctx {
	ended = false
	// a compute's: true while its function runs synchronously
	sync = true
	// a compute's: a read in this run was pending (the run is pending, even if f caught it)
	pended = false
	cleanups: (() => void)[] = []
	constructor(readonly kind: string) {}
	end() {
		if (this.ended) return
		this.ended = true
		for (const f of this.cleanups.splice(0).reverse()) f()
	}
}

// the contexts running synchronously now, innermost last
export const running: Ctx[] = []
export function within<T>(c: Ctx, f: () => T): T {
	running.push(c)
	try {
		return f()
	} finally {
		running.pop()
	}
}
export const top = () => running.at(-1)

// a node with nothing in it there (no entry at the path, or at the id)
export const missing = (api: DataAPI, n: Node) => api.entries(n as never).length === 0
export const idOf = (api: DataAPI, n: Node): string | undefined => {
	const id = n.id ?? api.entries(n as never)[0]?.id
	return typeof id === "string" ? id : undefined
}

// then(v) once ready() gives v (not PENDING): a hidden effect in the process's own folder, the
// only way today's api waits on a path (watch is not told when a node arrives at a path). it is
// owned by whatever scope is open, as any effect is
let waits = 0
export function whenReady<T>(
	api: DataAPI,
	ready: () => T | typeof api.PENDING,
	then: (v: T) => void,
) {
	let done = false
	api.effect(`.wait-${++waits}`, () => ready() as never, (v: unknown) => {
		if (done) return
		done = true
		queueMicrotask(() => then(v as T))
	})
}

// send at path, waiting for a handler: a promise of its answer. a handler's own error rejects it
export function sendWaiting(
	api: DataAPI,
	at: Node,
	args: unknown[],
	failed: (e: unknown) => unknown,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const attempt = () => {
			let out: unknown
			try {
				out = api.send(at as never, ...args)
			} catch (e) {
				if (e === api.PENDING) {
					return whenReady(
						api,
						() => api.read(at as never) === undefined ? api.PENDING : true,
						attempt,
					)
				}
				return reject(failed(e))
			}
			if (isThen(out)) out.then(resolve, (e) => reject(failed(e)))
			else resolve(out)
		}
		attempt()
	})
}
