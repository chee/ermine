// Line-protocol harness for apply.ts and invert.ts, one JSON request per line. An optional first
// argument names another module's apply to test instead.
//   { op: "apply", value?, patches, cow? }   -> { value? } | { error: { code, patch } }
//   { op: "invert", value?, patches, cow? }  -> { undo } | { error: { code, patch } }
// An absent value means nothing there (null is a value). Anything not understood answers { error: text }.
// Values use the JSON form of conformance/typescript/form.ts. Also checks that the inputs are unchanged.
import { ApplyError as Refused, type Patch } from "@ermine/changeable/apply"
import invert from "@ermine/changeable/invert"
import { line, revive, toJson } from "../../conformance/typescript/form.ts"
import { type Request, serve } from "../../conformance/typescript/harness.ts"

const { default: apply, ApplyError } =
	(Deno.args[0] === undefined ? await import("@ermine/changeable/apply") : await import(
		new URL(Deno.args[0], `file://${Deno.cwd()}/`).href
	)) as typeof import("@ermine/changeable/apply")

const isMap = (x: unknown): x is Record<string, unknown> =>
	x !== null && typeof x === "object" && !Array.isArray(x)

const whole = (v: unknown) => line(toJson(v))
const sorted = (v: unknown) =>
	isMap(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v
const content = (v: unknown) => line(toJson(v), sorted)

function answer(r: Request): Record<string, unknown> {
	if (!isMap(r) || (r.op !== "apply" && r.op !== "invert")) {
		return { error: `unknown op ${isMap(r) ? r.op : r}` }
	}
	if (!Array.isArray(r.patches)) return { error: "patches: not a list" }
	const value = Object.hasOwn(r, "value") ? revive(r.value) : undefined
	const patches = r.patches.map((p: unknown) =>
		isMap(p) && Object.hasOwn(p, "value") ? { ...p, value: revive(p.value) } : p
	) as Patch[]
	const inPlace = r.cow === false
	const form = inPlace ? content : whole
	const before = [form(value), ...patches.map((p) => form(isMap(p) ? p.value : undefined))]
	const same = (after: string[]) => after.every((a, i) => a === before[i])
	const wholes = patches.some((p) =>
		!isMap(p) || !Array.isArray(p.path) || p.path.length === 0 ||
		isMap(p.move) && Array.isArray(p.move.path) && p.move.path.length === 0
	)
	if (r.op === "invert") {
		let out: Record<string, unknown>
		try {
			let undo: Patch[]
			if (inPlace) {
				undo = []
				apply(value, patches, { undo, cow: false })
			} else undo = invert(value, patches)
			out = { undo: undo.map((p) => "value" in p ? { ...p, value: toJson(p.value) } : p) }
		} catch (e) {
			if (!(e instanceof Refused)) throw e
			out = { error: { code: e.code, patch: e.patch } }
		}
		const after = [form(value), ...patches.map((p) => form(isMap(p) ? p.value : undefined))]
		return (inPlace && !out.error) || same(after) ? out : { error: "a value given changed" }
	}
	let out: Record<string, unknown>
	let v: unknown
	try {
		v = apply(value, patches, { cow: !inPlace })
		out = v === undefined ? {} : { value: toJson(v) }
	} catch (e) {
		if (!(e instanceof ApplyError)) throw e
		out = { error: { code: e.code, patch: e.patch } }
	}
	const after = [form(value), ...patches.map((p) => form(isMap(p) ? p.value : undefined))]
	if (inPlace && !out.error) {
		if (
			!wholes && v !== undefined &&
			(Array.isArray(value) || isMap(value) && !ArrayBuffer.isView(value)) && v !== value
		) {
			return { error: "not the value given" }
		}
		return out
	}
	if (!same(after)) return { error: "a value given changed" }
	return out
}

if (import.meta.main) await serve(answer)
