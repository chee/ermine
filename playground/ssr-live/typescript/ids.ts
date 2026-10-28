// short ids, for this demo's html: each ermine makes a node's id as its own key and a count
// ("3fa9c2e1-1c") in place of a uuidv7. LLM generated: a prototype. createNode draws a node's name
// as it draws its id, so a list's row names (a page's keys and paths) are short too. ids made by
// many ermines (a tippet room's pages and server, the edge's requests) are kept apart by their
// keys: random, KEY_BYTES each, so two of 10,000 ermines share one about once in a hundred
//   createErmine({ features: [shortIds()], host })
//   newVisitor()   a visitor's name, as short: a key alone
import type { Feature } from "@ermine/system"

const KEY_BYTES = 4
// a count's base: digits and letters
const BASE = 36
// a byte as hex: two digits
const HEX = 16
const DIGITS = 2

const hex = (bytes: Uint8Array) =>
	[...bytes].map((b) => b.toString(HEX).padStart(DIGITS, "0")).join("")
export const newKey = () => hex(crypto.getRandomValues(new Uint8Array(KEY_BYTES)))
export const newVisitor = newKey

// a node's id (and a new node's name): the key, then how many came before; a process's as ermine
// makes it
export function shortIds(key = newKey()): Feature {
	let made = 0
	return {
		name: "short-ids",
		files: [import.meta.url],
		setup(f) {
			f.onId((kind, next) => kind === "node" ? `${key}-${(made++).toString(BASE)}` : next(kind))
		},
	}
}
