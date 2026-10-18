# tenfold, on dens

An example: the shape of Ink & Switch's tenfold (letters as small draw programs run every frame by
one engine) on ermine's dens (`@ermine/dens`). None of tenfold's code, letters or font are here;
this is written over again from what it does.

## what it shows

- **a den** (`tenfold.ts`) offering a javascript runner (ermine/api's `run`), a surface
  (`surfaces/screen`: a recording in tests, a canvas on the page) and a compiler
  (`compilers/loop-budget`).
- **the engine is a process**: a program at `/tenfold/engine.js` started on the den's javascript
  runner at `/tenfold/view`. It holds the surface and **offers a runner of its own**,
  `/tenfold/view/runners/letter` (takes `ermine.tenfold-letter`, api `ermine.tenfold.letter`).
- **letters are programs, not processes**: nodes under `/tenfold/letters/<letter>/<n>.js` whose
  value is source. Each cell is a memo of the engine's (`cells/<i>`): it reads its knob and its
  letter, compiles the letter through the den's loop-budget compiler (build's `compile`, so a source
  is compiled once and cached by its hash), loads the result on `runners/letter` (only when the code
  is new), and draws it. Every frame the surface's clock is written (`clock`) and the cells draw
  again; a source or knob edited draws again at the next pulse.
- **a letter** (`letter.ts`) gets a small pen in clip space (-1 to 1, y up, angles in turns:
  `move line curve arc circle rect close stroke fill width text`, `turn grow shift push pop`,
  `TAU sine cosine wrap mix clamp`) and the params `{ q, r, x, y, t, s }`.
- **the budget** (`budget.ts`): every loop's condition gets a check, every for-of's iterable a check
  an item. The count is the runner's (5000 a draw); past it, `BudgetError`.
- **cost and throws recorded**: a cell's node holds `{ letter, cost }` (its draw in ms); a throw is
  its status (an Error) and its run's error (`apis.runs(id)`), where an inspector reads them. The
  engine marks the cell on the surface: `["mark", "error", what]`, or `["mark", "cost", ms]` over
  `knobs.slow`. A throwing or never-ending letter does not stop the others.
- **both ways on one runner**: a letter started as a process on `runners/letter` with args `[cell]`
  (code carried, already through the budget) is that cell's guest while it runs. Stopping the engine
  stops it (the den's runner-stopped), withdraws the runner, ends the memos and the frames.

The knobs (`/tenfold/knobs`): `{ cells: [{ letter, q?, r?, x?, y? }], period?, slow? }`. The letters
in `letters.ts` spell ERMINE.

```sh
deno test playground/tenfold      # on a recording surface
deno task demo                    # then /tenfold/: the page (playground/demos/tenfold)
```

## what it does not

- no isolation: a letter runs in the page's realm (`new Function`), and can reach anything there. A
  letter runner in a worker (playground/realms) is the next step.
- no sync: the knobs and letters are local nodes, not shared with `together`; no presence for who is
  editing.
- no sound, no drawing measurements (tenfold's collector), no print surface, no sharing.
- the cell count is read once, as the engine starts; the cost is the last draw's, not averaged.
- a guest shows from the next frame (the guests are the engine's own, not a node read).
- the budget's instrumenter is a scanner, not a parser: loops inside a template's `${}` go
  unchecked, and a `/` after `)` `]` or `}` is always division.
