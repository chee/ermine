// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const slow = open("/slow/value")
	createEffect("draw", () => slow(), (v) => show(v === undefined ? "waiting" : `got: ${v}`))
}
