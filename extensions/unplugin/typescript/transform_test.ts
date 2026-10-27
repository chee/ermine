// the transform: rewrites by binding, refusals, nested arguments, aliasing, default and namespace
// imports, where the import goes, and that evaluation runs in the order it did
import { assert, assertEquals, assertThrows } from "@std/assert"
import { parse } from "@babel/parser"
import { Refused, transform } from "./transform.ts"

const T = (code: string, id = "/src/p.ts", options = {}) =>
	transform(code, id, { module: "ermine:site/0", ...options })
// the body only, the import written ahead of it cut
const body = (code: string) => T(code)!.code.replace(/^import \{[^}]*\} from "ermine:site\/0";/, "")

Deno.test("transform: a named import's calls, aliased too, each its own site; nested arguments too", () => {
	const out = T(`import { patch, read as r } from "@ermine/system"
patch("/x", [{ path: [], value: r("/y") }])
`)!
	assertEquals(
		out.code.split("\n")[1],
		`__ermine$at(__ermine$s0, patch)("/x", [{ path: [], value: __ermine$at(__ermine$s1, r)("/y") }])`,
	)
	assertEquals(out.sites, [{ line: 2, column: 1 }, { line: 2, column: 33 }])
	assert(
		out.code.startsWith(
			`import { at as __ermine$at, s0 as __ermine$s0, s1 as __ermine$s1 } from "ermine:site/0";`,
		),
	)
})

Deno.test("transform: namespace and default imports by member, dotted and computed", () => {
	const out = T(`import * as sys from "@ermine/system"
import def from "@ermine/system"
sys.patch(1); sys["ensureNode"](2); def.read(3); sys[k](4)
`)!
	assertEquals(
		out.code.split("\n")[2],
		`__ermine$at(__ermine$s0, sys.patch)(1); __ermine$at(__ermine$s1, sys["ensureNode"])(2); ` +
			`__ermine$at(__ermine$s2, def.read)(3); sys[k](4)`,
	)
	// as V8 places them: at the member; a computed one just after it
	assertEquals(out.sites, [{ line: 3, column: 5 }, { line: 3, column: 32 }, {
		line: 3,
		column: 41,
	}])
})

Deno.test("transform: by binding, not by name: shadowed, other modules', type-only, left as they are", () => {
	const src = `import { patch } from "@ermine/system"
import * as sys from "@ermine/system"
import { read } from "./mine.ts"
import type { list } from "@ermine/system"
import { type place } from "@ermine/system"
read(1); list(1); place(1)
function a(patch) { patch(1) }
const b = ({ x: [patch] }) => patch(1)
{ const patch = 1; patch(1) }
try {} catch (patch) { patch(1) }
for (const patch of []) patch(1)
function c() { if (x) { var patch } patch(1) }
function d() { sys.patch(1); { let sys; sys.patch(1) } }
class K { m(sys) { sys.patch(1) } }
patch(2)
`
	const out = T(src)!
	assertEquals(out.sites.length, 2)
	assertEquals(out.sites.map((s) => s.line), [13, 15])
	assertEquals(
		T(src.replace("patch(2)\n", "").replace("sys.patch(1);", ""), "/src/p.ts"),
		undefined,
	)
})

Deno.test("transform: optional calls, new, tagged templates and copies left as they are", () => {
	assertEquals(
		T(`import { patch } from "@ermine/system"
patch?.(1); new patch(); patch\`x\`; const p = patch; p(1); patch.call(null, 1)
`),
		undefined,
	)
})

Deno.test("transform: TypeScript and JSX parse; type arguments stay", () => {
	const out = T(`import { read } from "@ermine/system"
const n = read<number>("/x") as number
`)!
	assertEquals(
		out.code.split("\n")[1],
		`const n = __ermine$at(__ermine$s0, read)<number>("/x") as number`,
	)
	const jsx = T(
		`import { read } from "@ermine/system"
export const V = () => <div>{read("/x")}</div>
`,
		"/src/v.tsx",
	)!
	assert(jsx.code.includes(`{__ermine$at(__ermine$s0, read)("/x")}`))
})

