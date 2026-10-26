// a component as a model would write it, untyped: the words imported, found from the scope open
import { edit, method, open, read } from "ermine"

export function Counter({ name }) {
	const count = open(`./${name}/count`, 0)
	method(`./${name}/on/click`, () => edit(count, (n) => n + 1))
	return <p>count: {read(count)}</p>
}
