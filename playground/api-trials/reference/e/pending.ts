// @ts-nocheck: a program as a model would write it, untyped
export default function (e) {
	const slow = e.node("/slow/value")
	const label = e.memo(
		"label",
		(e) => e.status(slow).state === "pending" ? "loading" : `got: ${e.read(slow)}`,
	)
	e.effect("draw", (e) => e.read(label), (e, l) => e.show(l))
}
