// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	// a setup that sends to nothing stays pending: send in an effect, which runs again once it answers
	createEffect(
		"greet",
		() => send("/services/greet", "mimi"),
		(reply) => open("./greeting", reply),
	)
}
