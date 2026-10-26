// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const text = open("./text", "hi")
	const loud = memo("loud", () => send("/services/upper", text()))
	effect("draw", () => loud(), (v) => show(`loud: ${v}`))
	method("./on/set", (t) => text(t))
}
