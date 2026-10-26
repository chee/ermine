// a component as a model would write it, untyped: the words come in its props (api)
export function Counter({ api, name }) {
	const { open, read, edit, method } = api
	const count = open(`./${name}/count`, 0)
	method(`./${name}/on/click`, () => edit(count, (n) => n + 1))
	return <p>count: {read(count)}</p>
}
