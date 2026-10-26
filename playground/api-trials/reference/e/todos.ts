// @ts-nocheck: a program as a model would write it, untyped
export default function (e) {
	const todos = e.node("./todos", [])
	e.handler("./on/add", (e, text) => e.edit(todos, (d) => void d.push(text)))
	e.handler("./on/remove", (e, i) => e.edit(todos, (d) => void d.splice(i, 1)))
	e.effect("draw", (e) => e.read(todos), (e, t) => e.show(t.join(", ")))
}
