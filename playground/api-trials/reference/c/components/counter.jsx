// a component as a model would write it, untyped: the words come in its props (api)
export function Counter({ api, name }) {
	const { usePath, method } = api
	const [count, patchCount] = usePath(`./${name}/count`, 0)
	method(`./${name}/on/click`, () => patchCount((n) => n + 1))
	return <p>count: {count()}</p>
}
