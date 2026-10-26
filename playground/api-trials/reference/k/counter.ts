// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const [count, setCount] = createSignal(0, { name: "./count" })
	createMethod("./on/click", () => setCount((c) => c + 1))
	createEffect(() => count(), (n) => show(`count: ${n}`))
}
