// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const [todos, setTodos] = createStore([], { name: "./todos" })
	createMethod("./on/add", (text) =>
		setTodos((d) => {
			d.push(text)
		}))
	createMethod("./on/remove", (i) =>
		setTodos((d) => {
			d.splice(i, 1)
		}))
	createEffect(() => todos.join(", "), (text) => show(text))
}
