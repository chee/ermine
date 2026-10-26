// @ts-nocheck: a program as a model would write it, untyped
export default function (api) {
	const { usePath, useMemo, useEffect, method, send, show } = api
	const [text, patchText] = usePath("./text", "hi")
	const [loud] = useMemo("loud", () => send("/services/upper", text()))
	useEffect("draw", () => loud(), (v) => show(`loud: ${v}`))
	method("./on/set", (t) => patchText(t))
}
