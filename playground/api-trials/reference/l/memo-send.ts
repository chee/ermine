// @ts-nocheck: a program as a model would write it, untyped
import { edit, effect, memo, method, open, read, send, show } from "ermine"

export default function () {
	const text = open("./text", "hi")
	const loud = memo("loud", () => send("/services/upper", read(text)))
	effect("draw", () => read(loud), (v) => show(`loud: ${v}`))
	method("./on/set", (t) => edit(text, () => t))
}
