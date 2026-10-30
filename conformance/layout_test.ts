// the packages, lowest first, and what each builds on: it may import its own files, these, and
// whatever these may (system builds on places, so what may import system may import places too).
// nothing else.
// a package's code (typescript/, c/: TS imports and C #includes, bare @ermine/... and relative)
// is checked. a test file (named *_test, *_bench, *harness*, *fixture*, *fuzz*, or under fuzz/)
// may also import conformance/, the shared harness code every package uses. code never imports
// conformance/ or experiments/; neither does anything import experiments/
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

// what p may import: its own list, and theirs, all the way down
const reachable = (p: string): Set<string> =>
	new Set((PACKAGES[p] ?? []).flatMap((d) => [d, ...reachable(d)]))
// in the order for its C files alone: not in the workspace
const C_ONLY: string[] = []

// a test's file name: "crow_test.ts", "places_harness.c", "manual_fixture.ts", "apply_fuzz.c"
// match; "crow.ts", "harnessed/x.ts" (the word in a folder, not the file) do not
const TEST_FILE = /(_test|_bench|harness|fixture|fuzz)[^/]*\.(ts|c|h)$/
const testOnly = (path: string) => TEST_FILE.test(path) || path.includes("/fuzz/")

// a file worth reading: "a.ts", "a.c", "a.h" match; "a.json", "a.tsx" do not
const SOURCE = /\.(ts|c|h)$/
const skipped = (name: string) =>
	name === "node_modules" || name.startsWith(".") || name.endsWith(".dSYM")

// every .ts, .c and .h under dir, as paths from the root
const files = (dir: string): string[] =>
	[...Deno.readDirSync(root + dir)].filter((e) => !skipped(e.name)).flatMap((e) => {
		if (e.isDirectory) return files(`${dir}/${e.name}`)
		return SOURCE.test(e.name) ? [`${dir}/${e.name}`] : []
	})

// a TS import or export and its specifier: `import x from "./a.ts"`, `export * from "@ermine/crow"`,
// `import("./b.ts")` match (the specifier in group 1 or 2); `const x = "./a.ts"` does not
const TS_IMPORT =
	/(?:^|[\s;}])(?:import|export)\b[^"'`;]*?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/gm
// a C include in quotes: `#include "../../changeable/c/value.h"` matches; `#include <stdio.h>` does not
const C_INCLUDE = /^\s*#\s*include\s+"([^"]+)"/gm

// what a file names: TS import and export specifiers, C #include paths
const specifiers = (path: string): string[] =>
	[...Deno.readTextFileSync(root + path).matchAll(path.endsWith(".ts") ? TS_IMPORT : C_INCLUDE)]
		.map((m) => m[1] ?? m[2])

// a bare ermine specifier and its package: "@ermine/places/header" matches (places); "@std/assert"
// does not
const BARE = /^@ermine\/([^/]+)/

// the top folder a specifier reaches from a file: a package, conformance, experiments, or
// undefined (npm:, jsr:, @std, a folder outside the repo)
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
	// "./places" becomes "places"
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
