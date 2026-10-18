// getting code out of what the model said

import type { Wrap } from "./kits.ts"

export type Block = { lang: string; code: string; closed: boolean }

export function blocks(text: string): Block[] {
	const found: Block[] = []
	const re = /```[ \t]*([\w+-]*)[^\n]*\n([\s\S]*?)(```|$(?![\s\S]))/g
	for (const m of text.matchAll(re)) {
		found.push({
			lang: m[1].toLowerCase(),
			code: m[2].replace(/\s+$/, ""),
			closed: m[3] == "```",
		})
	}
	return found
}

const aliases: Record<string, string[]> = {
	js: ["js", "javascript", "jsx", "ts", "typescript", "mjs"],
	jsx: ["jsx", "tsx", "js", "javascript", "react"],
	html: ["html", "htm", "xml", "svg"],
	sql: ["sql", "sqlite", "postgresql", "mysql"],
}
const matches = (want: string, got: string) => (aliases[want] ?? [want]).includes(got)

export type Extracted = { code?: string; how: string }

// one block in the language asked for; `skip` passes over earlier blocks of a two-block answer
export function extract(
	text: string,
	wrap: Wrap,
	lang: string,
	skip = 0,
): Extracted {
	const stripped = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
	if (wrap == "json") {
		const start = stripped.indexOf("{")
		const end = stripped.lastIndexOf("}")
		if (start < 0 || end < start) return { how: "no json" }
		try {
			const v = JSON.parse(stripped.slice(start, end + 1))
			const code = typeof v == "string" ? v : v?.code
			if (typeof code == "string" && code.trim()) return { code, how: "json" }
			return { how: "json without code" }
		} catch {
			return { how: "bad json" }
		}
	}
	const all = blocks(stripped)
	const mine = all.filter((b) => matches(lang, b.lang))
	const pick = mine[skip] ??
		(skip == 0 ? all.find((b) => b.lang == "") : undefined)
	if (pick) {
		return {
			code: pick.code,
			how: wrap == "fence" ? (pick.closed ? "fence" : "unclosed fence") : "fence in raw",
		}
	}
	if (skip == 0 && all.length) return { code: all[0].code, how: "other fence" }
	if (wrap == "raw" && stripped) return { code: stripped, how: "raw" }
	if (stripped && skip == 0) return { code: stripped, how: "no fence" }
	return { how: "nothing" }
}

// enough of the answer has arrived: stop the model rather than wait for prose after the code
export function complete(text: string, wrap: Wrap, count: number) {
	if (wrap != "fence") return false
	return blocks(text).filter((b) => b.closed).length >= count
}
