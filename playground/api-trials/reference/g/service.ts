// @ts-nocheck: a program as a model would write it, untyped
export default async function () {
	const greeting = await node("/services/greet").call("mimi")
	node("greeting").set(greeting)
}
