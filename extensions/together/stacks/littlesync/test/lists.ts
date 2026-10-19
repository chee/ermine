// littlesync's lists against lists.ts (extensions/together/typescript/lists.ts) on the same commits:
// each line of build/lists.jsonl (test/test.c writes it) is a case, the commits seen on the wire and what
// each device holds at each path asked. exact: the same items, in the same order (names, gone, inside,
// at, values). else (a device without history, CONFLICTS.tex small devices): never less, every item
// lists.ts has the device has too. deno run --allow-read test/lists.ts build/lists.jsonl
import { createHistory } from "../../../typescript/history.ts"
import { createLists, type Item } from "../../../typescript/lists.ts"
import { hex, unhex } from "../../../typescript/hex.ts"

type CItem = {
	name: string
	gone: boolean
	far: boolean
	inside: boolean
	at: number
	value?: unknown
}
type Case = {
	label: string
	exact: boolean
	commits: string[]
	devices: { path: string[]; items: CItem[] }[][]
}

// values compared as data: maps by their entries, whatever the key order
const same = (a: unknown, b: unknown): boolean => {
	if (a === b) return true
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
	if (Array.isArray(a) !== Array.isArray(b)) return false
	const ka = Object.keys(a), kb = Object.keys(b)
	return ka.length === kb.length &&
		ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

const text = Deno.readTextFileSync(Deno.args[0] ?? "build/lists.jsonl")
let cases = 0, failed = 0, more = 0
for (const line of text.split("\n").filter((l) => l.trim())) {
	const c: Case = JSON.parse(line)
	cases++
	const history = createHistory()
	for (const b of c.commits) history.add(unhex(b))
	const waiting = history.waiting().length
	const lists = createLists(history, () => ({}))
	for (const k of history.all()) lists.add(k)
	const bad: string[] = []
	if (waiting) bad.push(`${waiting} commits wait on a parent never on the wire`)
	if (history.refused().length) bad.push(`refused: ${JSON.stringify(history.refused())}`)
	c.devices.forEach((paths, d) => {
		for (const { path, items } of paths) {
			const ts = lists.items(["value", ...path]).map((i: Item) => ({
				name: hex(i.write.kept.name),
				gone: !!i.gone,
				inside: !!i.inside,
				at: i.at === undefined ? path.length : i.at.length - 1,
				value: i.value,
			}))
			const where = `device ${d} /${path.join("/")}`
			const show = () =>
				`\n    ts ${
					JSON.stringify(ts.map((i) => [i.name.slice(4, 12), i.gone, i.inside, i.at, i.value]))
				}` +
				`\n    c  ${
					JSON.stringify(
						items.map((i) => [i.name.slice(4, 12), i.gone, i.inside, i.at, i.value]),
					)
				}`
			const less = ts.filter((t) => !items.some((i) => i.name === t.name))
			if (less.length) bad.push(`${where}: lists.ts has an item the device lacks${show()}`)
			else if (c.exact) {
				const ok = ts.length === items.length &&
					ts.every((t, i) =>
						t.name === items[i].name && t.gone === items[i].gone &&
						t.inside === items[i].inside &&
						t.at === items[i].at && (items[i].far || t.gone || same(t.value, items[i].value))
					)
				if (!ok) bad.push(`${where}: not the same${show()}`)
			} else if (items.length > ts.length) {
				more++
				if (Deno.args.includes("--show")) console.log(c.label, where, show())
			}
		}
	})
	if (bad.length) {
		failed++
		console.log(`  FAIL lists ${c.label}:\n    ${bad.join("\n    ")}`)
	}
}
console.log(
	`lists against lists.ts: ${cases} cases, ${failed} failed (${more} paths where a device shows more)`,
)
if (failed) Deno.exit(1)
