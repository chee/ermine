// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const text = node("text", "hi")
	const loud = derived("loud", () => node("/services/upper").call(text.get()))
	loud.watch((v) => show(`loud: ${v}`))
	on("on/set", (t) => text.set(t))
}
