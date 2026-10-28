/** @jsxImportSource @ermine */
// @ermine/jsx-runtime's checks: the pragma finds it, and jsx makes @ermine/render's views. LLM
// generated
import { assert, assertEquals } from "@std/assert"
import { bind, isBound, isView, type View } from "@ermine/render/h"

Deno.test("@jsxImportSource @ermine: jsx makes a view, with its key, kids and bindings", () => {
	const v = (
		<ul class="list" key="a">
			<li>one</li>
			{bind("n")}
		</ul>
	) as View
	assert(isView(v))
	assertEquals([v.tag, v.key, v.props.class], ["ul", "a", "list"])
	const kids = v.kids[0] as unknown[]
	assert(isView(kids[0]) && isBound(kids[1]))
})

Deno.test("a component is called with its props; a fragment gives its kids", () => {
	const Hi = (p: { to: string }) => <b>hi {p.to}</b>
	const v = <Hi to="you" /> as View
	assertEquals(v.tag, "b")
	const f = (
		<>
			<i />
			text
		</>
	) as unknown as unknown[]
	assert(Array.isArray(f) && isView(f[0]) && f[1] === "text")
})
