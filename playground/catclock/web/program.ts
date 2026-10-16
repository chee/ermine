// program.ts: a C program as clang's build takes it, and its key in the cache.
//
// A C program is more than its node: catclock.c #includes the headers beside it. start hands
// compile the program's value alone, so the host makes that its unit first: { main, files }, every
// file in the program's folder, each blanked: a comment turned to spaces, and the spaces ending a
// line gone. A comment over several lines keeps its newlines, each with a \ before it (so a
// directive goes on past it, as it did), its first line ending " \", the lines inside it "\".
// Lines and columns stay where they were, so clang's errors land where you typed; and a comment
// edited in place, or an edit undone, is the same unit: the same key, a cache hit. A line added
// is not.
import { hash } from "@ermine/encoding/hash"
import type { Value } from "@ermine/encoding/cbor"

export type Unit = { main: string; files: Record<string, string> }

// C with its comments blanked, lines and columns kept; strings and characters as written
export function blank(c: string): string {
	let out = ""
	for (let i = 0; i < c.length; i++) {
		const ch = c[i]
		if (ch === '"' || ch === "'") {
			let j = i + 1
			while (j < c.length && c[j] !== ch && c[j] !== "\n") j += c[j] === "\\" ? 2 : 1
			out += c.slice(i, j + 1)
			i = j
		} else if (ch === "/" && c[i + 1] === "/") {
			// to the end of the line, and the next while a \ ends this one
			let j = i
			while (j < c.length && !(c[j] === "\n" && c[j - 1] !== "\\")) j++
			out += c.slice(i, j).replace(/[^\n]/g, " ")
			i = j - 1
		} else if (ch === "/" && c[i + 1] === "*") {
			const end = c.indexOf("*/", i + 2)
			const lines = c.slice(i, end < 0 ? c.length : end + 2).split("\n")
			// one line: as long as it was. more: " \", "\" inside, the last as long as it was
			out += lines.length === 1
				? " ".repeat(lines[0].length)
				: [" \\", ...lines.slice(1, -1).map(() => "\\"), " ".repeat(lines.at(-1)!.length)]
					.join("\n")
			i = end < 0 ? c.length : end + 1
		} else out += ch
	}
	// the spaces ending each line (never before a \: int \ then x is not intx)
	return out.replace(/[ \t]+$/gm, "")
}

// the unit: main, and every file blanked
export const unit = (main: string, files: Record<string, string>): Unit => ({
	main,
	files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, blank(text)])),
})

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

// a build's key, as build.ts makes it: hex of hash([identity, input]) (@ermine/encoding's)
export const keyOf = (identity: unknown, input: unknown) => hex(hash([identity, input] as Value))

// an object's hash, by its bytes: hashed once each (8.7 MB, the cat's: its zeroed buffers)
const digests = new WeakMap<Uint8Array, string>()
export function digest(b: Uint8Array): string {
	let h = digests.get(b)
	if (h === undefined) digests.set(b, h = hex(hash(b)))
	return h
}

// a hash, short enough to read: #3fa9c2d
export const short = (h: string | undefined) => (h ? "#" + h.slice(0, 7) : "")
