/// <reference lib="dom" />
// the things' little pictures (the kit's letters: K ink, W white, P cherry, Y yellow, S grey)
import { pixels } from "./kit/sprites.ts"

export const PICTURES: Record<string, string[]> = {
	button: [
		"............",
		"....PPPP....",
		"..PPPPPPPP..",
		".PPWWPPPPPP.",
		".PPPPPPPPPP.",
		"..PPPPPPPP..",
		"KKKKKKKKKKKK",
		"KSSSSSSSSSSK",
		"KKKKKKKKKKKK",
	],
	counter: [
		"KKKKKKKKKKKK",
		"KWWWWWWWWWWK",
		"KWWWKWWKKWWK",
		"KWWKKWWWWKWK",
		"KWWWKWWWKWWK",
		"KWWWKWWKWWWK",
		"KWWKKKWKKKWK",
		"KWWWWWWWWWWK",
		"KKKKKKKKKKKK",
	],
	screen: [
		"KKKKKKKKKKKK",
		"KKKKKKKKKKKK",
		"KKYYYYKKKKKK",
		"KKKKKKKKKKKK",
		"KKYYYYYYYKKK",
		"KKKKKKKKKKKK",
		"KKKKKKKKKKKK",
		".....SS.....",
		"...SSSSSS...",
	],
	timer: [
		"...KKKKKK...",
		"..KWWWWWWK..",
		".KWWWWKWWWK.",
		".KWWWWKWWWK.",
		".KWWWWKPPWK.",
		".KWWWWWWWWK.",
		".KWWWWWWWWK.",
		"..KWWWWWWK..",
		"...KKKKKK...",
	],
	sound: [
		"......K.....",
		".....KK..P..",
		"KKKKKWK...P.",
		"KWWWWWK.P..P",
		"KWWWWWK..P.P",
		"KWWWWWK.P..P",
		"KKKKKWK...P.",
		".....KK..P..",
		"......K.....",
	],
	pad: [
		"KKKKKKKKKKKK",
		"KWWWWWWWWWWK",
		"KWKKWWWWWWWK",
		"KWWKKWWWKWWK",
		"KWWWKKWKKWWK",
		"KWWWWKKKWWPK",
		"KWWWWWWWWPPK",
		"KWWWWWWWWWWK",
		"KKKKKKKKKKKK",
	],
	chart: [
		"K...........",
		"K.........P.",
		"K........P..",
		"K....P..P...",
		"K...P.PP....",
		"K..P........",
		"K.P.........",
		"KP..........",
		"KKKKKKKKKKKK",
	],
}

export function picture(name: string, scale = 4): HTMLCanvasElement {
	const rows = PICTURES[name]
	const c = document.createElement("canvas")
	c.width = rows[0].length * scale
	c.height = rows.length * scale
	c.className = "icon"
	pixels(c.getContext("2d")!, rows, 0, 0, scale)
	return c
}
