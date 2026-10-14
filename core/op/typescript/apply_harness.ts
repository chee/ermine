// apply (apply.ts) and invert (invert.ts) on the line protocol (conformance/typescript/harness.ts).
// Nothing lasts between lines. Another implementation joins by speaking this (HARNESS). A first
// argument: another module's apply to test instead (core/op/typescript/optim/*.ts). The suites
// apply and invert are both asked of it.
//
// { op: "apply", value?, patches, cow? }
//    value: the value the patches are applied to; absent: nothing there
//    patches: a list, each as apply.ts has them (anything else in it: not-a-patch)
//    cow: false: the patches change the value in place (apply's cow option). The answer is the
//    same as without it
//    → { value? }                  the value after them; absent: nothing there
//    → { error: { code, patch } }  an ApplyError: its code and the patch's index
//
// { op: "invert", value?, patches, cow? }
//    the undo of the patches on value (invert.ts); value, patches, cow as apply's. With
//    cow: false the undo is the one apply builds changing the value in place: the same undo
//    → { undo }                    the undo's patches, in the order to apply them, a value in
//                                  them in the JSON form
//    → { error: { code, patch } }  an ApplyError: its code and the patch's index
//
// Values (the request's, a patch's, the answer's) in ENCODING.tex's JSON form
// (conformance/typescript/form.ts). Unlike ENCODING.tex, a string may hold lone surrogates
// (\udxxx): apply counts each as a position.
//
// Checked here, for every implementation: the value given and the patches' values are unchanged
// after the call (an invert's too). With cow: false instead: a refused call leaves the value and
// the patches' values as they were (by content, a key put back going last); a good one answers the
// value given itself, when that is a list or a map and no patch has the whole for a place.
// Anything not understood, or that broken: { error: why }, a string.
import { ApplyError as Refused, type Patch } from "@ermine/op/apply"
import invert from "@ermine/op/invert"
import { line, revive, toJson } from "../../../conformance/typescript/form.ts"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"

// the apply to test: @ermine/op/apply, or a module given as the first argument (a path from the
// working directory), such as core/op/typescript/optim/final.ts
const { default: apply, ApplyError } =
	(Deno.args[0] === undefined ? await import("@ermine/op/apply") : await import(
		new URL(Deno.args[0], `file://${Deno.cwd()}/`).href
	)) as typeof import("@ermine/op/apply")

const isMap = (x: unknown): x is Record<string, unknown> =>
	x !== null && typeof x === "object" && !Array.isArray(x)

const whole = (v: unknown) => line(toJson(v))
// by content: a key put back by an undo goes last in its order
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
