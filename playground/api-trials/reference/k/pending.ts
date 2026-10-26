// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const [slow] = createSignal(undefined, { name: "/slow/value" })
	const label = createMemo(
		() => isPending(() => slow()) ? "loading" : `got: ${slow()}`,
		{ name: "label" },
	)
	createEffect(() => label(), (l) => show(l))
}
