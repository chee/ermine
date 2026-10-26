// a program as a model would write it, untyped
import { Counter } from "./counter.jsx"

export default function (api) {
	const { usePath, useEffect, show } = api
	const [a] = usePath("./a/count")
	const [b] = usePath("./b/count")
	useEffect("view", () => [a(), b()], () =>
		show(
			<div>
				<Counter api={api} name="a" />
				<Counter api={api} name="b" />
			</div>,
		))
}
