// deno-lint-ignore-file no-import-prefix -- no deno.json of its own here: npm specifiers inline
/// <reference lib="dom" />
// editor.ts: CodeMirror, dressed for the desk: cream paper, plum ink, a cherry caret, a mint
// selection, the line you're on in lemon. C is a small stream language of its own here (no grammar to fetch); JavaScript is
// codemirror's. A build's errors are diagnostics on their lines.
import { basicSetup } from "npm:codemirror@6"
import { EditorView, keymap } from "npm:@codemirror/view@6"
import { Compartment, EditorState, Prec } from "npm:@codemirror/state@6"
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "npm:@codemirror/language@6"
import { javascript } from "npm:@codemirror/lang-javascript@6"
import { type Diagnostic, setDiagnostics } from "npm:@codemirror/lint@6"
import { indentWithTab } from "npm:@codemirror/commands@6"
import { tags as t } from "npm:@lezer/highlight@1"

const KEYWORDS = new Set(
	"if else for while do switch case default break continue return goto sizeof static const extern inline volatile register typedef struct union enum restrict"
		.split(" "),
)
const TYPES = new Set(
	"void char short int long float double signed unsigned _Bool bool size_t int64_t int32_t uint32_t uint8_t uint16_t Point View"
		.split(" "),
)

// C, a token at a time: comments, the preprocessor, strings, numbers, keywords, types, CONSTANTS
// and calls
const c = StreamLanguage.define<{ comment: boolean }>({
	name: "c",
	startState: () => ({ comment: false }),
	token(stream, state) {
		if (state.comment) {
			if (stream.match(/^.*?\*\//)) state.comment = false
			else stream.skipToEnd()
			return "comment"
		}
		if (stream.eatSpace()) return null
		if (stream.match("//")) {
			stream.skipToEnd()
			return "comment"
		}
		if (stream.match("/*")) {
			state.comment = true
			if (stream.match(/^.*?\*\//)) state.comment = false
			else stream.skipToEnd()
			return "comment"
		}
		if (stream.sol() && stream.match(/^#\s*\w+/)) return "meta"
		if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^<[\w.]+\.h>/)) return "string"
		if (stream.match(/^'(?:[^'\\]|\\.)*'?/)) return "string"
		if (stream.match(/^(?:0x[0-9a-fA-F]+|\d+\.?\d*(?:e[+-]?\d+)?|\.\d+)[uUlLfF]*/)) {
			return "number"
		}
		if (stream.match(/^[A-Za-z_]\w*/)) {
			const w = stream.current()
			if (KEYWORDS.has(w)) return "keyword"
			if (TYPES.has(w)) return "typeName"
			if (/^[A-Z][A-Z0-9_]+$/.test(w)) return "atom"
			if (stream.match(/^\s*\(/, false)) return "variableName.function"
			return "variableName"
		}
		if (stream.match(/^[-+*/%=<>!&|^~?:]+/)) return "operator"
		stream.next()
		return "punctuation"
	},
	languageData: { commentTokens: { line: "//", block: { open: "/*", close: "*/" } } },
})

const ink = {
	plum: "#3a2a43",
	cherry: "#ff2284",
	deep: "#c4006a",
	mint: "#0e8f74",
	lilac: "#7b5ce6",
	peach: "#c96f3b",
	blue: "#2269ff",
	soft: "#8a7d86",
}

const highlight = HighlightStyle.define([
	{ tag: [t.comment, t.lineComment, t.blockComment], color: ink.soft, fontStyle: "italic" },
	{ tag: t.meta, color: ink.lilac },
	{
		tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword],
		color: ink.cherry,
		fontWeight: "600",
	},
	{ tag: [t.typeName, t.className], color: ink.lilac },
	{ tag: [t.string, t.special(t.string)], color: ink.mint },
	{ tag: [t.number, t.integer, t.float, t.bool], color: ink.peach },
	{ tag: t.atom, color: ink.deep, fontWeight: "600" },
	{ tag: [t.function(t.variableName), t.function(t.propertyName)], color: ink.blue },
	{ tag: [t.variableName, t.propertyName], color: ink.plum },
	{ tag: [t.definition(t.variableName)], color: ink.plum, fontWeight: "600" },
	{ tag: [t.operator], color: ink.cherry },
	{ tag: [t.punctuation, t.bracket], color: ink.soft },
])

const theme = EditorView.theme({
	"&": { color: ink.plum, backgroundColor: "transparent", height: "100%", fontSize: "12.5px" },
	"&.cm-focused": { outline: "none" },
	".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6" },
	".cm-content": { caretColor: ink.cherry, padding: "12px 0 40px" },
	".cm-cursor, .cm-dropCursor": { borderLeft: `2px solid ${ink.cherry}` },
	"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
		backgroundColor: "#36f9c099 !important",
	},
	".cm-activeLine": { backgroundColor: "rgba(255, 255, 136, 0.35)" },
	".cm-gutters": {
		backgroundColor: "transparent",
		color: "#c7b9cc",
		border: "none",
		paddingLeft: "6px",
	},
	".cm-activeLineGutter": { backgroundColor: "transparent", color: ink.cherry },
	".cm-lineNumbers .cm-gutterElement": { fontSize: "11px", padding: "0 10px 0 4px" },
	".cm-foldGutter .cm-gutterElement": { color: "#d8c9cf" },
	".cm-matchingBracket": { backgroundColor: "#ffff88 !important", outline: "none" },
	".cm-tooltip": {
		backgroundColor: "#fcf7f2",
		border: "1px solid #000",
		borderRadius: "2px",
		overflow: "hidden",
	},
	".cm-panels": { backgroundColor: "#fcf7f2", color: ink.plum },
	".cm-diagnostic-error": { borderLeft: `4px solid ${ink.cherry}` },
	".cm-lintRange-error": {
		backgroundImage: "none",
		textDecoration: `wavy underline ${ink.cherry}`,
	},
	".cm-lint-marker-error": { content: "none" },
}, { dark: false })

export type Editor = ReturnType<typeof createEditor>

// an editor in box: open(name, text) shows a file; onSave hears the text, ⌘S or the button
export function createEditor(
	box: HTMLElement,
	onSave: (text: string) => void,
	onChange: (dirty: boolean) => void,
) {
	const language = new Compartment()
	const readOnly = new Compartment()
	let saved = ""
	const save = () => {
		saved = view.state.doc.toString()
		onChange(false)
		onSave(saved)
		return true
	}
	const view = new EditorView({
		parent: box,
		state: EditorState.create({
			doc: "",
			extensions: [
				basicSetup,
				Prec.high(
					keymap.of([{ key: "Mod-s", run: save, preventDefault: true }, indentWithTab]),
				),
				theme,
				syntaxHighlighting(highlight),
				language.of(c),
				readOnly.of(EditorState.readOnly.of(false)),
				EditorView.updateListener.of((u) => {
					if (u.docChanged) onChange(u.state.doc.toString() !== saved)
				}),
			],
		}),
	})
	return {
		view,
		save,
		// a file shown: its text, its language by its name
		open(name: string, text: string, editable = true) {
			saved = text
			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: text },
				effects: [
					language.reconfigure(name.endsWith(".js") ? javascript() : c),
					readOnly.reconfigure(EditorState.readOnly.of(!editable)),
				],
				selection: { anchor: 0 },
				scrollIntoView: true,
			})
			view.dispatch(setDiagnostics(view.state, []))
			onChange(false)
		},
		// the text changed under it (another write): shown, if nothing is being typed
		replace(text: string) {
			const now = view.state.doc.toString()
			if (now !== saved) return
			saved = text
			if (text === now) return
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
		},
		// clang's errors for this file: each on its line
		errors(list: { line: number; col: number; message: string }[]) {
			const doc = view.state.doc
			const diagnostics: Diagnostic[] = list.filter((e) => e.line >= 1 && e.line <= doc.lines)
				.map((e) => {
					const line = doc.line(e.line)
					const from = Math.min(line.from + Math.max(0, e.col - 1), line.to)
					return { from, to: Math.max(from, line.to), severity: "error", message: e.message }
				})
			view.dispatch(setDiagnostics(view.state, diagnostics))
		},
		text: () => view.state.doc.toString(),
		dirty: () => view.state.doc.toString() !== saved,
	}
}
