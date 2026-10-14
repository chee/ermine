# The scheduler: a model, its theorems, and where the code departs

author: LLM generated working output · 2026-10-13

The object is `core/scheduler/typescript/scheduler.ts` (with the declared `key` of `compute`, line
226), `order.ts`, `rank.ts`, `causes.ts`, `helpers.ts`, on `tracker.ts`. Line numbers are as of this
date. The intended behaviour is the suite (`conformance/scheduler/harness.ts`,
`core/scheduler/conformance/scheduler/*.json`) and `plan.org`. Every counterexample below was run
against the code as it stands; the scripts are scratch, not part of the repo.

## 0. Results

| #   | statement                                                                                                          | status                                                              | assumptions (§1.5) |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------ |
| 1   | a pulse ends, when what writes into what is acyclic                                                                | proved                                                              | A1, A6, A8         |
| 1′  | a pulse ends, with cycles, causes cutting them                                                                     | **false as written** (C1). Proved with one change (F1)              | A1, A2, A6–A8      |
| 2   | at a round's end and a pulse's end, every compute whose run ended done holds its function of the current store     | proved                                                              | A1–A4, A8          |
| 3   | an act is called with the effect's function of one settled store (its round's)                                     | proved. Fails across the acts of one round (C7) and with async (C8) | A1, A3, A4, A8     |
| 4   | each computation completes at most one run per round, given learned writers and edges                              | proved                                                              | (L)                |
| 4.1 | the same in a fresh round when every key is declared (the new `key`)                                               | proved                                                              | (D)                |
| 4.2 | why a run repeats: an unknown writer, or an unlearned edge. The first-pulse repeat is not bounded by two           | proved; counts measured                                             | —                  |
| 5   | an equal result never hides a change in the store; it matches a from-scratch reference iff readers respect `equal` | proved. Fails for a `set` that throws after writing                 | A1–A5              |
| 6   | dispose runs every cleanup under the owner exactly once, children first, newest first; nothing under it runs after | proved, with two exceptions (D1, D2)                                | A1                 |
| 7   | a loop flag means a real causal cycle in the pulse; `through` over-reports; what causes don't catch                | proved / counterexamples                                            | A8                 |

The result that matters most is 1′. With only computes whose `set` writes and reports (the intended
wiring, no async, no tricks), a pulse can run forever: when a flagged run is stopped, `first()` has
already cleared the flag (line 324) and `stop()` (358–362) doesn't put it back. In a small random
search, 7 of about 1200 pulses over cyclic systems never ended. With the flag kept, termination is a
theorem (§7.2).

## 1. The model

### 1.1 Stores and read programs

$K$ is a set of keys (opaque, compared by identity). $V$ is a set of values;
$V_\bot = V + \{\bot\}$, where $\bot$ is "no value". A store is $\sigma : K \to V_\bot$.

**Definition (read program).** A _read program_ is a function
$p : V_\bot^K \to \mathrm{Res} \times \mathcal P_{\mathrm{fin}}(K)$,
$p(\sigma) = (\mathrm{res}_p(\sigma), R_p(\sigma))$, with
$\mathrm{Res} = V + \mathrm{Err} + \{\mathsf{pending}\}$, which is _local_: if $\sigma$ and
$\sigma'$ agree on $R_p(\sigma)$, then $p(\sigma') = p(\sigma)$.

Equivalently, a decision tree whose inner nodes read a key and branch on its value. $R_p(\sigma)$ is
the path's keys. Locality is the whole content of "a deterministic function of what it read",
dynamic reads included. A run executes the tree against the live store, one read at a time. A
_stopped_ run (§1.5) executes a prefix of the path.

### 1.2 Computations and the intended wiring

A finite set $C$ of computations, each with a creation number $n(c)$ (`c.n`), a kind (compute or
effect), a read program $p_c$ (its `f`), and an equivalence $\approx_c$ on $V$ (`equal`, default
`Object.is`, `helpers.ts` 8–12). A compute has $\mathrm{set}_c : V \to 1$. An effect has
$\mathrm{act}_e : V \times V_\bot \to 1$. Both are arbitrary code, and their writes are reported.

