// lookup: patchwork's fallback tool (getFallbackTool) as a library, out of the core. a plugin's
// descriptor is its program node's attributes (patchwork.plugins: the module's plugins, each
// without its load), read without running anything: no discovery pass
//
//   const found = plugins(box.places, ["modules"])      // every plugin under a folder, by its node
//   pick(found, "counter")                               // the tool for a counter: exact, then "*"
//   pick(found, "counter", "json")                       // a tool by id (tool-id), any datatype
//
// plugins(places, folder): each program under folder (packages are folders: walked down), each of
// its descriptors in the order given, tracked (a reader is rerun as modules come and go)
// pick(found, datatype, id?): an id: the tool with that id, listed or not; else the listed tools
// that open datatype exactly, then those opening "*", each by id; the first. none: undefined
// datatypeOf(type): a node's ermine.type as patchwork's datatype id (patchwork.<id>: <id>; else as
// it is)
// open: whynots (why each other tool was passed over), as extensions/programs' satisfy gives them
import type { Id, Path, Places } from "@ermine/places"
import { get } from "@ermine/places/lib"

// the attribute a program's descriptors are in; a datatype's ermine.type prefix
export const PLUGINS = "patchwork.plugins"
export const PREFIX = "patchwork."
export const TOOL = "patchwork:tool"
export const DATATYPE = "patchwork:datatype"

// patchwork's PluginDescription and ToolDescription fields that travel (no load)
export type Descriptor = {
	readonly type: string
	readonly id: string
	readonly name?: string
	readonly icon?: string
	readonly tags?: readonly string[]
	readonly supportedDatatypes?: "*" | readonly string[]
	readonly unlisted?: boolean
}

// a descriptor and the program node it is on
export type Found = { readonly program: Id; readonly at: Path; readonly plugin: Descriptor }

const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v)

const isDescriptor = (d: unknown): d is Descriptor =>
	isMap(d) && typeof d.type === "string" && typeof d.id === "string"

export function plugins(places: Places, folder: Path): Found[] {
	const out: Found[] = []
	const top = get(places, folder)
	if (top === undefined) return out
	const walk = (id: Id, at: Path) => {
		const attrs = places.readValue("attributes", id)
		const given = isMap(attrs) ? attrs[PLUGINS] : undefined
		if (Array.isArray(given)) {
			for (const d of given) if (isDescriptor(d)) out.push({ program: id, at, plugin: d })
		}
		const kids = places.readValue("children", id)
		if (isMap(kids)) {
			for (const [name, kid] of Object.entries(kids)) {
				if (typeof kid === "string") walk(kid, [...at, name])
			}
		}
	}
	walk(top, folder)
	return out
}

const opens = (d: Descriptor, datatype: string) => {
	const s = d.supportedDatatypes
	return s === "*" ? false : Array.isArray(s) && s.includes(datatype)
}
const any = (d: Descriptor) => {
	const s = d.supportedDatatypes
	return s === "*" || (Array.isArray(s) && s.includes("*"))
}

export function pick(found: readonly Found[], datatype: string, id?: string): Found | undefined {
	const tools = found.filter((f) => f.plugin.type === TOOL)
	if (id !== undefined) return tools.find((f) => f.plugin.id === id)
	const rank = (f: Found) => opens(f.plugin, datatype) ? 0 : any(f.plugin) ? 1 : 2
	return tools
		.filter((f) => !f.plugin.unlisted && rank(f) < 2)
		.sort((a, b) => rank(a) - rank(b) || a.plugin.id.localeCompare(b.plugin.id))[0]
}

export const datatypeOf = (type: unknown): string =>
	typeof type !== "string" ? "" : type.startsWith(PREFIX) ? type.slice(PREFIX.length) : type
