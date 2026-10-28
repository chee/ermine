/** @jsxImportSource @ermine */
// the demo, one visitor's: a counter, a list to add to and take from, and every visitor's clicks
// (/shared/clicks: one node every visitor's page binds). LLM generated: a prototype
import { createAction, createNode, ensureNode, patch, peep, read, remove } from "@ermine/system"
import { bind, type Child, handler, under } from "@ermine/render/h"
import type { Page } from "./live.ts"

const add = (path: string, n: number) =>
	patch(path, [{ path: [], value: (peep(() => read(path)) as number) + n }])

export const demo = <E,>({ into, options, render }: Page<E>) =>
	function visitor() {
		ensureNode("count", 0)
		ensureNode("items")
		createAction("on/inc", () => {
			add("count", 1)
			add("/shared/clicks", 1)
		})
		createAction("on/dec", () => {
			add("count", -1)
			add("/shared/clicks", 1)
		})
		createAction("on/add", (text: string) => {
			const t = String(text ?? "").trim()
			if (t) createNode("items", t)
		})
		createAction("on/remove", (name: string) => remove(`items/${name}`))
		render(into, view(), options)
	}

function view(): Child {
	return (
		<div class="page">
			<section>
				<h2>counter</h2>
				<button type="button" onClick={handler("on/dec")}>−</button>
				<output class={bind("count", (n: number) => n < 0 ? "below" : "")}>
					{bind("count")}
				</output>
				<button type="button" onClick={handler("on/inc")}>+</button>
				<p>every visitor's clicks: {bind("/shared/clicks")}</p>
			</section>
			<section>
				<h2>list</h2>
				<form
					onSubmit={handler(
						"on/add",
						(e: { target: { elements: { text: { value: string } } } }) => [
							e.target.elements.text.value,
						],
					)}
				>
					<input name="text" autocomplete="off" placeholder="something to add" />
					<button type="submit">add</button>
				</form>
				<ul>
					{under("items", (item) => (
						<li>
							{bind(item.at)}{" "}
							<button type="button" onClick={handler("on/remove", [item.name])}>×</button>
						</li>
					))}
				</ul>
			</section>
		</div>
	)
}
