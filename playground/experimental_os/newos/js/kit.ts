// kit.ts: "ermine:kit", helpers a program imports, each a line or two over
// what a part is given (PORT.md, Programs in JS). Nothing here is the API: a
// program sees every helper it uses by name, and AFFORDANCES.md says why each
// one exists. A helper takes the part's map, or the pieces of it it needs.

type Version = { content: unknown; because?: { place?: unknown } }
type Item = { id: string; route: { name: string }[]; node?: unknown; versions?: Version[] }
type Patch = {
	path: readonly (string | number)[]
	range?: readonly [number, number]
	value?: unknown
}
export type Api = {
	look(address: readonly string[]): Item[]
	content(address: readonly string[]): Item[]
	children(address: readonly string[], name?: string): Item[] | string[]
	write(address: readonly string[], patches: Patch[], index?: number): number
	insert(id: string, name: string, child: string, index?: number): number
	remove(id: string, name: string, index: number): number
	create(value?: unknown, o?: { id?: string; ephemeral?: boolean }): string
	rename(id: string, name: string, to: string): number
	move(
		id: string,
		name: string,
		index: number,
		toid: string,
		toname: string,
		toindex?: number,
	): number
	as(o: { cause: unknown }): Api
	node(id: string): unknown
}
type Part = { api: Api; self: string; name: string; start?: (op: unknown) => string }

// --- values

/** the whole value replaced */
export const whole = (value: unknown): Patch[] => [{ path: [], value }]
/** one key of a map set */
export const key = (k: string | number, value: unknown): Patch[] => [{ path: [k], value }]

/** a version that is a process's status, written in front of its value */
export const isStatus = (v: Version) => v.because?.place === "status"
/** the first version that is not a status */
export const first = (versions?: Version[]): unknown => versions?.find((v) => !isStatus(v))?.content

/** the value at an address: the first item with versions, its first not a status */
export function val<T = unknown>(api: Pick<Api, "content">, address: readonly string[]): T {
	return first(api.content(address).find((i) => i.versions)?.versions) as T
}

/** every value at an address: one per id placed there (reads are lists) */
export function vals<T = unknown>(api: Pick<Api, "content">, address: readonly string[]): T[] {
	return api.content(address).filter((i) => i.versions).map((i) => first(i.versions) as T)
}

// --- nodes

/** the id of the first loaded node at an address */
export function idAt(api: Pick<Api, "look">, address: readonly string[]): string | undefined {
	return api.look(address).find((i) => i.node)?.id
}

/** a node holding value, made and placed in parent's list of name (parent an id); its id */
export function put(
	api: Pick<Api, "create" | "insert">,
	parent: string,
	name: string,
	value?: unknown,
	o: { id?: string; ephemeral?: boolean } = {},
): string {
	const id = api.create(value, o)
	api.insert(parent, name, id)
	return id
}

/** the node at address/name, made holding value if none is there; its id */
export function make(
	api: Pick<Api, "look" | "create" | "insert">,
	address: readonly string[],
	name: string,
	value?: unknown,
	o: { ephemeral?: boolean } = {},
): string | undefined {
	const had = idAt(api, [...address, name])
	if (had) return had
	const parent = idAt(api, address)
	return parent ? put(api, parent, name, value, o) : undefined
}

/** writes the value whole at address, or makes it there (parent/name) if nothing is, ephemeral if asked */
export function snap(
	api: Pick<Api, "look" | "create" | "insert" | "write">,
	address: readonly string[],
	value: unknown,
	o: { ephemeral?: boolean } = {},
) {
	if (idAt(api, address)) api.write(address, whole(value))
	else make(api, address.slice(0, -1), address[address.length - 1], value, o)
}

// --- processes

/** f as a handler, in on/<list> inside the process's node; its address from the process's place */
export function handler(
	{ api, self, name }: Part,
	list: string,
	f: (given: unknown) => unknown,
): string[] {
	let on = idAt(api, [name, "on"])
	if (!on) on = put(api, self, "on", null, { ephemeral: true })
	put(api, on, list, f, { ephemeral: true })
	return [name, "on", list]
}

// {deep: true}: a new value is one not the same all the way down; else (core's) a map or list
// is new each time it is made, so the effect runs each time the compute does
type Same = { deep?: boolean }

/** a child of the process running compute */
export function compute(
	{ start, name }: Part,
	child: string,
	f: (given: unknown) => unknown,
	o: Same = {},
): string {
	return start!({ address: [name], name: child, code: { compute: f }, ...o })
}

/** a child of the process running compute, and effect with each new value */
export function effect(
	{ start, name }: Part,
	child: string,
	c: (given: unknown) => unknown,
	e: (given: unknown) => unknown,
	o: Same = {},
): string {
	return start!({ address: [name], name: child, code: { compute: c, effect: e }, ...o })
}

/** the node id names in parent's list of name let go (the first, if no id) */
export function drop(
	api: Pick<Api, "look" | "children" | "remove">,
	parent: readonly string[],
	name: string,
	id?: string,
) {
	const at = idAt(api, parent)
	if (!at) return
	const items = api.children(parent, name) as Item[]
	const i = id === undefined ? 0 : items.findIndex((it) => it.id === id)
	if (i >= 0 && i < items.length) api.remove(at, name, i)
}

/** what boot gave the process: the value of the node "data" inside it */
export function data<T = unknown>({ api, name }: Pick<Part, "api" | "name">): T | undefined {
	return val<T>(api, [name, "data"])
}

/**
 * An ephemeral item in front of the document at address, in the same list:
 * what is being edited shows there, then is written into the document once.
 * Each call takes the part's api.
 */
export function front(address: readonly string[]) {
	const parent = address.slice(0, -1), name = address[address.length - 1]
	let id: string | undefined
	return {
		/** whether an item is in front */
		held: (api: Api) => !!id && !!idAt(api, address),
		/** value in front: written into the item there, or placed there first */
		put(api: Api, value: unknown, patches?: Patch[]) {
			if (id && idAt(api, address) === id) api.write(address, patches ?? whole(value))
			else {
				const at = idAt(api, parent)
				if (!at) return
				id = api.create(value, { ephemeral: true })
				api.insert(at, name, id, 0)
			}
		},
		/** over: the item in front let go, and value, if given, written into the document */
		done(api: Api, value?: unknown, patches?: Patch[]) {
			if (id) drop(api, parent, name, id)
			id = undefined
			if (value === undefined) return
			// patches, given, are what changed from the document as it is: written alone
			if (patches && idAt(api, address)) api.write(address, patches)
			else snap(api, address, value)
		},
	}
}
