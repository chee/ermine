// a component as a model would write it, untyped. a factory: an act's me can't answer, so
// Counter is made with the setup's me; it gives back the view, drawn with the me it is given
export function Counter(me, name) {
	const count = me.make(`./${name}/count`, 0)
	me.answer(`./${name}/on/click`, (me) => me.write(count, me.read(count) + 1))
	return ({ me }) => <p>count: {me.read(count)}</p>
}
