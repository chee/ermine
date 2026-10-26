// a component as a model would write it, untyped. a factory: only the program's e places a
// handler, so Counter is made with it; it gives back the view, drawn with the e it is given
export function Counter(e, name) {
	const count = e.node(`./${name}/count`, 0)
	e.handler(`./${name}/on/click`, (e) => e.edit(count, (n) => n + 1))
	return ({ e }) => <p>count: {e.read(count)}</p>
}
