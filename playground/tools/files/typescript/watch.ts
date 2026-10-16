// The watcher (FILES.tex, From edits to changes): host code that watches a
// store's folder and makes each pass one call of the files program's
// edit. Events are only hints: once the folder has had none for 100 ms, or
// what the host sets, a pass takes the store's lock, so no batch is laid out
// while it runs, compares each folder touched since the last pass with the
// layout, and calls edit with the differences, as the computer's user, with
// no person. The first pass, and a pass after the system dropped events,
// compares every folder.
//
// Before the call, a new folder's contents are read, all the way down, as
// its inside, and a Finder alias found is read as a link to where it leads,
// by the host's alias. After it, what edit answers is done on disk: ids set,
// entries removed or sent to the Trash, paths laid out again. Then, out of
// the lock, the host saves the graph, as after any change.

import { encode } from "@ermine/encoding/cbor"
import { relative } from "./layout.ts"
import type { Done, Edit } from "./program.ts"
import type { Store } from "./store.ts"
import { attr } from "./sys.ts"
import type { Difference, Listed } from "./types.ts"

/** Resolves a Finder alias file to the absolute path it leads to; undefined for any other file. */
export type Alias = (path: string) => string | undefined

/** A watcher, for files({store, watch}), and its passes, for a host or a test to run. */
export type Watcher = {
	start(at: { edit: (differences: Edit[], actor?: unknown) => Done }): void
	stop(): void
	/** Runs a pass now: over the folders touched, every folder if none are given. What edit answered, if it was called. */
	pass(touched?: readonly string[]): Promise<Done | undefined>
	/** Resolves once no pass is waiting or running. */
	idle(): Promise<void>
}

const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")))
const utf8 = new TextEncoder()

