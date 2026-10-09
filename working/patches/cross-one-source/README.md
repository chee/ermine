# One source per rule, across the four papers

These patches go on top of the four earlier sets. They take rules that two or more of `core/graph/GRAPH.tex`, `core/scheduler/SCHEDULER.tex`, `core/scheduler/LOADERS.tex` and `core/PROTOCOL.tex` state. Each rule is stated fully in one place, its home. In the other papers it is cut, or replaced by a pointer in that paper's style, such as `(\code{GRAPH.tex}, Paths)`. Where a restatement had a condition the home lacked, the condition was moved home. This happened twice: in patch 10 (which errors name no operation, moved to PROTOCOL) and patch 16 (slot order, moved to GRAPH).

They were made against the originals (GRAPH sha1 `1fbfa297`, SCHEDULER `3d3a1f37`, LOADERS `83eed287`, PROTOCOL `be97e0fa`) with the earlier sets applied.

Apply from the repo root, all sets in this order:

    for p in working/patches/graph-succinct/*.patch working/patches/graph-one-source/*.patch working/patches/scheduler-succinct/*.patch working/patches/scheduler-one-source/*.patch working/patches/cross-one-source/*.patch; do patch -p0 -V none < "$p"; done

scheduler-succinct 24 still prints `No such line 783 in input file, ignoring`. That message is harmless. These patches print only `patching file`.

## Checks run

- Each patch applies alone, with `--dry-run -F0`, to a fresh copy of the base (the originals with the four earlier sets applied). There is no fuzz and no offset.
- All 29 apply in order with `-F0` and leave no `.orig` or `.rej` file. The result is the same as making every edit at once.
- Starting from the four original files, the loop above gives the same four files.
- With everything applied, `tectonic` compiles all four papers. GRAPH and LOADERS give no warnings. SCHEDULER gives the base's one underfull box. PROTOCOL gives 4 underfull boxes, all of them already in the base, which had 5.
- These were not changed:
  - every `\label` and `\ref` target;
  - every decision, definition and property title;
  - every section, subsection and paragraph title;
  - every error code;
  - every table's rows and columns;
  - every listing;
  - the bibliographies.
- New pointers name sections that exist, written as each paper already writes them.
- Disagreements were not resolved: both texts of each are kept (see the end).
- A separate agent compared the old and new text of every hunk for meaning. It found one lost condition and three wording slips, all now fixed:
  - the lost condition was the order of a directory read's members and items, and of a lookup's items, which is now in GRAPH (16);
  - "an `at`" (13);
  - `pending` given to a change (14);
  - a refused union member after the first (15).

Patches 12, 15 and 17 carry 1 line of context in `PROTOCOL.tex`. The rows of the Encodings table next to each other belong to different patches, and Apple's `patch` rejects a hunk with empty or uneven context. Every other hunk carries 3 lines.

## Patches

"Words saved" is per paper, with each patch applied alone to the base. A negative number means the patch added words. G is GRAPH, S is SCHEDULER, L is LOADERS and P is PROTOCOL.

| patch | rule | home, and why | elsewhere | G | S | L | P |
|---|---|---|---|---|---|---|---|
| 01-latest-run | What a process's latest run shows. The scheduler keeps no records. | SCHEDULER, The latest run (its decision and its listing). The division gives the latest run to SCHEDULER. | GRAPH intro: "what a process's latest run shows: `SCHEDULER.tex` (The latest run)". PROTOCOL, The recorder: "for tests (`SCHEDULER.tex`, The latest run)". | 7 | | | 1 |
| 02-added-operations | The operations the scheduler adds. | SCHEDULER, What a process is given: the part table, the "Added" list and the host's interface. GRAPH's list (`start`, `batch`) was incomplete. | GRAPH, Operations: "(as the scheduler does: `SCHEDULER.tex`, What a process is given)". | −3 | | | |
| 03-process-node-ephemeral | A process node is ephemeral. An ephemeral node has one place and is never saved. | That a process node is ephemeral: SCHEDULER, Processes (the Process definition). One place, never saved: GRAPH, Ephemeral nodes. | GRAPH, Ephemeral nodes: "A scheduler's process node is ephemeral (…): one place per process" is cut. SCHEDULER, *A process is unique and local*: "Ephemeral (`GRAPH.tex`, Ephemeral nodes)". | 12 | 0 | | |
| 04-kills | The scheduler ends the processes whose nodes went. | SCHEDULER, Killing. It learns of kills from a change's answer. | GRAPH, Ephemeral nodes: "and a scheduler learn of kills (`SCHEDULER.tex`, Killing)". | 1 | | | |
| 05-node-gone | How a node goes: unplaced at an address or at its id, or with an ephemeral holder. An ephemeral node whose holder no place reaches stays here. | GRAPH, Ephemeral nodes. | SCHEDULER, Killing: "Killed: its node gone (`GRAPH.tex`, Ephemeral nodes)". Also "A process whose node no place reaches (`GRAPH.tex`, Ephemeral nodes) runs on". "Runs on" is the scheduler's part and stays. | | 12 | | |
| 06-release-at-id | An unplacement at an id takes the ephemeral node out of its one slot, wherever it is. | GRAPH, Operations, At an id. | SCHEDULER, Ephemeral nodes (Release): "(found even where no address reaches it) from its one slot" becomes "(`GRAPH.tex`, Operations, At an id)". | | 8 | | |
| 07-reader | Only the scheduler binds a reader. | SCHEDULER, What a process is given (the `peep` item), as the division says. | GRAPH, the entry layer: "strips `reader` (who binds one: `SCHEDULER.tex`, What a process is given)". The old pointer named Rounds. | −1 | | | |
| 08-start | A new id must not be here or held by a slot. A placement with no position goes last in the slot. A program path is searched for from the place. | GRAPH, Placement and Ephemeral nodes. LOADERS, Finding the program. | SCHEDULER, `start`, four edits. **(1)** "An id the graph has or a slot holds: invalid" is cut. "`start` is invalid only when its placement is" stays, and covers it. **(2)** "A name the slot has: no clash; the node goes last in the slot" becomes "with no position (`GRAPH.tex`, Placement)". **(3)** "Unless the start is matched (Children)" now covers the placement and its answer. Children already says so. **(4)** "searched for from the new place" becomes "a path (`LOADERS.tex`, Finding the program), found at each run". | | 27 | | |
| 09-place-names | A place is names, not a node. Moving a node on its walk leaves the place as it is. `cwd` is the names after the start. | GRAPH, Paths (Place). | SCHEDULER, Process definition: "`cwd` the path from there to it" is cut. *A place is names*: "Names, not a node (`GRAPH.tex`, Paths)". The process part stays: move its node, no kill, what it keeps, its new place. | | 25 | | |
| 10-part-returns | (a) Which errors name no operation. (b) An ephemeral node's value may be live. | (a) PROTOCOL, Errors, which says when `op` is there. Its list lacked this case, so the case moved there. (b) GRAPH, Values. | SCHEDULER, What a part returns: "no operation named" is cut, and "The value may be live (`GRAPH.tex`, Values)". PROTOCOL, Errors gains "nor the `wrong-field` of a part's return (`SCHEDULER.tex`, What a part returns)". | | 8 | | −12 |
| 11-site | What a site is. A change with no process has one. How a harness gets one. | What a site is: GRAPH, Changes. The harness's field: PROTOCOL, Session. | GRAPH, Running and wrapping: "for a harness: `PROTOCOL.tex`". PROTOCOL, Encodings (site): "the site of a change (`GRAPH.tex`, Changes)". SCHEDULER, What a process acts as: "its changes have their site (`GRAPH.tex`, Changes)" is cut. | 5 | 7 | | 7 |
| 12-time | A change's time is above the graph's highest, and names one change. A restored graph has the highest time saved. | GRAPH, Changes (time) and Nodes. PROTOCOL keeps the range 1 to 2^53−1. SCHEDULER keeps its clock. | SCHEDULER, Clock: its pointer goes from Nodes to Changes (it was stale). What the scheduler holds: "the clock goes on from a restored graph's highest time (`GRAPH.tex`, Nodes)". PROTOCOL, Encodings (time): "a change is named by its time" becomes a pointer. PROTOCOL, Session: "greater than the highest time the graph has had (code `time`)" becomes "(`GRAPH.tex`, Changes)". | | 5 | | 14 |
| 13-entry-layer-at | The entry layer checks each request's shape and strips `at`. `at` is for the holder of the bare graph. | GRAPH, Running and wrapping, and At an id. | PROTOCOL, Session: "which checks each request's fields" is cut. The `at` sentence becomes "The entry layer strips an `at` (`GRAPH.tex`, Operations; Running and wrapping)". | | | | 17 |
| 14-error-meanings | When each graph, scheduler and loader error happens. | GRAPH, since the division gives it error meanings. SCHEDULER and LOADERS for their own errors. PROTOCOL keeps each code, its kind and its details. | PROTOCOL, Errors, row by row: <br>• `above-root`, `exists`, `not-in-slot`, `ephemeral-parent` and `one-place` become pointers. `one-place` loses "a process's node included". <br>• `position` and `time` keep what their details hold (`length` is the slot's length, `last` the highest time). `position` keeps its `wrong-field` case. <br>• `not-a-program`/`no-loader` point to LOADERS, and keep the `steps` loader's case. <br>• `budget` points to SCHEDULER, and keeps `"budget": n` and its kind. <br>• `pending` keeps its kind and "given to a change". | | | | 115 |
| 15-items | What each kind of item is, a lookup item's path, and the header an item carries. | GRAPH: Paths (From, Header, Reading an address), Lookup, and Running and wrapping. PROTOCOL keeps the keys, and says when each key is there. | PROTOCOL, Encodings: the `address` and `from` rows. Items: <br>• the id item's spelled-out pending example; <br>• the routes and paths of the refused and pending items; <br>• the paragraph on an item's `change`. <br>All become pointers. | | | | 140 |
| 16-reads | Every read is a list. Names are in code point order. Members, and a slot's items, are in slot order. What `lookup` and `lookups` give. | GRAPH, Paths and Lookup. PROTOCOL's slot order covered directory reads and lookups, where GRAPH gave none. So GRAPH gains: "Members, and a slot's items, come in slot order." | PROTOCOL, Values in JSON: two sentences are cut. Commands: `directory` keeps its two shapes and gains a pointer. `lookup` and `lookups` keep their shapes. | −9 | | | 61 |
| 17-program-identity | A program's identity `{node, time}`: its node, and the time of the change that last set it. | LOADERS, *The host finds code*. | PROTOCOL, Encodings (identity): "a program (`LOADERS.tex`, Finding code)". SCHEDULER, The latest run gains a pointer for the listing's `program` field, which had none. | | −4 | | 13 |
| 18-code-is-a-read | Each run of a process whose program is a path calls `code` first, with the run's read-only view. Its reads are the run's. | SCHEDULER, *Code is a read*. Calling `code` is a step of the run. | LOADERS abstract: "(`SCHEDULER.tex`, Programs; Code is a read)". *The host finds code*: "called as `SCHEDULER.tex` says (Code is a read)". | | | 24 | |
| 19-live-program | Live values never leave their host. | GRAPH, Values (live). | LOADERS, Finding the program: "It never leaves its host" is cut. | | | 5 | |
| 20-new-code | New code is shown, and runs once the process is replaced. | SCHEDULER, Programs, New code. | LOADERS, Finding a loader: "is new code (`SCHEDULER.tex`, Programs, New code)". | | | 11 | |
| 21-handler-calls | A handler call acts as itself, and `protect` decides it. | SCHEDULER, Handlers. | LOADERS, Running code elsewhere: "which act as themselves and which `protect` decides" is cut. | | | 8 | |
| 22-first-pass-loaders | First-pass 25 restated three LOADERS rules. | LOADERS: Finding code, Finding the program, Loaders. | SCHEDULER, First-pass 25 still names its two agreeing picks, so the list still flags them for you, each now with a pointer. Its third clause, "marks those waiting", is disagreement 12 and is kept word for word. | | −1 | | |
| 23-change-answer | A change answers with the readers it marked, each once, in code point order, and with the ids it let go, in order. | GRAPH, Operations. | PROTOCOL, Commands: `marked` and `gone` point to GRAPH, Operations, and keep their keys. The refused-only sentence is disagreement 4 and is not touched. | | | | 14 |
| 24-part-variables | A process's place. What each part is given. A change that marked only through refused reads is given as its header with `"refused": true`. | SCHEDULER: Processes (the place), What a process is given (the part table), Marks. | PROTOCOL, Encodings (Changes): the refused sentence is cut. Programs as data (Variables): the place gloss and the five-item list are cut. It keeps "a handler call's `args` is missing if the call gave none", the harness's own rule. | | | | 61 |
| 25-acting-as | What a request's `process`, `place` and `chroot` mean. | GRAPH: Paths (Place) and Operations. SCHEDULER: Ephemeral nodes. | PROTOCOL, Acting as someone, keeps: <br>• the keys; <br>• the default place, the root; <br>• the chroot's `wrong-field`. <br>It cuts: <br>• "so that with `schedule` it may make and place ephemeral nodes"; <br>• the place's restatement, which Encodings also has; <br>• the chroot's walk. | | | | 49 |
| 26-events | A subscription keeps its events until they are taken. Some changes are kept with what the address read just after them. | GRAPH, Operations (the decision and the `subscribe` row). | PROTOCOL, Events keeps both event shapes. The list of ways a change can alter what the address reaches becomes a pointer to `subscribe`. | | | | 30 |
| 27-root-reload | A new graph's root is null. Nothing ephemeral is saved. | GRAPH, Nodes and Ephemeral nodes. | PROTOCOL, Session: "The root's value is `null`" becomes a pointer at "made with its root". `test-reload`: "so nothing ephemeral is left" is cut. | | | | 8 |
| 28-steps-load | A program that `code` cannot load fails its run before any part runs. | LOADERS, Finding code. | PROTOCOL, Programs as data: "so its run fails before any part runs" is cut. | | | | 8 |
| 29-scheduler-abstract | The graph runs nothing. A change reports the readers it marked. | GRAPH: the decision *The graph marks; the scheduler runs*, and Operations. | SCHEDULER abstract: "The graph runs nothing" is cut. Its pointer goes from Tracking to Operations (it was stale). | | 4 | | |

Sums: GRAPH 12, SCHEDULER 91, LOADERS 48, PROTOCOL 526. These equal the totals below.

## Totals

|  | original | after the four earlier sets | after these |
|---|---|---|---|
| GRAPH prose words | 6330 | 5038 | 5026 (−12, −0.2%) |
| GRAPH bytes | 41895 | 37584 | 37503 (−81) |
| SCHEDULER prose words | 6645 | 4576 | 4485 (−91, −2.0%) |
| SCHEDULER bytes | 45830 | 36046 | 35616 (−430) |
| LOADERS prose words | 1549 | 1549 | 1501 (−48, −3.1%) |
| LOADERS bytes | 11243 | 11243 | 10957 (−286) |
| PROTOCOL prose words | 5164 | 5164 | 4638 (−526, −10.2%) |
| PROTOCOL bytes | 41434 | 41434 | 38687 (−2747) |
| all four, prose words | 19688 | 16327 | 15650 (−677, −4.1%) |
| all four, bytes | 140402 | 126307 | 122763 (−3544) |

The earlier sets did not touch LOADERS or PROTOCOL. GRAPH's 12 words are few for a reason. GRAPH is the home of most of the shared rules, so most cuts fell in the other papers. Patches 02, 07 and 16 also add words to GRAPH: a fuller pointer, a pointer to the right home, and the slot-order condition moved home.

Words are counted as in `../graph-succinct/README.md`:

- The count runs from the abstract to the bibliography.
- The listings are left out.
- LaTeX commands are stripped.
- `\code{}` arguments and table cells count as words.

This count gives exactly the GRAPH numbers of the graph READMEs. For SCHEDULER it gives 76 fewer words than the scheduler READMEs, in both of their columns (6645 against 6721, and 4576 against 4652). The two counts handle something in the unchanged text differently. Only the differences matter here.

## Where these depart from the proposed division

- **Who binds a reader.** This follows the division: SCHEDULER is the home (What a process is given, the `peep` item). The scheduler-one-source README had proposed GRAPH.
- **Each run calls `code` first.** The home is SCHEDULER, *Code is a read*, not LOADERS. Calling `code` is a step of the run (the Rounds listing). LOADERS owns what `code` does once it is called, and keeps all of that.
- **Which errors name no operation.** The home is PROTOCOL, which says when `op` is there. So patch 10 moved SCHEDULER's "no operation named" into PROTOCOL's list.
- **Where the entry layer goes.** The cross-file list proposed SCHEDULER. It stays in GRAPH; see "Left as they are".
- **The patch codes** (`not-a-patch`, `no-key`, `range`, `wrong-kind`). The cross-file list proposed GRAPH for their meanings. They stay in PROTOCOL: PROTOCOL gives each fault its code, while GRAPH lists the faults without codes, so a pointer would lose which code goes with which fault.

## Stale pointers fixed

- SCHEDULER, The reference scheduler, Clock: `(GRAPH.tex, Nodes)` → `(GRAPH.tex, Changes)`. The time rule is in Changes (patch 12).
- SCHEDULER abstract: `(GRAPH.tex, Tracking)` → `(GRAPH.tex, Operations)`. A change's answer, which reports the readers, is in Operations (patch 29).
- GRAPH, entry layer: `(SCHEDULER.tex, Rounds)` → `(SCHEDULER.tex, What a process is given)`, the home of "only the scheduler binds a reader" (patch 07).
- PROTOCOL, an item's `change`: `(GRAPH.tex, Changes)` → `(GRAPH.tex, Paths; Ephemeral nodes)`, where an item's header is defined (patch 15).

## Left as they are

These rules are shared, but not patched:

- **Where the entry layer goes.** `GRAPH.tex`, the entry layer: "The host puts it on top of its stack; the scheduler, on every interface it hands to code". `SCHEDULER.tex`, What a process is given: `api` is "the graph's view … under the entry layer".
  - GRAPH states the general rule. SCHEDULER only names the layers `api` is made of.
  - Moving the rule into SCHEDULER would need a sentence there for every interface the scheduler hands out.
  - It is also unclear whether "to code" covers the view given to the host's `code`.
- **The shape check on arrivals.** GRAPH, the entry layer, states the general rule: whatever reaches the bare graph without passing the entry layer is checked. It names an arrival as an example, with a pointer. SCHEDULER, Arrivals applies the rule, with a pointer back. Neither copy restates the other.
- **What operations at an id are for.** GRAPH, At an id: "They are for changes made elsewhere (`SCHEDULER.tex`, Arrivals) and a scheduler's bookkeeping (`SCHEDULER.tex`, Processes)". This is already pointers.
- **A release's process or site.** SCHEDULER, Ephemeral nodes (Release): "carrying its cause's agent and process, or site: the killing change, or the call that did not start a child again (`GRAPH.tex`, Changes)".
  - GRAPH's rule covers "a change a layer makes because of a request". A part's call that did not start a child again is not a request in SCHEDULER's sense, so cutting SCHEDULER's words could drop that case.
  - A wording clash: "its cause's agent" uses "cause" loosely, beside GRAPH's `cause` header field and First-pass 10's "no cause".
- **No reader, no tracking; `forget`.**
  - SCHEDULER's `peep` ("readerless … untracked (`GRAPH.tex`, Tracking)") and Killing step 5 already point.
  - PROTOCOL's `test-reload` dropping reads is what that command does.
- **Marks, applied to cases.** Each of these applies GRAPH's tracking to one case, in that case's own home, and each points or sits beside a pointer:
  - SCHEDULER, *Code is a read*: "an edit to what it read … marks the process";
  - LOADERS, Finding the program: "that one's arrival marks the process";
  - LOADERS, Loaders: the empty write, so readers run again;
  - LOADERS, Finding a loader: "the arrival of either marks the process".
- **LOADERS, Finding a loader: "That node, the nearest named `k` that is here".** It picks one node from the lookup's items. GRAPH's lookup gives every item of the slot, so this is not a copy of it.
- **LOADERS, Finding the program: "A refused read ends the search there, as a refused step ends a lookup."** This is the program search's own rule. It is compared with lookup, not copied from it.
- **PROTOCOL: "A live value never crosses a line".** This is the wire's rule, and it leads to the stand-ins.
- **PROTOCOL error rows kept:**
  - the patch codes (see above);
  - `missing` and `wrong-field`, which are shape errors;
  - `read-only`/`write-only`, which already point;
  - `nothing-there` (disagreement 5);
  - `not-a-process`, which maps SCHEDULER's rule onto requests ("by a request not carrying `process`").
- **PROTOCOL, Encodings:**
  - The `route` row: its first clause is in disagreement 5, and the rest says what each key holds.
  - The value item's "`ephemeral` when its node is ephemeral", and Changes' "`site` is there when the change has no process, and `cause` when it has one". These say when a key is there.
  - The `status` row gives each field's JSON form.
- **PROTOCOL, Session: "`budget` … 100000 if not given".** This is the harness's default. SCHEDULER's "100000 unless the host sets it" is the same number, and a pointer would be as long.
- **PROTOCOL, Commands: "one the host's interface adds, `start`, `call`, `batch` or `replace`".** It names commands. Cutting the names would let `arrive`, which is not a command, seem to count.
- **SCHEDULER, Status: "Status is in the header of the node's value item (`GRAPH.tex`, Paths)".** This is a scheduler consequence, with its pointer.
- **SCHEDULER, Killing: "Code ending by itself: its host or loader unplaces its node".** It is stated only here. It is a duty that LOADERS does not state, and LOADERS Open, *Letting code go*, is about the other direction.
- **SCHEDULER, The reference scheduler: "passing operations at an id on (`GRAPH.tex`, Operations)".** The pointer names where `at` is defined, so it is not stale. The rule for passing `at` on is in Running and wrapping.
- **Premises and reasons:**
  - SCHEDULER Open: "makes an ordinary node", and the other premises that carry pointers;
  - First-pass 1 and 6: "no operation reads the graph's highest time", "no read at an id";
  - the GRAPH intro and abstract summaries;
  - GRAPH Changes' example "(such as a scheduler's unplacement at a kill)".
- **SCHEDULER First-pass 5 quotes "no reserved names".** No paper states that rule.

## Disagreements, for you

Both texts of each are kept as they were. Quotes are from the papers with everything applied.

1. **Which clock stamps a change.**
   - `GRAPH.tex`, Running and wrapping (last paragraph): "Time (§changes): the scheduler's clock, in a stack that has one, else the holder's."
   - `SCHEDULER.tex`, The reference scheduler: "The scheduler stamps changes made through it with it; the host, its own beneath." First-pass 1: "*Clock*, the host's (The reference scheduler)".
   - In a stack with a scheduler, GRAPH has the scheduler's clock stamp every change. SCHEDULER has the host stamp the changes made beneath the scheduler with its own clock.
2. **What is inside a process node.**
   - `SCHEDULER.tex`, Processes, decision *The layout, for now: inside and alongside*: "everything inside ephemeral, never saved (`GRAPH.tex`, Ephemeral nodes)".
   - `GRAPH.tex`, Ephemeral nodes: "invalid (`ephemeral-parent`): making an ordinary node in an ephemeral node's slot, as it would be saved with nothing that made it; mounting one there is not".
   - So an ordinary node can be mounted inside a process node, and it is saved.
3. **Bookkeeping "never refused".**
   - `SCHEDULER.tex`, The reference scheduler: "the bookkeeping interface, beneath the wrappers: the bare graph, or a host layer over it passing operations at an id on", and "*Bookkeeping*: … via the bookkeeping interface: no `enter`, never refused (`GRAPH.tex`, Running and wrapping)".
   - `GRAPH.tex`, Running and wrapping, decision *One seam: enter*: "so an operation made on the bare graph brings none, and bookkeeping is never refused".
   - GRAPH promises no `enter` only on the bare graph. A host layer is a wrapper, and may hand its `enter` down.
4. **Readers marked only through refused reads, in a change's answer.**
   - `GRAPH.tex`, Operations: "an operation making a change answers with it; the readers it marked, each once, in code point order; which of them only through refused reads (§tracking)".
   - `PROTOCOL.tex`, Commands: "Which of them it marked only through refused reads (`GRAPH.tex`, Tracking) is not in the answer".
5. **`nothing-there`, and a route's steps.**
   - `GRAPH.tex`, Operations: "a write, placement, unplacement or move whose address, or `to`, reaches nothing: invalid (`nothing-there`)". At an id adds the unplacement given only `at`.
   - `PROTOCOL.tex`, Errors: "`nothing-there` & the address reaches nothing". This is wider: it does not say "a change". `SCHEDULER.tex`, Handlers, also gives it for `call`: "a handler whose node has gone: reached by nothing (`nothing-there`)".
   - A route: `GRAPH.tex`, Paths (From) says "the route, a step per address name (not the place's)". `PROTOCOL.tex`, Encodings (route) says "one for each name walked".
6. **GRAPH points to a copy that SCHEDULER never makes.**
   - `GRAPH.tex`, Running and wrapping (the entry layer): "A layer handing the bare graph a value from code some other way copies it first, as the scheduler does a compute's value (`SCHEDULER.tex`, Rounds)."
   - `SCHEDULER.tex`, Rounds: "if v is not equal to the value p last wrote: write v at p's id, as bookkeeping and as p". No section of SCHEDULER mentions copying.
7. **GRAPH's Open item 3 is answered in SCHEDULER.**
   - `GRAPH.tex`, Open, item 3: "A scheduler compares a compute's value with its process node's, which it knows by id (`SCHEDULER.tex`, Rounds); no read is made at an id, so where the process's address reaches another node, the value counts as not equal and is written again. Reads at an id, or the scheduler holding the value it last wrote?"
   - `SCHEDULER.tex`, Rounds: "if v is not equal to the value p last wrote". What the scheduler holds: "the value last written at its id". First-pass 6: "*The value compared* (Rounds): no read at an id."
8. **`replace`'s change makes the process due.**
   - `SCHEDULER.tex`, Programs, New code: "One change, an empty write at its pid as bookkeeping, status dropping `new`, makes it due".
   - `SCHEDULER.tex`, Marks: "A process the graph marked joins it, the one making the change included, unless being killed or the change was the scheduler's own write for it (Status; The latest run)."
   - The Marks decision names "a replaced process's by its replacement" as a reason, but Marks makes no exception for it.
9. **A process's own changes (a tension).**
   - `GRAPH.tex`, Tracking: "It marks the reader it was made with as any other, and names its process, so a process can pass over its own changes."
   - `SCHEDULER.tex`, Marks: "A process the graph marked joins it, the one making the change included".
10. **`reader` on the wire.**
    - `GRAPH.tex`, Running and wrapping, the entry layer: it "strips `reader`", and "The host puts it on top of its stack".
    - `PROTOCOL.tex`, Session: "Each stack has the entry layer on top". Commands: "Below `schedule`, `marked` is empty unless a request gave a reader, as `conformance/graph/HARNESS.md` lets one."
11. **When `start` is invalid.**
    - `SCHEDULER.tex`, Processes (`start`): "`start` is invalid only when its placement is, as `protect` and the graph decide (`PROTECT.tex`)."
    - `LOADERS.tex`, Finding the program (the Program definition): "one with `..` is `wrong-field` (field `program`)".
12. **Which processes a slow loader marks.**
    - `SCHEDULER.tex`, First-pass 25: "a slow loader marks those waiting by an empty write at its loader node".
    - `LOADERS.tex`, Loaders: "it writes an empty list of patches at its loader node, through the host's interface, so each process that read that node runs again". Open, *Marking only the waiting*: "marks every process that read that node, not only those waiting for it. Whether a loader can mark only those."
13. **What counts as read, for a height.**
    - `SCHEDULER.tex`, Order: "every other one whose last compute read anything it or its cleanups changed (a value, a slot, or a slot a walk went through)".
    - `GRAPH.tex`, Tracking, lists more, and a change marks through each of them:
      - every member tried, and whether its node is here;
      - the place's walk;
      - a whole directory;
      - what an `enter` refused;
      - the nodes its answers depended on.
14. **When two errors are equal (a tension).**
    - `SCHEDULER.tex`, Status: "errors are equal when kind and code are (whether details count: `CACHE.tex`, Open, An error's details)".
    - `PROTOCOL.tex`, Errors: "the code and its details are fixed, so tests compare them".
15. **A failed request changes nothing.**
    - `PROTOCOL.tex`, Session (Time, site and cause): "A request that is invalid or refused makes no change and uses no number."
    - `SCHEDULER.tex`, Order (The budget): "the request answers the error `budget` (`PROTOCOL.tex`, Errors); its changes stand". In `PROTOCOL.tex`, Errors, `budget` is "of kind `invalid`", and in Commands a batch that reaches the budget: "what it changed stands".
    - GRAPH says "nothing changes" only for a write (Patches). Once this is settled, the cross-file list proposes that the per-operation rule's home be GRAPH, Operations.
16. **Site and process (maybe only a reading).**
    - `GRAPH.tex`, Changes: "*site*, if no process", and "A change a layer makes because of a request … carries that request's process or site".
    - `PROTOCOL.tex`, Session: "a process's changes have no site (`GRAPH.tex`, Changes), so a request carrying both is `wrong-field`, field `site`".
    - PROTOCOL reads "if no process" as "only if no process". GRAPH does not say "only".
