// @ts-nocheck: a program as a model would write it, untyped
export default function (api) {
	const { usePath, useEffect, send } = api
	// a setup that sends to nothing stays pending: send in an effect, which runs again once it answers
	useEffect("greet", () => send("/services/greet", "mimi"), (reply) => usePath("./greeting", reply))
}
