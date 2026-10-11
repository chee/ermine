// who may do what (PROTECT.tex), and nothing else. only the scheduler calls it: it
// asks before each operation, and gives the actor what the answers allow. nothing here reads the
// graph: a policy's own reads go through the read the scheduler gives, which it tracks.

// why a refusal: a code and its details
export type Why = { code: string; [detail: string]: unknown }
export type Answer = { yes: true } | { no: Why } | { pending: true }

// an object of a node: "value", ["info", name], ["children", name], or "order"
export type Which = "value" | "order" | readonly ["info" | "children", string]

// what is asked, about one node
export type Args = {
	node: string
	object?: Which
	name?: string
	id?: string
	at?: number | readonly [number, number]
}
export type Ask = { op: string; args: Args }

// a policy's read: a node's value, {} if it has none; none: not loaded
export type Read = (id: string) => { value?: unknown } | undefined

export type May = (actor: unknown, op: string, args: Args, read: Read) => Answer

export const yes: Answer = Object.freeze({ yes: true })
export const anyone: May = () => yes

const isYes = (a: Answer): a is { yes: true } => "yes" in a

// the first answer not yes, outside in
export function first(...mays: May[]): May {
	return (actor, op, args, read) => {
		for (const may of mays) {
			const a = may(actor, op, args, read)
			if (!isYes(a)) return a
		}
		return yes
	}
}

// asks in order: the first answer not yes, and its place; all yes: yes, at none
export function check(
	may: May,
	actor: unknown,
	asks: Iterable<Ask>,
	read: Read,
): { answer: Answer; at?: number } {
	let i = 0
	for (const { op, args } of asks) {
		const answer = may(actor, op, args, read)
		if (!isYes(answer)) return { answer, at: i }
		i++
	}
	return { answer: yes }
}

// what is asked

// by path: pass at each step of a route, at the node whose list it is, by the step's name
export const pass = (route: Iterable<{ node: string; name: string }>): Ask[] =>
	[...route].map((s) => ({ op: "pass", args: { node: s.node, name: s.name } }))

// by path: a node's names read without a name
export const list = (node: string): Ask => ({ op: "list", args: { node } })

// by node: read, per object of a node
export function read(node: {
	id: string
	value: readonly unknown[]
	info: ReadonlyMap<string, unknown>
	children: ReadonlyMap<string, unknown>
}): Ask[] {
	const asks: Ask[] = []
	if (node.value.length > 0) asks.push({ op: "read", args: { node: node.id, object: "value" } })
	for (const name of node.info.keys()) {
		asks.push({ op: "read", args: { node: node.id, object: ["info", name] } })
	}
	for (const name of node.children.keys()) {
		asks.push({ op: "read", args: { node: node.id, object: ["children", name] } })
	}
	return asks
}

// by node: an edit at an object, at its version
export const edit = (
	op: string,
	node: string,
	object: Which,
	at: number | readonly [number, number] = 0,
): Ask => ({ op, args: { node, object, at } })

// by node: a list's ids before and after: unplace for each removed, place for each added, as
// often as it was; one may place only what one may read: the caller adds read at each added id
// whose node is loaded
export function placing(
	node: string,
	name: string,
	before: readonly unknown[],
	after: readonly unknown[],
): Ask[] {
	const count = new Map<string, number>()
	for (const id of before) if (typeof id === "string") count.set(id, (count.get(id) ?? 0) + 1)
	const added: string[] = []
	for (const id of after) {
		if (typeof id !== "string") continue
		const n = count.get(id) ?? 0
		if (n > 0) count.set(id, n - 1)
		else added.push(id)
	}
	const asks: Ask[] = []
	for (const [id, n] of count) {
		for (let i = 0; i < n; i++) asks.push({ op: "unplace", args: { node, name, id } })
	}
	for (const id of added) asks.push({ op: "place", args: { node, name, id } })
	return asks
}

// rules (PROTECT.tex, Rules)

export type Rule = {
	actor?: unknown
	peer?: unknown
	person?: unknown
	trusted?: unknown
	process?: string
	program?: string
	op?: string
	node?: string
	id?: string
	name?: string
	object?: Which
	allow: boolean
}

const FIELDS = new Set([
	"actor",
	"peer",
	"person",
	"trusted",
	"process",
	"program",
	"op",
	"node",
	"id",
	"name",
	"object",
	"allow",
])

const isMap = (x: unknown): x is Record<string, unknown> =>
	x !== null && typeof x === "object" && !Array.isArray(x)

function equal(a: unknown, b: unknown): boolean {
	if (a === b) return true
	if (Array.isArray(a)) {
		return Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]))
	}
	if (!isMap(a) || !isMap(b)) return false
	const ka = Object.keys(a)
	return ka.length === Object.keys(b).length &&
		ka.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]))
}

// what a rule is matched against: the actor's own actor, else the whole actor; its own peer,
// person and trusted; process and program from its code's last step; and the ask's
export function facts(actor: unknown, op: string, args: Args): Record<string, unknown> {
	const a = isMap(actor) ? actor : undefined
	const f: Record<string, unknown> = { actor: a && Object.hasOwn(a, "actor") ? a.actor : actor }
	for (const k of ["peer", "person", "trusted"]) if (a && Object.hasOwn(a, k)) f[k] = a[k]
	const code = a && Array.isArray(a.code) ? a.code : []
	const last = code[code.length - 1]
	if (isMap(last)) {
		if (typeof last.process === "string") f.process = last.process
		const program = isMap(last.program) ? last.program.node : last.program
		if (typeof program === "string") f.program = program
	}
	f.op = op
	for (const [k, v] of Object.entries(args)) if (v !== undefined) f[k] = v
	return f
}

// every field a rule gives equals the ask's; one the ask lacks never matches
export function matches(rule: Record<string, unknown>, f: Record<string, unknown>): boolean {
	if (!isMap(rule)) return false
	for (const k of Object.keys(rule)) {
		if (k === "allow" || rule[k] === undefined) continue
		if (!Object.hasOwn(f, k) || !equal(rule[k], f[k])) return false
	}
	return true
}

function malformed(list: unknown): string | undefined {
	if (!Array.isArray(list)) return "rules are a list of rules"
	for (const rule of list) {
		if (!isMap(rule)) return "rules are a list of rules"
		for (const k of Object.keys(rule)) if (!FIELDS.has(k)) return `a rule has no field ${k}`
		if (typeof rule.allow !== "boolean") return "a rule's allow is true or false"
	}
}

// each list's check, once per value: a new value is a new object, so the same object is the same
// list. "" when well formed
const checked = new WeakMap<object, string>()
function wrongOf(list: unknown): string | undefined {
	if (list === null || typeof list !== "object") return malformed(list)
	let wrong = checked.get(list)
	if (wrong === undefined) checked.set(list, wrong = malformed(list) ?? "")
	return wrong || undefined
}

// a may reading its rules from the value of the node rulesAt, through read, at each ask: the
// first rule matching wins; none: allowed. not loaded: pending; not a list of rules: refused
export function rules(rulesAt: string): May {
	return (actor, op, args, read) => {
		const got = read(rulesAt)
		if (got === undefined) return { pending: true }
		const wrong = wrongOf(got.value)
		if (wrong) return { no: { code: "wrong-field", field: "rules", text: wrong } }
		const list = got.value as Record<string, unknown>[]
		const f = facts(actor, op, args)
		for (let rule = 0; rule < list.length; rule++) {
			if (!matches(list[rule], f)) continue
			return list[rule].allow ? yes : { no: { code: "rule", rule } }
		}
		return yes
	}
}
