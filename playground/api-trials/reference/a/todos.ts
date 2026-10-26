// @ts-nocheck: a program as a model would write it, untyped
export default function (api) {
	const { open, read, edit, effect, method, show } = api
	const todos = open("./todos", [])
	method("./on/add", (text) => edit(todos, (d) => void d.push(text)))
	method("./on/remove", (i) => edit(todos, (d) => void d.splice(i, 1)))
	effect("draw", () => read(todos), (t) => show(t.join(", ")))
}
