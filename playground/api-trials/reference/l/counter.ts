// @ts-nocheck: a program as a model would write it, untyped
import { edit, effect, method, open, read, show } from "ermine"

export default function () {
	const count = open("./count", 0)
	method("./on/click", () => edit(count, (n) => n + 1))
	effect("draw", () => read(count), (n) => show(`count: ${n}`))
}
