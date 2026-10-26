// @ts-nocheck: a program as a model would write it, untyped
export default function (api) {
	const { usePath, useMemo, useEffect, status, show } = api
	const [slow] = usePath("/slow/value")
	const [label] = useMemo(
		"label",
		() => status(slow)?.state === "pending" ? "loading" : `got: ${slow()}`,
	)
	useEffect("draw", () => label(), (l) => show(l))
}
