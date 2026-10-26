// @ts-nocheck: a program as a model would write it, untyped
import { edit, here, method, open } from "ermine"

export default function ({ title }) {
	const titleNode = open("./title", "")
	const history = open("./history", [])
	method("./on/fetch", async (url) => {
		const back = here()
		const got = await title(url)
		back(() => {
			edit(titleNode, () => got)
			edit(history, (d) => void d.push(url))
		})
		return got
	})
}
