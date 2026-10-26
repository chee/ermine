// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const slow = open("/slow/value")
	const label = createMemo(
		"label",
		() => getStatus(slow)?.state === "pending" ? "loading" : `got: ${slow()}`,
	)
	createEffect("draw", () => label(), (l) => show(l))
}
