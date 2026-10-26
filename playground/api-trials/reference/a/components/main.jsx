// a program as a model would write it, untyped
import { Counter } from "./counter.jsx"

export default function (api) {
	const { read, effect, show } = api
	// the counts the tree shows, read here so the effect runs again; its act shows the whole tree
	effect("view", () => [read("./a/count"), read("./b/count")], () =>
		show(
			<div>
				<Counter api={api} name="a" />
				<Counter api={api} name="b" />
			</div>,
		))
}
