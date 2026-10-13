// addresses as strings: "/notes/today" is ["/", "notes", "today"]. a string is split at each "/";
// a leading "/" is the root; empty pieces are skipped, as in unix ("a//b" is a, b). a name that
// holds a "/", or is "", needs the array form, or the tag: in path`/notes/${title}`, whatever is
// put in is always one name, never split
import type { Address } from "./places.ts"

// a string's steps
export function parse(s: string): string[] {
	const out: string[] = s.startsWith("/") ? ["/"] : []
	for (const piece of s.split("/")) if (piece !== "") out.push(piece)
	return out
}

// a string, or steps already, as steps
export const address = (a: string | Address): Address => typeof a === "string" ? parse(a) : a

// the tag: the literal parts split as parse does; each value put in, one name as it is
export function path(strings: TemplateStringsArray, ...names: unknown[]): string[] {
	const out: string[] = []
	for (let i = 0; i < strings.length; i++) {
		const steps = parse(strings[i])
		// a "/" leading a literal part that follows a name only separates
		if (i > 0 && steps[0] === "/") steps.shift()
		out.push(...steps)
		if (i < names.length) out.push(String(names[i]))
	}
	return out
}
