// Checks that each package imports only its own files and the packages below it.
import { assertEquals } from "@std/assert"

const PACKAGES: Record<string, readonly string[]> = {
	changeable: [],
	crow: ["changeable"],
	graph: ["changeable"],
	protect: ["changeable", "graph"],
	reactivity: ["changeable"],
	places: ["changeable", "crow", "graph", "reactivity"],
	encoding: ["changeable"],
	ids: ["encoding"],
	processes: ["changeable", "graph", "protect", "reactivity", "places"],
	system: ["changeable", "graph", "protect", "reactivity", "places", "processes"],
	bundling: ["system"],
}

const root = new URL("../", import.meta.url).pathname
const ORDER = Object.keys(PACKAGES)

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
	return spec.split("/").reduce(step, from.split("/").slice(0, -1))[0]
}

Deno.test("layout: every workspace package is in the order, and only those", () => {
	const workspace: string[] = JSON.parse(Deno.readTextFileSync(root + "deno.json")).workspace
	const packages = workspace.map((w) => w.replace(/^\.\//, "")).filter((w) =>
		!w.startsWith("experiments/")
	)
	assertEquals(packages.toSorted(), ORDER.filter((p) => !C_ONLY.includes(p)).toSorted())
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
		return files(p).flatMap((f) =>
			specifiers(f).filter((spec) => {
				const to = reaches(f, spec)
				if (to === "conformance" && testOnly(f)) return false
				return to !== undefined && to !== p && !may.has(to)
			}).map((spec) => `${f}: ${spec} (${reaches(f, spec)})`)
		)
	})
	assertEquals(wrong, [])
})
