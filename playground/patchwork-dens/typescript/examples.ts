// examples: three tools and a datatype written to patchwork's contract (tools/*.js), and installing
// them: a module's source as a program node's value, its descriptors (its plugins, each without
// load) copied onto its attributes once, as installing a package does. after that nothing runs to
// find a tool: the lookup reads attributes
//
//   tools/json.js      tool json, any datatype ("*"): the doc as JSON, again at each change
//   tools/counter.js   datatype counter, and tool counter for it: a count and a button; the clicks
//                      across every counter kept in its tool storage (patchwork:tool-storage)
//   tools/stack.js     tool stack, for patchwork's folder ({ docs: [{ name, url }] }): each doc in
//                      a <patchwork-view> of its own, its name a button opening it
//                      (patchwork:open-document), the selected one pressed (patchwork:selected-doc)
//
//   const write = writer(host)                                 // boot.ts' createHost
//   const { code, modules } = await installTools(write, top)   // each at modules/basics/<name>
//   const id = await install(write, await source("json.js"))   // one: { ermine.type, api, plugins }
//   const { selected, storage } = providers(write)              // [] and an empty folder
//   const doc = await createDoc(write, code["counter.js"], "counter")   // made by its init
//
// write: the few writes these need, each with the host's scope open (an await closes the one
// open): a node made, a node placed in a box, a folder found or made (folders made on the way)
import { type Box, box, createBox } from "@ermine/boxes"
import createEntry from "@ermine/node/entry"
import { createChangeHeader } from "@ermine/places/header"
import type { Id } from "@ermine/places"
import { PROGRAM_API } from "@ermine/dens"
import type { World } from "./boot.ts"
import { PLUGINS, PREFIX } from "./lookup.ts"
import { datatype, evaluate, JS, TOOL_API } from "./runner.ts"

export const TOOLS = ["json.js", "counter.js", "stack.js"] as const

// each written out, so a bundler sees them
const URLS: Record<(typeof TOOLS)[number], URL> = {
	"json.js": new URL("../tools/json.js", import.meta.url),
	"counter.js": new URL("../tools/counter.js", import.meta.url),
	"stack.js": new URL("../tools/stack.js", import.meta.url),
}

export const source = async (name: (typeof TOOLS)[number]): Promise<string> =>
	await (await fetch(URLS[name])).text()

export type Write = {
	// a value, attributes, children: each when given
	node: (
		value: unknown,
		attributes?: Readonly<Record<string, unknown>>,
		children?: Readonly<Record<string, Id>>,
	) => Id
	place: (b: Box, path: readonly string[], id: Id) => void
	// the folder at a path in b, made if missing
	folder: (b: Box, path: readonly string[]) => Id
}

export function writer(w: Pick<World, "places" | "table" | "scheduler" | "scope">): Write {
	const { places, table, scheduler, scope } = w
	const header = () => createChangeHeader(scheduler)
	const within = <T>(f: () => T): T => scheduler.runWithScope(scope, f)
	return {
		node: (value, attributes, children) =>
			within(() => {
				const id = crypto.randomUUID()
				if (value !== undefined) table.add("value", id, createEntry(value, header()) as never)
				if (attributes) table.add("attributes", id, createEntry({ ...attributes }, header()))
				if (children) table.add("children", id, createEntry({ ...children }, header()))
				return id
			}),
		place: (b, path, id) => within(() => void box(b, path, id)),
		folder: (b, path) => within(() => createBox({ places, table, scheduler }, path, b).root),
	}
}

// a module's descriptors: its plugins, without load
export async function describe(code: string): Promise<Record<string, unknown>[]> {
	const { plugins } = await evaluate(code)
	return plugins.map(({ load: _, ...d }) => d)
}

export async function install(write: Write, code: string): Promise<Id> {
	return write.node(code, {
		"ermine.type": JS,
		[PROGRAM_API]: TOOL_API,
		[PLUGINS]: await describe(code),
	})
}

// a doc of a datatype: {} given to its init, its ermine.type patchwork.<id>
export async function createDoc(write: Write, code: string, id: string): Promise<Id> {
	const d = await datatype(code, id)
	const doc: Record<string, unknown> = {}
	d.init(doc)
	return write.node(doc, { "ermine.type": `${PREFIX}${id}` })
}

// every example tool installed, at /apps/patchwork/modules/basics/<name> from top's root
export async function installTools(
	write: Write,
	top: Box,
): Promise<{ code: Record<string, string>; modules: Id }> {
	const code: Record<string, string> = {}
	let modules: Id | undefined
	for (const name of TOOLS) {
		code[name] = await source(name)
		const id = await install(write, code[name])
		write.place(top, ["apps", "patchwork", "modules", "basics", name], id)
		modules ??= write.folder(top, ["apps", "patchwork", "modules"])
	}
	return { code, modules: modules! }
}

// the providers' nodes: ./selected (no doc selected) and ./storage (an empty folder)
export const providers = (write: Write): { selected: Id; storage: Id } => ({
	selected: write.node([]),
	storage: write.node(undefined, undefined, {}),
})
