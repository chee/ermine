// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const text = open("./text", "hi")
	const loud = createMemo("loud", () => send("/services/upper", text()))
	createEffect("draw", () => loud(), (v) => show(`loud: ${v}`))
	createMethod("./on/set", (t) => text(t))
}
