// Rewrites each call to an @ermine/system function so it carries its site, and refuses source
// that names the site module, its runtime entry or the plugin's own locals. It depends only on
// the source.
//
//   import { patch } from "@ermine/system"          import { at as __ermine$at, s0 as __ermine$s0 }
//   patch("/x", [p])                           →      from "ermine:site/0";import { patch } ...
//                                                     __ermine$at(__ermine$s0, patch)("/x", [p])
//
// The import goes ahead of line 1, so source lines stay put. A site is a line and column, both
// from 1, as V8 places the call.
import { parse } from "@babel/parser"
import MagicString from "magic-string"

export const SITE_MODULE = "ermine:site"
export const SITE_ENTRY = "@ermine/system/site"
export const SYSTEM = "@ermine/system"
export const RESERVED = "__ermine$"

export class Refused extends Error {
	constructor(
		readonly id: string,
		readonly line: number | undefined,
		readonly column: number | undefined,
		what: string,
	) {
		super(
			`${line === undefined ? id : `${id}:${line}:${column}`}: ${what}: only @ermine/bundling ` +
				`writes it (a build site a program could name could be one not its own)`,
		)
		this.name = "Refused"
	}
}

export type TransformOptions = {
	module?: string
	sites?: boolean
	guarded?: readonly string[]
	resolve?: (specifier: string) => string | undefined
}

export type Rewritten = {
	code: string
	map: ReturnType<MagicString["generateMap"]>
	sites: { line: number; column: number }[]
}

type Node = {
	type: string
	start: number
	end: number
	loc: { start: { line: number; column: number } }
	[key: string]: unknown
}

