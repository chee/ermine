// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	show("waiting")
	node("/slow/value").watch((v) => show(`got: ${v}`))
}