The intended wiring (the harness, lines 189–203, and `plan.org` "computations depend on each other
only through the graph"): each compute $c$ has an output key $\mathrm{out}(c)$, and
$\mathrm{set}_c(v)$ writes $v$ at $\mathrm{out}(c)$ and then calls `changed([out(c)])`. With the new
`key` argument, the scheduler may be told $\mathrm{out}(c)$ when $c$ is made.

Scopes form a forest (the code's tree of owners and change info; the old `owner(parent?)` is gone:
`root(info?)`, `scope(info?, parent?)`, `run(scope, f)`). Each scope has an ordered list of children
(scopes and computations) and an ordered list of cleanups. A computation is a scope too. Below, "owner"
is the old name for a scope; line numbers are from before the change. The Lean model in
`core/scheduler/lean/` is being moved to scopes: nothing below is claimed of it yet.

### 1.3 The scheduler's state

| symbol                                       | meaning                                                                                                  | code                          |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------- |
| $\sigma$                                     | the store (the host's, not the scheduler's)                                                              | harness `store`               |
| $\mathrm{live} \subseteq C$                  | alive computations                                                                                       | `live`, 113                   |
| $\mathrm{last}(c)$                           | compute: last value given to `set` and returned; effect: last value acted on                             | `c.last`, 394, 458            |
| $R(c)$                                       | the keys $c$'s latest run read: the tracker's links                                                      | `tracker`, 282                |
| $W : K \rightharpoonup C$                    | the _writer_ of a key                                                                                    | `writers`, 112; `write`, 265  |
| $\mathrm{val}(c)$                            | the writers of the keys $c$'s latest _finished_ run read                                                 | `c.values`; `order.sees`, 404 |
| $\mathrm{aft}(c)$                            | the computation $c$ waits after                                                                          | `c.after`; `order.waits`      |
| $G$                                          | the _learned graph_: $p \to q$ iff $q \in \mathrm{val}(p) \cup \{\mathrm{aft}(p)\}$, $q \ne p$, $q$ live | `order.ts` 24–31              |
| $\mathrm{rank}$                              | §1.4                                                                                                     | `rank.ts`                     |
| $\mathrm{due} : C \rightharpoonup \mathbb N$ | the due computations, each with its _mark_ (the tick it became due)                                      | `order` `due`                 |
| $\mathrm{kept}(c)$                           | causes of the marks on $c$ since its last run that ended done                                            | `c.kept`, 236, 402            |
| $\mathrm{ran}$                               | computations that ran in this pulse                                                                      | `causes.ts` 13                |
| $\mathrm{flag}(c)$                           | the loop value of the latest mark on $c$                                                                 | `c.loop`, 240, 324            |
| $\mathrm{looping} \subseteq C$               | computations whose latest run ended looping                                                              | `c.looping`, 403, 242         |
| $\mathrm{acts}$                              | a queue of pending acts $(e, v)$                                                                         | `acts`, 117                   |

$W$ is set in two places. In `changed`, every key reported while a run or a set is in progress makes
that run's computation its writer (257); acts report with `writes: false` (449). In `make`, when
`key` is given (226). $W$ forgets a key only when another computation takes it, or when its writer
is disposed (187).

### 1.4 Ranks

$G$ induces a preorder $\le_G$ on $\mathrm{live}$ (reachability). Its quotient by mutual
reachability is the condensation, a finite poset. `rank.ts` (Tarjan, then lines 29–34) sets
$\mathrm{rank}(p) = 0$ when $p$'s component has no edge out, and otherwise
$1 + \max \mathrm{rank}(q)$ over the edges $p \to q$ leaving the component.

**Lemma R.** $\mathrm{rank}$ is constant on components, and strictly monotone across them: if
$p \to_G^+ q$ and $q \not\to_G^+ p$, then $\mathrm{rank}(p) > \mathrm{rank}(q)$.

_Proof._ By induction along the path. The rank of a component is at least $1 +$ the rank of every
component one edge away. ∎

This is the structure that does the ordering work: a strictly monotone map from the condensation
into the well-order $(\mathbb N, <)$. The heap (`order.ts` 36–67, 84–106) is rebuilt whenever the
rank map is remade (87–91). So every choice uses the current $G$.

### 1.5 Steps, rounds, pulses, observations

**next** (`order.next`, 84–106): among the due $p$ with
$\mathrm{aft}(p) \notin \mathrm{dom}(\mathrm{due})$, the least by
$(\mathrm{rank}(p), \mathrm{due}(p), n(p))$.

**run** $c$ (`first`, 308–356):

1. Remove $c$ from due and clear $\mathrm{aft}(c)$.
2. Snapshot $\mathrm{given} := \mathrm{kept}(c)$, make the run's cause
   $\mathrm{Cause}(c, \mathrm{given})$ and add $c$ to $\mathrm{ran}$.
3. Take the run's flag $r.\mathrm{loop} := \mathrm{flag}(c)$, then clear $\mathrm{flag}(c)$.
4. Drop a pending act of $c$.
5. For a compute, _clean_ $c$: dispose its children and run its cleanups (328).
6. Execute $p_c$. Each read of $k$ links $c \to k$. If $w = W(k)$ is defined and $\ne c$, add $w$ to
   the run's writers, and if $w$ is due and $c$ is not on $w$'s after-chain, _stop_: the run ends,
   $c$ is due again at its old mark, and $\mathrm{aft}(c) := w$ (276–290, 358–362).
7. Otherwise classify the result $v$ (366–397):
   - equal ($\mathrm{last}(c)$ defined and $v \approx_c \mathrm{last}(c)$): _done_, nothing given;
   - flagged and unequal: _looping_;
   - an effect, unequal: queue $(c, v)$;
   - a compute, unequal: call $\mathrm{set}_c(v)$, then $\mathrm{last}(c) := v$;
   - a throw: _failed_; $\mathsf{pending}$: _pending_.

Every outcome except _stopped_ sets $\mathrm{val}(c)$ to the run's writers (404).

**report** $K'$ (`changed`, 253–263): for each $k \in K'$, first the writer clause of §1.3, then for
every reader $c$ of $k$, **mark** $c$ with the cause of the run in progress (or none).

**mark** (234–249): keep the cause; compute $\ell :=$ `causes.loop` (is $c$ in $\mathrm{ran}$, and
does the cause's ancestry contain a run of $c$?).

- If $\ell$ is defined and the run in progress is $c$'s own flagged run, return (239).
- Otherwise set $\mathrm{flag}(c) := \ell$.
- If $c \in \mathrm{looping}$: return if $\ell$ is defined, else leave looping.
- Make $c$ due at this tick unless it already is.

**act** $(e, v)$ (441–462): clean $e$; call $\mathrm{act}_e(v, \mathrm{last}(e))$; then
$\mathrm{last}(e) := v$.

A **round** is a _run phase_ (next + run until nothing is due, 478–481) followed by an _act phase_
(act each queued act in order, 482). A **pulse** (468–489) lands settled promises, then does rounds
until nothing is due and no act is queued. It then clears every $\mathrm{kept}$ and $\mathrm{ran}$
(`causes.end`). A pulse is thus a partial function on states: the iteration of a step function,
defined when the iteration is finite. The **observations** are the sequence of calls
$\mathrm{set}_c(v)$ and $\mathrm{act}_e(v, \mathrm{prev})$, each tagged with its pulse and round
(the `Moment`s, 65–77, are a finer trace of the same).

There is no lattice to iterate on here. Values carry no order and read programs aren't monotone. The
run phase is a chaotic iteration of $F(\sigma)(\mathrm{out}(c)) = \mathrm{res}_c(\sigma)$, scheduled
by rank. So termination below is combinatorial (well-founded induction), and the fixpoint is
characterised directly, not as a least one.

**Assumptions.** Each theorem names the ones it uses.

- **A1** _(code)_: every $p_c$ is a read program (§1.1). Every `f`, `set`, `act`, cleanup, `equal`
  and hook returns.
- **A2** _(no writes in runs)_: no run's synchronous part calls `changed`. Writes come from sets,
  from acts, and from the host between pulses.
- **A3** _(writes reported)_: every write of the store is reported by `changed` before control
  returns to the scheduler, and every `set` is atomic: it writes and reports, or throws having
  written nothing.
- **A4** _(equal)_: each $\approx_c$ is an equivalence relation and never throws.
- **A5** _(wiring)_: $\mathrm{set}_c(v)$ writes $v$ at $\mathrm{out}(c)$ and reports it;
  $\mathrm{out}$ is injective; nothing else writes $\mathrm{out}(c)$.
- **A6** _(no creation)_: no computation is made during the pulse.
- **A7** _(attributed changes)_: every `changed` during a pulse is called while a run's synchronous
  part, a set or an act is in progress. That rules out cleanups run by `clean` at a run's or an
  act's start (328, 445: they run before `causing` is set), hooks, and timers.
- **A8** _(sync)_: no `f` returns a promise.

## 2. Lemmas used throughout

**Lemma T (tracker).** After a non-stopped run of $c$ ends, $c$ is a reader of $k$ iff $k \in R(c)$,
and this stays so until $c$'s next run begins or $c$ is disposed. During a run, $c$ is a reader of
$k$ from its read of $k$ on.

This is the tracker's contract (`tracker.ts` 91–125). I take it from its own suite and fuzz
(`tracker_test.ts`, `c/tracker_fuzz.c`), not prove it here. The `nodes` sweep (493–497) drops only
key nodes with no readers, so it loses no link.

**Lemma N (next is total).** Whenever something is due, `next` returns one (the `best!` at
`order.ts` 105 is never undefined). Moreover, for every due $p$ there is a due, non-waiting $q$ with
$\mathrm{rank}(q) \le \mathrm{rank}(p)$.

_Proof._ $\mathrm{aft}(p)$ is defined only for a due $p$: it is set together with re-making $p$ due
(359–360), cleared when $p$ runs (311), and dropped when $p$ goes. A stop sets
$\mathrm{aft}(c) := w$ only if $c$ is not on $w$'s after-chain (286, 292–299). Between that check
and the stop, only $c$'s own run executes, and a nested pulse does nothing (469). Take the last edge
set on any after-cycle: at its check, the rest of the cycle was already there and put $c$ on $w$'s
chain. Contradiction, so after-chains are acyclic. Follow $p$'s chain through due computations: it
ends at a due $q$ whose `after` is undefined or not due. Each after-edge is a $G$-edge, so ranks
don't increase along it (Lemma R). ∎

**Lemma M (dropped marks).** A mark on a live $c$ leaves $c$ not due in exactly two cases:

- **(i)** 239: the mark is a loop, made by $c$'s own run, set or act, and that run is flagged;
- **(ii)** 243: $c \in \mathrm{looping}$ and the mark is a loop.

Under A2, (i) cannot happen: sets and acts follow only unflagged runs (374–376).

**Lemma F (fresh reads).** Let $c$ be live and not due at a scheduler moment $\tau$, with its latest
run $R$ ended done. Under A2, no report of a key $k \in R(c)$ happened after $R$'s read of $k$.

_Proof._ By Lemma T, $c$ is a reader of $k$ from that read up to $\tau$ ($R$ is the latest run). A
report of $k$ marks $c$ (260). $c$ is not looping: $R$ ended done, and only a later run could make
it looping. So by Lemma M the mark leaves $c$ due. Then $c$ would have to run again before $\tau$,
contradicting latestness. ∎

## 3. Theorem 1: termination

**Theorem 1 (acyclic).** Let $H$ be the relation $c \to_H d$ iff code owned by $c$ (its runs, its
set or act, its cleanups) may report a key that $d$ may read, or $c$ may be $W(k)$ for such a key.
Under A1, A6 and A8, if $H$ is acyclic, every pulse ends.

_Proof._ Induction along a topological order of $H$; suppose every $H$-predecessor of $d$ runs
finitely often in the pulse.

1. **Marks.** Marks on $d$ come from reports by its predecessors, finitely many.
2. **Stops.** A stop of $d$ is on a due $w = W(k)$, an $H$-predecessor, and $d$ then waits until
   $w$'s next run (Lemma N's chain). So $d$ stops on $w$ at most once per interval in which $w$ is
   due. Each such interval begins with a mark on $w$ or a stop of $w$, finitely many.
3. **Runs.** $d$'s runs are at most one initial run, plus one per mark that made it due, plus one
   per stop: finitely many.
4. **Acts.** Each act belongs to one effect run.

Every round after the first has a run, since the act queue empties in each act phase and nothing
lands (A8). ∎

Causes play no part here. Theorem 1′, with cycles, is in §7.2: as written it is false (C1), and it
holds with F1.

## 4. Theorem 2: quiescence

**Theorem 2.** Assume A1–A4 and A8. At any scheduler moment $\tau$ when nothing is due (the end of a
round's run phase, or of a pulse), every live computation's latest run ended done, failed, pending
or looping, and:

- **(a) done:** $\mathrm{last}(c) \approx_c \mathrm{res}_c(\sigma_\tau)$ and
  $R(c) = R_c(\sigma_\tau)$.
- **(b) failed:** $p_c(\sigma_\tau)$ is the same throw, or the same result refused by a throwing
  `equal` or `set` (and $\mathrm{last}(c)$ is unchanged).
- **(c) pending:** $\mathrm{res}_c(\sigma_\tau) = \mathsf{pending}$.
- **(d) looping:** no claim.

With A5, in case (a), $\sigma_\tau(\mathrm{out}(c)) = \mathrm{last}(c)$. So if no run ended failed,
pending or looping, $\sigma_\tau$ is a fixpoint, up to $\approx$, of the equations
$x_{\mathrm{out}(c)} = \mathrm{res}_c(x)$.

_Proof._ Stopped runs leave $c$ due, so the latest run is not stopped. Take case (a).

1. By Lemma F and A3, every $k \in R(c)$ still holds, at $\tau$, the value the latest run read.
2. By locality (A1), $p_c(\sigma_\tau)$ equals that run's result $v$ and read set.
3. The run ended done, so either $v \approx_c \mathrm{last}(c)$, or `set` returned and
   $\mathrm{last}(c) := v$ (394).
4. (b) and (c) are the same argument, with the outcome in place of $v$.
5. With A5: `set` is the only writer of $\mathrm{out}(c)$ and writes exactly the value assigned to
   $\mathrm{last}(c)$; an equal result writes nothing. ∎

**Corollary 2.1 (from scratch).** Suppose $\approx_c$ is identity, the final read sets restricted to
compute outputs form a DAG, and every latest run ended done. Then $\sigma_\tau$ agrees with
evaluating every compute from scratch along the DAG, because a DAG's fixpoint is unique (induction
along it). This is what the suite's fuzz model checks (`conformance_test.ts` 181–232).

## 5. Theorem 3: glitch-freedom for effects

**Definition.** A store $\sigma$ is _settled_ if every live compute whose latest run ended done
satisfies $\mathrm{last}(c) \approx_c \mathrm{res}_c(\sigma)$. An act's value is _half-updated_ if
it is not $\mathrm{res}_e$ of a settled store.

**Theorem 3.** Assume A1, A3, A4 and A8. Let $\sigma_\rho$ be the store at the end of round $\rho$'s
run phase. Every act called in $\rho$'s act phase is $\mathrm{act}_e(\mathrm{res}_e(\sigma_\rho),
\mathrm{last}(e))$. With A2, $\sigma_\rho$ is settled (Theorem 2), so no act is half-updated.