export function watcher(o: {
	store: Store
	/** ms with no event before a pass; 100 */
	quiet?: number
	/** who the edits are by; the computer's user, as $USER gives it */
	actor?: unknown
	/** saves the graph into the store after a pass that called edit: the host's store.write */
	save?: () => Promise<unknown>
	/** the host's: where a Finder alias leads */
	alias?: Alias
	/** watch the folder with Deno.watchFs; true. A test runs its passes itself */
	events?: boolean
	/** told of what the watcher could not do */
	list?: (item: Listed) => void
}): Watcher {
	const { store } = o
	const quiet = o.quiet ?? 100
	const actor = o.actor ?? Deno.env.get("USER") ?? "user"
	const abs = (path: string) => (path === "" ? store.folder : `${store.folder}/${path}`)
	let edit: ((differences: Edit[], actor?: unknown) => Done) | undefined
	let fs: Deno.FsWatcher | undefined
	let timer: ReturnType<typeof setTimeout> | undefined
	let touched: Set<string> | undefined = new Set()
	let all = true
	let chain: Promise<unknown> = Promise.resolve()

	/** The folder's path from the store's, or undefined for one in .ermine that is not the root's file. */
	function inside(path: string): string | undefined {
		if (path !== store.folder && !path.startsWith(store.folder + "/")) return undefined
		const p = path === store.folder ? "" : path.slice(store.folder.length + 1)
		if (p === ".ermine" || (p.startsWith(".ermine/") && !/^\.ermine\/root\.[^/]*$/.test(p))) {
			return undefined
		}
		return p
	}

	async function listen(w: Deno.FsWatcher) {
		try {
			for await (const e of w) {
				let any = false
				if (e.flag === "rescan") all = true
				for (const p of e.paths) {
					const q = inside(p)
					if (q === undefined) continue
					any = true
					if (!q.startsWith(".ermine/")) touched?.add(parent(q))
				}
				if (any || e.flag === "rescan") soon()
			}
		} catch {
			// the watcher closed
		}
	}

	function soon() {
		if (timer !== undefined) clearTimeout(timer)
		timer = setTimeout(() => {
			timer = undefined
			const t = all ? undefined : [...touched!]
			all = false
			touched = new Set()
			void run(t)
		}, quiet)
	}

	/** A new folder's contents, all the way down; an alias as a link. */
	async function expand(ds: Difference[]): Promise<Edit[]> {
		const out: Edit[] = []
		for (const d of ds) {
			let e: Edit = d
			if (o.alias && d.now?.kind === "file" && !d.was) {
				const to = o.alias(abs(d.path))
				if (to !== undefined) {
					const rel = to === store.folder
						? ""
						: to.startsWith(store.folder + "/")
						? to.slice(store.folder.length + 1)
						: undefined
					const target = rel === undefined ? to : relative(parent(d.path), rel)
					e = { path: d.path, now: { kind: "link", target } }
				}
			}
			if (d.now?.kind === "folder" && (!d.was || d.was.kind !== "folder")) {
				const more = (await store.differences([d.path]))
					.filter((x) => x.path.startsWith(d.path + "/"))
				e = { ...d, inside: await expand(more) }
			}
			out.push(e)
		}
		return out
	}

	/** What edit answered, done on disk. */
	async function after(done: Done) {
		const quietly = async (f: () => Promise<unknown>, path: string) => {
			try {
				await f()
			} catch (e) {
				o.list?.({ path, why: e instanceof Error ? e.message : String(e) })
			}
		}
		for (const [p, id] of done.marks) {
			await quietly(() => store.sys.set(abs(p), attr.id, utf8.encode(id)), p)
		}
		for (const [p, holder, slot] of done.slots) {
			await quietly(() => store.sys.set(abs(p), attr.slot, encode([holder, slot])), p)
		}
		for (const p of done.unside) await quietly(() => store.sys.unset(abs(p), attr.side), p)
		for (const p of done.clear) {
			await quietly(async () => {
				try {
					await Deno.remove(abs(p))
				} catch (e) {
					if (!(e instanceof Deno.errors.NotFound)) throw e
				}
			}, p)
		}
		for (const t of done.trash) {
			await quietly(async () => {
				try {
					await Deno.lstat(abs(t.path))
				} catch {
					return
				}
				await store.trash(t.path, t.why)
			}, t.path)
		}
		if (done.mend.length) await quietly(() => store.mend([...new Set(done.mend)]), "")
	}

	async function pass(t?: readonly string[]): Promise<Done | undefined> {
		const take = edit
		if (take === undefined) return undefined
		const out = await store.lock(async () => {
			const found = await store.differences(t)
			// what is in a new folder comes once, as its inside
			const ds = await expand(found)
			const folders = ds.filter((d) => d.inside).map((d) => d.path)
			const edits = ds.filter((d) => !folders.some((f) => d.path.startsWith(f + "/")))
			if (!edits.length) return undefined
			let done: Done | undefined
			try {
				done = take(edits, actor)
			} catch (e) {
				o.list?.({ path: "", why: `edit failed: ${e instanceof Error ? e.message : e}` })
				return undefined
			}
			if (done) await after(done)
			return done
		})
		if (out && o.save) await o.save()
		return out
	}

	function run(t?: readonly string[]): Promise<Done | undefined> {
		const p = chain.then(() => pass(t))
		chain = p.catch(() => {})
		return p
	}

	return {
		start(given) {
			edit = given.edit
			all = true
			if (o.events ?? true) {
				fs = Deno.watchFs(store.folder, { recursive: true })
				void listen(fs)
				soon()
			}
		},
		stop() {
			edit = undefined
			if (timer !== undefined) clearTimeout(timer)
			timer = undefined
			fs?.close()
			fs = undefined
		},
		pass: (t) => run(t),
		idle: async () => {
			while (true) {
				const c = chain
				await c
				if (c === chain && timer === undefined) return
				if (timer !== undefined) await new Promise((r) => setTimeout(r, quiet + 10))
			}
		},
	}
}
