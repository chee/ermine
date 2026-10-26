// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const slow = node("/slow/value")
	const label = derived("label", () => {
		const v = slow.get()
		return v === undefined ? "loading" : `got: ${v}`
	})
	label.watch((l) => show(l))
}
