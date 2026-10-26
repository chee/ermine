// the designs, by letter: each an adapter (adapter.ts) and a cheat sheet (sheet.md) in its folder.
// another design: a folder with both, and a line here
import type { Adapter } from "../lib/trial.ts"
import a from "./a/adapter.ts"
import b from "./b/adapter.ts"
import c from "./c/adapter.ts"
import d from "./d/adapter.ts"
import e from "./e/adapter.ts"
import f from "./f/adapter.ts"
import g from "./g/adapter.ts"
import g2 from "./g2/adapter.ts"
import g3 from "./g3/adapter.ts"
import h from "./h/adapter.ts"
import i from "./i/adapter.ts"
import j from "./j/adapter.ts"
import k from "./k/adapter.ts"
import l from "./l/adapter.ts"

export type Design = { key: string; name: string; adapter: Adapter; sheet: URL }

const sheet = (key: string) => new URL(`./${key}/sheet.md`, import.meta.url)

export const designs: Design[] = [
	{ key: "a", name: "words", adapter: a, sheet: sheet("a") },
	{ key: "b", name: "call", adapter: b, sheet: sheet("b") },
	{ key: "c", name: "hooks", adapter: c, sheet: sheet("c") },
	{ key: "d", name: "methods", adapter: d, sheet: sheet("d") },
	{ key: "e", name: "explicit-e", adapter: e, sheet: sheet("e") },
	{ key: "f", name: "me", adapter: f, sheet: sheet("f") },
	{ key: "g", name: "invented", adapter: g, sheet: sheet("g") },
	{ key: "g2", name: "update", adapter: g2, sheet: sheet("g2") },
	{ key: "g3", name: "produce", adapter: g3, sheet: sheet("g3") },
	{ key: "h", name: "call-global", adapter: h, sheet: sheet("h") },
	{ key: "i", name: "call-verbs", adapter: i, sheet: sheet("i") },
	{ key: "j", name: "smallest", adapter: j, sheet: sheet("j") },
	{ key: "k", name: "solid", adapter: k, sheet: sheet("k") },
	{ key: "l", name: "imported", adapter: l, sheet: sheet("l") },
]

export const design = (k: string) => designs.find((d) => d.key === k || d.name === k)
