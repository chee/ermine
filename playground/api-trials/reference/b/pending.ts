// @ts-nocheck: a program as a model would write it, untyped
export default function (api) {
	const { open, memo, effect, status, show } = api
	const slow = open("/slow/value")
	const label = memo(
		"label",
		() => status(slow)?.state === "pending" ? "loading" : `got: ${slow()}`,
	)
	effect("draw", () => label(), (l) => show(l))
}
