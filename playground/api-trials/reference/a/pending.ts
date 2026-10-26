// @ts-nocheck: a program as a model would write it, untyped
export default function (api) {
	const { read, memo, effect, status, show } = api
	const label = memo(
		"label",
		() => status("/slow/value")?.state === "pending" ? "loading" : `got: ${read("/slow/value")}`,
	)
	effect("draw", () => read(label), (l) => show(l))
}
