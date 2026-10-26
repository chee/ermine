// a program as a model would write it, untyped
import { effect, read, show } from "ermine"
import { Counter } from "./counter.jsx"

export default function () {
	// the counts the tree shows, read here so the effect runs again; its act shows the whole tree
	effect("view", () => [read("./a/count"), read("./b/count")], () =>
		show(
			<div>
				<Counter name="a" />
				<Counter name="b" />
			</div>,
		))
}
