# Core cites nothing in working/

Nothing in `core/` should cite anything in `working/`, and there is no "keeper": where core said one, it now says what a host saved or restores.

Each pointer into `working/` was one of two things:

- **A pointer to undecided matter** (ideas, proposals, research, arguments). The pointer is cut. Where a clause or sentence existed only to point, it is cut too.
- **A rule core relies on.** The rule is stated in core, in the paper whose subject it is. This happened once: trusted input (patch 08).

Made against the originals (GRAPH sha1 `1fbfa297`, SCHEDULER `3d3a1f37`, LOADERS `83eed287`, PROTOCOL `be97e0fa`) with the five earlier sets applied. PROTECT has no pointer into `working/` and is not touched.

## Apply

From the repo root, all six sets in this order:

    for p in working/patches/graph-succinct/*.patch working/patches/graph-one-source/*.patch working/patches/scheduler-succinct/*.patch working/patches/scheduler-one-source/*.patch working/patches/cross-one-source/*.patch working/patches/core-no-working/*.patch; do patch -p0 -V none < "$p"; done

scheduler-succinct 24 still prints `No such line 783 in input file, ignoring`, which is harmless. These patches print only `patching file`.

The two patches in `outside-papers/` are not in the loop (see below).

## Patches

| patch | paper, section | change |
|---|---|---|
| 01-graph-elsewhere | GRAPH, intro (Elsewhere) | Cut "`IDEAS.tex`: the undecided". |
| 02-graph-restored | GRAPH, Nodes | "`restored`: what a keeper saved (`HOST.tex`, The keeper)" becomes "what a host saved". What it holds was already stated there. |
| 03-graph-no-log | GRAPH, What the graph holds | Cut "(`IDEAS.tex`, Kept history)". "It saves nothing itself (§nodes; `HOST.tex`, The keeper)" becomes "(§nodes)". |
| 04-graph-host-layer | GRAPH, Running and wrapping | Cut "(as the keeper does: `HOST.tex`, The keeper)". The rule stays: "a layer the host keeps for itself may pass it on". |
| 05-graph-shape-check | GRAPH, the entry layer | "what a keeper restores (`HOST.tex`, The keeper)" becomes "what a host restores". |
| 06-scheduler-bookkeeping | SCHEDULER, The reference scheduler | Cut "like the keeper (`HOST.tex`, The keeper)". |
| 07-scheduler-why-ended | SCHEDULER, Killing | Cut "(`HOST.tex`)". The rule was already stated: "why it ended is the host's to keep". |
| 08-scheduler-trusted-input | SCHEDULER, What a process acts as; Open, *Whose call* | Moves in the trusted input rule (below). The *Whose call* pointer now names "(What a process acts as)". |
| 09-scheduler-open | SCHEDULER, Open | Cut the line "Undecided proposals: `WHAT-IS-A-PROCESS.tex`, `scheduler-proposals.org`". In *Stages*, cut "(`working/stages-research.org`)". |
| 10-loaders-platforms | LOADERS, Loaders (end) | Cut "What each platform lets a loader run, and where building happens, are argued in `working/LOADING.tex`." |
| 11-loaders-elsewhere | LOADERS, Running code elsewhere | Cut "(`IDEAS.tex`, Running code elsewhere)". It is still "the loader's own design". |
| 12-loaders-targets | LOADERS, Targets (after the decision) | Cut "What else a target says, and what a loader does with one, are argued in `working/LOADING.tex` (Targets)." |
| 13-protocol-reload | PROTOCOL, Commands (`test-reload`) | "as a keeper restores one … what a keeper would have saved (`GRAPH.tex`, Nodes; `HOST.tex`, The keeper)" becomes "as a host restores one … what a host would have saved (`GRAPH.tex`, Nodes)". |

Patches 10 and 12 cut whole sentences. Neither says what is open. If you want "what each platform lets a loader run", "where building happens" or "what else a target says" as LOADERS Open items, they would be new items.

## Moved into core

**Trusted input** goes to SCHEDULER, What a process acts as. It replaces "`person`, `trusted`: only on a handler call by host code knowing a person made it (`HOST.tex`, Trusted input and the actor)":

> `person`: who acted; `trusted`: whether by *trusted input*, an input event the host vouches for (e.g. a browser event whose `isTrusted` is true, keys read from its own tty). Only the host knows a person acted, so both are only on a handler call by host code knowing a person made it.

It comes from `working/HOST.tex`:

- Trusted input and the actor: "The host is what knows a person acted. A browser can vouch for an event whose `isTrusted` is true; a terminal for keys read from its own tty; …".
- Item 8 of "What a host running the reference stack must do": "the person who acted, and whether it was a real input event".

Some of that section was left in HOST: the microcontroller and link-owner examples (`peer` is set as `PROTECT.tex`, Rules already says) and "an agent that host code passes in … is the host's to vouch for". No core text relies on them.

**The keeper.** No rule had to move. Each thing core took from HOST's keeper was already stated in GRAPH:

- what is saved and restored: Nodes (`restored`);
- nothing ephemeral is saved: Ephemeral nodes;
- what a host restores goes through the shape check: Running and wrapping.

The rest of HOST's keeper is that host's own design: a layer right over the bare graph, and its backend.

## Checks run

- Each patch applies alone to a fresh copy of the base, with `--dry-run -F0`, with no fuzz and no offset.
- All 13 apply in order with `-F0` and leave no `.orig` or `.rej` file. The result is the same as making every edit at once.
- Starting from the four original files, the six-set loop above gives the same four files.
- With everything applied, no `\code{…}` in the five papers names a `working/` file, and none says "keeper".
- `tectonic` compiles GRAPH, SCHEDULER, LOADERS and PROTOCOL, each with the same warnings as the base:
  - GRAPH: none;
  - SCHEDULER: the base's one underfull box;
  - LOADERS: none;
  - PROTOCOL: the base's 3 underfull boxes.
- These were not changed: every `\label`, `\ref` target, decision, definition and section title, error code, table and listing. The one new pointer, "(What a process acts as)", names a subsection that exists, written as SCHEDULER's Open items already write them.

## Outside the papers

Two notes files in `core/` also cite `working/`. Their patches are in `outside-papers/`:

- `01-graph-c-notes`, for `core/graph/c/NOTES.md`:
  - cuts "IDEAS.tex is never implemented". The next sentences already say not to invent where the spec does not decide;
  - "what a keeper saves" becomes "what a host saves".
- `02-scheduler-c-notes`, for `core/scheduler/c/NOTES.md`. In the chosen readings, it cuts the citations of `working/conformance-questions.org`:
  - S2, S5 (a), S9 (a) and H9;
  - "H5 says", leaving "a map is taken as is".

They were made against those files as they are now (sha1 `710b6af0` and `9683784d`), which other sessions edit often, so they are kept out of the loop. To apply them:

    for p in working/patches/core-no-working/outside-papers/*.patch; do patch -p0 -V none < "$p"; done

Both apply with `--dry-run -F0` today.

Not patched: "keeper" in code comments and test names. These are:

- `core/graph/typescript/graph.ts` (87, 100, 104, 173, 1042);
- `core/graph/typescript/graph_test.ts` (915);
- `core/graph/c/graph_test.c` (11, 446);
- `core/graph/c/ermine.h` (359, 367, 375);
- `core/graph/c/main.c` (241);
- `core/scheduler/typescript/harness/sync.ts` (435);
- `core/scheduler/typescript/harness/main.ts` (48, 126).

None of them cites `working/`.
