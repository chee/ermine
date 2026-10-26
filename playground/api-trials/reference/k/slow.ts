// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const [value] = createSignal(undefined, { name: "/slow/value" })
	createEffect(() => value(), (v) => show(v === undefined ? "waiting" : `got: ${v}`))
}
