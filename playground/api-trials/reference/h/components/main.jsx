// a program as a model would write it, untyped
import { Counter } from "./counter.jsx"

export default function () {
	const a = open("./a/count")
	const b = open("./b/count")
	effect("view", () => [a(), b()], () =>
		show(
			<div>
				<Counter name="a" />
				<Counter name="b" />
			</div>,
		))
}
