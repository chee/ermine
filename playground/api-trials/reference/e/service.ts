// @ts-nocheck: a program as a model would write it, untyped
export default async function (e) {
	const reply = await e.call("/services/greet", "mimi")
	e.write(e.node("./greeting"), reply)
}
