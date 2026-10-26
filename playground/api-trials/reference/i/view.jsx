// a program as a model would write it, untyped
export default function () {
	const count = open("./count", 0)
	createMethod("./on/click", () => count((n) => n + 1))
	createEffect("draw", () => count(), (n) => show(<p>count: {n}</p>))
}
