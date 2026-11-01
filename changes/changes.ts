// ermine changes (changes/README)
import * as semver from "@std/semver"

type Level = "patch" | "minor" | "major"
const LEVELS: readonly Level[] = ["patch", "minor", "major"]

type Package = {
	readonly name: string
	readonly dir: URL
	readonly config: Record<string, unknown>
	readonly version: string
	readonly imports: ReadonlySet<string>
}

const here = new URL("./", import.meta.url)
const root = new URL("../", here)

const SKIP = new Set(["node_modules", "c", "dist", "target"])
const SCOPE = "@ermine/"
const short = (name: string): string => name.startsWith(SCOPE) ? name.slice(SCOPE.length) : name
const read = (url: URL): string => Deno.readTextFileSync(url)

const sources = (dir: URL): URL[] =>
	[...Deno.readDirSync(dir)]
		.filter((e) => !e.name.startsWith(".") && !SKIP.has(e.name))
		.flatMap((e) => {
			if (e.isDirectory) return sources(new URL(`${e.name}/`, dir))
			const code = e.name.endsWith(".ts") && !e.name.endsWith("_test.ts") &&
				!e.name.endsWith("_bench.ts")
			return code ? [new URL(e.name, dir)] : []
		})

// the package an import names: "@ermine/graph/node" gives graph; "@std/assert" none
// https://regex101.com/?flavor=javascript&flags=g&regex=%5B%22'%5D%40ermine%5C%2F(%5Ba-z0-9-%5D%2B)&testString=%22%40ermine%2Fgraph%2Fnode%22%0A%22%40std%2Fassert%22
const IMPORT = /["']@ermine\/([a-z0-9-]+)/g
const importsOf = (dir: URL): Set<string> =>
	new Set(sources(dir).flatMap((f) => [...read(f).matchAll(IMPORT)].map((m) => m[1])))

const workspace: string[] = JSON.parse(read(new URL("deno.json", root))).workspace
const packages: Package[] = workspace.map((path) => {
	const dir = new URL(`${path}/`, root)
	const config = JSON.parse(read(new URL("deno.json", dir)))
	return {
		name: short(config.name),
		dir,
		config,
		version: config.version,
		imports: importsOf(dir),
	}
})
const named = new Map(packages.map((p) => [p.name, p]))

const files = [...Deno.readDirSync(here)]
	.filter((e) => e.isFile && e.name.endsWith(".md"))
	.map((e) => e.name)
	.sort()

const OPEN = "---\n"
const CLOSE = "\n---\n"
const changes = files.map((file) => {
	const text = read(new URL(file, here))
	const end = text.indexOf(CLOSE, OPEN.length - 1)
	if (!text.startsWith(OPEN) || end < 0) throw new Error(`changes/${file}: no --- header`)
	const note = text.slice(end + CLOSE.length).trim()
	if (!note) throw new Error(`changes/${file}: says nothing`)
	const bumps = text.slice(OPEN.length, end).split("\n").filter((l) => l.trim()).map((line) => {
		const [key, value] = line.split(":").map((s) =>
			s.replaceAll('"', "").replaceAll("'", "").trim()
		)
		if (!named.has(short(key))) throw new Error(`changes/${file}: no package ${key}`)
		if (!LEVELS.includes(value as Level)) throw new Error(`changes/${file}: ${key}: ${value}`)
		return [short(key), value as Level] as const
	})
	return { note, bumps }
})

const higher = (a: Level | undefined, b: Level): Level =>
	a && LEVELS.indexOf(a) > LEVELS.indexOf(b) ? a : b

const asked = changes.flatMap((c) => c.bumps).reduce(
	(levels, [name, level]) => new Map([...levels, [name, higher(levels.get(name), level)]]),
	new Map<string, Level>(),
)

const nextOf = (p: Package, level: Level): string => {
	const v = semver.parse(p.version)
	return semver.format(semver.increment(v, v.prerelease?.length ? "prerelease" : level))
}

const leaves = (p: Package, levels: ReadonlyMap<string, Level>): boolean => {
	const level = levels.get(p.name)
	if (!level) return false
	return !semver.satisfies(semver.parse(nextOf(p, level)), semver.parseRange(`^${p.version}`))
}

// a package whose new version leaves ^old takes the packages importing it along, at patch
const spread = (levels: ReadonlyMap<string, Level>): ReadonlyMap<string, Level> => {
	const more = packages.filter((q) =>
		!levels.has(q.name) && packages.some((p) => q.imports.has(p.name) && leaves(p, levels))
	)
	if (!more.length) return levels
	return spread(new Map([...levels, ...more.map((q) => [q.name, "patch" as Level] as const)]))
}

const levels = spread(asked)

const release = packages.filter((p) => levels.has(p.name)).map((p) => ({
	...p,
	next: nextOf(p, levels.get(p.name)!),
	notes: [
		...changes.filter((c) => c.bumps.some(([name]) => name === p.name)).map((c) => c.note),
		...packages
			.filter((d) => d !== p && p.imports.has(d.name) && leaves(d, levels))
			.map((d) => `@ermine/${d.name} ${nextOf(d, levels.get(d.name)!)}`),
	],
}))

const entry = (next: string, notes: readonly string[]): string =>
	`## ${next}\n\n${notes.map((n) => `- ${n.replaceAll("\n", "\n  ")}`).join("\n")}\n`

release.forEach((p) => console.log(entry(`@ermine/${p.name} ${p.next}`, p.notes)))

const changelog = (p: (typeof release)[number]): string => {
	const url = new URL("CHANGELOG.md", p.dir)
	const old = (() => {
		try {
			return read(url)
		} catch (e) {
			if (e instanceof Deno.errors.NotFound) return `# @ermine/${p.name}\n`
			throw e
		}
	})()
	const cut = old.indexOf("\n## ")
	const head = cut < 0 ? old : old.slice(0, cut)
	const rest = cut < 0 ? "" : old.slice(cut + 1)
	return [head.trimEnd() + "\n", entry(p.next, p.notes), rest].filter(Boolean).join("\n")
}

if (Deno.args[0] === "version") {
	release.forEach((p) => {
		Deno.writeTextFileSync(
			new URL("deno.json", p.dir),
			JSON.stringify({ ...p.config, version: p.next }, null, "\t") + "\n",
		)
		Deno.writeTextFileSync(new URL("CHANGELOG.md", p.dir), changelog(p))
	})
	files.forEach((file) => Deno.removeSync(new URL(file, here)))
	const logs = release.map((p) => new URL("CHANGELOG.md", p.dir).pathname)
	const fmt = new Deno.Command("deno", { args: ["fmt", "--quiet", ...logs], stdout: "inherit" })
	if (logs.length && !(await fmt.output()).success) throw new Error("deno fmt failed")
} else if (Deno.args.length) {
	throw new Error("deno task changes [version]")
}
