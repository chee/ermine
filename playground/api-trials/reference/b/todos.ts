// @ts-nocheck: a program as a model would write it, untyped
export default function (api) {
	const { open, effect, method, show } = api
	const todos = open("./todos", [])
	method("./on/add", (text) => todos((d) => void d.push(text)))
	method("./on/remove", (i) => todos((d) => void d.splice(i, 1)))
	effect("draw", () => todos(), (t) => show(t.join(", ")))
}
