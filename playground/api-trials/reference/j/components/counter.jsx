// a component as a model would write it, untyped: the words are globals
export function Counter({ name }) {
	const count = open(`./${name}/count`, 0)
	method(`./${name}/on/click`, () => count((n) => n + 1))
	return <p>count: {count()}</p>
}
