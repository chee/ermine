// @ts-nocheck: a program as a model would write it, untyped
// a memo can't call (e.call is not in a memo's f): an effect's act asks, and writes ./loud
export default function (e) {
	const text = e.node("./text", "hi")
	const loud = e.node("./loud")
	e.effect("ask", (e) => e.read(text), async (e, t) => {
		e.write(loud, await e.call("/services/upper", t))
	})
	e.effect("draw", (e) => e.read(loud), (e, v) => {
		if (v !== null) e.show(`loud: ${v}`)
	})
	e.handler("./on/set", (e, t) => e.write(text, t))
}
