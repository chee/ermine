// scene's host: the world, the scene seeded, two processes: view (draws the scene, and is the
// panels) and spinner (turns whatever is placed at /spin/target, by writing its transform node)
//
//   the scene   /scene is a tree of objects. an object is a node with three nodes under it:
//               transform (p: where, r: turned in degrees, s: size; each relative to its parent),
//               colour and shape (cube, sphere, line, none). every other name under it is a child
//   /spin       its target is a mount, placed here; "spin this" places another object there
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({
	render,
	processes: [{ name: "view", export: "view" }, { name: "spinner", export: "spin" }],
})

world.seed((host) => {
	const object = (
		at: string,
		o: { shape?: string; colour?: string; p?: number[]; r?: number[]; s?: number[] } = {},
	) => {
		host.ensureNode(`${at}/transform`, {
			p: o.p ?? [0, 0, 0],
			r: o.r ?? [0, 0, 0],
			s: o.s ?? [1, 1, 1],
		})
		host.ensureNode(`${at}/colour`, o.colour ?? "#ffffff")
		host.ensureNode(`${at}/shape`, o.shape ?? "none")
	}
	object("/scene/floor", { shape: "cube", colour: "#ffff88", p: [0, -0.06, 0], s: [7, 0.12, 7] })
	const c = "/scene/carousel"
	object(c)
	object(`${c}/base`, { shape: "cube", colour: "#ffd9ea", p: [0, 0.12, 0], s: [3.4, 0.24, 3.4] })
	object(`${c}/pole`, { shape: "cube", colour: "#ffffff", p: [0, 1.6, 0], s: [0.18, 2.72, 0.18] })
	object(`${c}/roof`, { shape: "sphere", colour: "#ff2284", p: [0, 3.3, 0], s: [3.4, 0.9, 3.4] })
	object(`${c}/bulb`, { shape: "sphere", colour: "#ffff88", p: [0, 3.9, 0], s: [0.4, 0.4, 0.4] })
	object(`${c}/arm-a`)
	object(`${c}/arm-b`, { r: [0, 120, 0] })
	object(`${c}/arm-c`, { r: [0, 240, 0] })
	// the pony: one object, placed under arm-a and (below) under arm-b
	const pony = `${c}/arm-a/pony`
	object(pony, { p: [1.3, 1.1, 0] })
	object(`${pony}/rod`, { shape: "line", colour: "#000000", s: [1, 1.9, 1] })
	object(`${pony}/body`, { shape: "cube", colour: "#40dcba", s: [0.34, 0.38, 0.86] })
	object(`${pony}/head`, {
		shape: "cube",
		colour: "#40dcba",
		p: [0, 0.34, 0.44],
		r: [-20, 0, 0],
		s: [0.26, 0.42, 0.28],
	})
	object(`${pony}/saddle`, {
		shape: "cube",
		colour: "#2269ff",
		p: [0, 0.21, -0.04],
		s: [0.38, 0.06, 0.34],
	})
	object(`${pony}/tail`, {
		shape: "sphere",
		colour: "#ff2284",
		p: [0, 0.12, -0.5],
		s: [0.16, 0.16, 0.16],
	})
	host.place(`${c}/arm-b/pony`, pony)
	// arm-c: a ball to sit on, not an instance
	const ball = `${c}/arm-c/ball`
	object(ball, { p: [1.3, 1.25, 0] })
	object(`${ball}/rod`, { shape: "line", colour: "#000000", s: [1, 1.75, 1] })
	object(`${ball}/seat`, { shape: "sphere", colour: "#2269ff", s: [0.62, 0.62, 0.62] })
	// what the spinner turns: the carousel, placed again at /spin/target (a mount)
	host.ensureNode("/spin/speed", 45)
	host.place("/spin/target", c)
})

export const reload = world.reload
