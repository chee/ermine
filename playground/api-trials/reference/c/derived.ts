// @ts-nocheck: a program as a model would write it, untyped
export default function (api) {
	const { usePath, useMemo, useEffect, method, show } = api
	const [n, patchN] = usePath("./n", 2)
	const [doubled] = useMemo("doubled", () => n() * 2)
	useEffect("draw", () => doubled(), (d) => show(`doubled: ${d}`))
	method("./on/set", (v) => patchN(v))
}
