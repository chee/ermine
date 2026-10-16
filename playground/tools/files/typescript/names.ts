// Names on disk (FILES.tex, Values and Names): extensions, stems, how a
// slot's name is written as a stem and how a person's name is read back, the
// key two stems compare by, names passed over, and a union's members' names.
// Pure: nothing here touches the disk.
//
// Extensions are compared as written: .text and .float32 are a cbor value's
// and a float32 array's, .DIAG and .Float32 are not.

import { type Form, type Kind, KINDS } from "./types.ts"

/** The names the files program passes over unless the host gives others. */
export const PASS: readonly string[] = [
	".DS_Store",
	".localized",
	"._*",
	"Icon\r",
	"*~",
	"*.swp",
	"#*#",
	"4913",
]

/** How many first bytes sniff looks at. */
export const HEAD = 12

/** What a stem takes, again and again, until it is free. */
const FINAL = ".FINAL"

/** The longest name a volume takes, in bytes of UTF-8. */
const MAX = 255

const isKind = (ext: string): ext is Kind => Object.hasOwn(KINDS, ext)

/**
 * A name's extension, without its dot: a dot that is not its first character,
 * then 1 to 8 ASCII letters and digits, but never FINAL, which comes before one.
 */
export function extension(name: string): string | undefined {
	const dot = name.lastIndexOf(".")
	if (dot < 1) return
	const ext = name.slice(dot + 1)
	return /^[A-Za-z0-9]{1,8}$/.test(ext) && `.${ext}` !== FINAL ? ext : undefined
}

/** Whether a value of the form may have the extension: diag only cbor, a kind only that kind, any other txt or bin. */
export function fits(ext: string, form: Form): boolean {
	if (form === "cbor") return ext === "text"
	if (form === "txt" || form === "bin") return ext !== "text" && !isKind(ext)
	return ext === form
}

/** Whether head starts with the bytes, at an offset. */
function at(head: Uint8Array, offset: number, bytes: readonly number[] | string): boolean {
	const want = typeof bytes === "string" ? [...bytes].map((c) => c.charCodeAt(0)) : bytes
	return want.every((b, i) => head[offset + i] === b)
}

