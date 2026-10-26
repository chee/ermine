// @ts-nocheck: a program as a model would write it, untyped
import { edit, here, method, open } from "ermine"

export default function ({ check }) {
	const list = open("/shared/list", [])
	method("./on/add", async (text) => {
		const back = here()
		await check(text)
		back(() => edit(list, (d) => void d.push(text)))
	})
}