_Proof._ Let the act come from $e$'s run $R$. It is the latest run of $e$ in $\rho$: `first` drops a
pending act (326), and only the latest run's act survives. Suppose some $k \in R(e)$ was reported
after $R$'s read of $k$ and before the end of the run phase. By Lemma T the report marks $e$. By
Lemma M the mark is dropped only if:

- (i) $R$ itself is flagged and made the report. But a flagged run queues no act (374).
- (ii) $e$ is looping. But $e$ became due through a mark that was not a loop (a loop mark on a
  looping $e$ returns at 243), and that mark cleared looping; $R$ ended done.

So $e$ is due after $R$ and runs again in $\rho$, contradicting latestness. By A3 the reads of $R$
are $\sigma_\rho$'s, and by locality $v = \mathrm{res}_e(\sigma_\rho)$. A2 is not needed for this
part. ∎

What the theorem does not say, with traces:

- **C7 (acts in one round see one snapshot, not the current store).**
  - _Setup:_ $e_1$ reads $a$ and acts $b := 100a$; $e_2$ reads $a, b$.
  - _Trace:_ after $a := 2$, the run phase gives $e_1 \mapsto 2$ and $e_2 \mapsto [2, 100]$. The act
    phase runs $e_1$'s act ($b := 200$, which makes $e_2$ due). Then $e_2$ acts on $[2, 100]$,
    though $b$ is already 200 and $e_2$ is due. The next round acts $[2, 200]$.
  - _Observed log:_ `[e1 2], [e2 [2,100]], [e2 [2,200]]`.
  - $[2, 100]$ never coexists in any settled store of the pulse. So at the pulse level, acts are
    glitch-free only if no act writes what another effect reads. Line 482 acts without checking
    whether the effect is due again.