/** A bin value's extension by how its bytes start: png, jpg, gif, pdf, webp, or bin. */
export function sniff(head: Uint8Array): string {
	if (at(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png"
	if (at(head, 0, [0xff, 0xd8, 0xff])) return "jpg"
	if (at(head, 0, "GIF87a") || at(head, 0, "GIF89a")) return "gif"
	if (at(head, 0, "%PDF-")) return "pdf"
	if (at(head, 0, "RIFF") && at(head, 8, "WEBP")) return "webp"
	return "bin"
}

/** The extension the store adds for a value of the form: txt, by sniff for bin, the kind, or diag. */
export function suffix(form: Form, head?: Uint8Array): string {
	if (form === "txt") return "txt"
	if (form === "bin") return sniff(head ?? new Uint8Array())
	if (form === "cbor") return "text"
	return form
}

/**
 * A slot's name split for a value of the form: the name less an extension
 * that fits, which is then not added, or the whole name and the extension the
 * store adds. Its file is stem + "." + ext. Given pass, a name that would be
 * passed over as it is keeps its extension in the stem, so that write wraps
 * it: foo.swp holding a string is _foo.swp_.txt, not foo.swp.
 */
export function split(
	name: string,
	form: Form,
	head?: Uint8Array,
	pass?: readonly string[],
): { stem: string; ext: string; added: boolean } {
	const ext = extension(name)
	if (ext !== undefined && fits(ext, form) && !(pass && passes(name, pass))) {
		return { stem: name.slice(0, -ext.length - 1), ext, added: false }
	}
	return { stem: name, ext: suffix(form, head), added: true }
}

const WRITTEN: Record<string, string> = { "/": ":", ":": "：", "\0": "�" }

/** A name written as a stem: / as :, : as U+FF1A, NUL as U+FFFD, "" as untitled, and _ at both ends of a name passed over. */
export function write(name: string, pass: readonly string[]): string {
	const stem = name === "" ? "untitled" : name.replace(/[/:\0]/g, (c) => WRITTEN[c])
	return passes(stem, pass) ? "_" + stem + "_" : stem
}

/** Bytes of UTF-8 a scalar value takes; a lone surrogate as U+FFFD's three. */
function utf8(c: number): number {
	return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
}

/** Bytes of UTF-8 a string takes. */
function size(s: string): number {
	let n = 0
	for (const c of s) n += utf8(c.codePointAt(0)!)
	return n
}

/**
 * A stem cut between scalar values so that it, ext, and five .FINALs fit in
 * 255 bytes of UTF-8, when it and ext are over 255. ext "" is none: a
 * folder's alone.
 */
export function cut(stem: string, ext: string): string {
	const dot = ext === "" ? 0 : 1 + size(ext)
	if (size(stem) + dot <= MAX) return stem
	let room = MAX - dot - 5 * FINAL.length
	let out = ""
	for (const c of stem) {
		room -= utf8(c.codePointAt(0)!)
		if (room < 0) break
		out += c
	}
	return out
}

/** The stem with .FINAL added until taken says it is free. . and .., which every folder has, are always taken. */
export function free(stem: string, taken: (stem: string) => boolean): string {
	let s = stem
	while (s === "." || s === ".." || taken(s)) s += FINAL
	return s
}

/** A name a person gave, read back: : as /, U+FF1A as :, anything else as itself. */
export function read(name: string): string {
	return name.replace(/[:：]/g, (c) => (c === ":" ? "/" : ":"))
}

/**
 * What two stems compare by: full case folding, then NFD. JavaScript has no
 * case folding; lower, upper and lower case again give the same classes as
 * Unicode's full folding on every scalar value, but for dotless ı, which has
 * no folding and which upper case would make I, so it is kept out of it.
 */
export function key(stem: string): string {
	const fold = (s: string) => s.toLowerCase().toUpperCase().toLowerCase()
	return stem.normalize("NFD").split("ı").map(fold).join("ı").normalize("NFD")
}

/** Whether a whole name matches a pattern, * standing for any run of characters. */
function matches(name: string, pattern: string): boolean {
	const parts = pattern.split("*")
	if (parts.length === 1) return name === pattern
	const first = parts[0], last = parts[parts.length - 1]
	const end = name.length - last.length
	if (end < first.length || !name.startsWith(first) || !name.endsWith(last)) return false
	let i = first.length
	for (const part of parts.slice(1, -1)) {
		const found = name.indexOf(part, i)
		if (found < 0 || found + part.length > end) return false
		i = found + part.length
	}
	return true
}

/** Whether a whole name matches one of the patterns, * standing for any run of characters. */
export function passes(name: string, pass: readonly string[]): boolean {
	return pass.some((pattern) => matches(name, pattern))
}

/** A union member's stem: its number, from 1, then a person's words, kept as they wrote them. */
export function member(n: number, words = ""): string {
	return String(n) + words
}

/** The number a member's stem starts with and the words after it; undefined if it has none. */
export function number(stem: string): [n: number, words: string] | undefined {
	const m = /^([0-9]+)([\s\S]*)$/.exec(stem)
	return m ? [Number(m[1]), m[2]] : undefined
}

/** What a new file's name gives: its slot, read back, less a .text or .kind extension, which gives its form. */
export function take(entry: string): { slot: string; form?: Form } {
	const slot = read(entry)
	const ext = extension(slot)
	if (ext === "text") return { slot: slot.slice(0, -5), form: "cbor" }
	if (ext !== undefined && isKind(ext)) return { slot: slot.slice(0, -ext.length - 1), form: ext }
	return { slot }
}

/**
 * The slot a renamed entry gives: a file's name read back, less ext if it
 * still ends in it, ext the extension the store added; a folder's name read
 * back, plus ext, the extension its slot's name had after its stem.
 */
export function renamed(entry: string, ext: string | undefined, folder: boolean): string {
	const name = read(entry)
	if (!ext) return name
	if (folder) return name + "." + ext
	return extension(name) === ext ? name.slice(0, -ext.length - 1) : name
}

/** An id as a URL path segment, percent-encoded, with . as %2E, for a link into .ermine/id/. */
export function percent(id: string): string {
	return encodeURIComponent(id).replaceAll(".", "%2E")
}

/** The id a segment of a link into .ermine/id/ names; a segment that does not decode names itself. */
export function unpercent(segment: string): string {
	try {
		return decodeURIComponent(segment)
	} catch {
		return segment
	}
}

/** Code point order: UTF-16's, but with surrogates after U+E000 to U+FFFF. */
export function byCodePoint(a: string, b: string): number {
	const n = Math.min(a.length, b.length)
	for (let i = 0; i < n; i++) {
		const x = a.charCodeAt(i), y = b.charCodeAt(i)
		if (x !== y) return point(x) - point(y)
	}
	return a.length - b.length
}

const point = (u: number) => u >= 0xe000 ? u - 0x800 : u >= 0xd800 ? u + 0x2000 : u
