// clingy (clingy.ts) on a real scheduler
import { assertEquals } from "@std/assert"
import { createScheduler } from "@ermine/core/scheduler"
import { createClingy } from "./clingy.ts"

function setup() {
	const s = createScheduler()
	const root = s.createRootScope({ actor: "test" })
	const host = s.createRootScope({ actor: "host" })
	const gone: unknown[] = []
	const clingy = createClingy<object>(s, (k) => void gone.push(k))
	const on = {}
	const flip = () => {
		s.runWithScope(host, () => s.mark([on], undefined))
		s.pulse()
	}
	// a reader of key while its switch is on
	const reader = (key: object) => {
		let reading = true
		const c = s.runWithScope(root, () =>
			s.createComputer(() => {
				s.track(on)
				if (reading) s.track(key)
				return reading
			}, () => {}))
		s.pulse()
		const stop = () => {
			reading = false
			flip()
		}
		return { c, stop }
	}
	return { s, clingy, gone, reader }
}

Deno.test("clingy: tracked while a run tracks it; its last tracker gone, go told", () => {
	const { clingy, gone, reader } = setup()
	const k = {}
	clingy.add(k)
	assertEquals([clingy.has(k), clingy.tracked(k)], [true, false])
	const a = reader(k), b = reader(k)
	assertEquals(clingy.tracked(k), true)
	a.stop()
	assertEquals([clingy.tracked(k), gone], [true, []])
	b.stop()
	assertEquals([clingy.tracked(k), gone], [false, [k]])
})

Deno.test("clingy: told on each last tracker, and it stays added till dropped", () => {
	const { clingy, gone, reader } = setup()
	const k = {}
	clingy.add(k)
	reader(k).stop()
	reader(k).stop()
	assertEquals(gone, [k, k])
	clingy.drop(k)
	reader(k).stop()
	assertEquals([clingy.has(k), gone.length], [false, 2])
})

Deno.test("clingy: a torn-down tracker lets go too", () => {
	const { s, clingy, gone, reader } = setup()
	const k = {}
	clingy.add(k)
	const a = reader(k)
	s.teardown(a.c)
	assertEquals([clingy.tracked(k), gone], [false, [k]])
})

Deno.test("clingy: keys not added are not told; a read outside a run tracks nothing", () => {
	const { s, clingy, gone, reader } = setup()
	const k = {}, other = {}
	clingy.add(k)
	reader(other).stop()
	s.track(k)
	assertEquals([clingy.tracked(k), gone], [false, []])
})

Deno.test("clingy: adding again keeps what it knows; stop: told nothing more", () => {
	const { clingy, gone, reader } = setup()
	const k = {}
	clingy.add(k)
	const a = reader(k)
	clingy.add(k)
	assertEquals(clingy.tracked(k), true)
	clingy.stop()
	a.stop()
	assertEquals([clingy.has(k), gone], [false, []])
})
