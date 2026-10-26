// @ts-nocheck: a program as a model would write it, untyped
export default function (api) {
	const { usePath, useEffect, show } = api
	const [slow] = usePath("/slow/value")
	useEffect("draw", () => slow(), (v) => show(v === undefined ? "waiting" : `got: ${v}`))
}
