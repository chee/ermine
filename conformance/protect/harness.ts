// The reference protect on the line protocol: one JSON request per line in, one answer per line
// out, in order. Another implementation joins by speaking this.
//
// A policy is data here: "anyone", {rules: id}, {first: [policy, ...]}, or {answer} (always that
// answer). nodes: what read gives: {id: {value}} or {id: {}} (no value); an id left out: not loaded.
// Maps the reference takes (a node's info, children) are lists of [name, value] pairs, in order.
//
// { op: "may", policy, actor, ask: {op, args}, nodes }      →  { answer }
// { op: "check", policy, actor, asks: [{op, args}], nodes } →  { answer, at? }
// { op: "pass", route: [{node, name, ...}] }                →  { asks }
// { op: "list", node }                                      →  { ask }
// { op: "read", node: {id, value, info, children} }         →  { asks }
// { op: "edit", edit, node, object, at? }                   →  { ask }
// { op: "placing", node, name, before, after }              →  { asks }
// { op: "facts", actor, ask: {op, args} }                   →  { facts }
// { op: "matches", rule, facts }                            →  { matches }
import {
	type Answer,
	anyone,
	type Args,
	type Ask,
	check,
	edit,
	facts,
	first,
	list,
	matches,
	type May,
	pass,
	placing,
	type Read,
	read,
	rules,
	type Which,
} from "@ermine/protect"

export type Policy = "anyone" | { rules: string } | { first: Policy[] } | { answer: Answer }
// deno-lint-ignore no-explicit-any
export type Request = { op: string; [field: string]: any }

export function policy(p: Policy): May {
	if (p === "anyone") return anyone
	if ("rules" in p) return rules(p.rules)
	if ("first" in p) return first(...p.first.map(policy))
	const a = p.answer
	return () => a
}

const reader = (nodes: Record<string, { value?: unknown }>): Read => (id) =>
	Object.hasOwn(nodes, id) ? nodes[id] : undefined

export function answer(r: Request): unknown {
	switch (r.op) {
		case "may": {
			const ask = r.ask as Ask
			return { answer: policy(r.policy)(r.actor, ask.op, ask.args, reader(r.nodes ?? {})) }
		}
		case "check":
			return check(policy(r.policy), r.actor, r.asks as Ask[], reader(r.nodes ?? {}))
		case "pass":
			return { asks: pass(r.route) }
		case "list":
			return { ask: list(r.node) }
		case "read":
			return {
				asks: read({
					id: r.node.id,
					value: r.node.value,
					info: new Map(r.node.info),
					children: new Map(r.node.children),
				}),
			}
		case "edit":
			return { ask: edit(r.edit, r.node, r.object as Which, r.at) }
		case "placing":
			return { asks: placing(r.node, r.name, r.before, r.after) }
		case "facts":
			return { facts: facts(r.actor, r.ask.op, r.ask.args as Args) }
		case "matches":
			return { matches: matches(r.rule, r.facts) }
		default:
			return { error: `unknown op ${r.op}` }
	}
}

if (import.meta.main) {
	const out = Deno.stdout.writable.getWriter()
	const encoder = new TextEncoder()
	let buffer = ""
	for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
		buffer += chunk
		let i
		let text = ""
		while ((i = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, i)
			buffer = buffer.slice(i + 1)
			if (line.trim() === "") continue
			text += JSON.stringify(answer(JSON.parse(line))) + "\n"
		}
		if (text) await out.write(encoder.encode(text))
	}
}
