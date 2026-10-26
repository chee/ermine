// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const [text, setText] = createSignal("hi", { name: "./text" })
	const loud = createMemo(() => send("/services/upper", text()), { name: "loud" })
	createEffect(() => loud(), (v) => show(`loud: ${v}`))
	createMethod("./on/set", (t) => setText(t))
}
