// pipe's harness: the ermine harness (ermine/system/typescript/ermine_harness.ts: its ermine,
// programs, requests and test features, all as documented there) with pipes (pipe.ts) beside: the
// feature asked for by name, "pipe", and its library's function a program may call:
//   ["pipe", from, to?, a?, b?, options?]   pipe(…): each argument an expr (a list of from:
//                                           ["all", …]), but a function, written
//                                           { fn: steps, back?: expr }: told a write, its steps run
//                                           with $patches, $value, $from, $change named, then back's
//                                           value given back (none: nothing)
// a getter is written { get: expr }, in options as { to: { get: expr }, … }: a function giving
// expr's value when called (what it reads is read as the pipe's memo reads, not as a program's step)
// and one op:
//   { op: "pipesite", part, id | path } → { site }   the site a change carries: "pipe" (the line in this
//                                           file that calls pipe: the line that made the pipe),
//                                           "program" (a program's step), "none", else "other"
import pipes, { pipe, type Told } from "./pipe.ts"
import {
	libraries,
	named,
	ops,
	serveErmine,
} from "../../../ermine/system/typescript/ermine_harness.ts"
import type { Key } from "@ermine/core/table"
import { get } from "@ermine/core/places/lib"

named.set("pipe", pipes)

const isGet = (x: unknown): x is { get: unknown } =>
	x !== null && typeof x === "object" && !Array.isArray(x) && "get" in x

const isOptionsGet = (x: unknown): x is { to: { get: unknown } } =>
	x !== null && typeof x === "object" && !Array.isArray(x) && !("fn" in x) && "to" in x &&
	isGet(x.to)

const isFn = (x: unknown): x is { fn: unknown[]; back?: unknown } =>
	x !== null && typeof x === "object" && !Array.isArray(x) && "fn" in x

libraries.set("pipe", (env, raw, { expr, run }) => {
	const args = raw.map((x) => {
		if (isGet(x)) return () => expr(env, x.get)
		if (isOptionsGet(x)) {
			const { to, ...others } = x
			return { ...expr(env, others) as object, to: () => expr(env, to.get) }
		}
		if (Array.isArray(x) && x[0] === "all" && x.some(isGet)) {
			return x.slice(1).map((y) => isGet(y) ? () => expr(env, y.get) : expr(env, y))
		}
		if (!isFn(x)) return expr(env, x)
		return (w: Told) => {
			const inner = new Map(env)
			inner.set("patches", w.patches)
			inner.set("value", w.value)
			inner.set("from", w.from)
			inner.set("change", w.change)
			run(inner, x.fn as never)
			return x.back === undefined ? undefined : expr(inner, x.back)
		}
	})
	return (pipe as (...a: unknown[]) => unknown)(...args)
})

ops.set("pipesite", (r, e) => {
	const id = r.id ?? get(e.places, r.path)
	const at = e.table.get(r.part as Key, id)?.change?.external?.[0]
	if (at === undefined) return { site: "none" }
	if (at.function === "setup") return { site: "setup" }
	if (at.file === import.meta.url) return { site: "pipe" }
	if (at.file.endsWith("/ermine_harness.ts")) return { site: "program" }
	return { site: "other" }
})

if (import.meta.main) serveErmine()
