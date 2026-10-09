# GRAPH.tex: spec-sheet patches

These patches are made against `core/graph/GRAPH.tex` as of 2026-10-09 14:01 (sha1 `1fbfa297`, 41895 bytes).
There is one patch per section. Apply them from the repo root:

    patch -p0 --dry-run < working/patches/graph-succinct/06-paths.patch
    patch -p0 --no-backup-if-mismatch < working/patches/graph-succinct/06-paths.patch

## Checks run

- Each patch applies alone with no fuzz.
- All 16 apply in order, and also in reverse order, with no fuzz. Either way the result is the same file.
- When applied in sequence, later patches land with an offset, and patch then leaves `GRAPH.tex.orig` behind. `--no-backup-if-mismatch` stops that.
- With all 16 applied, `tectonic GRAPH.tex` compiles with no warnings, the same as the original.

## What the patches leave alone

These are untouched:

- the preamble, the title and the author;
- the patch listing;
- every decision and property title;
- every `\label` and `\ref`;
- every error code;
- the bibliography.

In the operations table, two cells are shorter: `move` ("moves an id from one slot into another") and `take` ("in change order").

## Patches

| patch | words before | words after |
|---|---|---|
| 01-abstract | 104 | 83 |
| 02-designable-software | 570 | 426 |
| 03-nodes | 190 | 134 |
| 04-values | 318 | 237 |
| 05-ephemeral-nodes | 380 | 325 |
| 06-paths | 826 | 651 |
| 07-patches | 186 | 133 |
| 08-changes | 289 | 222 |
| 09-placement | 351 | 274 |
| 10-lookup | 205 | 166 |
| 11-tracking | 457 | 378 |
| 12-operations | 603 | 527 |
| 13-what-the-graph-holds | 120 | 92 |
| 14-running-and-wrapping | 1184 | 1084 |
| 15-open | 300 | 265 |
| 16-related-work | 247 | 225 |

## Totals

|  | before | after |
|---|---|---|
| prose words | 6330 | 5222 (−17.5%) |
| bytes of GRAPH.tex | 41895 | 38236 (−8.7%) |

How the words were counted:

- The count runs from `\begin{document}` to the bibliography.
- The listing is left out.
- LaTeX commands are stripped.
- `\code{}` arguments count as words, and so do the table's 158 words (151 after).

A separate agent compared the old and new text for meaning. It found 28 places where the meaning had shifted. Most of these were "the graph" dropped as the subject, "start" used loosely when it is a defined term, and "such as" turned into a bare parenthesis. All 28 are fixed.

What remains is mostly rules. A deeper cut would need you to pick which copy to keep of each rule listed under "Stated twice" below.

## Ambiguous, kept as is

- **§Nodes, restored:** "the headers of their last changes that were not ephemeral". This could mean the last change, if it was not ephemeral, or the last change of those that were not. §What the graph holds says the second, but only for slots.
- **§Nodes vs §Operations (At an id):** "Every other node is made by placing it" sits against "a write at an id the graph does not have … makes that node".
- **§Placement vs §Ephemeral nodes:** a placement with no position "is still a change, and the slot's last". But an ephemeral change "never becomes a slot's last change".
- **§Tracking:** "The nodes an answer depended on are tracked as refused too" sits in the no-or-pending paragraph. It is unclear whether yes answers count too; the enter decision says "each" answer.
- **§Tracking:** "what a refused read and another both tracked". "Another" could mean a read by the same reader, or any read.
- **§Running, One seam:** "decides whether an operation may act only through `enter`". "Only" can attach to "decides" or to "act".
- **§Running:** "A wrapper learns … what it did from its answer". "Its" could be the `enter` or the operation.
- **§Running, where the graph asks:** "If a step passes over every member and one was refused". "One" means at least one?
- **§Running, subscriptions:** "asked again each time its address is walked again, after a change that could alter what it reaches, after a change to a node an answer depended on, and, while it is refused, at each change it would keep". It is unclear whether "after a change that could alter …" says when the address is walked again, or is a separate trigger. The wording is kept verbatim.
- **Table, `unsubscribe`:** in "stops them", "them" could be the events or the subscription.
- **§Open, First-pass choices:** "the smallest detail that … needed and nothing decided".

## Stated twice, not patched

- **A subscription keeps the changes its address reaches:** the abstract, §Changes (second paragraph), and the `subscribe` row of the table.
- **`take` is not a read: untracked, asks no `enter`:** §Operations, just after the decision, and §Open, First-pass choices.
- **`take` drops events and `unsubscribe` drops those not taken:** the table, and First-pass choices.
- **The entry layer gives a change with no process its site:** §Running, in the entry-layer list and in the last paragraph.
- **Code-facing layers strip `at`:** the wrapper paragraph, the entry-layer list ("as it strips `at`"), and the view decision.
- **An item carries the header of the change that set it, or none:** the Reads are lists property, and the Header paragraph in §Paths.
- **A change's time comes from a clock outside the graph:** §Changes (time), and the last paragraph of §Running.
- **Nodes an `enter` answer depended on are tracked as refused:** §Tracking, and the decision "enter's answer names what it read".
- **An ephemeral change is never a slot's last change:** §Ephemeral nodes, §What the graph holds, and §Nodes (restored).
- **An unplacement answers with the ids let go:** §Ephemeral nodes (letting go), and §Operations.
- **Ids are strings:** the Node definition, and the Value definition (string).
- **An id whose node is not here gives a pending slot item:** §Paths (reading), §Placement (mounting), and the Reads are lists property.
- **A subscription keeps the `enter`s it brought:** §What the graph holds, and §Running.
- **`missing` for a change with neither process nor site:** §Changes (site), and §Running (the entry layer's list of laws).
- **A slot item's header may be about another member:** §Paths (Header), and §Open, item 1.
- **Only the bare graph starts from a node given by id:** §Paths (opening paragraph), and §Operations, At an id.
- **The graph never runs anything:** the abstract, and the §Running decision.
- **A no from `enter` ends a lookup's search:** §Lookup, and §Running (where the graph asks).

## Cut as not rules

These are explanations, examples, analogies and "so …" lines.

- **§Nodes:** "This is how a graph is restored". "No restore operation" stays.
- **§Changes:** the header gloss "who made it, when, where from and why".
- **§Ephemeral nodes:** "a stream before its connection", and "as any change".
- **§Lookup:** "so a reader can see that something farther up was not searched", and "so a reader sees what the nearest shadows".
- **§Tracking:** "So a change there marks the reader, and its next read asks again". The enter decision still says this.
- **§Operations:** the Plan 9 / epoll comparison for `take`.
- **§Running:** "the walk cannot tell whether that member had the name", and "the reader learns that".
- **Designable software:** "It is hard to see software working", "Software should speak to the people repairing it the same way", "as above", and some detail from the DS teardown.
