// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const [n, setN] = createSignal(2, { name: "./n" })
	const doubled = createMemo(() => n() * 2, { name: "doubled" })
	createEffect(() => doubled(), (d) => show(`doubled: ${d}`))
	createMethod("./on/set", (v) => setN(v))
}
