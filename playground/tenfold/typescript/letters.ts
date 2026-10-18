// letters: the ones the folder starts with, by path under /tenfold/letters (<letter>/<n>.js), and
// the knobs that spell ERMINE with them. each is a letter's source (letter.ts): written here for
// this example
export const LETTERS: Record<string, string> = {
	"e/0.js": `// e: a ring open to the right, its bar tipping with y
const gap = 0.1 + 0.06 * sine(t)
width(0.13)
arc(0, 0, 0.7, gap, 1 - gap)
move(-0.7, 0)
line(0.7, 0.25 * y)`,

	"e/1.js": `// e, wound: the bar, then one line winding in from its end
width(0.07)
move(-0.75, 0)
line(0.75, 0)
const turns = 0.88 + 0.08 * q
for (let i = 0; i <= 96; i++) {
	const a = (i / 96) * turns
	const k = 0.75 * (1 - 0.3 * a * (0.5 + 0.5 * sine(t)))
	line(k * cosine(a), k * sine(a))
}`,

	"r/0.js": `// r: a stem, and a shoulder that nods with t
width(0.14)
move(-0.4, -0.8)
line(-0.4, 0.55)
move(-0.4, 0.1)
curve(-0.3, 0.65 + 0.12 * sine(t), 0.5, 0.45 + 0.2 * y)`,

	"r/1.js": `// r in beads: each a step along the stroke, swelling in turn
const bead = (bx, by, k) => circle(bx, by, 0.04 + 0.05 * (0.5 + 0.5 * sine(t - k)))
for (let k = 0; k < 9; k++) bead(-0.4, -0.8 + k * 0.17, k / 9)
for (let k = 1; k < 6; k++) bead(-0.4 + k * 0.17, 0.32 + 0.2 * sine(k / 14), (k + 4) / 9)
fill()`,

	"m/0.js": `// m: three stems under two arches; q spreads them, t lifts them
width(0.12)
const w = 0.3 + 0.06 * q
const h = 0.12 * sine(t)
move(-2 * w, -0.7)
line(-2 * w, h)
arc(-w, h, w, 0.5, 0)
line(0, -0.7)
move(0, h)
arc(w, h, w, 0.5, 0)
line(2 * w, -0.7)`,

	"m/1.js": `// m, folded: a zigzag whose middle dips with x
width(0.1)
move(-0.75, -0.7)
line(-0.6, 0.6)
line(0, -0.1 + 0.4 * (x + 0.5) * sine(t))
line(0.6, 0.6)
line(0.75, -0.7)`,

	"i/0.js": `// i: a stem, and a dot going round above it
width(0.16)
move(0, -0.8)
line(0, 0.3)
stroke()
circle(0.15 * sine(t), 0.65 + 0.08 * cosine(t), 0.11)
fill()`,

	"n/0.js": `// n: a stem and an arch, its shoulder on r
width(0.12)
const h = 0.1 + 0.3 * r
move(-0.5, -0.7)
line(-0.5, h)
arc(0, h, 0.5, 0.5, 0)
line(0.5, -0.7)`,

	"n/1.js": `// n, turning: the arch again and again, each a little turned about the middle
width(0.025)
for (let k = 0; k < 8; k++) {
	push()
	turn(0.015 * (k - 3.5) * sine(t))
	move(-0.5, -0.7)
	line(-0.5, 0)
	arc(0, 0, 0.5, 0.5, 0)
	line(0.5, -0.7)
	pop()
}`,
}

export const KNOBS = {
	cells: [
		{ letter: "e/0.js" },
		{ letter: "r/0.js", y: 0.2 },
		{ letter: "m/0.js" },
		{ letter: "i/0.js" },
		{ letter: "n/1.js", r: 0.5 },
		{ letter: "e/1.js", q: -0.5 },
	],
	period: 6000,
	slow: 6,
}