Deno.test("transform: the import goes after a #! line and directives, on their line; lines stay", () => {
	// it parses as a module, its directive still one, the import first in the body, lines where they were
	const parses = (code: string, directives: number) => {
		const ast = parse(code, { sourceType: "module" }).program
		assertEquals(ast.directives.length, directives)
		assertEquals(ast.body[0].type, "ImportDeclaration")
	}
	const out = T(
		`#!/usr/bin/env -S deno run
"use strict"
import { patch } from "@ermine/system"
patch(1)
`,
		"/src/p.js",
	)!
	const lines = out.code.split("\n")
	assertEquals(lines[0], "#!/usr/bin/env -S deno run")
	assert(lines[1].startsWith(`"use strict";import { at as __ermine$at`))
	assertEquals(lines[3], "__ermine$at(__ermine$s0, patch)(1)")
	assertEquals(out.sites, [{ line: 4, column: 1 }])
	assert(out.map.mappings.length > 0)
	parses(out.code, 1)
	// a directive with its semicolon: none added
	const semi = T(`"use strict";\nimport { patch } from "@ermine/system"\npatch(1)\n`, "/src/q.js")!
	assert(semi.code.startsWith(`"use strict";import {`))
	parses(semi.code, 1)
	// a #! line alone: the import on the next line, never inside the #! line
	const bang = T(
		`#!/usr/bin/env node\nimport { patch } from "@ermine/system"\npatch(1)\n`,
		"/src/r.js",
	)!
	const b = bang.code.split("\n")
	assertEquals(b[0], "#!/usr/bin/env node")
	assert(b[1].startsWith("import { at as __ermine$at"))
	assertEquals(b.length, 4)
	parses(bang.code, 0)
})

Deno.test("transform: a source naming the site module, its entry, a file of it or a plugin local is refused", () => {
	const refused = [
		`import { s0 } from "ermine:site/0"`,
		`import "ermine:site"`,
		`export * from "ermine:site/3"`,
		`export { site } from "@ermine/system/site"`,
		`import { take } from "@ermine/system/typescript/site.ts"`,
		"const m = import(`ermine:site`)",
		`const m = require("@ermine/system/site")`,
		`import m = require("ermine:site/0")`,
		`const __ermine$s0 = 1`,
		`f(__ermine$at)`,
	]
	for (const src of refused) assertThrows(() => T(src), Refused, "only @ermine/unplugin writes it")
	// by path, a file of it
	assertThrows(
		() =>
			T(`import { site } from "../ermine/system/site.ts"`, "/repo/src/p.ts", {
				guarded: ["/repo/ermine/system/site.ts"],
				resolve: (s: string) => s.startsWith("../") ? "/repo/" + s.slice(3) : undefined,
			}),
		Refused,
		"/repo/src/p.ts:1:22",
	)
	// sites: false checks still, rewrites nothing
	assertThrows(() => T(`import "ermine:site"`, "/p.ts", { sites: false }), Refused)
	assertEquals(
		T(`import { patch } from "@ermine/system"\npatch(1)`, "/p.ts", { sites: false }),
		undefined,
	)
	// a mention in a string or comment is not a name
	assertEquals(T(`// ermine:site\nconst s = "__ermine$at"`), undefined)
})

Deno.test("transform: evaluation runs in its order; the site is set as the call starts", async () => {
	const log: string[] = []
	const g = globalThis as unknown as { __log: (s: string) => unknown }
	g.__log = (s: string) => (log.push(s), s)
	const out = T(
		`import { patch } from "@ermine/system"
patch(__log("a"), patch(__log("b")), __log("c"))
`,
		"/p.js",
	)!
	const sites = `data:text/javascript,${
		encodeURIComponent(`export const s0 = "s0", s1 = "s1"
export const at = (s, f) => (...a) => (globalThis.__log("call " + s), f(...a))`)
	}`
	const system = `data:text/javascript,${
		encodeURIComponent(`export const patch = (...a) => globalThis.__log("patch " + a.join(" "))`)
	}`
	const code = out.code.replace(`"ermine:site/0"`, JSON.stringify(sites)).replace(
		`"@ermine/system"`,
		JSON.stringify(system),
	)
	await import(`data:text/javascript,${encodeURIComponent(code)}`)
	assertEquals(log, ["a", "b", "call s1", "patch b", "c", "call s0", "patch a patch b c"])
})

Deno.test("transform: a decorator in a module that names site parses", () => {
	assertEquals(T("@dec class A {}\n// site\n"), undefined)
})

Deno.test("transform: a specifier to a guarded file is refused with or without its extension", () => {
	const guarded = ["/x/ermine/system/typescript/site.ts"]
	for (const spec of ["site.ts", "site", "site.js", "../typescript/site"]) {
		assertThrows(
			() =>
				T(`import "${spec}"`, "/x/ermine/system/typescript/a.ts", {
					guarded,
					resolve: (s: string) =>
						`/x/ermine/system/typescript/${s.replace(/^\.\.\/typescript\//, "")}`,
				}),
			Refused,
		)
	}
})

Deno.test("transform: lines count \\r\\n, \\r and U+2028 as the engine does", () => {
	// V8 counts \n, \r, \r\n, U+2028 and U+2029 as line ends
	for (const eol of ["\n", "\r\n", "\r", " ", " "]) {
		const out = T(`import { patch } from "@ermine/system"${eol}${eol}patch(1)`)!
		assertEquals(out.sites, [{ line: 3, column: 1 }], JSON.stringify(eol))
	}
})
