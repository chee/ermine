// Checks that each package imports only its own files and the packages below it.
import { assertEquals } from "@std/assert"

const PACKAGES: Record<string, readonly string[]> = {
	changeable: [],
	crow: ["changeable"],
	blake3: [],
	ed25519: [],
	graph: ["changeable"],
	protect: ["changeable", "graph"],
	reactivity: ["changeable"],
	places: ["changeable", "crow", "graph", "reactivity"],
	encoding: ["changeable"],
	processes: ["changeable", "graph", "protect", "reactivity", "places"],
	system: ["changeable", "graph", "protect", "reactivity", "places", "processes"],
	bundling: ["system"],
}

const root = new URL("../../", import.meta.url).pathname
const ORDER = Object.keys(PACKAGES)

const workspace: string[] = JSON.parse(Deno.readTextFileSync(root + "deno.json")).workspace
const DIRS = new Map(
	workspace.map((w) => w.slice("./".length)).filter((w) => !w.startsWith("experiments/"))
		.map((w) => [w.split("/").at(-1)!, w]),
)

const reachable = (p: string): Set<string> =>
	new Set((PACKAGES[p] ?? []).flatMap((d) => [d, ...reachable(d)]))
const C_ONLY: string[] = []

const TEST_FILE = /(_test|_bench|harness|fixture|fuzz)[^/]*\.(ts|c|h)$/
const testOnly = (path: string) => TEST_FILE.test(path) || path.includes("/fuzz/")

const SOURCE = /\.(ts|c|h)$/
const skipped = (name: string) =>
	name === "node_modules" || name.startsWith(".") || name.endsWith(".dSYM")

const files = (dir: string): string[] =>
	[...Deno.readDirSync(root + dir)].filter((e) => !skipped(e.name)).flatMap((e) => {
		if (e.isDirectory) return files(`${dir}/${e.name}`)
		return SOURCE.test(e.name) ? [`${dir}/${e.name}`] : []
	})

const TS_IMPORT =
	/(?:^|[\s;}])(?:import|export)\b[^"'`;]*?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/gm
const C_INCLUDE = /^\s*#\s*include\s+"([^"]+)"/gm

const specifiers = (path: string): string[] =>
	[...Deno.readTextFileSync(root + path).matchAll(path.endsWith(".ts") ? TS_IMPORT : C_INCLUDE)]
		.map((m) => m[1] ?? m[2])

const BARE = /^@ermine\/([^/]+)/

function reaches(from: string, spec: string): string | undefined {
	const bare = BARE.exec(spec)
	if (bare) return bare[1]
	if (!spec.startsWith(".")) return undefined
	const step = (at: string[], s: string) => {
		if (s === "..") return at.slice(0, -1)
		return s === "." ? at : [...at, s]
	}
	const at = spec.split("/").reduce(step, from.split("/").slice(0, -1)).join("/") + "/"
	if (at.startsWith("meta/conformance/")) return "conformance"
	return [...DIRS].find(([, dir]) => at.startsWith(`${dir}/`))?.[0] ?? at.split("/")[0]
}

Deno.test("layout: every workspace package is in the order, and only those", () => {
	assertEquals([...DIRS.keys()].toSorted(), ORDER.filter((p) => !C_ONLY.includes(p)).toSorted())
})

Deno.test("layout: lib/ imports nothing outside lib/", () => {
	const lib = [...DIRS].filter(([, dir]) => dir.startsWith("lib/")).map(([p]) => p)
	const wrong = lib.flatMap((p) =>
		PACKAGES[p].filter((d) => !lib.includes(d)).map((d) => `${p} -> ${d}`)
	)
	assertEquals(wrong, [])
})

Deno.test("layout: a package may import only packages before it", () => {
	const wrong = Object.entries(PACKAGES).flatMap(([p, deps]) =>
		deps.filter((d) => ORDER.indexOf(d) >= ORDER.indexOf(p)).map((d) => `${p} -> ${d}`)
	)
	assertEquals(wrong, [])
})

Deno.test("layout: a package's files import only itself and what they may", () => {
	const wrong = Object.keys(PACKAGES).flatMap((p) => {
		const may = reachable(p)
		return files(DIRS.get(p)!).flatMap((f) =>
			specifiers(f).filter((spec) => {
				const to = reaches(f, spec)
				if (to === "conformance" && testOnly(f)) return false
				return to !== undefined && to !== p && !may.has(to)
			}).map((spec) => `${f}: ${spec} (${reaches(f, spec)})`)
		)
	})
	assertEquals(wrong, [])
})