- **Sets are not covered.** A compute's `set` may be called with a value from before its writers
  ran: the unit test's reader is given `[undefined, 2]`. Theorem 4 says when sets are glitch-free.
- **Async:** §10.

## 6. Theorem 4: at most once

Call a run _complete_ if it isn't stopped. In a round $\rho$, let $E_\rho$ be the pairs $(d, w)$
where a run of $d$ in $\rho$ reads a key $k$ with $W(k) = w \ne d$.

**Condition (L), learned.** Every computation that runs in $\rho$ has completed a run before $\rho$,
reading the same keys with the same writers that its runs in $\rho$ read. $W$ doesn't change during
$\rho$, and every report in $\rho$'s run phase comes from a set of $W(k)$. $G$ at $\rho$'s start is
acyclic, and no computation is made or disposed during $\rho$.

**Theorem 4.** Under (L) and A1, no run in $\rho$ stops, and each computation completes at most one
run in $\rho$. With Theorem 2 (and A3, A4, A8), each `set` and act in $\rho$ is called with the
round's settled value.

_Proof._ Under (L), every run in $\rho$ sees $\mathrm{val}$ unchanged (404 replaces it with the same
set) and, by induction, no stop. So $G$ is constant through $\rho$ and $E_\rho \subseteq G$.

- **No stops.** Let $d$ be chosen at time $t$ and read $k$ with $w = W(k)$. If $w$ were due at $t$,
  then $d \to_G w$, and Lemma R gives $\mathrm{rank}(w) < \mathrm{rank}(d)$. $w$ is not waiting (no
  stops so far), so `next` would have chosen $w$ or something lower. Hence $w$ is not due, and the
  read doesn't stop.
- **No repeats.** Suppose $d$ completes run $R$ at $t$ and is marked again later in $\rho$. The mark
  is a report of some $k \in R(d)$ by $x_1 = W(k)$'s set, so $x_1$ ran after $t$.
  1. $x_1$ was not due at $t$, by the same rank argument.
  2. So $x_1$ was made due after $t$ by a report from some $x_2$ with $x_1 \to_G x_2$, and so on.
  3. The chain $d \to x_1 \to \dots \to x_m$ is finite, since the reports go back in time to $t$.
  4. Its last element was either due at $t$, or made due during $d$'s own set. The latter needs
     $x_m \to_G d$, a cycle.
  5. If due at $t$: $d \to_G^+ x_m$ gives $\mathrm{rank}(x_m) < \mathrm{rank}(d)$, and Lemma N then
     gives a due, non-waiting computation below $d$ at $t$, so `next` would not have chosen $d$.
     Contradiction. ∎

(L) fails in the first pulse after making computations, and that is the known first-pulse repeat.
The new `key` changes its shape.

**Condition (D), declared and fresh.** Every computation that runs in $\rho$ is due at $\rho$'s
start. For every key reported in $\rho$, $W(k)$ is its reporter from $\rho$'s start (declared with
`key`, or learned before) and doesn't change. Reports come only from sets. $E_\rho$ is acyclic.

**Theorem 4.1.** Under (D) and A1, each computation completes exactly one run in $\rho$. Stops
remain.

_Proof._ Show by induction along $E_\rho$ (sinks first): once $d$ has completed a run in $\rho$, it
is never due again in $\rho$.

1. Let $d$'s complete run $R$ read $k$ with $w = W(k) \ne d$. At that read $w$ was not due: else the
   read stops, unless $w$ waits after $d$. That would mean an after-chain $w \to \dots \to d$;
   after- edges lie in $E_\rho$, so with $(d, w)$ that is a cycle.
2. Everything was due at $\rho$'s start, and a stopped run stays due. So $w$ not due means $w$ had
   completed a run, and by induction it is never due again.
3. Keys with no reporter in $\rho$ don't change. So nothing $R$ read changes after $R$, and $d$ is
   never marked again. ∎

This is what the unit test "a compute's key, given" shows: a reader made before its writer is given
`[undefined, 2]` without the key and `[2]` with it.

Measured on 4000 random DAGs of 2–6 computes each, static reads, made in random order, first pulse:

| declared keys | max complete runs per compute |
| ------------- | ----------------------------- |
| none          | 3                             |
| some          | 3                             |
| all           | 1                             |

In the second pulse (learned, condition (L)) the maximum is 1 in every mode. Every final store
matched the from-scratch evaluation.

**Proposition 4.2 (why a run repeats).** Suppose $d$ completes runs $R$ and then $R'$ in one round,
with no cycle through $d$, and $R'$ was made due by a report of $k \in R(d)$ by $x_1$. Then at $R$'s
read of $k$ one of these holds:

- **(a) unknown writer:** $W(k) \ne x_1$. The key is undeclared and $x_1$ had not yet reported it,
  or another computation held it.
- **(b) unlearned edge:** $W(k) = x_1$, $x_1$ was not due when $d$ was chosen, and there is a chain
  $d \to x_1 \to \dots \to x_m$ of reporters with $x_m$ due at that moment. The chain is not
  contained in $G$ then; otherwise Lemma R and Lemma N order $x_m$, or something below it, before
  $d$.

