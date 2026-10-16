// a small CodeMirror for the world's iframe (the page's own editor is not reachable from it), made
// into cm.js beside this by vite (vite.config.ts)
import { basicSetup } from "codemirror"
import { EditorView, keymap } from "@codemirror/view"
import { javascript } from "@codemirror/lang-javascript"
import { syntaxHighlighting } from "@codemirror/language"
import { indentWithTab } from "@codemirror/commands"
import { lycheeHighlightStyle, lycheeTheme } from "../../src/lychee.ts"

export function createEditor(parent: HTMLElement, doc: string, onchange: (text: string) => void) {
	const view = new EditorView({
		parent,
		doc,
		extensions: [
			basicSetup,
			javascript(),
			keymap.of([indentWithTab]),
			lycheeTheme,
			syntaxHighlighting(lycheeHighlightStyle),
			EditorView.theme({
				"&": { height: "100%", fontSize: "12px" },
				".cm-scroller": { overflow: "auto" },
			}),
			EditorView.updateListener.of((u) => u.docChanged && onchange(u.state.doc.toString())),
		],
	})
	return view
}
// replace the whole text (a preset button); fires onchange like typing does
export function setText(view: EditorView, text: string) {
	view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
}
