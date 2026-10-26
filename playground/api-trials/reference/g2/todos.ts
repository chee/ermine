// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const todos = node("todos", [])
	on("on/add", (text) =>
		todos.update((list) => {
			list.push(text)
		}))
	on("on/remove", (i) =>
		todos.update((list) => {
			list.splice(i, 1)
		}))
	todos.watch((list) => show(list.join(", ")))
}
