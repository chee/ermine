# SCHEDULER.tex, succinct

These patches are made against `core/scheduler/SCHEDULER.tex` as of 2026-10-09 14:01 (sha1 `3d3a1f37`). There is one patch per section. They cut words and keep the rules. The code listings, decision titles, labels, `\ref`s, field names, error codes and the bibliography are unchanged.

Apply from the repo root:

    patch -p0 < working/patches/scheduler-succinct/05-processes.patch          # one
    for p in working/patches/scheduler-succinct/*.patch; do patch -p0 -V none < "$p"; done   # all

- **Each patch alone:** applies exactly, with no offset and no fuzz.
- **All in order:** no fuzz. Later patches apply at an offset, so Apple's `patch` leaves `SCHEDULER.tex.orig` behind unless you pass `-V none`. Patch 24 also prints `No such line 783 in input file, ignoring`. That message is harmless: the patch still applies.
- **Context lines:** 03, 04, 06 and 07 carry 1 line of context, 08 and 10 carry 2, and the rest carry 3. This keeps neighbouring patches off each other's lines.
- **Compiling:** with all patches applied, `tectonic SCHEDULER.tex` builds. It gives one underfull-box warning, as the original does (in a different place).

## Patches (prose words, before → after)

| patch | before | after |
|---|---|---|
| 00-abstract | 121 | 94 |
| 01-every-scheduler | 74 | 54 |
| 02-reference-scheduler | 198 | 119 |
| 03-requests | 97 | 61 |
| 04-arrivals | 97 | 78 |
| 05-processes | 577 | 417 |
| 06-killing | 290 | 190 |
| 07-children | 262 | 169 |
| 08-ephemeral-nodes | 161 | 110 |
| 09-programs | 325 | 183 |
| 10-new-code | 281 | 205 |
| 11-what-a-process-is-given | 387 | 290 |
| 12-what-a-process-acts-as | 351 | 295 |
| 13-handlers | 272 | 215 |
| 14-status | 337 | 269 |
| 15-latest-run | 164 | 133 |
| 16-marks | 255 | 187 |
| 17-rounds | 236 | 188 |
| 18-order | 531 | 413 |
| 19-outside-operations | 97 | 70 |
| 20-hooks | 136 | 114 |
| 21-what-the-scheduler-holds | 196 | 143 |
| 22-open | 476 | 420 |
| 23-related-work | 181 | 154 |
| 24-first-pass-choices | 619 | 561 |

## Totals

|  | before | after |
|---|---|---|
| prose words | 6721 | 5132 (−24%) |
| bytes of the .tex | 45830 | 38616 (−16%) |
| lines of the .tex | 859 | 764 |

Prose words run from the abstract to the end of First-pass choices. They exclude the preamble, the code listings and the bibliography. LaTeX commands are stripped; `\code{}` arguments and table cells count as words.

This is short of your density. Your loops, budget and outside-operations passage went from about 330 words to about 170. The same passage here goes from 362 to 255. The words still standing are mostly rules, names, cross-references, the part table, the Open questions and the First-pass choices, all of which the brief said to keep. The prose-only sections lost 30–45%.

## Your wording, used as given

- The `actor` line is now "actor: who made the changes (person, device, service)". This changes the meaning from "whoever the changes are for".
- The setup item is now "Untracked. Called once. Makes nodes and subprocesses. Returns a value."

## Cut as gloss, example or consequence

Check that none of these was a rule:

- **01:** the example orders "at once, lazily, once a frame, or by hand".
- **02:** the examples of bookkeeping and of "on a process's behalf"; "a refusal can never hide a kill from the scheduler".
- **03:** "as when an effect calls a handler".
- **05:** "so a process can start before its program is here"; "so it never escapes a chroot"; "has read nothing yet"; "a node in front of it in a union, or a folder above it moved, changes only what reads find".
- **06:** "as a script exits"; "as an external program exits"; "such as a script unplacing its own node"; "so the graph drops its reads".
- **07:** "so the processes form a tree of who started what, wherever they are placed"; "parts can make parts" (First-pass 19 still says it); "so an equal value is no change, and a matched compute runs again only when what it reads changes".
- **08:** "So a socket or a canvas outlives new code."
- **09:** "A program with no effect part is a derived value, like a formula in a spreadsheet"; "a library can steer programs away from it".
- **10:** "So new code is shown as new"; "a host that wants new code at once replaces it when it sees new".
- **11:**
  - "so a program names only what it uses";
  - the gloss on `input`;
  - "The reads of a setup, an effect part, a handler call, a cleanup and a peep are not tracked" (the table and the `peep` item say it);
  - "the sync process is given arrive", now a pointer to Arrivals.
- **14:** "to fall back to or pass on"; "so a process that keeps failing the same way stops"; "so the read shows it".
- **16:** "so a later run is given them too"; "A refused reader learns that something changed, and who changed it, never what"; "there is no other kind of reason".
- **18:** "as any equal value ends one"; "as parts of runs already counted".

## Ambiguous, kept as is

1. **Layout decision:** "its temporary state, its parts, which are its computes and effects, and its handlers". Is this a gloss, or a list of three?
2. **Requests:** "asked from outside a round". Yet requests made during a round are queued.
3. **Arrivals:** "The host gives arrive to the sync process; no program's interface has it." Is the sync process a program?
4. **Children:** "in start order" (was "in the order they were started"). The order of the starts, or of the children?
5. **What a part returns:** "or, from a compute, pending, such as undefined". Is `undefined` an example of pending, or of "anything but a value"?
6. **self, name:** "the rest is what the part is for". What is the rest?
7. **Agent:** "a starting agent not of this shape is taken as the actor, with empty code". Is the new process's step then added?
8. **Rounds:** "its earlier run ends done then". When the compute reruns, or when the effect part runs?
9. **Order:** "waits after it until it reruns". Which "it"?
10. **Order:** "whose compute read its value" against "whose last compute read". Is that the same compute?
11. **Loop decision:** "its sides shown", and ": only when one more lap would write a new value".
12. **Budget:** "the most runs and handler calls". One count for both, or a count for each?
13. **Killing:** "why it ended is the host's to keep". Must the host keep it, or may it?
14. **First-pass 5:** "The hook moments' shapes too."
15. **First-pass 10:** "no cause".

## Stated twice or more (not patched)

- **No own write makes its own process due:**
  - Status;
  - The latest run;
  - Marks ("the scheduler's own write for it");
  - First-pass 4.
- **The scheduler marks its own changes in the last step:**
  - What a process acts as (the sentence naming `"status"` and `"kill"`);
  - its decision;
  - Status;
  - Ephemeral nodes.
- **Cleanups run newest first:** Killing step 3; `onCleanup`; Rounds.
- **A process node no place reaches runs on:** Killing; Open, Unreachable processes.
- **No history and no records:** the abstract; The latest run decision; the Hooks decision.
- **Computes and effects are children of their starter:** the abstract; Children.
- **A setup's value is written as a compute's:** Rounds; Status (snapshot "when a setup or compute returns").
- **`replace` is on the host's interface:** New code; What a process is given; First-pass 14.
- **`call` lasts until the kill:** What a process is given; First-pass 12.
- **Budget outcomes:** The budget; First-pass 7.
- **Where pending is written:** Status; First-pass 3.
- **The First-pass choices in general:** most restate a body rule with its why. This is by design, so only the overlaps above are listed.
