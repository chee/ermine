// piece-lens's outside, bundled apart (the frame's import map only has @ermine/*), made into cm.js
// beside this by vite (vite.config.ts): a small CodeMirror, and automerge (the repo patchwork
// syncs through). both speak UTF-16 units, JavaScript's own: a change here is { from, to, insert }
// in units, each in the text the changes before it made. the program turns them into ermine's
// splices (code points)
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state"
import {
	drawSelection,
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	lineNumbers,
} from "@codemirror/view"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { syntaxHighlighting } from "@codemirror/language"
import { markdown } from "@codemirror/lang-markdown"
import { javascript } from "@codemirror/lang-javascript"
import { lycheeHighlightStyle, lycheeTheme } from "../../src/lychee.ts"

export type Change = { from: number; to: number; insert: string }

// ---- the editor ----
// a change from elsewhere: not the person's, not in their undo, not told back
const elsewhere = Annotation.define<boolean>()

export type TextEditor = {
	dom: HTMLElement
	text(): string
	// a text of its own (another node's): what it had and its undo go
	load(text: string, options?: { readonly?: boolean; name?: string }): void
	// changes made elsewhere
	apply(changes: readonly Change[]): void
	// the person's changes, told once they are in: a transaction's changes, and its text before
	onedit: (changes: Change[], before: string) => void
}

const language = (name = "") =>
	/\.(md|markdown|txt)$/i.test(name) || !/\.\w+$/.test(name)
		? markdown()
		: /\.(m?[jt]sx?|json)$/i.test(name)
		? javascript({ typescript: /\.tsx?$/i.test(name), jsx: /x$/i.test(name) })
		: []

export function createTextEditor(): TextEditor {
	const lang = new Compartment()
	const locked = new Compartment()
	const extensions = (readonly: boolean, name?: string) => [
		lineNumbers(),
		highlightActiveLineGutter(),
		history(),
		drawSelection(),
		highlightActiveLine(),
		keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
		EditorView.lineWrapping,
		lycheeTheme,
		syntaxHighlighting(lycheeHighlightStyle),
		lang.of(language(name)),
		locked.of([EditorState.readOnly.of(readonly), EditorView.editable.of(!readonly)]),
		EditorView.theme({
			"&": { height: "100%", fontSize: "12.5px" },
			".cm-scroller": { overflow: "auto", fontFamily: "Monaco, ui-monospace, Menlo, monospace" },
		}),
		EditorView.updateListener.of((u) => {
			for (const tr of u.transactions) {
				if (!tr.docChanged || tr.annotation(elsewhere)) continue
				const changes: Change[] = []
				// fromB: where it starts once the ones before it are in; the span it cuts is the old one's
				tr.changes.iterChanges((fromA, toA, fromB, _toB, inserted) =>
					changes.push({ from: fromB, to: fromB + (toA - fromA), insert: inserted.toString() })
				)
				editor.onedit(changes, tr.startState.doc.toString())
			}
		}),
	]
	const view = new EditorView({ doc: "", extensions: extensions(true) })
	const editor: TextEditor = {
		dom: view.dom,
		text: () => view.state.doc.toString(),
		load(text, { readonly = false, name } = {}) {
			view.setState(EditorState.create({ doc: text, extensions: extensions(readonly, name) }))
		},
		apply(changes) {
			if (changes.length === 0) return
			// a spec each: sequential is between specs, each in the text the ones before it made
			view.dispatch(...changes.map((c) => ({
				changes: { from: c.from, to: c.to, insert: c.insert },
				sequential: true,
				annotations: [elsewhere.of(true), Transaction.addToHistory.of(false)],
			})))
		},
		onedit: () => {},
	}
	return editor
}

// ---- automerge: a patchwork doc by its url ----
// a UnixFileEntry (patchwork's file doc): { content, extension, mimeType, name }. content is text
// (a string), an ImmutableString, or bytes
export const SERVER = "wss://subduction.sync.inkandswitch.com"

export type Kind = "text" | "immutable" | "bytes" | "none"
export type Told = { before: string; after: string; changes: Change[] | undefined; local: boolean }
export type Doc = {
	url: string
	name: string
	// automerge-repo's DocHandle, for the console
	handle: unknown
	kind(): Kind
	text(): string
	// told each change to content: its text before and after, and automerge's own splices (none:
	// a change not made of splices); local: made here
	on(fn: (told: Told) => void): () => void
	// changes made here, against before; content not before any more (or not text): set to after
	change(changes: readonly Change[], before: string, after: string): void
}
export type Automerge = {
	// the repo and automerge itself, for the console
	repo: unknown
	Automerge: unknown
	open(url: string): Promise<Doc>
	create(name: string): Promise<Doc>
	online(): boolean
	onstatus(fn: (online: boolean) => void): () => void
}

