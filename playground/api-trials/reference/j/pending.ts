// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const slow = open("/slow/value")
	const label = memo("label", () => slow() === undefined ? "loading" : `got: ${slow()}`)
	effect("draw", () => label(), (l) => show(l))
}
