// @ts-nocheck: a program as a model would write it, untyped
export default function (api) {
	const { open, effect, method, show } = api
	const todos = open("./todos", [])
	method("./on/add", (text) => todos.edit((d) => void d.push(text)))
	method("./on/remove", (i) => todos.edit((d) => void d.splice(i, 1)))
	effect("draw", () => todos.read(), (t) => show(t.join(", ")))
}
