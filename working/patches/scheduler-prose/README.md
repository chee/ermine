# SCHEDULER.tex prose patches

Made against `core/scheduler/SCHEDULER.tex` as of 2026-10-09 14:01 (sha1 `3d3a1f37`).
These patches change prose only. Code listings, the table, decision titles, labels,
`\ref`s and the bibliography are untouched.

Apply from the repo root:

    patch -p0 --dry-run < working/patches/scheduler-prose/05-processes.patch
    patch -p0 < working/patches/scheduler-prose/05-processes.patch

Each patch applies alone. All 25 also apply together, in order or in reverse, with no
fuzz, so you can apply any subset. Patches 02 to 10 carry only 1 or 2 lines of context,
so that neighbouring patches never touch each other's lines. With all applied, the file
compiles (tectonic) with the same single underfull-box warning as before.

## Patches

"Saves" is the prose words cut. A negative number means the patch adds words, mostly by
naming who acts where the old sentence said "it" or used the passive.

| patch | saves | what it does |
|---|---|---|
| 00-abstract | 0 | Ends three colon and semicolon joins with full stops. "which end when their node goes" becomes its own sentence. |
| 01-every-scheduler | 2 | "is a wrapper over" becomes "wraps". The pending rule now has the scheduler as subject: "once a scheduler is told a process is marked, the process never reads as current until it runs". |
| 02-reference-scheduler | 5 | The one-sentence list of what the host gives becomes an itemize. Splits the clock and bookkeeping paragraphs. "a refusal can never" becomes "no refusal can". |
| 03-requests | 1 | Splits the rules for queued requests into four sentences. |
| 04-arrivals | -3 | Splits the five-verb chain in two. "it makes" and "it marked" become "the change makes" and "the change marked", because "it" could be read as the scheduler. |
| 05-processes | 2 | Splits the semicolons in the definition, in `start` and in the unique-and-local and place decisions. "may be sent the node" becomes "may get the node". "Its value and status are written" becomes "The scheduler writes its value and status". |
| 06-killing | -2 | Splits sentences. In kill step 4, "nodes it owns" becomes "nodes the process owns", because "it" read as the scheduler. |
| 07-children | 0 | Splits sentences. "are released" becomes "the scheduler releases". "Names are, for now," becomes "For now, names are". |
| 08-ephemeral-nodes | -4 | "An ephemeral node a process makes … is the process's …: the process owns it" becomes "A process owns each ephemeral node it makes". "is added" becomes "The scheduler adds". "pid being" becomes "where pid is". |
| 09-programs | 6 | "knows what a program is by its shape" becomes "tells a program's kind by its shape", the wording of the Open item. Splits the setup and compute items. The effect item drops "it is … then is given". "is found by code" becomes "code finds". In Code is a read, "the view being" becomes "where view is" and "Code … is waited for" becomes "A process waits for code". |
| 10-new-code | -5 | "replacing it" becomes "replacing the process". The three ways a replaced process runs become an itemize. What a part returns is reordered: "If a setup returns anything but a value, or a compute anything but a value or pending, such as undefined, the run fails". The old order read as if `undefined` were an example of pending. |
| 11-what-a-process-is-given | 2 | "Its api" becomes "A part's api". The onCleanup item is now active. Cuts "the sync process is given arrive", which Arrivals already says. "but for call" becomes "The exception is call". |
| 12-what-a-process-acts-as | -2 | "is bound" becomes "The scheduler binds". Splits the code-step sentence: first the program, then what the process was doing. "A process's agent is made at start:" becomes "At start, a process's agent is". |
| 13-handlers | -2 | Splits sentences. The not-a-handler sentence is turned round: "A node is not-a-handler unless…". "The function is called" becomes "The scheduler calls the function". "p being" becomes "where p is". |
| 14-status | 9 | The two writes at the pid become an itemize, and the two pending cases become two sentences. Cuts "No status write makes its own process due.", which Marks says (pointing to Status). |
| 15-latest-run | 11 | In the decision, "are moments a hook can listen to" becomes "A hook can listen to". Each field gloss becomes a sentence. Cuts "A write to the run node never makes its own process due.", which Marks says. |
| 16-marks | 5 | "is kept … is given" becomes "The scheduler keeps … and gives". "They are let go" becomes "It lets them go". The decision cuts "there is no other kind of reason", which its own "only" already says, and turns the passives round: "a start marks a process's first run". |
| 17-rounds | -5 | Splits the second-half paragraph. "a setup's value is written as a compute's is" becomes "The scheduler writes a setup's value as it writes a compute's". How a run ends becomes an itemize. "is LOADERS.tex's" becomes "LOADERS.tex says where". |
| 18-order | -12 | Moves "By height" to the front of its sentence. "if it is not" becomes "if its height is not". Splits the stopped-run paragraph. In the loop decision, ": only when" becomes "It is parked only when". Splits Loops, with "it" replaced by "the compute" or "the process". The budget's five outcomes become an itemize. |
| 19-outside-operations | -1 | "once it is made" becomes "once the change is made". "ends it there" becomes "ends the batch there". |
| 20-hooks | 1 | Splits the decision. "is what stops" becomes "stops". |
| 21-what-the-scheduler-holds | 2 | The per-process state, a 12-part semicolon chain, becomes a nested itemize. |
| 22-open | 1 | Puts the subject first, or splits, in Mounters, Unreachable processes, A kill beneath the scheduler, What a run cannot show, The top of the stack and Small hosts. |
| 23-related-work | 1 | Splits or turns round Solid, Incremental and Hazel. |
| 24-first-pass-choices | -7 | Turns semicolons into full stops in Pending, Budget, Handlers, replace, Loops and Loaders. Reorders Matching so that "otherwise" sits next to the clause it negates. |

