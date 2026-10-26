// a program as a model would write it, untyped
import { Counter } from "./counter.jsx"

export default function () {
	const [a] = createSignal(undefined, { name: "./a/count" })
	const [b] = createSignal(undefined, { name: "./b/count" })
	createEffect(() => [a(), b()], () =>
		show(
			<div>
				<Counter name="a" />
				<Counter name="b" />
			</div>,
		))
}
