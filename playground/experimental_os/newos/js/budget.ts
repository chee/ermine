// budget.ts: a loop budget patched into a program's code (runner.ts, load): each run of a part
// (a setup, a compute, an effect, a handler, a timer) may take BUDGET steps, a step being one turn
// of a loop (for, for-of, for-in, while, do) or one entry of a function (a function, a method, an
// arrow); past it the program is thrown an ordinary Error named "budget", which it may catch, and
// which otherwise fails the run as any thrown run does. So a `while (true) {}` ends, and the OS
// goes on; and only that part is stopped: a part that called it (through call, a handler) sees the
// Error as any other, which a CPU watchdog of JavaScriptCore's could not give (its termination is
// uncatchable and persists to the outermost part).
//
// The rewrite (budget(source)) keeps every line where it was, so a frame's line still names the
// source's: it only inserts, on the same line, `__b();` after the `{` opening a loop's or a function's
// body, `(__b(), ` … `)` round an arrow's expression body, `__b(), ` into the condition of a while or
// a for whose body has no braces, and `{__b(); ` … `}` round the braceless body of a for-of or for-in.
// a braceless do's while gets the step as a while does. It goes by tokens, not a parse: strings,
// template literals (and what their ${} hold), regular expressions and comments are passed whole; a
// braceless body or an arrow's expression ends at `;`, at a closing bracket, at a `,` or a
// ternary's `:` (an arrow's), or at a line's end when neither line goes on with the other (an
// operator ending the one or starting the next, `.`, `(`: as ASI reads it). Blocks of if, else,
// switch, try, catch and finally are not steps.

/**
 * Steps a run may take. The largest run of the image's programs seen in a boot, a shell session,
 * plasma for 20 s, catclock, graph, the inspector and the C examples took 90 452 steps (a setup
 * of graph's); 5 000 000 leaves them fifty times that, while a `while (true) {}` takes it in about
 * 0.2 s of CPU (JavaScriptCore runs a loop calling __b at about 25 M steps a second, measured),
 * so a looping part is stopped well within a second.
 */
export const BUDGET = 5_000_000

/** the step, as the program's code calls it: a parameter of the module's wrapper (runner.ts) */
export const STEP = "__b"

type Kind = "ident" | "num" | "str" | "regex" | "punct" | "thead" | "tmid" | "ttail" | "tmpl"
type Token = { kind: Kind; text: string; at: number; end: number; nl: boolean }

const puncts = [
	">>>=",
	"...",
	"===",
	"!==",
	"**=",
	"<<=",
	">>=",
	">>>",
	"&&=",
	"||=",
	"??=",
	"=>",
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"??",
	"?.",
	"++",
	"--",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"&=",
	"|=",
	"^=",
	"<<",
	">>",
	"**",
	"{",
	"}",
	"(",
	")",
	"[",
	"]",
	";",
	",",
	"<",
	">",
	"+",
	"-",
	"*",
	"/",
	"%",
	"&",
	"|",
	"^",
	"!",
	"~",
	"?",
	":",
	"=",
	".",
	"@",
	"#",
]
// after these a `/` starts a regular expression, not a division
const regexAfter = new Set([
	"return",
	"typeof",
	"instanceof",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"throw",
	"case",
	"do",
	"else",
	"yield",
	"await",
])
// a line that starts with one of these goes on with the expression before it (no semicolon is read)
const continues = new Set([
	".",
	"?.",
	"?",
	":",
	"=>",
	"(",
	"[",
	"+",
	"-",
	"*",
	"/",
	"%",
	"**",
	"&&",
	"||",
	"??",
	"&",
	"|",
	"^",
	"<",
	">",
	"<=",
	">=",
	"==",
	"!=",
	"===",
	"!==",
	"<<",
	">>",
	">>>",
	"=",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"**=",
	"&=",
	"|=",
	"^=",
	"<<=",
	">>=",
	">>>=",
	"&&=",
	"||=",
	"??=",
	",",
	"in",
	"of",
	"instanceof",
])
const identStart = /[\p{ID_Start}$_\\]/u
const identPart = /[\p{ID_Continue}$‌‍\\]/u