const decoder = new TextDecoder()
function kindOf(c: unknown): Kind {
	if (typeof c === "string") return "text"
	if (c instanceof Uint8Array) return "bytes"
	if (c !== null && typeof c === "object" && "val" in c) return "immutable"
	return "none"
}
function textOf(c: unknown): string {
	const kind = kindOf(c)
	if (kind === "text") return c as string
	if (kind === "bytes") return decoder.decode(c as Uint8Array)
	if (kind === "immutable") return String((c as { val: unknown }).val)
	return ""
}

let started: Promise<Automerge> | undefined
// one repo per world, made the first time a doc is asked for: the wasm is big
export function automerge(): Promise<Automerge> {
	return started ??= (async () => {
		const [{ Repo }, A, { automergeWasmBase64 }, sub, { wasmBase64 }] = await Promise.all([
			import("@automerge/automerge-repo/slim"),
			import("@automerge/automerge/slim"),
			import("@automerge/automerge/automerge.wasm.base64"),
			import("@automerge/automerge-subduction/slim"),
			import("@automerge/automerge-subduction/wasm-base64"),
		])
		await A.initializeBase64Wasm(automergeWasmBase64) // deno-lint-ignore no-explicit-any
		;(sub as any).initSync({ module: Uint8Array.from(atob(wasmBase64), (c) => c.charCodeAt(0)) })
		// no storage: what this world holds goes with it; the server keeps the docs
		const repo = new Repo({ subductionWebsocketEndpoints: [SERVER] })

		// deno-lint-ignore no-explicit-any
		function wrap(handle: any): Doc {
			let local = false
			const content = () => handle.doc()?.content
			const meta = handle.doc() ?? {}
			const name = typeof meta.name === "string" && meta.name
				? meta.name + (meta.extension ? "." + meta.extension : "")
				: String(handle.url).slice(-8)
			return {
				url: handle.url,
				name,
				handle,
				kind: () => kindOf(content()),
				text: () => textOf(content()),
				on(fn) {
					// deno-lint-ignore no-explicit-any
					const heard = ({ doc, patches, patchInfo }: any) => {
						const before = textOf(patchInfo?.before?.content)
						const after = textOf(doc?.content)
						if (before === after) return
						let changes: Change[] | undefined = []
						for (const p of patches) {
							if (p.path[0] !== "content") continue
							const at = p.path[1]
							if (p.path.length === 2 && p.action === "splice") {
								changes.push({ from: at, to: at, insert: p.value })
							} else if (p.path.length === 2 && p.action === "del") {
								changes.push({ from: at, to: at + (p.length ?? 1), insert: "" })
							} else changes = undefined
							if (!changes) break
						}
						fn({ before, after, changes, local })
					}
					handle.on("change", heard)
					return () => handle.off("change", heard)
				},
				change(changes, before, after) {
					local = true
					try {
						// deno-lint-ignore no-explicit-any
						handle.change((d: any) => {
							if (typeof d.content !== "string" || d.content !== before) {
								d.content = after
								return
							}
							for (const c of changes) {
								A.splice(d, ["content"], c.from, c.to - c.from, c.insert)
							}
						})
					} finally {
						local = false
					}
				},
			}
		}

		return {
			repo,
			Automerge: A,
			async open(url) {
				const found = /automerge:[1-9A-HJ-NP-Za-km-z]+/.exec(url)?.[0]
				if (!found) throw new Error("no automerge: url in that")
				const signal = AbortSignal.timeout(20_000)
				// deno-lint-ignore no-explicit-any
				return wrap(await repo.find(found as any, { signal }))
			},
			async create(name) {
				const handle = repo.create({
					"@patchwork": { type: "file" },
					content: "",
					extension: "md",
					mimeType: "text/markdown",
					name,
				})
				await handle.whenReady?.()
				return wrap(handle)
			},
			online: () => repo.isSubductionConnected(),
			onstatus(fn) {
				const heard = ({ connected }: { connected: boolean }) => fn(connected)
				repo.on("subduction-connection", heard)
				return () => repo.off("subduction-connection", heard)
			},
		}
	})()
}
