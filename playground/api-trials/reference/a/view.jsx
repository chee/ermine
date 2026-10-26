// a program as a model would write it, untyped
export default function (api) {
	const { open, read, edit, effect, method, show } = api
	const count = open("./count", 0)
	method("./on/click", () => edit(count, (n) => n + 1))
	effect("draw", () => read(count), (n) => show(<p>count: {n}</p>))
}