## Totals

Counts cover the prose only: no preamble, code listings or bibliography. LaTeX commands
are stripped, and `\code{}` arguments count as words.

|  | before | after |
|---|---|---|
| words | 6724 | 6719 |
| sentences (list items count) | 311 | 415 |
| mean words per sentence | 21.2 | 15.9 |
| sentences over 30 words | 66 | 24 |
| sentences over 40 words | 25 | 4 |
| longest sentence | 109 | 50 |
| semicolons | 110 | 73 |

The word count barely moves, but the sentences get shorter.

## Repetition

Cut, with the place that still says it:
- "No status write makes its own process due" (Status) and "A write to the run node never makes its own process due" (The latest run). Marks still says it: "unless … the change was the scheduler's own write for it (Status; The latest run)". First-pass choice 4 keeps the reason.
- "the sync process is given arrive" (What a process is given). Arrivals still says it.
- "there is no other kind of reason" (Every reason is a change). The decision's own "only because" still says it.

Kept, but worth a look:
- The scheduler's marks in the last step are stated four times: in Ephemeral nodes ("kill"), in Status ("status"), in the sentence after the list in What a process acts as, and in the decision "The scheduler marks its own changes in the agent". The decision is the one source. The sentence before it could go, but it is the only place that names both keys.
- Cleanup order, "the most recently registered first", is stated in Killing step 3, in onCleanup and in Rounds. Only onCleanup covers a setup's cleanups when it runs as replaced.
- "A program given to start as a path is found by code" (Programs) repeats `start` and Code is a read. It stays because "one given as code runs as it is" appears nowhere else.
- "A process node no place reaches … runs on" is stated in Killing and again in Open, Unreachable processes.

## Renames suggested (not patched)

1. **maker → parent.** Children uses both words for the process that started a child, and agent steps say "its maker's program".
2. **definer → owner.** A handler is an ephemeral node, and "the process that owns it is its definer". That gives one relation two words.
3. **"the run", the scheduler's half** ("the order and the run"), clashes with "a run", one execution. Rename the half. "runner" is taken by the loaders paper; "worker" is free.
4. **"part" has three senses.** It means a program's functions (setup, compute, effect part). It also means child processes: "its parts, which are its computes and effects" in the layout decision, and "parts can make parts". And it means the scheduler's halves: "two parts", and "how the two parts are exported". Suggest "halves" for the scheduler and "children" in the layout decision.
5. **"waits after" → "behind"**, as in "it is behind that process".
6. **"kept changes".** renames.txt queues keep → track, but here "tracked" already means reads made with a reader, so "tracked changes" would clash. "held changes" fits, and Open, Small hosts already says "held whole".
7. **"the world"** ("writing through the world", "give the world a plain function") → "outside the graph".
8. **"provenance"** (What a process is given, used once). Name what it is instead: the agent, process or site on every change.
9. **"makes real"** (layout decision). Plain words would be "makes to last", or name the non-ephemeral nodes.
10. Already queued in renames.txt and used here: chroot → scope, "here", place/unplace, agent, cause.

## Sentences I could not read (not patched; patched text keeps the wording)

1. **Layout decision:** "A process's temporary state, its parts, which are its computes and effects (Children), and its handlers, … go inside its node." Is "its parts …" a gloss on the temporary state, or a second item in a list of three?
2. **Requests:** "what the scheduler is asked from outside a round". Requests made from inside a part, during a round, are queued. Does "outside a round" mean "not one of the round's own graph operations"?
3. **Arrivals:** "The host hands arrive to the sync process; no program's interface has it." Is the sync process not a program?
4. **Children:** "matched to that child, one to one, in the order they were started". Does "they" mean the starts, the children, or both in step?
5. **Programs:** "A program with no effect part is a derived value, like a formula in a spreadsheet." Does that take in a setup, which also has no effect part?
6. **What the scheduler adds:** "self and name, so a process can reach and unplace its own node; the rest is what the part is for." What is "the rest"?
7. **What a process acts as:** "a starting agent not of this shape is taken as the actor, with an empty code". Is the new process's step then added to that empty code?
8. **Rounds:** "its earlier run ends done then". Is that when the compute runs again, or when the single effect part runs?
9. **Order:** "waits after it until it runs again". Until the stopped compute runs again, or until the process it waits after runs?
10. **Order:** "each other process whose compute read this process's value", next to "whose last compute read" for an effect part. Is that the same compute?
11. **Loop decision:** "its sides shown". Are the sides the `through` list?
12. **First-pass 5:** "its fields are as in The latest run. The hook moments' shapes too." Does that mean the hook shapes are first-pass picks as well?
13. **First-pass 10:** "no cause". Does a release carry no cause field?
14. **Killing:** "Why a process ended is the host's to keep." Must the host keep it, or may it?
