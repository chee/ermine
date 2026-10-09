# GRAPH.tex: one source per rule

These patches go on top of `../graph-succinct/`. They were made against `core/graph/GRAPH.tex` (sha1 `1fbfa297`, 41895 bytes) with all 16 succinct patches applied (38236 bytes).

Apply from the repo root, succinct first:

    for p in working/patches/graph-succinct/*.patch working/patches/graph-one-source/*.patch; do patch -p0 -V none < "$p"; done

Each patch takes one rule that GRAPH states in two or three places. It states the rule fully in one place, its home. Everywhere else the rule is deleted or replaced with a pointer such as `(\S\ref{sec:operations})` or `letting go: \S\ref{...}`. Where a second statement added a condition the home lacked, that condition was moved into the home.

## Checks run

- Each patch applies alone to the succinct base with no fuzz.
- All 25 apply in order with no fuzz, and leave no `.orig` file. The result is the same as making every edit at once.
- With all of them applied, `tectonic GRAPH.tex` compiles with no warnings, the same as the base.
- These were not changed:
  - every `\label`, `\ref` target, decision title and property title;
  - every error code;
  - the operations table;
  - the patch listing;
  - the bibliography.
- The only new pointers are `\S\ref`s to labels that already exist.

## Patches

Patches 01–16 are the 18 rules listed under "Stated twice" in `../graph-succinct/README.md`. Two pairs of those rules share lines, so each pair is one patch: 02 covers two rules, and so does 03. Patches 17–25 are repeats found after that list was made.

"Words saved" is counted the same way as for the succinct patches, with each patch applied alone to the base. A negative number means the patch added words.

| patch | rule | home, and why | elsewhere | words saved |
|---|---|---|---|---|
| 01-subscription-keeps | A subscription keeps the changes its address reaches. | The `subscribe` row of the table, the operation the rule is about. | Abstract: "subscriptions keep it (§)". §Changes: "which subscriptions keep it: `subscribe` (§)". "Until taken" was already in the decision and the `take` row. | 17 |
| 02-take | `take` is not a read. `take` and `unsubscribe` drop events. | §Operations: the prose after the decision, and the table rows. These are the operations themselves. | First-pass choices keeps both items, but only as pointers: "`take(subscription)`, and the events it and `unsubscribe` drop (§)" and "`take` not being a read (§)". The list still says what the first-pass choices are. | 10 |
| 03-time-and-site | A change's time comes from a clock outside the graph. The entry layer gives a change with no process its site. | Time: §Changes, the header's time field. Site: the entry-layer list, since the entry layer is what gives it. | The last paragraph of §Running keeps only what is said nowhere else: "Time (§): the scheduler's clock, in a stack that has one, else the holder's", and "Site: captured where the call enters the stack", with the per-language detail. §Changes's time field gains a pointer to §Running. | 16 |
| 04-strip-at | A layer whose interface is given to code strips `at`. | The wrapper paragraph in §Running. It states the general rule, names the entry layer and the view, and gives the exception for the host's own layers. | Entry-layer list: "as it strips `at`" is cut. View decision: "so it strips `at`" is cut. | 8 |
| 05-item-header | An item carries the header of the change that set it, or none. | The Header paragraph in §Paths. It gives the cases: a value item, a slot item, and none. | Reads are lists property: "and its header (below)". | 7 |
| 06-answer-tracked | The nodes an `enter` answer depended on are tracked as refused. | The decision *enter's answer names what it read*. The decision box is the home. | §Tracking: "The nodes an answer depended on: *enter's answer names what it read* (§)". | −1 |
| 07-ephemeral-last-change | An ephemeral change is never a slot's last change. | §Ephemeral nodes, which defines the ephemeral change. | §What the graph holds: "each value's and slot's last change (§ephemeral)". | 8 |
| 08-ids-let-go | An unplacement answers with the ids it let go, in order. | The §Operations bullet listing what a change answers. "In the order they went" was moved there. | §Ephemeral nodes keeps only why: "With its answer (§), a host can let the gone nodes' live things go in the order they went, and a scheduler end the processes…". | −2 |
| 09-ids-are-strings | Ids and names are strings. | The Node definition: "an id (a string …)", "directory (string names to slots)". | The Value definition: "Ids and names are strings" is cut. | 4 |
| 10-pending-id | An id whose node is not here gives a pending item, and walks pass over it. | §Paths: Walking, and Reading an address. These are the walk and the read. | §Placement keeps the definition of a pending id. "walks pass over it; its slot item is pending" becomes "(§paths)". The property keeps "a placed id's node" as its example of a pending item. | 9 |
| 11-subscription-enters | A subscription keeps the `enter`s it brought. | §What the graph holds, the list of what is held. | §Running: "A subscription's `enter`s (§state) are asked again …". The rest of that sentence is kept word for word (see the succinct README, Ambiguous). | 5 |
| 12-missing | `missing` is for a change with neither process nor site. | §Changes, at the site field. | §Running's list of the graph's own checks: "`missing` (§changes)". | 4 |
| 13-slot-header-open | A slot item's header may be about another member. | The Header paragraph in §Paths. | Open item 1: "A slot item's header (§paths): should each member carry …?" | 9 |
| 14-at-an-id | Only an operation at an id, on the bare graph, starts from a node given by id. | §Operations, At an id. That paragraph defines `at`, on the bare graph. | §Paths: "Everything is reached by path, except by an operation at an id (§)". | 10 |
| 15-runs-nothing | The graph runs nothing; a scheduler runs what each change marked. | The decision *The graph marks; the scheduler runs*. | Abstract: "The graph runs nothing" is cut. Intro: "Programs run as processes, under a swappable scheduler (§running); a process's latest run says …". This drops "outside the graph" and a restatement of marking. | 24 |
| 16-lookup-no | A no from `enter` ends a lookup's search. | §Lookup, which says what the lookup then gives. | §Running, the list of where the graph asks: "No: §lookup". | 3 |
| 17-saving | A keeper saves the graph and makes a new one from what it saved. | §Nodes, which defines `graph(root, restored?)`. | §What the graph holds: "It saves nothing itself (§nodes; `HOST.tex`, The keeper)". | 13 |
| 18-live-host | Live values never leave their host. | The Value definition: "live: held only by its host". | The paragraph on live values: "never leave their host" is cut. | 4 |
| 19-copied-in | Values from code are copied in. | §Running: the entry layer, and "a layer handing the bare graph a value … copies it first". This is about who copies. | §Values: "Copying in values from code: §running (The entry layer)". | 1 |
| 20-bound-place | An interface is bound to a place. | The decision *An interface fixes its agent and its place*. | The Place definition: the sentence is cut. | 7 |
| 21-refused-position | A from's step notes the positions of the members `enter` refused. | The From definition. | §Running, at the walk's members: "its from's step noting its position" is cut. From already points to §Running. | 6 |
| 22-lookup-from | A lookup item's from is the path from the place to its slot. | The From definition. The `["..", "theme"]` example was moved there. | The Lookup definition: "(from: §paths)". | 3 |
| 23-lookup-pending | A pending step ends a lookup with a pending item, from the path to the directory, after what `lookups` found. | §Lookup, which already says "Pending: the same", and the same for `lookups`. | The pending paragraph in §Running: "(a search's: §lookup)". | 12 |
| 24-reader-carried | An operation may carry a reader. | The §Operations bullet listing what an operation carries. | §Tracking: "An operation's reads are tracked under its reader (§operations) as made …". | 3 |
| 25-write-walk-enter | A change's walk asks `enter` as a read's does. | §Running, the list of where the graph asks. It covers every operation. | §Tracking: "though it asks `enter` (§running)". | 4 |

Patches 06 and 08 add a word or two. They are there to give the rule one source, not to save words.

## Totals

|  | original | after succinct | after both |
|---|---|---|---|
| prose words | 6330 | 5222 | 5038 |
| bytes of GRAPH.tex | 41895 | 38236 | 37584 |

Compared with the succinct base, these patches cut 184 words (−3.5%) and 652 bytes (−1.7%). Compared with the original, both sets together cut 1292 words (−20.4%) and 4311 bytes (−10.3%).

## The two conflicts, and the ambiguities

- **Placement vs Ephemeral ("the slot's last").** Patch 07 changes only §What the graph holds. That list said the same as §Ephemeral ("a slot's: its last that is not ephemeral"), and its new pointer leads to §Ephemeral. Both sides of the conflict keep their meaning: §Ephemeral's "never a slot's last change" and §Placement's "still a change, and the slot's last" are untouched.
- **Nodes vs At an id ("made by placing").** Neither side is touched. Patch 09 edits the Node definition, but not "Other nodes: made by placing". Patch 14 edits §Paths, but not At an id.
- **§Nodes, restored: "the headers of their last changes that were not ephemeral" is not patched.** The succinct README marks this wording as ambiguous. A pointer to §Ephemeral would pick one reading. The two readings differ exactly when the Placement/Ephemeral conflict applies, so that choice is left to you.
- **Patch 06 and the yes-answer question.** The pointer stays where the old sentence was, in the paragraph about no and pending answers. The decision says "each answer", as it did before. The question of whether yes answers count is no more or less open than it was.

## Repeats found but left

- **The abstract's other items** (node, patches, read, "everything is reached by path", tracking). They summarise sections in a few words, which is the abstract's job. Only the items that carried a rule's conditions (01) or a rule a decision states (15) were cut.
- **The intro's lookup paragraph** ("like `node_modules`", the three directions). It is the only place the three directions appear. "The first wins, the rest are still read" is a gloss on §Paths.
- **The property's "pending item: … (a placed id's node; …)".** The box's example; see 10.
- **"A refused or pending item holds only its from" (§Running) against "else pending, with no value" (§Paths).** It is unclear whether the first covers the slot item of a not-here id, whose id is known. Merging the two could change their meaning.
- **§Operations: "a wrapper may add more (as the scheduler adds `start` and `batch`)" against the wrapper definition's "may add its own".** A pointer would be just as long. SCHEDULER also adds `call` and `replace`; see the cross-file list.
- **The One seam decision ("bookkeeping is never refused") against the wrapper paragraph ("goes around every wrapper, as a scheduler's bookkeeping does").** The decision's line is a consequence of its own rule, so it was left.
- **The view decision ("… is for `protect`") against the One seam decision ("Who refuses, and why: the wrapper's (`protect`'s)").** These are two decisions, each with its own reason.
- **Premises that already carry pointers.** §Ephemeral says "no node moves inside itself (§placement)" and "an unplacement at its id lets it go (§operations)".
- **Context an open question needs.** Open item 2 says "a move at an id walks its address and `to` from one node". Open item 3 says "no read is made at an id".
- **Fault order 3** ("a write's patches checked in order, each against the value the ones before it made") against §Patches ("apply in order"). The fault item needs it, and §Patches has no label to point to.
- **Lookup's "no higher"** against Place's "nothing above it can be named or found". Two words.
- **Related work, Subtext:** "every value says which change made it" repeats the intro. It is a comparison.
- **Table cells** `unplace` and `cwd` repeat §Placement and the Place definition. The table is kept as it is.

## Rules GRAPH shares with SCHEDULER, LOADERS and PROTOCOL (not patched)

This list comes from reading the succinct-applied GRAPH against `core/scheduler/SCHEDULER.tex`, `core/scheduler/LOADERS.tex` and `core/PROTOCOL.tex`.

The rule for choosing a home:

- a graph rule belongs in GRAPH, and the other file keeps only its own consequence or wire keys;
- a scheduler rule belongs in SCHEDULER, and GRAPH points to it;
- a wire shape belongs in PROTOCOL.

**Home: SCHEDULER (GRAPH should only point)**

- **The scheduler's clock gives the time.** GRAPH §Running: "the scheduler's clock, in a stack that has one". SCHEDULER, The reference scheduler: "The clock gives each change its time". GRAPH keeps only "a clock outside the graph".
- **What a process's latest run shows.** GRAPH intro: "what marked it and what it looked up, read and wrote". SCHEDULER, The latest run.
- **The operations the scheduler adds.** GRAPH §Operations: "start and batch". SCHEDULER, What a process is given: `start`, `call`, `batch`, `replace`, and `arrive`. GRAPH's list is incomplete.
- **A process node is ephemeral, one place per process.** GRAPH §Ephemeral. SCHEDULER, Processes. GRAPH keeps the one-slot rule.
- **The scheduler kills the processes whose nodes went.** GRAPH §Ephemeral ("a scheduler end the processes whose nodes went"). SCHEDULER, Killing.
- **Only the scheduler binds a reader.** GRAPH, the entry layer. SCHEDULER, What a process is given (peep). GRAPH keeps "the entry layer strips `reader`".
- **The shape check on arrivals.** GRAPH, the entry layer. SCHEDULER, Arrivals. GRAPH keeps the general rule for whatever goes around the entry layer.
- **Arrivals and bookkeeping use operations at an id.** GRAPH, At an id. SCHEDULER, Arrivals and The reference scheduler. GRAPH only defines `at`.
- **The entry layer on every process's interface.** GRAPH, the entry layer. SCHEDULER, What a process is given.
- **A release carries the request's process or site.** SCHEDULER, Ephemeral nodes, repeats GRAPH §Changes ("a change a layer makes because of a request …"). It also adds the agent. GRAPH keeps the general header rule.

**Home: GRAPH (the other file should only point)**

- **Ephemeral nodes are never saved; an ephemeral node no place reaches stays here; one-place.** SCHEDULER (unique-and-local decision, layout decision, Killing, Open) and PROTOCOL Errors (`one-place`, nearly word for word).
- **Unplacing at an id lets an ephemeral node go; a write at an unknown id makes an ordinary node.** SCHEDULER, Ephemeral nodes and Open.
- **A new id must not be here or held by a slot; the node goes at the end of the slot.** SCHEDULER, Processes.
- **`at` is for the holder of the bare graph; the entry layer strips it.** PROTOCOL, Session. SCHEDULER, The reference scheduler.
- **The bare graph brings no `enter`, so bookkeeping is never refused.** SCHEDULER, The reference scheduler.
- **A place is names, not a node; cwd; a move lets nothing go.** SCHEDULER, Processes and the decision "A place is names". SCHEDULER keeps "not killed".
- **No reader means not tracked; `forget` drops reads.** SCHEDULER (peep, Killing) and PROTOCOL (test-reload).
- **A change marks the reader it was made with, marks even when nothing changes, and marks when a node becomes here.** SCHEDULER (Marks, Status, Code is a read) and LOADERS (Loaders, Finding the program). SCHEDULER, Order paraphrases the marks list more narrowly: it leaves out whole-directory reads and here/not-here changes.
- **Lookup gives the nearest slot holding a node that is here; a refused step ends it with a refused item.** LOADERS (Finding a loader, Finding the program) and PROTOCOL (Commands, Items).
- **Live values never leave their host.** LOADERS ("It never leaves its host"), PROTOCOL ("never crosses a line"), and SCHEDULER (What a part returns).
- **Root starts null; restore keeps the highest time.** PROTOCOL, Session and test-reload. SCHEDULER, What the scheduler holds.
- **Time is above the highest time, and names one change.** PROTOCOL, Encodings, Session, and the `time` error. PROTOCOL keeps the 1..2^53−1 range.
- **Error meanings.** `above-root`, `exists`, `not-in-slot`, `ephemeral-parent`, `position`, `nothing-there`, `read-only`/`write-only`, the patch codes and `pending` are all restated in PROTOCOL, Errors. PROTOCOL should keep only each code, its kind and its details.
- **Value rules.** String excludes surrogates; numbers are binary64; reads are lists; a directory is listed in code point order; items say "ephemeral". These are in PROTOCOL, Lines, Values in JSON, and Items. PROTOCOL keeps the JSON forms.
- **Header fields and change body.** PROTOCOL, Changes and Encodings, restates them along with their keys.
- **From and route; pending, refused and union-member items.** PROTOCOL, Encodings and Items, restates them almost word for word. PROTOCOL keeps the keys.
- **What a change answers** (readers marked once, in code point order; the ids that went). PROTOCOL, Commands (`gone`, `marked`).
- **What every operation carries; operation signatures; subscriptions and events.** PROTOCOL, Acting as someone, Commands, and Events.
- **A failed operation changes nothing.** GRAPH states this only for a write's patches (§Patches). PROTOCOL, Session states it for every request. The home should be GRAPH, stated for every operation. PROTOCOL keeps "uses no number".

**Home: PROTOCOL**

- **The site's shape and the harness's site field.** GRAPH §Running mentions "a harness is given it in each request".
- **Errors come from a fixed list, and what the kind `refused` means.** GRAPH §Operations, last bullet.

**Disagreements noticed along the way (checked against the files, not patched)**

- **GRAPH Open item 3 is out of date.** SCHEDULER, Rounds compares with "the value p last wrote", "which it holds: no read is made at an id".
- **A dangling pointer.** GRAPH's entry layer says "as the scheduler does a compute's value (`SCHEDULER.tex`, Rounds)", but SCHEDULER never mentions copying.
- **Own changes (a tension rather than a contradiction).** GRAPH: a change "names its process, so a process can pass over its own changes". SCHEDULER, Marks: the process that made the change still joins the due list.
- **Refused-only readers.** GRAPH: the answer says which readers were marked only through refused reads. PROTOCOL: this "is not in the answer".
- **Site and process.** PROTOCOL makes a request carrying both `wrong-field`. GRAPH only says "site, if no process".
- **"Everything inside is ephemeral."** SCHEDULER's layout decision says this. GRAPH lets an ordinary node be mounted in an ephemeral node's slot.
- **`reader` on the wire.** PROTOCOL lets a harness request give a reader. GRAPH's entry layer strips `reader` on every stack.
- **`nothing-there`.** PROTOCOL's meaning ("the address reaches nothing") is wider than GRAPH's, which covers changes only. The same goes for a route's steps: PROTOCOL's "one for each name walked" drops GRAPH's "(not the place's)".
