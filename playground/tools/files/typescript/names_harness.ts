// names (names.ts) on the line protocol (conformance/typescript/harness.ts). Nothing lasts between
// lines. Bytes (a head) are lowercase hex; a missing answer is null; a function that throws
// answers {error}.
//   {op: "extension", name}                    -> {result: ext | null}
//   {op: "fits", ext, form}                    -> {result: bool}
//   {op: "sniff", head}                        -> {result}
//   {op: "suffix", form, head?}                -> {result}
//   {op: "split", name, form, head?, pass?}    -> {result: {stem, ext, added}}
//   {op: "write", name, pass}                  -> {result}
//   {op: "cut", stem, ext}                     -> {result}
//   {op: "free", stem, taken: [stem]}          -> {result}   (taken: the stems the predicate says are taken)
//   {op: "read", name}                         -> {result}
//   {op: "key", stem}                          -> {result}
//   {op: "passes", name, pass}                 -> {result: bool}
//   {op: "member", n, words?}                  -> {result}
//   {op: "number", stem}                       -> {result: [n, words] | null}
//   {op: "take", entry}                        -> {result: {slot, form?}}
//   {op: "renamed", entry, ext?, folder}       -> {result}
//   {op: "percent", id}                        -> {result} | {error}
//   {op: "unpercent", segment}                 -> {result}
//   {op: "bycodepoint", a, b}                  -> {result: -1 | 0 | 1}
// Another implementation joins by speaking this (HARNESS).
import * as names from "./names.ts"
import type { Form } from "./types.ts"
import { type Answer, type Request, serve } from "../../../conformance/typescript/harness.ts"

const unhex = (s: unknown) =>
	Uint8Array.from(typeof s === "string" ? s.match(/../g) ?? [] : [], (x) => parseInt(x, 16))

function run(r: Request): unknown {
	const name = r.name as string, form = r.form as Form
	switch (r.op) {
		case "extension":
			return names.extension(name) ?? null
		case "fits":
			return names.fits(r.ext as string, form)
		case "sniff":
			return names.sniff(unhex(r.head))
		case "suffix":
			return names.suffix(form, r.head === undefined ? undefined : unhex(r.head))
		case "split":
			return names.split(
				name,
				form,
				r.head === undefined ? undefined : unhex(r.head),
				r.pass as string[] | undefined,
			)
		case "write":
			return names.write(name, r.pass as string[])
		case "cut":
			return names.cut(r.stem as string, r.ext as string)
		case "free": {
			const taken = new Set(r.taken as string[])
			return names.free(r.stem as string, (s) => taken.has(s))
		}
		case "read":
			return names.read(name)
		case "key":
			return names.key(r.stem as string)
		case "passes":
			return names.passes(name, r.pass as string[])
		case "member":
			return names.member(r.n as number, r.words as string | undefined)
		case "number":
			return names.number(r.stem as string) ?? null
		case "take":
			return names.take(r.entry as string)
		case "renamed":
			return names.renamed(r.entry as string, r.ext as string | undefined, r.folder as boolean)
		case "percent":
			return names.percent(r.id as string)
		case "unpercent":
			return names.unpercent(r.segment as string)
		case "bycodepoint":
			return Math.sign(names.byCodePoint(r.a as string, r.b as string))
		default:
			throw new Error(`unknown op ${r.op}`)
	}
}

function answer(r: Request): Answer {
	try {
		return { result: run(r) }
	} catch (e) {
		if (e instanceof URIError) return { error: "URI malformed" }
		return { error: String((e as Error).message ?? e) }
	}
}

if (import.meta.main) await serve(answer)
