// the party's look, for every server that serves it. LLM generated: a prototype
// the page's look: black on white to read, neon to see (each visitor's colour c0…c7), lychee wells
export const style = `
:root { --page: #fff; --ink: #000; --muted: #4d4450; --lychee: #f9fcff; --line: #cde8f6;
	--peach: #ff4f86; --mint: #36f9c0; --blue: #2269ff; --sunglow: #ffd000; --pink: #ee046f; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink);
	font: 16px/1.5 Jost, system-ui, -apple-system, "Segoe UI", sans-serif; }
.party { max-width: 760px; margin: 0 auto; padding: 0 16px 72px; }
.top { position: sticky; top: 0; z-index: 2; background: var(--page); display: flex; flex-wrap: wrap;
	align-items: center; gap: 4px 12px; padding: 12px 0 8px; border-bottom: 2px solid var(--line); }
h1 { margin: 0; font-size: 1.5rem; line-height: 1.1; font-weight: 600; }
h1 .dot { color: var(--peach); }
.me { margin: 0; color: var(--muted); }
.here { display: flex; flex-wrap: wrap; gap: 4px; list-style: none; margin: 0; padding: 0; width: 100%; }
.chip { font-size: .85rem; padding: 1px 8px; border-radius: 3px; }
.chip.away { opacity: .45; }
h2 { font-size: 1.15rem; margin: 28px 0 8px; font-weight: 600; }
h3 { font-size: 1rem; margin: 0 0 4px; font-weight: 600; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin: 0 0 8px; }
.muted { color: var(--muted); font-size: .9rem; }
button { font: inherit; border: 0; border-radius: 3px; background: var(--lychee); color: var(--ink);
	padding: 4px 10px; min-height: 32px; cursor: pointer; box-shadow: inset 0 0 0 1px var(--line); }
button:focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; }
.tool.on, .pick.on { background: var(--mint); box-shadow: none; }
.who { color: var(--muted); }
.c0 { background: #ff4f86; } .c1 { background: #36f9c0; } .c2 { background: #2269ff; color: #fff; }
.c3 { background: #ffd000; } .c4 { background: #b46cff; } .c5 { background: #ff8a3d; }
.c6 { background: #00c2d1; } .c7 { background: #ee046f; color: #fff; }
.wall { display: grid; grid-template-columns: repeat(16, 1fr); gap: 1px; background: var(--line);
	padding: 1px; max-width: 420px; border-radius: 3px; }
.px { aspect-ratio: 1; min-height: 0; padding: 0; border-radius: 0; box-shadow: none; background: var(--lychee); }
.px.c0 { background: #ff4f86; } .px.c1 { background: #36f9c0; } .px.c2 { background: #2269ff; }
.px.c3 { background: #ffd000; } .px.c4 { background: #b46cff; } .px.c5 { background: #ff8a3d; }
.px.c6 { background: #00c2d1; } .px.c7 { background: #ee046f; }
.life { display: grid; grid-template-columns: repeat(20, 1fr); gap: 2px; max-width: 520px; }
.cell { aspect-ratio: 1; min-height: 0; padding: 0; border-radius: 2px; box-shadow: none; background: var(--lychee); }
.cell.on { background: var(--blue); }
.beat { display: grid; gap: 4px; }
.track { display: grid; grid-template-columns: 48px repeat(8, 1fr); gap: 4px; max-width: 460px; align-items: center; }
.lbl { font-size: .85rem; color: var(--muted); }
.step { aspect-ratio: 1; min-height: 0; padding: 0; }
.step:nth-of-type(4n + 1) { box-shadow: inset 0 0 0 1px #9fd0e8; }
.step.on.r0 { background: var(--peach); } .step.on.r1 { background: var(--blue); }
.step.on.r2 { background: var(--sunglow); } .step.on.r3 { background: var(--mint); }
.dot { justify-self: center; width: 10px; height: 10px; border-radius: 50%; background: var(--line); }
.dot.now { background: var(--ink); }
.pick { font-size: 1.2rem; padding: 2px 6px; }
.board { position: relative; width: 640px; max-width: 100%; height: 220px; background: var(--lychee); border: 1px solid var(--line);
	border-radius: 4px; overflow: hidden; cursor: crosshair; }
.sticker { position: absolute; transform: translate(-50%, -50%); font-size: 1.8rem; line-height: 1;
	pointer-events: none; }
.pet { font-size: 1.1rem; margin: 0 0 8px; }
.hamster { font-size: 2rem; vertical-align: -6px; }
.bar { font-family: "IBM Plex Mono", ui-monospace, monospace; letter-spacing: 1px; color: var(--peach); }
.hearts { color: var(--pink); letter-spacing: 1px; }
.card { background: var(--lychee); border-left: 6px solid var(--sunglow); padding: 8px 12px; border-radius: 3px;
	margin: 0 0 8px; }
.to { margin: 0 0 4px; font-size: 1.1rem; }
.sigs { display: flex; flex-wrap: wrap; gap: 4px 14px; list-style: none; margin: 0; padding: 0; }
input { font: inherit; min-height: 32px; padding: 0 8px; border: 1px solid var(--line); border-radius: 3px; }
.pens { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 4px; }
.pen { background: var(--lychee); border-radius: 3px; padding: 8px 12px; min-height: 120px; }
.pen ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.pen button { min-height: 28px; padding: 2px 8px; font-size: .85rem; background: var(--page); }
`

// its fonts, from Google Fonts
export const fonts =
	`<link href="https://fonts.googleapis.com/css2?family=Jost:wght@400;600&family=IBM+Plex+Mono&display=swap" rel="stylesheet">`
