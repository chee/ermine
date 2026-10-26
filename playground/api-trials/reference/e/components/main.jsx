// a program as a model would write it, untyped
import { Counter } from "./counter.jsx"

export default function (e) {
	const A = Counter(e, "a")
	const B = Counter(e, "b")
	e.effect("view", (e) => [e.read("./a/count"), e.read("./b/count")], (e) =>
		e.show(
			<div>
				<A e={e} />
				<B e={e} />
			</div>,
		))
}