/** the source as tokens; a template literal's text parts as thead/tmid/ttail (or tmpl, whole, with no ${}) */
function tokens(s: string): Token[] {
	const out: Token[] = []
	const n = s.length
	let i = 0, nl = false
	// the brace depth at which each open template's ${ waits for its }
	const tmpl: number[] = []
	let braces = 0
	const push = (kind: Kind, at: number, end: number) => {
		out.push({ kind, text: s.slice(at, end), at, end, nl })
		nl = false
	}
	const regexAllowed = () => {
		const p = out[out.length - 1]
		if (!p) return true
		if (p.kind === "ident") return regexAfter.has(p.text)
		if (p.kind === "punct") return p.text !== ")" && p.text !== "]"
		return p.kind === "thead" || p.kind === "tmid"
	}
	// a template's text from i (just past ` or }) to its ${ (thead/tmid) or its closing ` (ttail/tmpl)
	const template = (at: number, opening: boolean) => {
		let k = i
		for (;;) {
			if (k >= n) throw new Error("budget: an unterminated template literal")
			const c = s[k]
			if (c === "\\") k += 2
			else if (c === "`") {
				i = k + 1
				push(opening ? "tmpl" : "ttail", at, i)
				return
			} else if (c === "$" && s[k + 1] === "{") {
				i = k + 2
				push(opening ? "thead" : "tmid", at, i)
				tmpl.push(braces)
				return
			} else k++
		}
	}
	while (i < n) {
		const c = s[i]
		if (c === "\n") nl = true, i++
		else if (
			c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v" || c === " " || c === "﻿"
		) i++
		else if (c === "/" && s[i + 1] === "/") {
			while (i < n && s[i] !== "\n") i++
		} else if (c === "/" && s[i + 1] === "*") {
			const e = s.indexOf("*/", i + 2)
			if (e < 0) throw new Error("budget: an unterminated comment")
			if (s.slice(i, e).includes("\n")) nl = true
			i = e + 2
		} else if (c === "'" || c === '"') {
			const at = i++
			while (i < n && s[i] !== c) {
				if (s[i] === "\\") i++
				if (s[i] === "\n") throw new Error("budget: an unterminated string")
				i++
			}
			i++
			push("str", at, i)
		} else if (c === "`") {
			const at = i++
			template(at, true)
		} else if (c === "}" && tmpl.length && tmpl[tmpl.length - 1] === braces) {
			tmpl.pop()
			const at = i++
			template(at, false)
		} else if (c === "/" && regexAllowed()) {
			const at = i++
			let cls = false
			for (; i < n; i++) {
				const d = s[i]
				if (d === "\\") i++
				else if (d === "\n") throw new Error("budget: an unterminated regular expression")
				else if (cls) cls = d !== "]"
				else if (d === "[") cls = true
				else if (d === "/") break
			}
			i++
			while (i < n && identPart.test(s[i])) i++
			push("regex", at, i)
		} else if (c >= "0" && c <= "9" || (c === "." && s[i + 1] >= "0" && s[i + 1] <= "9")) {
			const at = i++
			while (
				i < n &&
				(identPart.test(s[i]) || s[i] === "." ||
					((s[i] === "+" || s[i] === "-") && (s[i - 1] === "e" || s[i - 1] === "E") &&
						!/^0[xob]/i.test(s.slice(at, i))))
			) i++
			push("num", at, i)
		} else if (identStart.test(c)) {
			const at = i++
			while (i < n && identPart.test(s[i])) i++
			push("ident", at, i)
		} else {
			const p = puncts.find((x) => s.startsWith(x, i))
			if (!p) {
				throw new Error(`budget: a character that is no token, ${JSON.stringify(c)} at ${i}`)
			}
			if (p === "{") braces++
			else if (p === "}") braces--
			const at = i
			i += p.length
			push("punct", at, i)
		}
	}
	return out
}

type Insert = { at: number; text: string; from: number }