Conversely, if (a) or (b) holds and every result along the chain is unequal to its last, $d$
repeats. _Proof:_ the proof of Theorem 4, read as a case split. ∎

So:

- **Undeclared, first pulse.** Case (a) occurs whenever a reader runs before its writer has
  reported. It feeds (b): the reader's $\mathrm{val}$ misses that writer, so its rank is too low,
  and it can run early again.
- **Not bounded by two.** For `parents [[],[0],[1],[1,2],[2],[3,4]]` made in order `[1,5,4,0,3,2]`,
  $c_5$ completes 4 runs. In run 3 its rank is 1 while $c_2$, on which it depends through $c_4$, is
  due at rank 2. $c_4$ had read $c_2$'s key before $c_2$ reported, so $c_4 \to c_2 \notin G$. The
  same system with every key declared: one complete run each, 6 stops. Random 14-compute DAGs reach
  5 complete runs.
- **Plan.org's note** ("a first pulse can run a reader twice") undercounts.

**What declaring still leaves.** A declaration removes (a) for its key. It cannot remove (b): $G$
learns $d \to w$ only from a run of $d$. A writer that exists already is not due, so it doesn't stop
its readers. Two traces, every key declared:

- **A new reader made before a new upstream of an existing writer.**
  - _Setup:_ $w$ (reads $a$, writes $b$) exists. Then $d$ (reads $b$) is made, then $u$ (writes
    $a$).
  - _Trace:_ $d$ runs first, since $u$ shares rank 0 and has a later mark. $w$ isn't due, so $d$
    doesn't stop. Then $u$ sets $a$, $w$ reruns, and $d$ reruns.
  - _Observed:_ $d$ is given `[1, 11]`.
- **A dynamic read.**
  - _Setup:_ an existing $d$ starts reading $b$ this round (a flag flips). $b$'s writer $w$ is not
    due, but $w$'s input is written later in the round by $u$.
  - _Observed:_ `[1, 11]`.

Repeats also remain from cycles; from two computations reporting one key (the declared writer is
taken at 257 and 265–270); from a `set` that writes keys other than the declared one; and from
writes in runs and acts.

**Stops cost.** A stopped run executes a prefix of `f`, and a compute's `clean` (328) runs before
every run, stopped ones included. So declaring trades repeated sets for repeated cleanups: each stop
disposes the compute's children and runs its cleanups once more.

## 7. Loops: what causes guarantee

### 7.1 Soundness, and what `through` says

For a run $Q$, let
$\mathrm{anc}(Q) = \{\text{its computation}\} \cup \bigcup_{g \in \mathrm{given}(Q)}
\mathrm{anc}(g)$: the computations of every run in its cause history. A mark on $y$ by $Q$'s cause
is a _loop mark_ iff $y \in \mathrm{ran}$ and $y \in \mathrm{anc}(Q)$ (`causes.ts` 44–50). Otherwise
it is _free_.

**Theorem 7.** Assume A8. If $y$'s run is flagged, then in this pulse a run of $y$ caused,
transitively through marks, the change that made it due: a causal cycle through $y$. Its `through`
is $\mathrm{anc}(Q)$ sorted by creation. That contains the cycle, and in general more.

_Proof._ Read off lines 44–50. ∎

- **C2 (over-report).**
  - _Setup:_ $u$: $y = x + 1$. $c$: $z = y + z + 1$, a self-loop through its own key.
  - _Trace:_ after $x := 5$, $c$ ends looping `through [u, c]`. $u$ is not on the loop; 47–49 walk
    the whole ancestry.
- **Without A8 the cycle may close in an earlier pulse** (§10, async3).

### 7.2 Theorem 1′: termination with cycles

**C1 (a pulse that never ends, as written).**

- _Setup:_ $x$ reads $k$ and $j$ and sets $k := k + 1$ (its result $k + 1 + (j \bmod 1)$). $w$ reads
  $k$ and sets $j := k \bmod 1 = 0$. Plain computes and sets.
- _Trace:_
  1. $x$ sets $k$ and marks itself with a loop.
  2. $w$ stops on $x$.
  3. $x$ (flagged) ends looping.
  4. $w$ sets $j$, a free mark that clears looping.
  5. $x$ sets $k$, marking itself and $w$ with loops. Same component, rank 0, same tick; $x$ is
     older.
  6. $x$ runs flagged, reads $j$ while $w$ is due, and **stops**. Its flag was cleared at 324, and
     `stop` (358–362) doesn't restore it.
  7. $w$ runs flagged. Its result is equal, so it is done, sets nothing, and isn't looping.
  8. $x$ reruns with no flag and sets $k$: back to step 5.
- _Observed:_ the run cap is hit with $k = 67$. In a random search (300 cyclic systems, sets and
  writing acts only, 4 pulses each) 7 pulses never ended.

**F1 (a change, not applied):** in `stop`, if no mark reached $c$ during the stopped run, set
$\mathrm{flag}(c) := r.\mathrm{loop}$. Then the flag of every run is the loop value of the latest
mark that reached $c$, across stops.

**Theorem 1′.** Assume A1, A2, A6–A8 and F1. Every pulse ends.

_Proof._ Under A2 and A7, every mark during the pulse comes from a _productive_ run: one whose set
or act was called. A productive run is unflagged and unequal (374–386).

1. **Unflagged runs need free marks.** By F1, a run of $y$ that is not $y$'s first in the pulse is
   unflagged iff the latest mark that set $\mathrm{flag}(y)$ (line 240) before it was free. That
   mark's cause $g$ is in the run's given. Under A2 a run's marks on $y$ all happen in one stretch,
   either its set or its act, so no done run of $y$ deletes $g$ between the mark and the run (402).
2. **Claim.** For $A \subseteq C$, let $P_A$ be the productive runs $Q$ with
   $\mathrm{anc}(Q) \cap A = \emptyset$. Then $P_A$ is finite.
