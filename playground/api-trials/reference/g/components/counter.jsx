// a component as a model would write it, untyped: the words are globals
export function Counter({ name }) {
	const count = node(`${name}/count`, 0)
	on(`${name}/on/click`, () => count.set(count.get() + 1))
	return <p>count: {count.get()}</p>
}
