// a program as a model would write it, untyped
import { Counter } from "./counter.jsx"

export default function (me) {
	const A = Counter(me, "a")
	const B = Counter(me, "b")
	const a = me.node("./a/count")
	const b = me.node("./b/count")
	me.effect("view", (me) => [me.read(a), me.read(b)], (_now, _before, me) =>
		me.show(
			<div>
				<A me={me} />
				<B me={me} />
			</div>,
		))
}
