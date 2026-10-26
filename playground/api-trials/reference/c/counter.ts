// @ts-nocheck: a program as a model would write it, untyped
export default function (api) {
	const { usePath, useEffect, method, show } = api
	const [count, patchCount] = usePath("./count", 0)
	method("./on/click", () => patchCount((n) => n + 1))
	useEffect("draw", () => count(), (n) => show(`count: ${n}`))
}
