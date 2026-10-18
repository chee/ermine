// handle: automerge-repo's DocHandle as far as a patchwork tool reaches for it, over an ermine node,
// through a process's api. a node is no automerge doc: change(fn) runs fn on a draft (op's produce)
// and what it did is the patches written to the node
//
//   const repo = createRepo(api, places)
//   const handle = repo.handle(id)                    // the node with that id
//   handle.doc()                                      // its value now, untracked
//   handle.change((d) => { d.count++ })               // the patches, written with api.edit
//   handle.on("change", ({ doc, patches }) => ...)    // every write to its value, as it lands
//   await repo.find(handle.url)                       // "ermine:<id>": the same handle
//   repo.close()                                      // every handle's listeners off
//
// url "ermine:<id>", documentId the id. doc() and docSync(): the value (none: undefined). change(fn):
// fn(draft, { splice }) (produce's helpers: splice(parent, key, start, remove, insert?) is where
// automerge's A.splice would be imported); nothing changed: nothing written. on/off "change": { handle, doc, patches, patchInfo:
// { after, source: "change" } }, told synchronously as the write lands (another process's, the
// host's, this one's), the patches ermine's ({ path, value?, range? }), not automerge's. heads():
// [the value's hash]: a content hash, there is no history. whenReady, isReady: ready at once.
// other events (delete, ephemeral-message): accepted, never told
// find(url): a url not ermine's, or no node with that id: refused (a rejected promise)
// open: urls are ids, so find is not held to the box (an id could be anywhere; a box is a folder)
import type { API } from "@ermine/api"
import produce from "@ermine/op/produce"
import type { Patch } from "@ermine/op/apply"
import type { Fact, Id, Places } from "@ermine/places"
import { hashOf } from "@ermine/dens"

export const SCHEME = "ermine:"

export type ChangePayload = {
	readonly handle: DocHandle
	readonly doc: unknown
	readonly patches: readonly Patch[]
	readonly patchInfo: { readonly after: unknown; readonly source: "change" }
}
type Listener = (payload: ChangePayload) => void

export type DocHandle = {
	readonly url: string
	readonly documentId: Id
	doc: () => unknown
	docSync: () => unknown
	// a recipe, as automerge's: the draft is the doc's shape, whatever it is
	// deno-lint-ignore no-explicit-any
	change: (fn: (draft: any, helpers: any) => unknown) => void
	on: (event: string, fn: Listener) => void
	off: (event: string, fn: Listener) => void
	heads: () => string[]
	isReady: () => boolean
	whenReady: () => Promise<void>
}

export type Repo = {
	find: (url: string) => Promise<DocHandle>
	// the handle of a node by id, made once
	handle: (id: Id) => DocHandle
	close: () => void
}

export const urlOf = (id: Id): string => `${SCHEME}${String(id)}`
export const idOf = (url: unknown): Id | undefined =>
	typeof url === "string" && url.startsWith(SCHEME) && url.length > SCHEME.length
		? url.slice(SCHEME.length)
		: undefined

// places: the process's (its box's), for the facts as they land
export function createRepo(api: API, places: Places): Repo {
	const handles = new Map<Id, DocHandle>()
	const listeners = new Map<Id, Set<Listener>>()
	let stop: (() => void) | undefined

	// one watch for every handle: the facts at a value of a node with listeners
	function told(fact: Fact) {
		if (fact.part !== "value") return
		const fns = listeners.get(fact.id)
		const h = handles.get(fact.id)
		if (fns === undefined || h === undefined) return
		const doc = fact.entry?.value
		const payload = {
			handle: h,
			doc,
			patches: fact.patches,
			patchInfo: { after: doc, source: "change" },
		} as const
		for (const fn of [...fns]) fn(payload)
	}

	function handle(id: Id): DocHandle {
		const had = handles.get(id)
		if (had !== undefined) return had
		const node = { id, part: "value" } as const
		const doc = () => api.peep(node)
		const h: DocHandle = {
			url: urlOf(id),
			documentId: id,
			doc,
			docSync: doc,
			change(fn) {
				const patches = produce(doc(), fn as never)
				if (patches.length) api.edit(node, patches)
			},
			on(event, fn) {
				if (event !== "change") return
				let fns = listeners.get(id)
				if (fns === undefined) listeners.set(id, fns = new Set())
				fns.add(fn)
				stop ??= places.watchAll(told)
			},
			off(event, fn) {
				if (event === "change") listeners.get(id)?.delete(fn)
			},
			heads: () => {
				const h = hashOf(doc())
				return h === undefined ? [] : [h]
			},
			isReady: () => true,
			whenReady: () => Promise.resolve(),
		}
		handles.set(id, h)
		return h
	}

	function find(url: string): Promise<DocHandle> {
		const id = idOf(url)
		if (id === undefined) return Promise.reject(new TypeError(`not an ermine url: ${url}`))
		if (api.peep({ id, part: "value" }) === undefined) {
			return Promise.reject(new Error(`nothing there: ${url}`))
		}
		return Promise.resolve(handle(id))
	}

	function close() {
		stop?.()
		stop = undefined
		listeners.clear()
	}

	return { find, handle, close }
}
