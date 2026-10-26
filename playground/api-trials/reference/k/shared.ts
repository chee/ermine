// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const [, setList] = createStore([], { name: "/shared/list" })
	createMethod("./on/add", async (text) => {
		await check(text)
		setList((d) => {
			d.push(text)
		})
	})
}
