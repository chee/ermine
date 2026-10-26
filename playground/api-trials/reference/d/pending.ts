// @ts-nocheck: a program as a model would write it, untyped
export default function (api) {
	const { open, memo, effect, show } = api
	const slow = open("/slow/value")
	const label = memo(
		"label",
		() => slow.status()?.state === "pending" ? "loading" : `got: ${slow.read()}`,
	)
	effect("draw", () => label.read(), (l) => show(l))
}
