# SCHEDULER.tex: one source per rule

These patches go on top of `../scheduler-succinct/`. They were made against `core/scheduler/SCHEDULER.tex` (sha1 `3d3a1f37`, 45830 bytes) with all 25 succinct patches applied (38616 bytes).

Apply from the repo root, succinct first, both with `patch -p0 -V none`:

    for p in working/patches/scheduler-succinct/*.patch working/patches/scheduler-one-source/*.patch; do patch -p0 -V none < "$p"; done

Succinct 24 still prints `No such line 783 in input file, ignoring`. That message is harmless. These patches print only `patching file`.

Each patch takes a rule that SCHEDULER states in two or more places. It states the rule fully in one place, its home. Everywhere else the rule is deleted or replaced with a pointer in the paper's style, such as `(Marks)` or `(\S\ref{sec:api})`. Where another statement added a condition the home lacked, that condition was moved into the home.

## Checks run

- Each patch applies alone to the succinct base with `-F0`: no fuzz and no offset.
- All 21 apply in order with `-F0` and leave no `.orig` file. The result is the same as making every edit at once.
- Starting from the original file, applying succinct and then these with plain `patch -p0 -V none` gives the same file.
- With all of them applied, `tectonic SCHEDULER.tex` compiles. It gives one underfull-box warning, in the handler-call agent paragraph, as the base does.
- These were not changed:
  - every `\label`, `\ref` target and decision title;
  - every error code;
  - the code listings;
  - the part table;
  - the bibliography.
- New pointers are `\S\ref`s to existing labels, or section names as the paper already writes them.

## Patches

Patches 00–09 cover the 12 rules under "Stated twice or more" in `../scheduler-succinct/README.md`. Patches 10–19 are repeats found after that list was made. Patch 20 covers the First-pass choices.

Three patches cover more than one rule because the rules share a line:

- 02 also cuts the decision box's "which only host code gives";
- 10 covers two rules in one sentence of `start`;
- 17 covers two rules in the Programs list.

Every First-pass edit is in patch 20, including the edits for rules that have their own patch. Adjacent items belong to different rules. Patches that split them would share context lines, and Apple's `patch` rejects a hunk whose context is empty or uneven. So patch 20 applies alone, and it also moves into the body the three conditions its items held.

"Words saved" is counted the same way as for the succinct patches, with each patch applied alone to the base. A negative number means the patch added words.

| patch | rule | home, and why | elsewhere | words saved |
|---|---|---|---|---|
| 00-abstract | The abstract restated these rules: processes are ephemeral nodes that end with their node; the three program kinds; computes and effects are children of their starter; the interface; no history; status and the latest run go into the graph; four moments go to hooks. | The sections that state them: Processes (definition, Killing, Children), Programs, What a process is given, The latest run, Hooks. | The abstract keeps its first sentence. The rest is now a map of the paper, with no rules. Nothing else depends on this patch, so drop it if you want an abstract that gives the gist. | 42 |
| 01-own-writes | No own write makes its own process due. | Marks: "joins it … unless … the change was the scheduler's own write for it (Status; The latest run)". Marks says what makes a process due. Its wording is the broadest of the copies and is unchanged. | Status: "No status write makes its own process due" is cut. The latest run: "A write to `run` never makes its own process due" is cut. First-pass 4 (in 20). | 18 |
| 02-own-marks | The scheduler marks its own changes in the last `code` step: `"status"` on status writes, `"kill"` on releases; an empty `code` becomes that one step. Also: only host code gives `person` and `trusted`. | The decision *The scheduler marks its own changes in the agent*. The decision box is the home. "An empty `code` becomes that one step" was moved there from Ephemeral nodes. For `person` and `trusted`, the home is the What a process acts as line "only on a handler call by host code knowing a person made it". | What a process acts as: the sentence "The scheduler's own writes add …" is cut. Status: "carries the whole status, `"status": s` (What a process acts as)". Ephemeral nodes: "The agent gains `"kill": pid` (What a process acts as), `pid` the node's owner." The box: "which only host code gives" is cut. First-pass 2 and 10 (in 20). | 16 |
| 03-cleanups | Cleanups run before their part reruns, told `{"killed": false}`, and at the kill, told `{"killed": true}`, newest first. | The `onCleanup` item in What a process is given. That item defines cleanups, and it covers both reruns and kills. | Killing step 3: "cleanups (§api), an error ending one not stopping the rest". New code: "a setup's cleanups run (§api), then the setup". Rounds: "its earlier effect parts' cleanups run (§api); an error ending one is the run's". Each place keeps its own rule for errors. | 13 |
| 04-unreachable | A process runs while its node is here, whether or not an address or place reaches it. A process node no place reaches stays, running on. | Killing, which says what ends a process and what does not. | Processes: the paragraph "A process runs while its node is here, whether or not its address reaches it; value and status at its id" is cut. Its parts are already said elsewhere: rearranging is no kill (Killing, and *A place is names*), and the value and status are written at the pid (Status). Open, Unreachable processes: "(Killing). Does anything release one, …?" | 34 |
| 05-no-history | The scheduler keeps no records; a hook can record. | The decision *The scheduler keeps no runs, and writes the latest*. What the scheduler holds lists the whole state, so it covers the due moment too. | The Hooks decision: "No records kept; a recorder listens on the hooks" is cut. Its "(e.g. a recorder)" stays. The abstract's copy is in 00. | 9 |
| 06-who-starts-children | Any part or handler call but a cleanup may start children while it runs. | The part table: `start` is in every row but cleanup's. "A part's interfaces stop when it returns" also applies. | Children: the sentence is cut, and the definition gains (§api). First-pass 19 (in 20). "Children of their starter" lives in Children; the abstract's copy is in 00. | 13 |
| 07-value-written | A setup's or compute's value is written at its pid, as bookkeeping and as the process, when it is not equal to the last one written. | Rounds: the run listing and "a setup's value is written as a compute's". Writing the value is a step of the run. | Status: "the value, as a snapshot (Rounds); an empty list of patches when …". "Snapshot" stays in Status because the listing cannot change. First-pass 6 (in 20). | 13 |
| 08-host-interface | The host's interface has `start`, `call`, `batch` and `replace`. | The sentence in What a process is given that lists the host's interface. | New code: "`replace` (§api):". Outside operations: "`batch`, the scheduler's own (§api):". First-pass 14 (in 20). | 6 |
| 09-pending-at-budget | When a request ends, pending is written for each process still due. | Status. | The budget: "due stays due, pending written" becomes "due stays due". Reaching the budget ends the request. First-pass 3 and 7 (in 20). | 2 |
| 10-start-chroot-due | (a) A process's first run is marked by its start. (b) A new process's `/` is its starter's chroot, and its `cwd` is the path from there to its place. | (a) The decision *Every reason is a change*, in Marks. (b) The Process definition, at Place. | `start`: the sentence "The new process acts beneath the caller's `/`, `cwd` …; it is due by the start's change." is cut. Its `cwd` clause moved to Place. | 15 |
| 11-code-each-run | A program given as a path is found by `code` at each run, not by `start`. Code given to `start` runs as is. | The decision *Code is a read*. | `start`: "a path, searched for … at each run (Programs, Code is a read), or code, … (Programs), run as is". Programs: "A path given to `start`: found by `code` …; code given: run as is." is cut. "Run as is" moved to `start`. | 11 |
| 12-handler-place | Handlers go at `on/<name>` inside their process's node. | The layout decision (Processes). | Handlers: "placed by a process as the layout says (Processes)". | 3 |
| 13-handler-error | When an uncaught error ends an outside handler call, earlier changes stand. | Outside operations and batches: "Outside handler calls and `replace`: likewise". | Handlers: "earlier changes stand" is cut and a pointer added. "Goes back to a caller outside a round" stays, because Outside does not say it. | −1 |
| 14-order-hook | The order hears the hook moments. | The Hooks decision: "serving the order and anyone else". | Hooks prose: "The order stops a run at a read (Order)." | 5 |
| 15-reads-shown | Every read passes the `reads` hook, and a run's reads are listed in its latest run. | Hooks ("`reads`: every read …, tracked or not") and The latest run (the `reads` field). | What a process is given: the sentence is cut. | 14 |
| 16-kept-changes | A run that ends stopped or parked keeps its changes. | Marks: "kept when a run ends pending, failed, stopped or parked". | Order: "Kept changes stay;" is cut. Loops: "kept changes kept," is cut. | 6 |
| 17-program-kinds | (a) A compute's return is the process's value. (b) An effect part may act in the graph or outside it. | (a) The Process definition: "Value: its setup's return, or its compute's last return". (b) Programs: "Whether an effect part writes the graph is not the scheduler's rule." | The compute item: "Returns a value, or pending". The effect item: "which acts on it." | 6 |
| 18-open-premises | Open items that restated rules before asking their question. | Killing: a kill beneath the scheduler goes unseen. Ephemeral nodes: only processes move ephemeral nodes. The reference scheduler: interfaces bind over the top of the stack. | Open, A kill beneath the scheduler: "(Killing). The process's next write …". Moving a process node: "Host code cannot (Ephemeral nodes), even one it started." The top of the stack: "bound over it (The reference scheduler)". | 29 |
| 19-queued-after-round | Requests made during a round are queued and run after it. | Requests. | Rounds: "Then the round's queued requests run." is cut. | 6 |
| 20-first-pass | Each First-pass choice restated its body rule. | Each item's home is in the table below. | Each item keeps three things: what it picks, named in its title; a pointer; and its reason. An item that had no reason is now a pointer. Item 25 (Loaders) is unchanged (see LOADERS.tex below). Three conditions the items held move into the body: in Children, "the child replaced too, by an empty write at its pid" (from 14) and "a call ending otherwise keeps them" (from 13); in New code, "pending or an error included" (from 15). | 220 |

### Patch 20, item by item

| item | home | kept in the item |
|---|---|---|
| 1 Clock | The reference scheduler | why: no operation reads the graph's highest time |
| 2 Status | *The scheduler marks its own changes*; Status | why: a map in the value could not hold a live value |
| 3 Pending | Status | why: re-marking, loops never settling |
| 4 Own writes | Marks | why: one reading its own node would never stop |
| 5 The latest run | Processes ("Inside, the scheduler writes only the latest run"), The latest run, Hooks | the cost: `run` narrows "no reserved names" |
| 6 The value compared | Rounds | why: no read at an id |
| 7 Budget | Order, The budget | why: "it never splits a compute from its effect part" (was "checked before each starts, so …") |
| 8 Queued requests | Requests | why |
| 9 `code`'s reads | *Code is a read*; What a process acts as | pointer |
| 10 Releases | Ephemeral nodes | why, and "no cause" |
| 11 Handlers | Handlers; The budget | pointer |
| 12 call lasts | What a process is given | why |
| 13 Matching and release | Children | why, now worded "were a matched child rerun on taking new code" (was "otherwise") |
| 14 replace | What a process is given; New code; Children | pointer |
| 15 New code | New code | pointer |
| 16 One writing view | the part table | pointer |
| 17 onCleanup | the part table | why |
| 18 The second half | Rounds | pointer |
| 19 start from a compute | the part table | why |
| 20 A compute's data | Children, and `start`'s listing (it takes no data) | why |
| 21 Live values | What a part returns | pointer |
| 22 Stopping in a loop | Order | why |
| 23 Loops | Order, Loops | pointer |
| 24 Code given to start | What a process acts as | pointer |

## Totals

|  | original | after succinct | after both |
|---|---|---|---|
| prose words | 6721 | 5132 | 4652 |
| bytes of the .tex | 45830 | 38616 | 36046 |
| lines of the .tex | 859 | 764 | 736 |

These patches cut 480 words, 9.4% of the succinct text, and 2570 bytes. Both sets together cut 31% of the original's words and 21% of its bytes. The per-patch counts add up to 480. Words are counted as in the succinct README.

## Cut as a consequence of other rules

Check that none of these was a rule:

- **04:** "whether or not its address reaches it". Killing's "Rearranging the tree around it: no kill" and *A place is names* cover it.
- **04:** Open's "whose node's ordinary holder", and its `GRAPH.tex` pointer. Only an unreachable ordinary holder leaves a process node here but unreachable (`GRAPH.tex`, Ephemeral nodes). Killing already points there.
- **20, item 1:** "shared with the scheduler". The reference scheduler says the host stamps its own changes beneath.
- **20, item 13:** "so reruns only through its reads and compared `data`, or once per replacement of its maker".

## Left as they are

- **Killing:** "Unwinding, newest first:" heads the list, and items 2 and 4 also say "newest first". Cutting either side could make the header read as the order of the steps.
- **Every scheduler and Status:** "whenever a read can reach it, its status says pending" is the rule for every scheduler. Status says how the reference scheduler meets it.
- **The loop decision and Loops:** the paragraph defines the decision's "a change from outside it" (one its loop did not cause) and "its sides shown" (`through`).
- **The pull-on-read decision and Order:** the paragraph adds the height and names "waits after".
- **Replacement making a process due:** the Marks decision gives "a replaced process's [first run] by its replacement" as an example. New code's "One change … makes it due" is needed to say what that change is for.
- **Pending code:** "if `code` gives pending, the run ends pending" is in *Code is a read*, How a run ends, and the listing. The box needs it to say what waiting is, and the listing cannot change.
- **Children's owned nodes:** "their nodes are ephemeral nodes it owns (below)" against Ephemeral nodes' "its children's nodes included". Children's version is already a pointer.
- **What the scheduler holds:** this summarises the state by design. "Handlers and latest runs: in the graph" marks where that state ends.
- **Related work:** it restates rules in order to compare them.
- **An old tension:** Marks rules out "the scheduler's own write for it". Yet `replace`'s change, a bookkeeping write at the pid, "makes it due" (New code). The Marks decision names replacement as a reason, so `replace` seems meant as an exception, but Marks does not say so. This was true before these patches.

## Restated from other papers (not patched)

The place named last in each item is where the rule should live.

**GRAPH.tex**

1. The reference scheduler, Clock: "above any it gave and the graph's highest (`GRAPH.tex`, Nodes)". This rule lives in GRAPH, Changes (time), and the pointer names the wrong section. Keep a pointer to Changes.
2. Which clock stamps. The reference scheduler says "the host, its own beneath", and First-pass 1 says the clock is shared. GRAPH, Running and wrapping disagrees: "the scheduler's, in a stack that has one, otherwise the holder's". Which clock a stack uses is a scheduler and host matter, so it lives in SCHEDULER. GRAPH should say only "a clock outside the graph".
3. Bookkeeping: "no `enter`, never refused". This lives in GRAPH, One seam, but GRAPH promises it only for the bare graph, and the bookkeeping interface may be a host layer. Keep a pointer, and add a scheduler rule that such a layer adds no `enter`.
4. Arrivals: "its shape checked by the entry layer's check". GRAPH, Entry layer states it too, and each paper points at the other. It lives in GRAPH, Entry layer.
5. `start`: "An id the graph has or a slot holds: invalid". This lives in GRAPH, Placement and Ephemeral nodes. Cut it: `start` already says it is invalid only when its placement is.
6. `start`: "A name the slot has: no clash; the node goes last in the slot". This lives in GRAPH, Placement. Keep only that `start` gives no position, and the exception for matching.
7. The Place `cwd`, which patch 10 moved into the Process definition. GRAPH, Paths says "its cwd is the place's names after the start". It lives in GRAPH, Paths. Keep "its `/`: the starter's chroot".
8. *A process is unique and local*: "Ephemeral (`one-place`, never saved)". This lives in GRAPH, Ephemeral nodes. Keep a pointer.
9. The layout decision: "everything inside ephemeral, never saved". This **disagrees** with GRAPH, Ephemeral nodes: an ordinary node may be mounted inside a process node, and it is saved. Say "what it makes inside is ephemeral", with a pointer.
10. *A place is names*: "moving or renaming a folder above does not change it … another node, or nothing". This lives in GRAPH, Paths, Place. Keep only the process part.
11. Killing: "unplaced, at an address or its id, or gone with an ephemeral node holding it". This lives in GRAPH, Ephemeral nodes and At an id. Keep "its node gone", with the pointer.
12. Killing: "A process node no place reaches stays". This lives in GRAPH, Ephemeral nodes. Keep "running on" and a pointer.
13. Release: "(found even where no address reaches it) from its one slot". This lives in GRAPH, Operations, At an id. Point to At an id and cut the gloss.
14. Release: "carrying its cause's agent and process, or site". The process or site lives in GRAPH, Changes. Keep the agent and the `kill` step. "Cause" also clashes with GRAPH's `cause` header field, and with First-pass 10's "no cause".
15. What a part returns: "The value may be live: the process node is ephemeral". This lives in GRAPH, Values. Keep a pointer.
16. `peep`: "only the scheduler binds a reader". GRAPH, Running and wrapping says the same and points back to SCHEDULER. It lives in GRAPH, since the entry layer enforces it.
17. Order, heights: "(a value, a slot, or a slot a walk went through)". This **disagrees** with GRAPH, Tracking, which lists more, such as whole directories, ids being here, refused reads and `enter`'s nodes. It lives in GRAPH, Tracking. Say "whose last compute those changes marked".
18. Lighter copies next to a pointer:
    - "its changes have their site": GRAPH, Changes.
    - "Status is in the header of the node's value item": GRAPH, Paths. This relies on an empty write counting as the change that "last set" the value.
    - "a restored graph has the highest time saved": GRAPH, Nodes.
    - Open's "makes an ordinary node": GRAPH, At an id.
    - First-pass 1 and 6, "no operation reads …" and "no read at an id": GRAPH, Operations.
    - The abstract's "a change reports the readers it marked (Tracking)": that rule is in Operations.
    - "passing operations at an id on (Operations)": that rule is in Running and wrapping.
19. First-pass 5 points to "no reserved names", a rule that no paper states.

**LOADERS.tex**

1. `start`: "searched for from the new place". This lives in LOADERS, Finding the program. Keep a pointer.
2. First-pass 25 restates three LOADERS rules: "whole program or none", the slow loader's empty write, and "a live program node is code as is". Its "marks those waiting" also **disagrees**. LOADERS, Loaders says the write marks every process that read the node, and LOADERS Open, *Marking only the waiting*, leaves that question open. These rules live in LOADERS, so drop the item.
3. Killing: "its host or loader unplaces its node". This is a duty for loaders that LOADERS never states; LOADERS Open, *Letting code go*, says loaders are not told of kills. If it stays, it lives in LOADERS.
4. `start`: "invalid only when its placement is". This **disagrees** with LOADERS, where a program path with `..` is `wrong-field` (field `program`). Say "when its placement or its program is".
5. The latest run's `"program": {"node": id, "time": t}`. This shape lives in LOADERS, Finding code, and PROTOCOL, Encodings. The run listing has no pointer to it.
6. Two copies are on LOADERS' side. These are scheduler rules that LOADERS repeats: "each run first calls `code(process, view)`" (LOADERS, *The host finds code*), and "the code's arrival marks the process" (LOADERS, Finding a loader).

**core/PROTOCOL.tex**

1. What a part returns: "`wrong-field`, field `value`, no operation named". Whether `op` appears is PROTOCOL's rule (Errors), and its list lacks this case. Add the case there, and keep "fails the run: `wrong-field`, field `value`".
2. Status: "errors are equal when kind and code are". This is in tension with PROTOCOL, Errors: "the code and its details are fixed, so tests compare them".

**Seen in GRAPH, about the scheduler**

- GRAPH, Running and wrapping says the scheduler copies "a compute's value (`SCHEDULER.tex`, Rounds)". Rounds has no copy.
- GRAPH Open item 3 asks whether the scheduler should hold the value it last wrote. It now does: see the Rounds listing, What the scheduler holds, and First-pass 6.
