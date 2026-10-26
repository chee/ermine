// @ts-nocheck: a program as a model would write it, untyped
import { effect, memo, read, show, status } from "ermine"

export default function () {
	const label = memo(
		"label",
		() => status("/slow/value")?.state === "pending" ? "loading" : `got: ${read("/slow/value")}`,
	)
	effect("draw", () => read(label), (l) => show(l))
}