/** the program's source with the steps in it: a line-preserving rewrite */
export function budget(source: string): string {
	const t = tokens(source)
	const ins: Insert[] = []
	const is = (k: number, text: string) =>
		k < t.length && t[k].kind === "punct" && t[k].text === text
	const word = (k: number, text: string) =>
		k < t.length && t[k].kind === "ident" && t[k].text === text &&
		!(k > 0 && is(k - 1, ".") && !t[k - 1].nl)
	const opens = (k: number) => is(k, "(") || is(k, "[") || is(k, "{") || t[k].kind === "thead"
	const closes = (k: number) => is(k, ")") || is(k, "]") || is(k, "}") || t[k].kind === "ttail"
	/** the token after the bracket matching the opener at k */
	const past = (k: number): number => {
		let depth = 0
		for (; k < t.length; k++) {
			if (opens(k)) depth++
			else if (closes(k) && --depth === 0) return k + 1
		}
		return k
	}
	/**
	 * where a braceless body or an arrow's expression starting at k ends: the token index it ends before.
	 * comma: a `,` at depth 0 ends it (an arrow's); a statement's does not
	 */
	const endOf = (k: number, comma: boolean): number => {
		let depth = 0, asks = 0 // brackets open; ?s of ternaries open, whose : is the body's
		for (let j = k; j < t.length; j++) {
			if (j > k && t[j].nl && depth === 0 && !goesOn(t[j]) && !wants(t[j - 1])) return j
			if (opens(j)) depth++
			else if (closes(j)) {
				if (depth === 0) return j
				depth--
			} else if (depth === 0 && t[j].kind === "punct") {
				if (t[j].text === ";" || (comma && t[j].text === ",")) return j
				if (t[j].text === "?") asks++
				else if (t[j].text === ":" && asks-- === 0) return j
			}
		}
		return t.length
	}
	/** the token goes on with the expression before it, though on a new line */
	const goesOn = (x: Token) => (x.kind === "punct" || x.kind === "ident") && continues.has(x.text)
	/** the token wants an operand after it, so the expression goes on past a new line */
	const wants = (x: Token) =>
		(x.kind === "punct" && x.text !== ")" && x.text !== "]" && x.text !== "}" &&
			x.text !== "++" && x.text !== "--") ||
		(x.kind === "ident" &&
			(continues.has(x.text) || x.text === "typeof" || x.text === "new" || x.text === "await" ||
				x.text === "void" || x.text === "delete")) ||
		x.kind === "thead" || x.kind === "tmid"
	const after = (k: number) => t[k].end
	const before = (k: number) => (k < t.length ? t[k].at : source.length)
	/** the end position of the token before k, where a body that ends before k is closed */
	const close = (k: number) => (k > 0 ? t[k - 1].end : 0)
	const step = `${STEP}();`
	for (let k = 0; k < t.length; k++) {
		const tk = t[k]
		if (tk.kind === "punct" && tk.text === "{" && k > 0 && !tk.nl) {
			const p = t[k - 1]
			if (p.kind === "punct" && p.text === "=>") {
				ins.push({ at: after(k), text: step, from: tk.at })
			} else if (p.kind === "ident" && p.text === "do") {
				ins.push({ at: after(k), text: step, from: tk.at })
			} else if (p.kind === "punct" && p.text === ")") {
				// the head before the matching (: a keyword's block, a loop's, or a function's
				let depth = 0, j = k - 1
				for (; j >= 0; j--) {
					if (closes(j)) depth++
					else if (opens(j) && --depth === 0) break
				}
				const h = j > 0 ? t[j - 1] : null
				const head = h && h.kind === "ident" ? h.text : null
				if (head !== "if" && head !== "switch" && head !== "catch" && head !== "with") {
					ins.push({ at: after(k), text: step, from: tk.at })
				}
			}
		} else if (tk.kind === "punct" && tk.text === "=>" && !is(k + 1, "{")) {
			// an arrow's expression body: (__b(), body)
			const e = endOf(k + 1, true)
			ins.push({ at: after(k), text: ` (${STEP}(),`, from: tk.at })
			ins.push({ at: close(e), text: ")", from: tk.at })
		} else if (
			(word(k, "for") || word(k, "while")) &&
			(is(k + 1, "(") || (word(k + 1, "await") && is(k + 2, "(")))
		) {
			if (word(k, "while") && k > 0 && is(k - 1, "}")) continue // a do's while after its braced body, which has the step
			const open = is(k + 1, "(") ? k + 1 : k + 2
			const body = past(open)
			if (is(body, "{")) continue // the {-rule above
			if (word(k, "while")) ins.push({ at: after(open), text: `${STEP}(), `, from: tk.at })
			else {
				// for (init; cond; step): the step into the condition; for (x of y), for (x in y): round the body
				let semi = -1, depth = 0
				for (let j = open + 1; j < body - 1 && semi < 0; j++) {
					if (opens(j)) depth++
					else if (closes(j)) depth--
					else if (depth === 0 && is(j, ";")) semi = j
				}
				if (semi >= 0) {
					ins.push({
						at: after(semi),
						text: is(semi + 1, ";") ? ` ${STEP}()` : ` ${STEP}(),`,
						from: tk.at,
					})
				} else {
					const e = endOf(body, false)
					ins.push({ at: before(body), text: `{${STEP}(); `, from: tk.at })
					ins.push({ at: close(e), text: "}", from: tk.at })
				}
			}
		}
	}
	// innermost first at one position (its closer before an outer's), else by position
	ins.sort((a, b) => a.at - b.at || b.from - a.from)
	let out = "", last = 0
	for (const x of ins) {
		out += source.slice(last, x.at) + x.text
		last = x.at
	}
	return out + source.slice(last)
}
