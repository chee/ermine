// @ts-nocheck: a program as a model would write it, untyped
import { effect, read, show } from "ermine"

export default function () {
	effect("draw", () => read("/slow/value"), (v) => show(v === undefined ? "waiting" : `got: ${v}`))
}
