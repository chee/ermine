// a program as a model would write it, untyped
import { Counter } from "./counter.jsx"

export default function () {
	const both = derived("both", () => [node("a/count").get(), node("b/count").get()])
	both.watch(() =>
		show(
			<div>
				<Counter name="a" />
				<Counter name="b" />
			</div>,
		)
	)
}
