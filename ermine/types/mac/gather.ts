// the type lists, gathered from what macs declare:
//   swift ermine/types/mac/scan.swift > one.json          (on each mac)
//   deno run -A ermine/types/mac/gather.ts one.json two.json ...
//
// writes
//   ../typescript/utis.json       the list installTypes installs: every type Apple's documentation
//                                 names (the UTType constants), every public.* type a mac declares,
//                                 wanted.json's, not-on-a-mac.json's; and what each conforms to,
//                                 followed
//   ../typescript/constants.json  the documented constants, { jpeg: "public.jpeg", ... }
//   everything.json               every type the macs declare, imported by nothing
//
// a type declared more than once: CoreTypes.bundle's first, then another system bundle's, then an
// exporter's (its owner) before an importer's, then the first scan given, then the path's order
// a type in not-on-a-mac.json is left out when a declared type in the list claims one of its
// extensions (one name per thing)
// the constants: Apple's documentation page's names, each asked of this mac's UTType (swift), which
// needs a mac with the SDK
import type { Known } from "../typescript/types.ts"

type Declared = { kind: "exported" | "imported"; from: string; decl: Record<string, unknown> }
type Scan = Record<string, Declared[]>

const DOC =
	"https://developer.apple.com/tutorials/data/documentation/uniformtypeidentifiers/system-declared-uniform-type-identifiers.json"

const here = (path: string) => new URL(path, import.meta.url)

const strings = (v: unknown): string[] =>
	typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((s) => typeof s === "string") : []

// lower is first
const rank = (d: Declared) =>
	(d.from.startsWith("/System/Library/CoreServices/CoreTypes.bundle/")
		? 0
		: d.from.startsWith("/System/")
		? 2
		: 4) +
	(d.kind === "exported" ? 0 : 1)

if (Deno.args.length === 0) {
	console.error("gather.ts: give it the scans (swift scan.swift > mac.json)")
	Deno.exit(1)
}

// every declaration, the scans' order kept for ties
const all = new Map<string, Declared[]>()
for (const file of Deno.args) {
	const scan: Scan = JSON.parse(Deno.readTextFileSync(file))
	for (const [id, list] of Object.entries(scan)) all.set(id, [...all.get(id) ?? [], ...list])
}

// tags a type's declarations give that it is not to claim: markdown's "text" is plain text's
const NOT: Record<string, readonly string[]> = { "net.daringfireball.markdown": ["text"] }

// a declaration as a list entry: the first's, with every declaration's tags, the first's first (as
// each that knows the type says), less NOT's
function known(id: string): Known {
	const ds = [...all.get(id)!].sort((a, b) => rank(a) - rank(b))
	const d = ds[0].decl
	const not = new Set((NOT[id] ?? []).map((x) => x.toLowerCase()))
	const tag = (name: string) => {
		const seen = new Map<string, string>()
		for (const x of ds) {
			const tags = (x.decl.UTTypeTagSpecification ?? {}) as Record<string, unknown>
			for (const v of strings(tags[name])) {
				const key = v.toLowerCase()
				if (!seen.has(key) && !not.has(key)) seen.set(key, v)
			}
		}
		return [...seen.values()]
	}
	const t: { -readonly [K in keyof Known]: Known[K] } = { identifier: id }
	const conformsTo = strings(d.UTTypeConformsTo)
	const filenameExtension = tag("public.filename-extension")
	const mimeType = tag("public.mime-type")
	if (conformsTo.length) t.conformsTo = conformsTo
	if (filenameExtension.length) t.filenameExtension = filenameExtension
	if (mimeType.length) t.mimeType = mimeType
	const url = ds.map((x) => x.decl.UTTypeReferenceURL).find((u) => typeof u === "string")
	if (typeof url === "string") t.referenceURL = url
	if (typeof d.UTTypeVersion === "number") t.version = d.UTTypeVersion
	return t
}

// the documented constants, by asking UTType
async function constants(): Promise<Record<string, string>> {
	const page = await (await fetch(DOC)).json()
	const names: string[] = []
	for (const section of page.topicSections) {
		if (section.title === "Tag classes") continue
		for (const ref of section.identifiers) names.push(page.references[ref].title)
	}
	const swift = [
		"import UniformTypeIdentifiers",
		"import ShazamKit",
		...names.map((n) => `print("${n}", UTType.${n}.identifier)`),
	].join("\n")
	const file = await Deno.makeTempFile({ suffix: ".swift" })
	await Deno.writeTextFile(file, swift)
	const run = await new Deno.Command("swift", { args: [file], stderr: "inherit" }).output()
	await Deno.remove(file)
	if (!run.success) throw new Error("gather.ts: swift could not ask UTType")
	const out: Record<string, string> = {}
	for (const line of new TextDecoder().decode(run.stdout).trim().split("\n")) {
		const [name, id] = line.split(" ")
		out[name] = id
	}
	return out
}

const constant = await constants()
// types no doc page names and no public.* prefix brings, wanted in the list; types no mac declares
const also: string[] = JSON.parse(Deno.readTextFileSync(here("./wanted.json")))
const others: Known[] = JSON.parse(Deno.readTextFileSync(here("./not-on-a-mac.json")))

// the list: what's wanted, then what it conforms to. a type of not-on-a-mac.json with a declared twin
// (a type in the list claiming one of its extensions) is left out, and what conformed to it conforms
// to the twin
const list = new Map<string, Known>()
const twin = new Map<string, string>()
function follow(wanted: string[]) {
	for (let i = 0; i < wanted.length; i++) {
		const id = twin.get(wanted[i]) ?? wanted[i]
		if (list.has(id)) continue
		if (!all.has(id)) throw new Error(`gather.ts: no mac declares ${id}`)
		const t = known(id)
		list.set(id, t)
		wanted.push(...strings(t.conformsTo).filter((up) => all.has(up)))
	}
}
follow([
	...Object.values(constant),
	...[...all.keys()].filter((id) => id.startsWith("public.")),
	...also,
])
const claims = new Map<string, string>()
for (const t of list.values()) {
	for (const e of strings(t.filenameExtension)) claims.set(e.toLowerCase(), t.identifier)
}
const kept: Known[] = []
for (const t of others) {
	const by = strings(t.filenameExtension).map((e) => claims.get(e.toLowerCase())).find((x) => x)
	if (by !== undefined) twin.set(t.identifier, by)
	else kept.push(t)
}
for (const t of kept) {
	const conformsTo = strings(t.conformsTo).map((up) => twin.get(up) ?? up)
	list.set(t.identifier, conformsTo.length ? { ...t, conformsTo } : t)
	follow(conformsTo)
}
const dropped = [...twin].map(([from, to]) => `${from} (${to})`)
const missing = [...list.values()].flatMap((t) => strings(t.conformsTo)).filter((up) =>
	!list.has(up)
)
if (missing.length) {
	throw new Error(`gather.ts: conformed to, not in the list: ${[...new Set(missing)].join(", ")}`)
}

const byId = (a: Known, b: Known) =>
	a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0
const write = (url: URL, v: unknown) =>
	Deno.writeTextFileSync(url, JSON.stringify(v, null, "\t") + "\n")
write(here("../typescript/utis.json"), [...list.values()].sort(byId))
write(here("../typescript/constants.json"), constant)
write(here("./everything.json"), [...all.keys()].map(known).sort(byId))
console.error(
	`utis.json ${list.size}, constants ${Object.keys(constant).length}, everything ${all.size}; ` +
		`not-on-a-mac dropped for a declared twin: ${dropped.join(", ") || "none"}`,
)
