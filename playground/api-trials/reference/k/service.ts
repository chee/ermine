// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	createMemo(() => send("/services/greet", "mimi"), { name: "./greeting" })
}
