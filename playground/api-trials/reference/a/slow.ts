// @ts-nocheck: a program as a model would write it, untyped
export default function (api) {
	const { read, effect, show } = api
	effect("draw", () => read("/slow/value"), (v) => show(v === undefined ? "waiting" : `got: ${v}`))
}