export function refusedSpecifier(
	spec: string,
	guarded: readonly string[] = [],
	resolve?: (s: string) => string | undefined,
): boolean {
	if (spec.includes(SITE_MODULE)) return true
	if (/^@ermine\/system\/(typescript\/)?site(\.ts)?([?#].*)?$/.test(spec)) return true
	if (guarded.length === 0 || resolve === undefined) return false
	const file = resolve(spec)
	return file !== undefined && guarded.some((g) => bare(g) === bare(file))
}
const bare = (path: string) => path.replace(/\/index(?=\.|$)/, "").replace(/\.[cm]?[jt]sx?$/, "")

export const mayNeed = (code: string): boolean =>
	code.includes("ermine") || code.includes(RESERVED) || code.includes("site")

// The rewrite of the code, undefined if there is nothing to rewrite. Throws Refused for a name
// that is not allowed.
export function transform(
	code: string,
	id: string,
	options: TransformOptions = {},
): Rewritten | undefined {
	const program = parse(code, {
		sourceType: "module",
		sourceFilename: id,
		plugins: pluginsFor(id),
	}).program as unknown as Node
	const guarded = options.guarded ?? []
	const refuse = (n: Node, what: string): never => {
		throw new Refused(id, n.loc.start.line, n.loc.start.column + 1, what)
	}
	const checkSpecifier = (n: unknown) => {
		const s = literal(n)
		if (s !== undefined && refusedSpecifier(s, guarded, options.resolve)) {
			refuse(n as Node, `names ${JSON.stringify(s)}`)
		}
	}

	const named = new Set<string>()
	const spaces = new Set<string>()
	for (const s of program.body as Node[]) {
		if (s.type !== "ImportDeclaration" || literal(s.source) !== SYSTEM) continue
		if (s.importKind === "type") continue
		for (const sp of s.specifiers as Node[]) {
			const local = (sp.local as Node).name as string
			if (sp.type === "ImportSpecifier" && sp.importKind !== "type") named.add(local)
			else if (sp.type !== "ImportSpecifier") spaces.add(local)
		}
	}
	const rewriting = options.sites !== false && (named.size > 0 || spaces.size > 0)

	const out = new MagicString(code)
	const sites: { line: number; column: number }[] = []
	const scopes: Set<string>[] = []
	const shadowed = (name: string) => scopes.some((s) => s.has(name))

	const callee = (c: Node): Node | undefined => {
		if (c.type === "Identifier") {
			return named.has(c.name as string) && !shadowed(c.name as string) ? c : undefined
		}
		if (c.type !== "MemberExpression") return undefined
		const o = c.object as Node
		if (o.type !== "Identifier" || !spaces.has(o.name as string) || shadowed(o.name as string)) {
			return undefined
		}
		const p = c.property as Node
		if (!c.computed && p.type === "Identifier") return p
		if (c.computed && p.type === "StringLiteral") return c
		return undefined
	}
	// V8 places a call at the callee's name, at the member of a member call, just after a computed
	// member, and at the parenthesis of a parenthesized callee.
	const placeOf = (c: Node, at: Node): { line: number; column: number } => {
		const paren = (c.extra as { parenStart?: number } | undefined)?.parenStart
		const offset = paren ?? (at === c && c.type === "MemberExpression" ? c.end : at.start)
		return position(offset)
	}
	const starts = [0]
	for (const m of code.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) starts.push(m.index + m[0].length)
	const position = (offset: number) => {
		let lo = 0
		let hi = starts.length - 1
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1
			if (starts[mid] <= offset) lo = mid
			else hi = mid - 1
		}
		return { line: lo + 1, column: offset - starts[lo] + 1 }
	}

	function visit(n: Node) {
		switch (n.type) {
			case "Identifier":
			case "JSXIdentifier":
				if ((n.name as string).startsWith(RESERVED)) refuse(n, `names ${n.name}`)
				return
			case "ImportDeclaration":
			case "ExportNamedDeclaration":
			case "ExportAllDeclaration":
				if (n.source) checkSpecifier(n.source)
				break
			case "ImportExpression":
				checkSpecifier(n.source)
				break
			case "TSExternalModuleReference":
				checkSpecifier(n.expression)
				break
			case "CallExpression": {
				const c = n.callee as Node
				const args = n.arguments as Node[]
				if (
					(c.type === "Import" || (c.type === "Identifier" && c.name === "require")) && args[0]
				) {
					checkSpecifier(args[0])
				}
				const at = rewriting ? callee(c) : undefined
				if (at !== undefined) {
					const local = `${RESERVED}s${sites.length}`
					sites.push(placeOf(c, at))
					out.appendLeft(c.start, `${RESERVED}at(${local}, `)
					out.prependRight(c.end, ")")
				}
				break
			}
		}
		const scope = opens(n)
		if (scope !== undefined) scopes.push(scope)
		for (const k in n) {
			if (SKIP.has(k)) continue
			const v = n[k]
			if (Array.isArray(v)) {
				for (const x of v) if (isNode(x)) visit(x)
			} else if (isNode(v)) visit(v)
		}
		if (scope !== undefined) scopes.pop()
	}
	for (const s of program.body as Node[]) visit(s)
	if (sites.length === 0) return undefined

	const names = [`at as ${RESERVED}at`, ...sites.map((_, i) => `s${i} as ${RESERVED}s${i}`)]
	const head = `import { ${names.join(", ")} } from ${
		JSON.stringify(options.module ?? SITE_MODULE)
	};`
	const at = headAt(code, program)
	out.prependLeft(at.at, at.before + head)
	return {
		code: out.toString(),
		map: out.generateMap({ hires: true, source: id, includeContent: true }),
		sites,
	}
}

const SKIP = new Set([
	"loc",
	"start",
	"end",
	"range",
	"extra",
	"leadingComments",
	"trailingComments",
	"innerComments",
	"typeAnnotation",
	"returnType",
	"typeParameters",
	"typeArguments",
	"superTypeParameters",
	"superTypeArguments",
])

const isNode = (x: unknown): x is Node =>
	typeof x === "object" && x !== null && typeof (x as Node).type === "string"

const literal = (n: unknown): string | undefined => {
	if (!isNode(n)) return undefined
	if (n.type === "StringLiteral") return n.value as string
	const q = n.quasis as Node[] | undefined
	if (
		n.type === "TemplateLiteral" && (n.expressions as unknown[]).length === 0 && q?.length === 1
	) {
		return (q[0].value as { cooked?: string }).cooked
	}
	return undefined
}

function pluginsFor(id: string): ("typescript" | "jsx" | "decorators")[] {
	const file = id.replace(/[?#].*$/, "")
	if (/\.[cm]?ts$/.test(file)) return ["typescript", "decorators"]
	if (/\.tsx$/.test(file)) return ["typescript", "jsx", "decorators"]
	return ["jsx", "decorators"]
}

// Where the import goes: after the directives, or after a #! line, or at the very start. Source
// lines never move.
function headAt(code: string, program: Node): { at: number; before: string } {
	const directives = program.directives as Node[] | undefined
	if (directives !== undefined && directives.length > 0) {
		const end = directives[directives.length - 1].end as number
		return { at: end, before: code[end - 1] === ";" ? "" : ";" }
	}
	if (program.interpreter || code.startsWith("#!")) {
		const nl = code.indexOf("\n")
		return nl === -1 ? { at: code.length, before: "\n" } : { at: nl + 1, before: "" }
	}
	return { at: 0, before: "" }
}

function opens(n: Node): Set<string> | undefined {
	switch (n.type) {
		case "FunctionDeclaration":
		case "FunctionExpression":
		case "ArrowFunctionExpression":
		case "ObjectMethod":
		case "ClassMethod":
		case "ClassPrivateMethod": {
			const names = new Set<string>(["arguments"])
			if (n.type === "FunctionExpression" && n.id) names.add((n.id as Node).name as string)
			for (const p of n.params as Node[]) bound(p, names)
			const body = n.body as Node
			if (body.type === "BlockStatement") {
				vars(body, names)
				lexical(body.body as Node[], names)
			}
			return names
		}
		case "BlockStatement":
		case "StaticBlock": {
			const names = new Set<string>()
			lexical(n.body as Node[], names)
			return names.size > 0 ? names : undefined
		}
		case "SwitchStatement": {
			const names = new Set<string>()
			for (const c of n.cases as Node[]) lexical(c.consequent as Node[], names)
			return names.size > 0 ? names : undefined
		}
		case "CatchClause": {
			const names = new Set<string>()
			if (n.param) bound(n.param as Node, names)
			return names
		}
		case "ForStatement":
		case "ForInStatement":
		case "ForOfStatement": {
			const head = (n.type === "ForStatement" ? n.init : n.left) as Node | null
			if (head?.type !== "VariableDeclaration" || head.kind === "var") return undefined
			const names = new Set<string>()
			for (const d of head.declarations as Node[]) bound(d.id as Node, names)
			return names
		}
		case "ClassExpression":
			return n.id ? new Set([(n.id as Node).name as string]) : undefined
		case "TSModuleBlock": {
			const names = new Set<string>()
			lexical(n.body as Node[], names)
			vars(n, names)
			return names
		}
	}
	return undefined
}

function bound(p: Node, into: Set<string>) {
	switch (p.type) {
		case "Identifier":
			into.add(p.name as string)
			return
		case "ObjectPattern":
			for (const q of p.properties as Node[]) {
				bound((q.type === "RestElement" ? q.argument : q.value) as Node, into)
			}
			return
		case "ArrayPattern":
			for (const q of p.elements as (Node | null)[]) if (q) bound(q, into)
			return
		case "AssignmentPattern":
			bound(p.left as Node, into)
			return
		case "RestElement":
			bound(p.argument as Node, into)
			return
		case "TSParameterProperty":
			bound(p.parameter as Node, into)
			return
	}
}

function lexical(statements: Node[], into: Set<string>) {
	for (let s of statements) {
		if (s.type === "ExportNamedDeclaration" || s.type === "ExportDefaultDeclaration") {
			if (!isNode(s.declaration)) continue
			s = s.declaration
		}
		if (s.type === "VariableDeclaration" && s.kind !== "var") {
			for (const d of s.declarations as Node[]) bound(d.id as Node, into)
		} else if (
			(s.type === "FunctionDeclaration" || s.type === "ClassDeclaration" ||
				s.type === "TSEnumDeclaration" || s.type === "TSModuleDeclaration") &&
			isNode(s.id) && s.id.type === "Identifier"
		) {
			if (s.declare !== true) into.add(s.id.name as string)
		}
	}
}

function vars(n: Node, into: Set<string>) {
	for (const k in n) {
		if (SKIP.has(k)) continue
		const v = n[k]
		for (const x of Array.isArray(v) ? v : [v]) {
			if (!isNode(x)) continue
			if (x.type === "VariableDeclaration" && x.kind === "var" && x.declare !== true) {
				for (const d of x.declarations as Node[]) bound(d.id as Node, into)
			}
			if (FUNCTIONS.has(x.type)) continue
			vars(x, into)
		}
	}
}

const FUNCTIONS = new Set([
	"FunctionDeclaration",
	"FunctionExpression",
	"ArrowFunctionExpression",
	"ObjectMethod",
	"ClassMethod",
	"ClassPrivateMethod",
])