3. **Induction** on $|C \setminus A|$, downwards.
   - _Base:_ $P_C = \emptyset$, since a run's own computation is in its ancestry.
   - _Step:_ take $R \in P_A$, a run of $y$, other than $y$'s first. The free latest mark's cause
     $g$, a run $Q_g$, has $y \notin \mathrm{anc}(Q_g)$. (Free with $y \in \mathrm{ran}$ means
     $y \notin \mathrm{anc}$; if $y \notin \mathrm{ran}$, $R$ is $y$'s first.) Also
     $\mathrm{anc}(Q_g) \subseteq \mathrm{anc}(R)$, so $Q_g \in P_{A \cup \{y\}}$, finite by
     induction. Each $Q_g$ makes finitely many marks (A1), and each mark is the latest before at
     most one run of $y$. So $P_A$ has at most
     $\sum_{y \notin A} (1 + \text{marks of } P_{A \cup \{y\}})$ elements.
4. **Finitely many marks.** $P_\emptyset$, every productive run, is finite.
5. **Finitely many runs.** Between two moments that make something due, the due set only shrinks. A
   stop of $y$ on $w$ makes $y$ wait until $w$ completes (Lemma N), and $w$ doesn't return within
   the stretch. So each stretch has at most $|C|^2$ stops.
6. **Finitely many acts and rounds.** Acts are at most the productive effect runs, and every round
   after the first has a run. ∎

With F1 the random search found no non-ending pulse. Note where the proof uses each assumption:

- _productive implies unflagged_, for the counting;
- _every mark has a productive cause_, which is A2 with A7;
- _$C$ finite_, which is A6.

Each of those can fail.

### 7.3 What causes don't guarantee

- **C3, a loop cut silently.**
  - _Setup:_ $x$ writes $k := k + 1$ in its run and returns 0.
  - _Trace:_ run 2 is flagged. Its self-mark is dropped (239), and its result is equal, so it is
    _done_, never _looping_.
  - _Result:_ $k = 2$. The loop is stopped but not reported.
- **C4, writes in runs never caught.**
  - _Setup:_ $x$ writes $k_x := k_y + 1$ and returns 0; $z$ writes $k_y := k_x + 1$ and returns 0.
  - _Trace:_ each flagged run's write marks the other with a loop. 239 drops only self-marks, and
    equal results never set looping.
  - _Result:_ runs forever.
  - _F4 (a change):_ drop a loop mark made by any flagged run, not only one's own (239 without
    `causing.r.c === c`). With F1 and F4, the random search with writes in runs found no non-ending
    pulse (F1 alone: 3). The proof above uses A2 at step 1, so for writes in runs this is measured,
    not proved.
- **C5, a loop through a cleanup.**
  - _Setup:_ a compute reads $k$ and registers a cleanup that writes $k := k + 1$.
  - _Trace:_ `first` runs `clean` (328) after removing $c$ from due (310), but before `causing` is
    set (337). The cleanup's report has no cause, so it is a free mark, and $c$ is due again.
  - _Result:_ forever.
  - The same for an effect's cleanup made in its act (C5e; `act` cleans at 445, `causing` is set at
    449).
  - _F2:_ run `clean` under the run's cause, with `writes: false`. Ends both.
- **C6, a loop through creation.**
  - _Setup:_ an effect's act makes a compute under the effect whose set writes what the effect read.
  - _Trace:_ `make` marks without a cause (228). The new compute's set is a free mark on the effect,
    whose next act disposes the compute (445) and makes a new one.
  - _Result:_ forever.
  - _F3:_ mark with `causing?.r.cause`. Ends it. Theorem 1′'s proof still needs a bound on
    creations.
- **A loop through a deferred report.** A `set` that reports after the pulse returns (a batching
  host, a microtask) has no cause, and no writer is learned. Every pulse ends, but every pulse runs
  the loop once more, forever, never looping. Causes end with the pulse (486).
- **Latest mark wins (240).** An outside change followed by a loop mark before the run is dropped
  with the flagged result: async3 in §10 loses the host's $x := 2$ this way. With "flagged iff every
  mark since the last run was a loop", outside changes would pass. The counting in §7.2 goes through
  unchanged (each free mark unflags at most one run).
- **A flagged run's writes in its run still happen** (scenario 14: $k$ reaches 2). The looping
  verdict lands on whichever member is re-marked first.

## 8. Theorem 5: cutoff

**Theorem 5.** Assume A1–A5.

- **(a)** A done-equal run changes neither the store nor $\mathrm{last}$, and every mark is
  independent of results. So no reader misses any change of the store, and Theorem 2 holds with
  cutoff.
