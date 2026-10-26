// a program as a model would write it, untyped
import { Counter } from "./counter.jsx"

export default function (api) {
	const { open, effect, show } = api
	const a = open("./a/count")
	const b = open("./b/count")
	effect("view", () => [a.read(), b.read()], () =>
		show(
			<div>
				<Counter api={api} name="a" />
				<Counter api={api} name="b" />
			</div>,
		))
}
