// The reference apply (core/op/typescript/apply.ts) on the line protocol: one JSON request per line
// in, one answer per line out, in order. Nothing lasts between lines. Another implementation joins
// by speaking this (OP_APPLY_HARNESS). A first argument: another module's apply to test instead
// (core/op/typescript/optim/*.ts).
//
// { op: "apply", value?, patches, list? }
//    value: the value the patches are applied to; absent: nothing there
//    patches: a list, each as apply.ts has them (anything else in it: not-a-patch)
//    list: true or absent
//    → { value? }                  the value after them; absent: nothing there
//    → { error: { code, patch } }  an ApplyError: its code and the patch's index
//
// { op: "invert", value?, patches, list? }
//    the undo of the patches on value (invert.ts); value, patches, list as apply's
//    → { undo }                    the undo's patches, in the order to apply them, a value in
//                                  them in the JSON form
//    → { error: { code, patch } }  an ApplyError: its code and the patch's index
//
// Values (the request's, a patch's, the answer's) in ENCODING.tex's JSON form, as
// conformance/pack/form.ts and json.c write them: bytes {"/": {"bytes": b64}}, a typed array
// {"/": {kind: [elements]}} (int8 int16 uint16 int32 uint32 int64 uint64 float32 float64; 64-bit
// as decimal strings, a float's NaN and infinities as words), a stand-in {"/": {"live": kind}},
// NaN and the infinities {"/": {"number": word}}, a map whose one key is "/" as
// {"/": {"map": {"/": x}}}; -0 written -0. Unlike ENCODING.tex, a string may hold lone
// surrogates (\udxxx): apply counts each as a position.
//
// Checked here, for every implementation: the value given and the patches' values are unchanged
// after the call (an invert's too). Anything not understood, or that broken: { error: why }, a
// string.
import { ApplyError as Refused, type Patch } from "@ermine/op/apply"
import invert from "@ermine/op/invert"
import { Stand } from "@ermine/encoding/cbor"
import { fromJson, line, toJson } from "../pack/form.ts"

// the apply to test: @ermine/op/apply, or a module given as the first argument (a path from the
// working directory), such as core/op/typescript/optim/final.ts
const { default: apply, ApplyError } =
	(Deno.args[0] === undefined ? await import("@ermine/op/apply") : await import(
		new URL(Deno.args[0], `file://${Deno.cwd()}/`).href
	)) as typeof import("@ermine/op/apply")

// deno-lint-ignore no-explicit-any
type Request = Record<string, any>

const isMap = (x: unknown): x is Record<string, unknown> =>
	x !== null && typeof x === "object" && !Array.isArray(x)
const isSlash = (x: unknown): x is { "/": unknown } =>
	isMap(x) && Object.keys(x).length === 1 && Object.hasOwn(x, "/")

// a value from its JSON form; a string may hold lone surrogates, which fromJson refuses
function revive(x: unknown): unknown {
	if (Array.isArray(x)) return x.map(revive)
	if (!isMap(x)) return x
	if (isSlash(x)) {
		const form = x["/"]
		if (isMap(form) && Object.keys(form).length === 1) {
			if (Object.hasOwn(form, "map") && isSlash(form.map)) return { "/": revive(form.map["/"]) }
			if (Object.hasOwn(form, "live")) return new Stand(revive(form.live) as never)
		}
		return fromJson(x)
	}
	const out: Record<string, unknown> = {}
	for (const k of Object.keys(x)) {
		Object.defineProperty(out, k, {
			value: revive(x[k]),
			enumerable: true,
			writable: true,
			configurable: true,
		})
	}
	return out
}
const form = (v: unknown) => line(toJson(v))

function answer(r: Request): unknown {
	if (!isMap(r) || (r.op !== "apply" && r.op !== "invert")) {
		return { error: `unknown op ${isMap(r) ? r.op : r}` }
	}
	if (!Array.isArray(r.patches)) return { error: "patches: not a list" }
	const value = Object.hasOwn(r, "value") ? revive(r.value) : undefined
	const patches = r.patches.map((p: unknown) =>
		isMap(p) && Object.hasOwn(p, "value") ? { ...p, value: revive(p.value) } : p
	) as Patch[]
	const before = [form(value), ...patches.map((p) => form(isMap(p) ? p.value : undefined))]
	if (r.op === "invert") {
		let out: unknown
		try {
			const undo = invert(value, patches, { list: r.list === true })
			out = { undo: undo.map((p) => "value" in p ? { ...p, value: toJson(p.value) } : p) }
		} catch (e) {
			if (!(e instanceof Refused)) throw e
			out = { error: { code: e.code, patch: e.patch } }
		}
		const after = [form(value), ...patches.map((p) => form(isMap(p) ? p.value : undefined))]
		return after.some((a, i) => a !== before[i]) ? { error: "a value given changed" } : out
	}
	let out: Record<string, unknown>
	try {
		const v = apply(value, patches, { list: r.list === true })
		out = v === undefined ? {} : { value: toJson(v) }
	} catch (e) {
		if (!(e instanceof ApplyError)) throw e
		out = { error: { code: e.code, patch: e.patch } }
	}
	const after = [form(value), ...patches.map((p) => form(isMap(p) ? p.value : undefined))]
	if (after.some((a, i) => a !== before[i])) return { error: "a value given changed" }
	return out
}

function safe(text: string): string {
	try {
		return line(answer(JSON.parse(text)))
	} catch (e) {
		return JSON.stringify({ error: String(e) })
	}
}

const out = Deno.stdout.writable.getWriter()
const encoder = new TextEncoder()
let buffer = ""
for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
	buffer += chunk
	let i
	let text = ""
	while ((i = buffer.indexOf("\n")) !== -1) {
		const l = buffer.slice(0, i)
		buffer = buffer.slice(i + 1)
		if (l.trim() === "") continue
		text += safe(l) + "\n"
	}
	if (text) await out.write(encoder.encode(text))
}