- **(b)** Let $\sigma^*$ be the reference where each $\mathrm{out}(c)$ holds exactly
  $\mathrm{res}_c(\sigma^*)$ (a DAG, every run done). Say readers _respect_ $\approx$ if, whenever
  $\sigma, \sigma'$ agree on host keys and are $\approx_{c}$-related on each $\mathrm{out}(c)$ in
  $R_d(\sigma)$, then $R_d(\sigma') = R_d(\sigma)$ and $\mathrm{res}_d(\sigma) \approx_d
  \mathrm{res}_d(\sigma')$. If readers respect $\approx$ along the DAG, then
  $\sigma(\mathrm{out}(c)) \approx_c \sigma^*(\mathrm{out}(c))$ for every $c$. If some reader
  doesn't, there are histories where this fails.
- **(c)** For effects, an act happens iff the value is $\not\approx_e$ the last one acted on.

_Proof._ (a) is read off 370 and 379–394. For (b), by induction along the DAG,
$\sigma(\mathrm{out}(c)) = \mathrm{last}(c) \approx_c \mathrm{res}_c(\sigma) \approx_c
\mathrm{res}_c(\sigma^*)$, using Theorem 2, respect, and transitivity (A4). For the second half: let
$d$ tell apart $v \approx_c w$; make $c$'s last value $v$, then change its inputs so that it
computes $w$. The result is cut, and $d$ keeps $\mathrm{res}_d$ of $v$ where the reference has $w$.
(c) is read off 370 and 376, with `last` set in `act` (458). ∎

Respect holds for `Object.is` with values never changed in place. It fails for a value changed in
place, the copy-on-write question in plan.org; that is really an unreported write, against A3. It
fails by design for an `equal` coarser than what readers look at (the unit test's `x % 10`). With a
non-transitive `equal`, (b) fails.

**Departure (a set that throws after writing).**

- _Trace:_ `set` writes $\mathrm{out} := 1$ and throws. `last` stays 0 (393). The next result 0 is
  equal to `last` and is cut (370).
- _Result:_ $\mathrm{out} = 1$ while $f = 0$. This is why A3 asks `set` to be atomic.

## 9. Theorem 6: disposal

For an owner $o$ with children $o_1, \dots, o_k$ and cleanups $f_1, \dots, f_m$ (in the order made),
let

$$D(o) = D(o_k) \cdots D(o_1) \cdot f_m \cdots f_1,$$

a post-order fold over the tree with children reversed. Computations are owners; their children are
what their runs and acts made.

**Theorem 6.** Assume A1.

- **(a)** If no cleanup run during `dispose(o)` makes, registers on, or disposes anything under $o$,
  the cleanups run are exactly $D(o)$, in that order, even when some throw. The first error is
  thrown after.
- **(b)** In general, every cleanup registered under $o$, before or during the disposal, runs
  exactly once.
- **(c)** After `dispose(o)` returns, every owner under $o$ is gone. Every computation under it is
  not live, not due, the writer of no key, a reader of nothing, without a pending act, and its
  promise lands nowhere. No `f`, `set` or `act` under $o$ is called again, except D1 and D2.

_Proof._

- (a) Structural induction. `dispose` marks $o$ disposing, `drop`s it if it is a computation (171),
  then `clean` detaches the children (145–146) and disposes them newest first, then detaches the
  cleanups (154–155) and runs them newest first, each in its own `try` (147–162).
- (b) Each list is detached before it runs, so an element runs at most once. Registration on a live
  owner appends to a list that the traversal will reach, because nothing can be made under a
  disposing owner (130, 205). Registration on a non-live owner runs at once (139).
- (c) Read off `drop` (183–191), `order.gone`, and the state checks in `mark` (235), `track` (279),
  `act` (444), the promise's settle (419) and `land` (427). ∎

The same fold, without the final state change, is what `clean(c)` does before a compute's run and
before an effect's act.

Departures:

- **D1, a computation's `f` called after it is disposed.**
  - _Setup:_ a compute registers a cleanup that disposes it.
  - _Trace:_ on its next run, `clean` (328) disposes $c$, and `f` is still called (340). Its result
    is then dropped (349).
  - _Observed:_ one call after disposal.
  - _F8:_ return if $c$ is not alive after `clean`.
- **D2, an `act` called after its effect is disposed.**
  - _Setup:_ an effect's act registers a cleanup disposing the effect's owner.
  - _Trace:_ the next act's `clean` (445) disposes it, and `act` is called anyway (451).
  - _Observed:_ acted `[0, 1, 2]`, the 2 after disposal.
  - _Fix:_ the same check.
- **D3, children of an effect's `f`.** Only computes are cleaned before a run (328). Owners an
  effect makes in `f` live until its next act; with equal results they pile up (5 after 5 equal
  runs).
- **The rest of a run in progress.** If code under $c$ disposes $c$ from inside $c$'s run, the run
  continues (JS can't preempt). Its later reports still mark readers (with $c$'s cause), though they
  no longer make $c$ a writer (257).

## 10. Async

With A8 dropped, a run that returns a promise ends pending. Its settling lands at the next pulse's
first round (`landed`, 416–431, 473–476). A real promise cannot settle during a synchronous pulse. A
read after an await through the run's own `read` throws `stopped`; the plain `read` is silently
untracked. So model an async compute as a read program for its synchronous part, plus a continuation
that must read nothing.

- **Theorem 1:** unchanged. Landings happen only at a pulse's start.
- **Theorem 2:** weakens. Pending computes are excluded, and a landed result may come from inputs
  that have since changed. In C8, $c$ lands 10, computed from $x = 1$, while $x = 2$ and $c$ is due
  again (426–431 don't check due).
- **Theorem 3:** the snapshot clause holds; _settled_ fails. A pending compute's key holds its
  previous value while its inputs are new.
  - **C8 trace:** $c$ reads $x$ and resolves to $10x$; $e$ reads $c$'s key and $x$. After the first
    settle and $x := 2$, the next pulse lands 10, $c$ goes pending again, and $e$ acts on $[10, 2]$:
    half-updated. Acts are glitch-free only relative to synchronous computes.
  - _F6:_ drop a landing whose compute is due. That removes the landed half of C8, not the pending
    half.
- **Theorem 4:** readers don't wait for a pending compute (it isn't due), so they run on the old
  value and run again when the result lands, in the next pulse. That is by design.
- **Theorem 7:** causes outlive the pulse. A pending run keeps its cause (`r.cause`), and its
  landing marks readers with it. `causes.loop` then walks into the previous pulse.
  - **async3 trace:** $a$ (async) reads $c$; $e$ reads $a$; $c$ reads $x$, and $e$ once a flag is
    true.
    1. In pulse 2, $c$ stops on $e$, so $c \in \mathrm{ran}$.
    2. $e$, marked by the landing whose cause holds pulse 1's run of $c$, sets $e$ and marks $c$.
    3. That mark is flagged though no run of $c$ in pulse 2 caused it. $c$ ends looping
       `through [a, c, e]`.
    4. $c$ stays 1 where $x + e = 22$. The host's $x := 2$ is lost too (latest mark wins).
  - This contradicts `causes.ts`'s "nothing is kept past the pulse" and its "a run of t in this
    pulse".
  - _F7:_ land with a cause cut at the pulse boundary.

## 11. The three proposals

`plan.org` does not record these yet. I take them as named: (P1) `changed(keys, by)` with an
explicit writer; (P2) every write reporting itself; (P3) a compute declaring its output key up
front, now built as `key`.

| theorem           | P1 `changed(keys, by)`                                                                                                                                                                               | P2 every write reports itself                                                                                | P3 declared key (built)                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| 1, 1′ termination | removes A7 for reports that name `by`, if `by` also supplies a cause: closes C5 when the cleanup's write names $c$. Cross-pulse loops stay uncaught unless causes are kept, which brings back async3 | nothing by itself. In-run writes become visible as reports, so F4 matters more                               | nothing (adds no causes)                                                               |
| 2 fixpoint        | —                                                                                                                                                                                                    | discharges A3: no unreported write. A `set` still needs atomicity                                            | $\mathrm{out}(c)$ becomes the scheduler's data: A5's clause is stated in its own terms |
| 3 glitch          | —                                                                                                                                                                                                    | discharges A3                                                                                                | —                                                                                      |
| 4 once            | (L)'s "every report comes from $W(k)$" holds for deferred or batched reports and for acts naming their effect. Writers are learned where `causing` is unset                                          | —                                                                                                            | Theorem 4.1: fresh rounds are once. Removes case (a) for declared keys, not (b)        |
| 5 cutoff          | —                                                                                                                                                                                                    | discharges the "nothing else writes" half of A5 for in-system writes; a second writer becomes visible in $W$ | makes "the output key" checkable                                                       |
| 6 disposal        | —                                                                                                                                                                                                    | —                                                                                                            | —                                                                                      |
| 7 loops           | attribution outside runs                                                                                                                                                                             | —                                                                                                            | —                                                                                      |

P1 with P3: every writer is known at creation and at every report, so (a) never happens. What is
left for repeats is (b) alone, learning $G$'s edges, which only a reader's run teaches.

## 12. Departures

| id          | where                                | input | effect                                                   | change that ends it (scratch copy)                              |
| ----------- | ------------------------------------ | ----- | -------------------------------------------------------- | --------------------------------------------------------------- |
| C1          | `stop` 358–362; `first` 324          | §7.2  | infinite pulse                                           | F1. The suite (29 scenarios + fuzz) passes on a copy with F1–F4 |
| C2          | `causes.ts` 47–49                    | §7.1  | `through` lists the whole ancestry                       | walk only causes on a path back                                 |
| C3          | `mark` 239, `result` 374             | §7.3  | a loop cut, reported done                                | —                                                               |
| C4          | `mark` 239                           | §7.3  | infinite pulse (writes in runs)                          | F4                                                              |
| C5          | `first` 328 vs 337; `act` 445 vs 449 | §7.3  | infinite pulse (cleanup writes)                          | F2                                                              |
| C6          | `make` 228                           | §7.3  | infinite pulse (creation)                                | F3                                                              |
| C7          | `pulse` 482, `act`                   | §5    | act on a value its own round already changed; acts twice | skip a due effect's act                                         |
| C8          | `land` 426–431                       | §10   | act on a value mixed from old and new inputs             | F6 (part)                                                       |
| async3      | `awaiting`/`land`; `causes.loop`     | §10   | false loop across pulses; outside change lost            | F7                                                              |
| D1          | `first` 328 → 340                    | §9    | `f` of a disposed compute called                         | F8                                                              |
| D2          | `act` 445 → 451                      | §9    | `act` of a disposed effect called                        | F8                                                              |
| D3          | `first` 328                          | §9    | an effect's `f`-made owners pile up                      | —                                                               |
| set-throws  | `result` 393                         | §8    | cutoff hides a partial write                             | —                                                               |
| first pulse | `changed` 257; ranks                 | §6    | not "twice": up to 5 complete runs measured              | `key` makes fresh rounds once                                   |

The scratch copy with F1–F4 is a test of the analysis, not a proposal of code. It shows each
counterexample ended by its change and the suite unchanged.

## 13. After the fixes (2026-10-13)

The code now takes the changes below, in TypeScript and C. Line numbers above are of the code before
them. Each counterexample is a test that failed before and passes now: scenarios 30–41 in
`core/scheduler/conformance/scheduler/`, unit tests in `scheduler_test.ts`, and the loops fuzz in
`scheduler_fuzz_test.ts` (cyclic systems, writes in runs, cleanups that write, creation in runs and
acts, async settling while due, self-disposing cleanups; at most 5000 runs a pulse).

### 13.1 `changed(keys, by)`

`by`: the run that made the change, told by the caller (a run's own `read`; a computation, for its
latest run; in C an `sc_run`, `sc_latest`). The writer is learned only from it, and only for a
compute; an effect is no one's writer. No `by`: from outside, no writer and no cause. The scheduler
no longer reads `causing` for changes. A cause from an earlier pulse is cut to its computation
alone, in this pulse (`causeOf`). What `by` removes:

- **A7** becomes: a change made by a computation's code names it. Cleanups, acts, sets and code
  after an await can all meet it, so their changes carry causes.
- **The deferred report** (§7.3): a report after the pulse, naming its run, learns the writer and
  carries the run's cut cause. A self-loop through it is seen (scenario 39).
- **(L)** in Theorem 4: "every report in ρ's run phase comes from a set of W(k)" is now exactly
  "names W(k)"; nothing is guessed.

### 13.2 Fixed

| id         | test       | fix                                                                                                                                             |
| ---------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| C1         | 30         | F1: a stopped run that no mark reached keeps its flag                                                                                           |
| C2         | 31         | `through`: the computations of the causes on a path back to a run of y (`causes.loop`)                                                          |
| C3         | 32         | a flagged run that cut a loop (a loop mark of its own dropped) ends looping, equal or not                                                       |
| C4         | 33         | F4: a loop mark from any flagged run is dropped                                                                                                 |
| C5, C5e    | 34         | F2 by `by`: a cleanup's change names its computation, whose latest run is the one cleaning                                                      |
| C6         | unit       | F3: what is made in a run, set, act or cleanup is marked with that run's cause                                                                  |
| C7         | 35         | an act whose effect is due again is skipped: its value is old; its next run acts                                                                |
| C8         | 36         | F6: a landing whose compute is due again lands nowhere; the next run's does                                                                     |
| async3     | 37         | F7: causes cut at the pulse's end                                                                                                               |
| D1, D2     | 38         | after the cleanups before a run or act, a computation gone is not run or acted                                                                  |
| D3         | unit       | an effect's run first disposes what was made under it since its last act; the act's stays                                                       |
| set-throws | unit       | a set that throws forgets the last result: the next is given to set, equal or not                                                               |
| N1 (new)   | unit, fuzz | made in a flagged run, its set re-marking it, equal results: endless. Making something there cuts it                                            |
| N2 (new)   | fuzz       | a stop loop: a run's clean made its writer due, it stopped on it, forever. A run does not stop on a writer due by its own doing (`causes.from`) |

N1 and N2 were found by the loops fuzz, not in §§1–12.

### 13.3 Which theorems now hold without the extra conditions

- **1′**: holds for the code (F1), under A1, A2, A6–A8. With writes in runs, writing cleanups,
  creation and async: measured, not proved (the loops fuzz, 40 seeds kept and 80 more run once).
- **2**: async included. A landed result is from a run whose compute was not due again, so Lemma F
  applies to it; the weakening in §10 is gone. Pending computes are still excluded.
- **3**: an act is called with $\mathrm{res}_e$ of the store at the act, not only $\sigma_\rho$,
  unless a loop mark on $e$ was dropped (only a flagged run that writes does that: not under A2).
- **5**: without A3's atomic set. A set that throws forgets `last`, so cutoff hides no part write.
- **6 (c)**: no exceptions. Still: the rest of a run in progress, when its own code disposes it.
- **7**: `through` is exactly the computations on the loop. Without A8: a cause never reaches past
  its pulse, so the cycle a flag reports is in this pulse, or closes through a change named by a run
  since the last pulse. C3 is reported, not silent.

### 13.4 Also added

- **PENDING thrown** (the symbol itself): the run ends pending, as returning it does. A promise
  rejected with it lands pending (decided here). C: `f` returns `SC_PENDING`, a promise
  `sc_resolve_pending`. Scenario 40; a unit test of a chain pending through reads.
- **`forget(key)`**: told each key no longer read, at once when its last reader's run reads it no
  more (the links the tracker's end drops) or its reader is disposed; the sweep catches the rest.
  Link passes it on to `paths.release`. Scenario 41; link's tests.
