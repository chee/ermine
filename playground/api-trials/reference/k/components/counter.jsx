// a component as a model would write it, untyped: the words are globals
export function Counter({ name }) {
	const [count, setCount] = createSignal(0, { name: `./${name}/count` })
	createMethod(`./${name}/on/click`, () => setCount((c) => c + 1))
	return <p>count: {count()}</p>
}
