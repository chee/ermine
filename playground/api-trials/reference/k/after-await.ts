// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const [, setTitle] = createSignal("", { name: "./title" })
	const [, setHistory] = createStore([], { name: "./history" })
	createMethod("./on/fetch", async (url) => {
		const got = await title(url)
		setTitle(got)
		setHistory((d) => {
			d.push(url)
		})
		return got
	})
}
