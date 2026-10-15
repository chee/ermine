-- LLM generated working output
-- at most once per round (proof.md §6, §13.1) on the model (Model.lean), with Quiescence.lean's
-- invariant. a round's run phase from s is `trace`: the state after i runs (trace_step: it is
-- the model's step). counts are the log's (`completed`, `started`), relative to s.
--
-- proved:
-- - first_ran1: what a run adds to the log and what it moves (A2): its reads, the writers it
--   learned, where it stopped or how it went through each read of a due writer, what its set
--   marked; Ran1.completed, Ran1.started: one start, and one end unless it stopped
-- - Theorem 4, under (L) (Learned): nostop, no run in the round stops; once, each computation
--   completes, and starts, at most one run in it; settles, each set in it is given what its
--   compute gives from scratch on the store when the run phase ends (Theorem 2); queued, so is
--   each act left then; keyed, W does not move when each compute that runs is its key's writer
-- - Theorem 4.1, under (D) (Fresh): fresh, at most one complete run each; exactly, when the run
--   phase ends, one for each computation due at the round's start, none for the others
-- - Proposition 4.2 (why): a repeat is made due by a report of a key the earlier run read; if
--   that key's writer then was the reporter and it was due, the read went through only by waits
--   or came; the reporters behind it go back to the earlier run's choice (Back), and, that run's
--   computation on no cycle of the learned graph, their chain is not in the learned graph then
-- - checks (Model.Check): §6's measured first pulse (c5: four complete runs; every key
--   declared: one each, six stops), (L) in the next pulse, and the counterexamples below, each as
--   the TS runs it
--
-- assumed (each a hypothesis where used):
-- - A2: no writes in runs. so the run phase's changes are sets, and (L)'s "names W(k)" is "W does
--   not move". no make in a round: the model's make is the host's
-- - the rank is ranked over the current edges (Theorem 4, why; Rank.lean)
-- - s is reached (Reach) and in a run phase (Theorem 4, settles, exactly, why)
-- - (L), (D): Learned's and Fresh's fields, each commented
--
-- §6 as written is false on the model (and the TS), so two conditions are stronger here:
-- - a compute reading its own key (12-loop-set): two complete runs a round, under (L) with G
--   (no self edges) acyclic and under (D) with E_ρ (no self pairs) acyclic. Learned asks that no
--   writer read be the reader; Fresh's uses counts the self pair as a cycle
-- - causes.ts from across rounds: in a pulse's second round (D) holds, and a computation reads
--   a due writer without stopping, since that writer's kept mark came from its run a round
--   before; it completes two runs. Fresh asks that no cause be kept at the round's start (close
--   clears them; the host's changes keep none)
import Scheduler.Quiescence

namespace Model

open Relation

set_option linter.unusedSectionVars false
set_option linter.unusedSimpArgs false

variable {K V : Type} [DecidableEq K] [DecidableEq V]

-- marks: what a change does to the state

-- s' from s by marks of ds, keeping the causes ks: only dues (growing, at ds), kept (growing, by
-- ks), the log (by due moments), loop, looping and cut move
structure Marks (s s' : State K V) (ds : List Nat) (ks : List Why) : Prop where
  eq : s' = { s with
    due := s'.due, kept := s'.kept, log := s'.log, loop := s'.loop, looping := s'.looping,
    cut := s'.cut }
  due : ∀ x m, s.due x = some m → s'.due x = some m
  fresh : ∀ x, (s'.due x).isSome → (s.due x).isSome ∨ x ∈ ds
  kept : ∀ x y, y ∈ s'.kept x → y ∈ s.kept x ∨ y ∈ ks
  log : ∃ l, s'.log = s.log ++ l ∧ ∀ e ∈ l, e.pulse = s.pulses ∧ e.round = s.round ∧
    ∃ a b w, e.event = .due a b w

theorem Marks.refl (s : State K V) : Marks s s [] [] where
  eq := rfl
  due _ _ h := h
  fresh _ h := Or.inl h
  kept _ _ h := Or.inl h
  log := ⟨[], by simp, by simp⟩

theorem Marks.trans {s s' s'' : State K V} {ds ds' : List Nat} {ks ks' : List Why}
    (h1 : Marks s s' ds ks) (h2 : Marks s' s'' ds' ks') : Marks s s'' (ds ++ ds') (ks ++ ks') where
  eq := h2.eq.trans (by rw [h1.eq])
  due x m h := h2.due x m (h1.due x m h)
  fresh x h := by
    rcases h2.fresh x h with h | h
    · rcases h1.fresh x h with h | h
      · exact Or.inl h
      · exact Or.inr (List.mem_append_left _ h)
    · exact Or.inr (List.mem_append_right _ h)
  kept x y h := by
    rcases h2.kept x y h with h | h
    · rcases h1.kept x y h with h | h
      · exact Or.inl h
      · exact Or.inr (List.mem_append_left _ h)
    · exact Or.inr (List.mem_append_right _ h)
  log := by
    obtain ⟨l1, e1, h1l⟩ := h1.log
    obtain ⟨l2, e2, h2l⟩ := h2.log
    have hp : s'.pulses = s.pulses := by rw [h1.eq]
    have hr : s'.round = s.round := by rw [h1.eq]
    refine ⟨l1 ++ l2, by rw [e2, e1, List.append_assoc], ?_⟩
    intro e he
    rcases List.mem_append.1 he with he | he
    · exact h1l e he
    · obtain ⟨a, b, c⟩ := h2l e he
      exact ⟨a.trans hp, b.trans hr, c⟩

theorem Marks.mono {s s' : State K V} {ds ds' : List Nat} {ks ks' : List Why}
    (h : Marks s s' ds ks) (hd : ∀ x ∈ ds, x ∈ ds') (hk : ∀ y ∈ ks, y ∈ ks') : Marks s s' ds' ks' where
  eq := h.eq
  due := h.due
  fresh x hx := (h.fresh x hx).imp_right (hd x)
  kept x y hy := (h.kept x y hy).imp_right (hk y)
  log := h.log

theorem settle_marks (s : State K V) (d t : Nat) (who : Option Nat) (l : Option (List Nat))
    (f : Bool) : Marks s (settle s d t who l f) [d] [] := by
  unfold settle
  split
  · split
    · exact { eq := rfl, due := fun _ _ h => h, fresh := fun _ h => Or.inl h,
              kept := fun _ _ h => Or.inl h, log := ⟨[], by simp, by simp⟩ }
    · exact Marks.mono (Marks.refl s) (by simp) (by simp)
  · simp only
    split
    · exact { eq := rfl, due := fun _ _ h => h, fresh := fun _ h => Or.inl h,
              kept := fun _ _ h => Or.inl h, log := ⟨[], by simp, by simp⟩ }
    · unfold due
      split
      · exact { eq := rfl, due := fun _ _ h => h, fresh := fun _ h => Or.inl h,
                kept := fun _ _ h => Or.inl h, log := ⟨[], by simp, by simp⟩ }
      · rename_i hd
        refine { eq := rfl, due := ?_, fresh := ?_, kept := fun _ _ h => Or.inl h,
                 log := ⟨[⟨s.pulses, s.round, .due d t who⟩], rfl, by simp⟩ }
        · intro x m hx
          by_cases hxd : x = d
          · subst hxd; simp [hx] at hd
          · simp [say, put_ne _ _ hxd, hx]
        · intro x hx
          by_cases hxd : x = d
          · exact Or.inr (by simp [hxd])
          · left; simpa [say, put_ne _ _ hxd] using hx

theorem keep_marks (s : State K V) (t : Nat) (k : Why) : Marks s (keep s t k) [] [k] := by
  unfold keep
  split
  · exact Marks.mono (Marks.refl s) (by simp) (by simp)
  · refine { eq := rfl, due := fun _ _ h => h, fresh := fun _ h => Or.inl h, kept := ?_,
             log := ⟨[], by simp, by simp⟩ }
    intro x y hy
    by_cases hx : x = t
    · subst hx; simp at hy
      rcases hy with hy | hy
      · exact Or.inl hy
      · exact Or.inr (by simp [hy])
    · simp [put_ne _ _ hx] at hy; exact Or.inl hy

-- a mark by a run of this pulse (its cause not cut), or from outside: keeps its run's cause
theorem mark_marks (s : State K V) (d t : Nat) (who : Option Nat)
    (hw : ∀ c, who = some c → s.when c = s.pulses) :
    Marks s (mark s d t who) [d] (who.map s.cause).toList := by
  cases who with
  | none => exact Marks.mono (settle_marks s d t none none false) (by simp) (by simp)
  | some c =>
    simp only [mark, causeof, hw c rfl, ite_true]
    have := (keep_marks s d (s.cause c)).trans (settle_marks (keep s d (s.cause c)) d t (some c)
      (loopof (keep s d (s.cause c)) (s.cause c) d)
      ((((keep s d (s.cause c)).ran c).bind (·.loop)).isSome))
    exact this.mono (by simp) (by simp)

theorem marks_fold (t : Nat) (r : Option Nat) : ∀ (ds : List Nat) (s : State K V),
    (∀ c, r = some c → s.when c = s.pulses) →
    Marks s (ds.foldl (fun s d => mark s d t r) s) ds (r.map s.cause).toList
  | [], s, _ => (Marks.refl s).mono (by simp) (by simp)
  | d :: ds, s, hw => by
    simp only [List.foldl_cons]
    have m1 := mark_marks s d t r hw
    have hw' : ∀ c, r = some c → (mark s d t r).when c = (mark s d t r).pulses := by
      rw [m1.eq]; exact hw
    have hc : r.map (mark s d t r).cause = r.map s.cause := by rw [m1.eq]
    have m2 := marks_fold t r ds (mark s d t r) hw'
    rw [hc] at m2
    exact (m1.trans m2).mono (by simp) (by simp)

-- the compute named, as changed learns it
def namer (cs : Nat → Comp K V) (s : State K V) (who : Option Nat) : Option Nat :=
  (runof s who).filter fun c => match (cs c).kind with | .compute _ => true | .effect _ => false

-- a change of one key: learn its writer, then mark its readers
theorem changed_marks (cs : Nat → Comp K V) (s : State K V) (k : K) (who : Option Nat)
    (hw : ∀ c, who = some c → s.when c = s.pulses) :
    Marks (learn { s with tick := s.tick + 1 } k (namer cs s who)) (changed cs s [k] who)
      (readers s k) ((runof s who).map s.cause).toList := by
  have hr : readers (learn { s with tick := s.tick + 1 } k (namer cs s who)) k = readers s k := by
    cases namer cs s who <;> rfl
  have m := marks_fold (s.tick + 1) (runof s who) (readers s k)
    (learn { s with tick := s.tick + 1 } k (namer cs s who)) (by
      intro c hc
      have : who = some c := (Option.filter_eq_some_iff.1 hc).1
      cases namer cs s who <;> exact hw c this)
  have hc : (runof s who).map (learn { s with tick := s.tick + 1 } k (namer cs s who)).cause =
      (runof s who).map s.cause := by cases namer cs s who <;> rfl
  rw [hc] at m
  have e : changed cs s [k] who = tell (learn { s with tick := s.tick + 1 } k (namer cs s who)) k
      (s.tick + 1) (runof s who) := by
    simp only [changed, List.foldl_cons, List.foldl_nil, namer, runof]
    congr 3
  rw [e, tell, hr]
  exact m

-- runs

theorem mem_ins {x w : Nat} {l : List Nat} : x ∈ ins w l ↔ x ∈ l ∨ x = w := by
  unfold ins
  split
  · rename_i h
    constructor
    · exact Or.inl
    · rintro (h' | rfl)
      · exact h'
      · exact h
  · simp

theorem came_congr {s s' : State K V} (h1 : s'.went = s.went) (h2 : s'.kept = s.kept) (t c : Nat) :
    came s' t c = came s t c := by simp [came, h1, h2]

theorem came_ran_reads (s : State K V) (x : Nat → Option (Run K V)) (y : Nat → List K) (w c : Nat) :
    came { s with ran := x, reads := y } w c = came s w c := rfl

-- a run, A2: what it read (in order, along f from scratch), the writers it learned, and how it
-- stopped or went through each read of a due writer
theorem exec_run (cs : Nat → Comp K V) (c : Nat) :
    ∀ (p : Prog K V), nowrites p → ∀ (s : State K V) (r : Run K V), s.ran c = some r →
    r.stopped = none →
    ∃ (seen : List (K × Option V)) (vals : List Nat) (st : Option Nat),
      (exec cs c s p).1 = { s with
        ran := put s.ran c (some { r with seen := r.seen ++ seen, values := vals, stopped := st }),
        reads := put s.reads c (s.reads c ++ seen.map (·.1)) } ∧
      (∀ q ∈ seen, s.store q.1 = q.2) ∧
      (∀ q ∈ seen, q ∈ (eval s.store p).2) ∧
      (st = none → follow p seen = some (exec cs c s p).2) ∧
      (∀ w, w ∈ vals ↔ w ∈ r.values ∨ ∃ q ∈ seen, s.writers q.1 = some w ∧ w ≠ c) ∧
      (∀ w, st = some w → (s.due w).isSome ∧ waits s w c = false ∧ came s w c = false ∧ w ≠ c ∧
        ∃ q ∈ seen, s.writers q.1 = some w) ∧
      (st = none → ∀ q ∈ seen, ∀ w, s.writers q.1 = some w → w ≠ c → (s.due w).isSome →
        waits s w c = true ∨ came s w c = true)
  | .value v, _, s, r, hr, hs => by
    refine ⟨[], r.values, none, ?_, by simp, by simp, by simp [follow, exec], by simp, by simp,
      by simp⟩
    have : { r with seen := r.seen ++ [], values := r.values, stopped := none } = r := by
      cases r; simp_all
    rw [this, put_self hr]
    simp only [exec, List.map_nil, List.append_nil, put_self (rfl : s.reads c = _)]
  | .error, _, s, r, hr, hs => by
    refine ⟨[], r.values, none, ?_, by simp, by simp, by simp [follow, exec], by simp, by simp,
      by simp⟩
    have : { r with seen := r.seen ++ [], values := r.values, stopped := none } = r := by
      cases r; simp_all
    rw [this, put_self hr]
    simp only [exec, List.map_nil, List.append_nil, put_self (rfl : s.reads c = _)]
  | .pending, _, s, r, hr, hs => by
    refine ⟨[], r.values, none, ?_, by simp, by simp, by simp [follow, exec], by simp, by simp,
      by simp⟩
    have : { r with seen := r.seen ++ [], values := r.values, stopped := none } = r := by
      cases r; simp_all
    rw [this, put_self hr]
    simp only [exec, List.map_nil, List.append_nil, put_self (rfl : s.reads c = _)]
  | .write .., hp, _, _, _, _ => absurd hp (by simp [nowrites])
  | .read k next, hp, s, r, hr, hs => by
    have hp' := fun x => (show nowrites (Prog.read k next) from hp) x
    -- the rest of the run, from s with the read recorded and the values vs
    have rest : ∀ (vs : List Nat) (s2 : State K V),
        (∀ w, w ∈ vs ↔ w ∈ r.values ∨ (s.writers k = some w ∧ w ≠ c)) →
        (∀ w, s.writers k = some w → w ≠ c → (s.due w).isSome →
          waits s w c = true ∨ came s w c = true) →
        s2 = { s with ran := put s.ran c (some { r with seen := r.seen ++ [(k, s.store k)], values := vs }),
                      reads := put s.reads c (s.reads c ++ [k]) } →
        ∃ seen vals st,
          (exec cs c s2 (next (s.store k))).1 = { s with
            ran := put s.ran c (some { r with seen := r.seen ++ seen, values := vals, stopped := st }),
            reads := put s.reads c (s.reads c ++ seen.map (·.1)) } ∧
          (∀ q ∈ seen, s.store q.1 = q.2) ∧
          (∀ q ∈ seen, q ∈ (eval s.store (.read k next)).2) ∧
          (st = none → follow (.read k next) seen = some (exec cs c s2 (next (s.store k))).2) ∧
          (∀ w, w ∈ vals ↔ w ∈ r.values ∨ ∃ q ∈ seen, s.writers q.1 = some w ∧ w ≠ c) ∧
          (∀ w, st = some w → (s.due w).isSome ∧ waits s w c = false ∧ came s w c = false ∧ w ≠ c ∧
            ∃ q ∈ seen, s.writers q.1 = some w) ∧
          (st = none → ∀ q ∈ seen, ∀ w, s.writers q.1 = some w → w ≠ c → (s.due w).isSome →
            waits s w c = true ∨ came s w c = true) := by
      intro vs s2 hvs hthis hs2
      have h2 : s2.ran c = some { r with seen := r.seen ++ [(k, s.store k)], values := vs } := by
        rw [hs2]; simp
      obtain ⟨seen, vals, st, heq, hstore, hev, hfollow, hvals, hstop, hgo⟩ :=
        exec_run cs c (next (s.store k)) (hp' _) s2 _ h2 (by simpa using hs)
      have e1 : s2.writers = s.writers := by rw [hs2]
      have e2 : s2.due = s.due := by rw [hs2]
      have e5 : s2.store = s.store := by rw [hs2]
      have hw : ∀ w, waits s2 w c = waits s w c := fun w => waits_congr (by rw [hs2]) (by rw [hs2]) w c
      have hc : ∀ w, came s2 w c = came s w c := fun w => came_congr (by rw [hs2]) (by rw [hs2]) w c
      refine ⟨(k, s.store k) :: seen, vals, st, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩
      · rw [heq, hs2]
        simp [put_put]
      · intro q hq
        rcases List.mem_cons.1 hq with rfl | hq
        · rfl
        · rw [← e5]; exact hstore q hq
      · intro q hq
        simp only [eval]
        rcases List.mem_cons.1 hq with rfl | hq
        · exact List.mem_cons_self ..
        · have := hev q hq
          rw [e5] at this
          exact List.mem_cons_of_mem _ this
      · intro hst
        simp [follow, hfollow hst]
      · intro w
        rw [hvals w, e1]
        simp only [hvs w, List.mem_cons]
        constructor
        · rintro ((h | h) | ⟨q, hq, h⟩)
          · exact Or.inl h
          · exact Or.inr ⟨_, Or.inl rfl, h⟩
          · exact Or.inr ⟨q, Or.inr hq, h⟩
        · rintro (h | ⟨q, rfl | hq, h⟩)
          · exact Or.inl (Or.inl h)
          · exact Or.inl (Or.inr h)
          · exact Or.inr ⟨q, hq, h⟩
      · intro w hst
        obtain ⟨h1, h2, h3, h4, q, hq, h5⟩ := hstop w hst
        rw [e2] at h1; rw [hw] at h2; rw [hc] at h3; rw [e1] at h5
        exact ⟨h1, h2, h3, h4, q, List.mem_cons_of_mem _ hq, h5⟩
      · intro hst q hq w hqw hwc hwd
        rcases List.mem_cons.1 hq with rfl | hq
        · exact hthis w hqw hwc hwd
        · rw [← hw, ← hc]
          exact hgo hst q hq w (by rw [e1]; exact hqw) hwc (by rw [e2]; exact hwd)
    have hs1 : edit { s with reads := put s.reads c (s.reads c ++ [k]) } c
        (fun r => { r with seen := r.seen ++ [(k, s.store k)] }) =
        { s with ran := put s.ran c (some { r with seen := r.seen ++ [(k, s.store k)], values := r.values }),
                 reads := put s.reads c (s.reads c ++ [k]) } := by
      simp [edit, hr]
    simp only [exec]
    rw [hs1]
    generalize hd : ({ s with
        ran := put s.ran c (some { r with seen := r.seen ++ [(k, s.store k)], values := r.values }),
        reads := put s.reads c (s.reads c ++ [k]) } : State K V) = s1
    have e1 : s1.writers = s.writers := by rw [← hd]
    cases hw : s.writers k with
    | none =>
      simp only [e1, hw]
      exact rest _ s1 (by simp [hw]) (by simp [hw]) hd.symm
    | some w =>
      simp only [e1, hw]
      by_cases hwc : w = c
      · simp only [hwc, ite_true]
        refine rest _ s1 ?_ ?_ hd.symm
        · intro w'
          rw [hw]
          constructor
          · exact Or.inl
          · rintro (h | ⟨h, h'⟩)
            · exact h
            · cases h; exact absurd hwc h'
        · intro w' h h'
          rw [hw] at h; cases h; exact absurd hwc h'
      · simp only [hwc, ite_false]
        have hs2 : edit s1 c (fun r => { r with values := ins w r.values }) =
            { s with
              ran := put s.ran c (some { r with seen := r.seen ++ [(k, s.store k)],
                                                values := ins w r.values }),
              reads := put s.reads c (s.reads c ++ [k]) } := by
          rw [← hd]; simp [edit, put_put]
        rw [hs2]
        have hwt : waits { s with
              ran := put s.ran c (some { r with seen := r.seen ++ [(k, s.store k)],
                                                values := ins w r.values }),
              reads := put s.reads c (s.reads c ++ [k]) } w c = waits s w c :=
          waits_ran_reads s _ _ w c
        have hct : came { s with
              ran := put s.ran c (some { r with seen := r.seen ++ [(k, s.store k)],
                                                values := ins w r.values }),
              reads := put s.reads c (s.reads c ++ [k]) } w c = came s w c :=
          came_ran_reads s _ _ w c
        have hvs : ∀ w', w' ∈ ins w r.values ↔ w' ∈ r.values ∨ (some w = some w' ∧ w' ≠ c) := by
          intro w'
          rw [mem_ins]
          constructor
          · rintro (h | rfl)
            · exact Or.inl h
            · exact Or.inr ⟨rfl, hwc⟩
          · rintro (h | ⟨h, _⟩)
            · exact Or.inl h
            · cases h; exact Or.inr rfl
        split
        · rename_i hcond
          simp only [hwt, hct, Bool.and_eq_true, Bool.not_eq_eq_eq_not, Bool.not_true] at hcond
          refine ⟨[(k, s.store k)], ins w r.values, some w, ?_, by simp, ?_, by simp, ?_, ?_, by simp⟩
          · simp [edit, put_put]
          · intro q hq; simp at hq; subst hq; simp [eval]
          · intro w'; rw [hvs]; simp [hw]
          · intro w' hw'
            cases hw'
            exact ⟨by simpa using hcond.1.1, hcond.1.2, hcond.2, hwc, _, List.mem_singleton_self _, hw⟩
        · rename_i hcond
          simp only [hwt, hct, Bool.and_eq_true, Bool.not_eq_eq_eq_not, Bool.not_true] at hcond
          refine rest _ _ (by simpa [hw] using hvs) ?_ rfl
          intro w' hw' _ hd'
          rw [hw] at hw'; cases hw'
          by_cases h1 : waits s w c = true
          · exact Or.inl h1
          · by_cases h2 : came s w c = true
            · exact Or.inr h2
            · exact absurd ⟨⟨by simpa using hd', by simpa using h1⟩, by simpa using h2⟩ hcond

-- c's run at f's end: started, f read along (A2)
def mid (s : State K V) (c rk : Nat) (seen : List (K × Option V)) (vals : List Nat)
    (st : Option Nat) : State K V :=
  { s with
    due := put s.due c none, after := put s.after c none, runs := put s.runs c (s.runs c + 1),
    kept := put s.kept c [], went := put s.went c true, loop := put s.loop c none,
    ran := put s.ran c (some (begun s c vals st seen)),
    cause := put s.cause c (.mk (c, s.runs c + 1) (s.kept c)), when := put s.when c s.pulses,
    cut := put s.cut c false, acts := s.acts.filter (fun a => a.1 ≠ c),
    reads := put s.reads c (seen.map (·.1)),
    log := s.log ++ [⟨s.pulses, s.round, .starts c (s.runs c + 1) rk⟩] }

-- a run, A2: start, f read along the store, then its end from mid
theorem first_mid (cs : Nat → Comp K V) (s : State K V) (c rk : Nat) (hp : nowrites (cs c).f) :
    ∃ (seen : List (K × Option V)) (vals : List Nat) (st : Option Nat) (o : Out V),
      first cs s c rk = ending cs (mid s c rk seen vals st) c o ∧
      (∀ q ∈ seen, s.store q.1 = q.2) ∧
      (∀ q ∈ seen, q ∈ (eval s.store (cs c).f).2) ∧
      (st = none → follow (cs c).f seen = some o) ∧
      (∀ w, w ∈ vals ↔ ∃ q ∈ seen, s.writers q.1 = some w ∧ w ≠ c) ∧
      (∀ w, st = some w → (s.due w).isSome ∧ waits (start s c rk) w c = false ∧
        came (start s c rk) w c = false ∧ w ≠ c ∧ ∃ q ∈ seen, s.writers q.1 = some w) ∧
      (st = none → ∀ q ∈ seen, ∀ w, s.writers q.1 = some w → w ≠ c → (s.due w).isSome →
        waits (start s c rk) w c = true ∨ came (start s c rk) w c = true) := by
  have h0 : (start s c rk).ran c = some (begun s c [] none []) := by simp [start, say, begun]
  obtain ⟨seen, vals, st, heq, hst, hev, hfo, hvals, hstop, hgo⟩ :=
    exec_run cs c (cs c).f hp (start s c rk) _ h0 rfl
  have e1 : (start s c rk).store = s.store := rfl
  have e2 : (start s c rk).writers = s.writers := rfl
  have e3 : ∀ w, w ≠ c → (start s c rk).due w = s.due w := by
    intro w hw; simp [start, say, put_ne _ _ hw]
  simp only [first]
  generalize hx : exec cs c (start s c rk) (cs c).f = x at heq hfo
  obtain ⟨s2, o⟩ := x
  simp only at heq hfo
  subst heq
  refine ⟨seen, vals, st, o, ?_, hst, hev, hfo, ?_, ?_, ?_⟩
  · congr 1
    simp [mid, start, say, put_put, begun]
  · intro w; rw [hvals w, e2]; simp [begun]
  · intro w hw
    obtain ⟨h1, h2, h3, h4, h5⟩ := hstop w hw
    rw [e3 w h4] at h1; rw [e2] at h5
    exact ⟨h1, h2, h3, h4, h5⟩
  · intro hw q hq w hqw hwc hwd
    exact hgo hw q hq w (by rw [e2]; exact hqw) hwc (by rw [e3 w hwc]; exact hwd)

-- what a run of c from s leaves, F (A2): seen what it read, vals the writers it learned, st the
-- writer it stopped at, setv the value it gave set
structure Ran1 (cs : Nat → Comp K V) (s : State K V) (c rk : Nat) (F : State K V)
    (seen : List (K × Option V)) (vals : List Nat) (st : Option Nat) (setv : Option V) : Prop where
  pulses : F.pulses = s.pulses
  round : F.round = s.round
  phase : F.phase = s.phase
  made : F.made = s.made
  ran : ∀ d, d ≠ c → F.ran d = s.ran d
  reads : F.reads = put s.reads c (seen.map (·.1))
  values : ∀ d, d ≠ c → F.values d = s.values d
  after : ∀ d, d ≠ c → F.after d = s.after d
  cause : F.cause = put s.cause c (.mk (c, s.runs c + 1) (s.kept c))
  when : F.when = put s.when c s.pulses
  run : ∃ rf e, F.ran c = some rf ∧ rf.seen = seen ∧ rf.stopped = st ∧ rf.n = s.runs c + 1 ∧
    rf.ended = some e ∧ (e = .stopped ↔ st.isSome) ∧
    (∀ v, setv = some v → st = none ∧ e = .done ∧ rf.out = some (.value v) ∧
      iseffect (cs c) = false) ∧
    ∃ eq w th dues, F.log = s.log ++ [⟨s.pulses, s.round, .starts c (s.runs c + 1) rk⟩] ++
      (setv.map fun v => (⟨s.pulses, s.round, .set c v⟩ : Entry V)).toList ++ dues ++
      [⟨s.pulses, s.round, .ends c (s.runs c + 1) e eq w th⟩] ∧
      ∀ x ∈ dues, x.pulse = s.pulses ∧ x.round = s.round ∧ ∃ a b w, x.event = .due a b w
  store_seen : ∀ q ∈ seen, s.store q.1 = q.2
  eval_seen : ∀ q ∈ seen, q ∈ (eval s.store (cs c).f).2
  eval_all : st = none → (eval s.store (cs c).f).2 = seen
  known : ∀ w, w ∈ vals ↔ ∃ q ∈ seen, s.writers q.1 = some w ∧ w ≠ c
  stop : ∀ w, st = some w → (s.due w).isSome ∧ waits (start s c rk) w c = false ∧
    came (start s c rk) w c = false ∧ w ≠ c ∧ (∃ q ∈ seen, s.writers q.1 = some w) ∧
    F.after c = some w ∧ (F.due c).isSome ∧ F.values c = s.values c ∧ setv = none
  go : st = none → (∀ q ∈ seen, ∀ w, s.writers q.1 = some w → w ≠ c → (s.due w).isSome →
      waits (start s c rk) w c = true ∨ came (start s c rk) w c = true) ∧
    F.after c = none ∧ F.values c = vals
  due : ∀ d m, d ≠ c → s.due d = some m → F.due d = some m
  fresh : ∀ d, (F.due d).isSome → (d ≠ c ∧ (s.due d).isSome) ∨ (d = c ∧ st.isSome) ∨
    ∃ k v, setv = some v ∧ (cs c).kind = .compute (some k) ∧ k ∈ F.reads d ∧ d < s.made
  writers : F.writers = s.writers ∨
    ∃ k v, setv = some v ∧ (cs c).kind = .compute (some k) ∧ F.writers = put s.writers k (some c)
  named : ∀ v, setv = some v → ∀ k, (cs c).kind = .compute (some k) →
    F.writers = put s.writers k (some c)
  kept : ∀ x y, y ∈ F.kept x → y ∈ s.kept x ∨
    (setv.isSome ∧ y = .mk (c, s.runs c + 1) (s.kept c))

-- before a run's finish, from M (its f's end, out recorded): set may have been called with setv
structure Pre (cs : Nat → Comp K V) (c : Nat) (M X : State K V) (setv : Option V) : Prop where
  eq : X = { M with
    store := X.store, writers := X.writers, tick := X.tick, log := X.log, due := X.due,
    kept := X.kept, loop := X.loop, looping := X.looping, cut := X.cut, last := X.last,
    acts := X.acts }
  due : ∀ d m, M.due d = some m → X.due d = some m
  fresh : ∀ d, (X.due d).isSome → (M.due d).isSome ∨
    ∃ k v, setv = some v ∧ (cs c).kind = .compute (some k) ∧ k ∈ M.reads d ∧ d < M.made
  writers : X.writers = M.writers ∨
    ∃ k v, setv = some v ∧ (cs c).kind = .compute (some k) ∧ X.writers = put M.writers k (some c)
  named : ∀ v, setv = some v → ∀ k, (cs c).kind = .compute (some k) →
    X.writers = put M.writers k (some c)
  kept : ∀ x y, y ∈ X.kept x → y ∈ M.kept x ∨ (setv.isSome ∧ y = M.cause c)
  log : ∃ dues, X.log = M.log ++ (setv.map fun v => (⟨M.pulses, M.round, .set c v⟩ : Entry V)).toList ++
    dues ∧ ∀ x ∈ dues, x.pulse = M.pulses ∧ x.round = M.round ∧ ∃ a b w, x.event = .due a b w

theorem Pre.refl (cs : Nat → Comp K V) (c : Nat) (M : State K V) : Pre cs c M M none where
  eq := rfl
  due _ _ h := h
  fresh _ h := Or.inl h
  writers := Or.inl rfl
  named _ h := by cases h
  kept _ _ h := Or.inl h
  log := ⟨[], by simp, by simp⟩

theorem Pre.acts (cs : Nat → Comp K V) (c : Nat) (M : State K V) (a : List (Nat × V)) :
    Pre cs c M { M with acts := a } none where
  eq := rfl
  due _ _ h := h
  fresh _ h := Or.inl h
  writers := Or.inl rfl
  named _ h := by cases h
  kept _ _ h := Or.inl h
  log := ⟨[], by simp, by simp⟩

-- set, as the harness wires it, by c's latest run of this pulse
theorem Pre.set (cs : Nat → Comp K V) (c : Nat) (M : State K V) (v : V) (l : Nat → Option V)
    (hw : M.when c = M.pulses) (hr : (M.ran c).isSome) :
    Pre cs c M { set cs M c v with last := l } (some v) := by
  have hs : (say M (.set c v)).log = M.log ++ [⟨M.pulses, M.round, .set c v⟩] := rfl
  cases hk : (cs c).kind with
  | effect a =>
    simp only [Model.set, hk]
    exact { eq := rfl, due := fun _ _ h => h, fresh := fun _ h => Or.inl h, writers := Or.inl rfl,
            named := (fun _ _ k h => by rw [hk] at h; cases h),
            kept := fun _ _ h => Or.inl h, log := ⟨[], by simp [say], by simp⟩ }
  | compute to =>
    cases to with
    | none =>
      simp only [Model.set, hk]
      exact { eq := rfl, due := fun _ _ h => h, fresh := fun _ h => Or.inl h, writers := Or.inl rfl,
              named := (fun _ _ k h => by rw [hk] at h; cases h),
              kept := fun _ _ h => Or.inl h, log := ⟨[], by simp [say], by simp⟩ }
    | some k =>
      simp only [Model.set, hk]
      generalize hS : store (say M (.set c v)) k v = S
      have eS : S = { M with store := put M.store k (some v), log := M.log ++ [⟨M.pulses, M.round, .set c v⟩] } := by
        rw [← hS]; rfl
      have m := changed_marks cs S k (some c) (by intro c' h; cases h; rw [eS]; exact hw)
      have hrun : runof S (some c) = some c := by
        simp [runof, eS, hr]
      have hnam : namer cs S (some c) = some c := by
        simp [namer, hrun, hk]
      rw [hnam, hrun] at m
      have hcause : S.cause c = M.cause c := by rw [eS]
      generalize hC : changed cs S [k] (some c) = C at m
      have eL : learn { S with tick := S.tick + 1 } k (some c) =
          { S with tick := S.tick + 1, writers := put S.writers k (some c) } := rfl
      rw [eL] at m
      have eC := m.eq
      obtain ⟨l1, hl1, hl1'⟩ := m.log
      refine { eq := ?_, due := ?_, fresh := ?_, writers := ?_, named := ?_, kept := ?_, log := ?_ }
      · rw [eC, eS]
      · intro d n hd
        exact m.due d n (by rw [eS]; exact hd)
      · intro d hd
        rcases m.fresh d hd with h | h
        · left; rw [eS] at h; exact h
        · right
          simp only [readers, List.mem_filter, List.mem_range, decide_eq_true_eq] at h
          refine ⟨k, v, rfl, hk, ?_, ?_⟩
          · rw [eS] at h; exact h.2
          · rw [eS] at h; exact h.1
      · right; refine ⟨k, v, rfl, hk, ?_⟩
        rw [eC, eS]
      · intro v' _ k' hk'
        rw [hk] at hk'; cases hk'
        rw [eC, eS]
      · intro x y hy
        rcases m.kept x y hy with h | h
        · left; rw [eS] at h; exact h
        · right; simp at h; exact ⟨rfl, by rw [h, hcause]⟩
      · refine ⟨l1, ?_, ?_⟩
        · rw [hl1, eS]; simp
        · intro x hx
          obtain ⟨a, b, w⟩ := hl1' x hx
          rw [eS] at a b
          exact ⟨a, b, w⟩

-- a run that went through, finished from X
theorem pre_ran1 (cs : Nat → Comp K V) (s : State K V) (c rk : Nat)
    (seen : List (K × Option V)) (vals : List Nat) (o : Out V)
    (h1 : ∀ q ∈ seen, s.store q.1 = q.2) (h2 : ∀ q ∈ seen, q ∈ (eval s.store (cs c).f).2)
    (h3 : follow (cs c).f seen = some o) (h4 : ∀ w, w ∈ vals ↔ ∃ q ∈ seen, s.writers q.1 = some w ∧ w ≠ c)
    (h5 : ∀ q ∈ seen, ∀ w, s.writers q.1 = some w → w ≠ c → (s.due w).isSome →
      waits (start s c rk) w c = true ∨ came (start s c rk) w c = true)
    (X : State K V) (setv : Option V) (e : Ended) (eq : Option Bool) (th : Option (List Nat))
    (hpre : Pre cs c (edit (mid s c rk seen vals none) c fun r => { r with out := some o }) X setv)
    (he : e ≠ .stopped)
    (hset : ∀ v, setv = some v → e = .done ∧ o = .value v ∧ iseffect (cs c) = false) :
    Ran1 cs s c rk (finish X c e eq none th) seen vals none setv := by
  generalize hM : edit (mid s c rk seen vals none) c (fun r => { r with out := some o }) = M at hpre
  have eM : M = { mid s c rk seen vals none with
      ran := put s.ran c (some { begun s c vals none seen with out := some o }) } := by
    rw [← hM]; simp [edit, mid, put_put]
  have eX := hpre.eq
  have hrX : X.ran c = some { begun s c vals none seen with out := some o } := by rw [eX, eM]; simp
  obtain ⟨e', th', he', hfin⟩ := finish_any X c _ hrX e eq none th
  rw [hfin]
  have hne : e' ≠ .stopped := by rcases he' with ⟨rfl, _⟩ | ⟨_, rfl⟩ <;> simp [he]
  have hset' : ∀ v, setv = some v → e' = .done ∧ o = .value v ∧ iseffect (cs c) = false := by
    intro v hv
    obtain ⟨a, b, c'⟩ := hset v hv
    rcases he' with ⟨rfl, _⟩ | ⟨h, _⟩
    · exact ⟨a, b, c'⟩
    · rw [a] at h; cases h
  clear he' hset he
  have hev : (eval s.store (cs c).f) = (o, seen) := eval_follow _ _ _ h3 h1
  obtain ⟨dues, hl, hdues⟩ := hpre.log
  refine { pulses := ?_, round := ?_, phase := ?_, made := ?_, ran := ?_, reads := ?_, values := ?_,
           after := ?_, cause := ?_, when := ?_, run := ?_, store_seen := h1, eval_seen := h2,
           eval_all := ?_, known := h4, stop := ?_, go := ?_, due := ?_, fresh := ?_, writers := ?_,
           named := ?_, kept := ?_ }
  · simp only; rw [eX, eM]; rfl
  · simp only; rw [eX, eM]; rfl
  · simp only; rw [eX, eM]; rfl
  · simp only; rw [eX, eM]; rfl
  · intro d hd; simp only [put_ne _ _ hd]; rw [eX, eM]; simp [put_ne _ _ hd]
  · simp only; rw [eX, eM]; rfl
  · intro d hd
    simp only [hne, ne_eq, not_false_eq_true, ite_true, put_ne _ _ hd]
    rw [eX, eM]; rfl
  · intro d hd; simp only; rw [eX, eM]; simp [mid, put_ne _ _ hd]
  · simp only; rw [eX, eM]; rfl
  · simp only; rw [eX, eM]; rfl
  · refine ⟨{ { begun s c vals none seen with out := some o } with
      ended := some e', given := [], loop := if e' = .pending then s.loop c else none }, e',
      by simp [begun],
      rfl, rfl, rfl, rfl, by simp [hne], ?_, eq, none, th', dues, ?_, ?_⟩
    · intro v hv
      obtain ⟨a, b, c'⟩ := hset' v hv
      exact ⟨rfl, a, by simp [b], c'⟩
    · have hpX : X.pulses = s.pulses := by rw [eX, eM]; rfl
      have hrX : X.round = s.round := by rw [eX, eM]; rfl
      simp only [hl, begun, hpX, hrX]
      rw [eM]; simp [mid]
    · intro x hx
      obtain ⟨a, b, w⟩ := hdues x hx
      rw [eM] at a b
      exact ⟨a, b, w⟩
  · intro _; rw [hev]
  · intro w hw; cases hw
  · intro _
    refine ⟨h5, ?_, ?_⟩
    · simp only; rw [eX, eM]; simp [mid]
    · simp [hne, begun]
  · intro d m hd hdm
    simp only
    apply hpre.due d m
    rw [eM]; simp [mid, put_ne _ _ hd, hdm]
  · intro d hd
    simp only at hd
    rcases hpre.fresh d hd with h | ⟨k, v, hv, hk, hkd, hdm⟩
    · left
      rw [eM] at h
      by_cases hdc : d = c
      · subst hdc; simp [mid] at h
      · simp [mid, put_ne _ _ hdc] at h; exact ⟨hdc, h⟩
    · right; right
      refine ⟨k, v, hv, hk, ?_, ?_⟩
      · simp only; rw [eX, eM]; rw [eM] at hkd; exact hkd
      · rw [eM] at hdm; exact hdm
  · simp only
    rcases hpre.writers with h | ⟨k, v, hv, hk, hw⟩
    · left; rw [h, eM]; rfl
    · right; refine ⟨k, v, hv, hk, ?_⟩; rw [hw, eM]; rfl
  · intro v hv k hk
    simp only
    rw [hpre.named v hv k hk, eM]; rfl
  · intro x y hy
    -- not done: c's given (its kept at the start) back in front
    have hy' : y ∈ X.kept x ∨ y ∈ s.kept x := by
      simp only at hy
      split at hy
      · exact Or.inl hy
      · by_cases hxc : x = c
        · subst hxc; simp [begun] at hy; exact hy.symm
        · left; simpa [put_ne _ _ hxc] using hy
    rcases hy' with hy' | hy'
    · rcases hpre.kept x y hy' with h | ⟨hs, h⟩
      · left; rw [eM] at h
        by_cases hxc : x = c
        · subst hxc; simp [mid] at h
        · simpa [mid, put_ne _ _ hxc] using h
      · right; refine ⟨hs, ?_⟩; rw [h, eM]; simp [mid]
    · exact Or.inl hy'

-- a run that stopped at w
theorem stop_ran1 (cs : Nat → Comp K V) (s : State K V) (c rk : Nat)
    (seen : List (K × Option V)) (vals : List Nat) (w : Nat)
    (h1 : ∀ q ∈ seen, s.store q.1 = q.2) (h2 : ∀ q ∈ seen, q ∈ (eval s.store (cs c).f).2)
    (h4 : ∀ w, w ∈ vals ↔ ∃ q ∈ seen, s.writers q.1 = some w ∧ w ≠ c)
    (h6 : ∀ w', some w = some w' → (s.due w').isSome ∧ waits (start s c rk) w' c = false ∧
        came (start s c rk) w' c = false ∧ w' ≠ c ∧ ∃ q ∈ seen, s.writers q.1 = some w') :
    Ran1 cs s c rk (stop (mid s c rk seen vals (some w)) c) seen vals (some w) none := by
  have hr : (mid s c rk seen vals (some w)).ran c = some (begun s c vals (some w) seen) := by
    simp [mid]
  have hd : (mid s c rk seen vals (some w)).due c = none := by simp [mid]
  rw [stop_eq _ c _ hr hd]
  obtain ⟨a1, a2, a3, a4, a5⟩ := h6 w rfl
  refine { pulses := rfl, round := rfl, phase := rfl, made := rfl, ran := ?_, reads := rfl,
           values := fun _ _ => rfl, after := ?_, cause := rfl, when := rfl, run := ?_,
           store_seen := h1, eval_seen := h2, eval_all := (fun h => by cases h), known := h4,
           stop := ?_, go := (fun h => by cases h), due := ?_, fresh := ?_, writers := Or.inl rfl,
           named := (fun _ h => by cases h), kept := ?_ }
  · intro d hd; simp [mid, put_ne _ _ hd]
  · intro d hd; simp [mid, put_ne _ _ hd]
  · refine ⟨{ begun s c vals (some w) seen with ended := some .stopped, given := [], loop := none },
      .stopped,
      by simp, rfl, rfl,
      rfl, rfl, by simp, by simp, none, some w, none, [], ?_, by simp⟩
    simp [mid, begun]
  · intro w' hw'
    cases hw'
    exact ⟨a1, a2, a3, a4, a5, by simp [begun], by simp, rfl, rfl⟩
  · intro d m hdc h
    simp [mid, put_ne _ _ hdc, h]
  · intro d h
    by_cases hdc : d = c
    · subst hdc; right; left; simp
    · left; simp [mid, put_ne _ _ hdc] at h; exact ⟨hdc, h⟩
  · -- its given (c's kept at the start) back in c's kept
    intro x y hy
    left
    by_cases hxc : x = c
    · subst hxc; simpa [mid, begun] using hy
    · simpa [mid, put_ne _ _ hxc] using hy

-- every run, A2
theorem first_ran1 (cs : Nat → Comp K V) (s : State K V) (c rk : Nat) (hp : nowrites (cs c).f) :
    ∃ seen vals st setv, Ran1 cs s c rk (first cs s c rk) seen vals st setv := by
  obtain ⟨seen, vals, st, o, hf, h1, h2, h3, h4, h6, h7⟩ := first_mid cs s c rk hp
  rw [hf]
  cases st with
  | some w =>
    have hr : (mid s c rk seen vals (some w)).ran c = some (begun s c vals (some w) seen) := by
      simp [mid]
    refine ⟨seen, vals, some w, none, ?_⟩
    simp only [ending, hr, begun, Option.bind_some, Option.isSome_some, ite_true]
    exact stop_ran1 cs s c rk seen vals w h1 h2 h4 h6
  | none =>
    have hr : (mid s c rk seen vals none).ran c = some (begun s c vals none seen) := by
      simp [mid]
    have hfo := h3 rfl
    have h5 := h7 rfl
    simp only [ending, hr, begun, Option.bind_some, Option.isSome_none, Bool.false_eq_true, ite_false]
    have pr := pre_ran1 cs s c rk seen vals o h1 h2 hfo h4 h5
    cases o with
    | error =>
      exact ⟨seen, vals, none, none, pr _ none .failed none none (Pre.refl cs c _) (by simp)
        (by simp)⟩
    | pending =>
      exact ⟨seen, vals, none, none, pr _ none .pending none none (Pre.refl cs c _) (by simp)
        (by simp)⟩
    | value v =>
      simp only [result]
      generalize hM : (edit (mid s c rk seen vals none) c fun r => { r with out := some (Out.value v) }) = M
      rw [hM] at pr
      have hMr : M.ran c = some { begun s c vals none seen with out := some (.value v) } := by
        rw [← hM]; simp [edit, mid]
      have hMw : M.when c = M.pulses := by rw [← hM]; simp [edit, mid]
      split
      · exact ⟨seen, vals, none, none, pr _ none .failed _ none (Pre.refl cs c _) (by simp)
          (by simp)⟩
      · rename_i e _
        split
        · exact ⟨seen, vals, none, none, pr _ none .looping _ _ (Pre.refl cs c _) (by simp)
            (by simp)⟩
        · cases hk : (cs c).kind with
          | effect a =>
            simp only
            cases e
            · exact ⟨seen, vals, none, none, pr _ none .done _ _ (Pre.acts cs c _ _) (by simp)
                (by simp)⟩
            · exact ⟨seen, vals, none, none, pr _ none .done _ _ (Pre.refl cs c _) (by simp)
                (by simp)⟩
          | compute to =>
            simp only
            cases e
            · simp only [Bool.false_eq_true, ite_false]
              refine ⟨seen, vals, none, some v, pr _ (some v) .done _ _
                (Pre.set cs c M v _ hMw (by simp [hMr])) (by simp) ?_⟩
              intro v' hv'
              cases hv'
              exact ⟨rfl, rfl, by simp [iseffect, hk]⟩
            · exact ⟨seen, vals, none, none, pr _ none .done _ _ (Pre.refl cs c _) (by simp)
                (by simp)⟩

-- the log, counted

-- the runs of c that ended other than stopped, in a pulse's round, in a log
def ends (p r c : Nat) (l : List (Entry V)) : Nat :=
  (l.filter fun e => e.pulse == p && e.round == r && match e.event with
    | .ends d _ ended .. => d == c && ended != .stopped
    | _ => false).length

def starts (p r c : Nat) (l : List (Entry V)) : Nat :=
  (l.filter fun e => e.pulse == p && e.round == r && match e.event with
    | .starts d .. => d == c
    | _ => false).length

theorem completed_ends (s : State K V) (p r c : Nat) : completed s p r c = ends p r c s.log := rfl

theorem started_starts (s : State K V) (p r c : Nat) : started s p r c = starts p r c s.log := rfl

theorem ends_append (p r c : Nat) (l1 l2 : List (Entry V)) :
    ends p r c (l1 ++ l2) = ends p r c l1 + ends p r c l2 := by
  simp [ends, List.filter_append]

theorem starts_append (p r c : Nat) (l1 l2 : List (Entry V)) :
    starts p r c (l1 ++ l2) = starts p r c l1 + starts p r c l2 := by
  simp [starts, List.filter_append]

theorem ends_dues (p r c : Nat) (l : List (Entry V))
    (h : ∀ x ∈ l, ∃ a b w, x.event = .due a b w) : ends p r c l = 0 := by
  simp only [ends, List.length_eq_zero_iff, List.filter_eq_nil_iff]
  intro x hx
  obtain ⟨a, b, w, e⟩ := h x hx
  simp [e]

theorem starts_dues (p r c : Nat) (l : List (Entry V))
    (h : ∀ x ∈ l, ∃ a b w, x.event = .due a b w) : starts p r c l = 0 := by
  simp only [starts, List.length_eq_zero_iff, List.filter_eq_nil_iff]
  intro x hx
  obtain ⟨a, b, w, e⟩ := h x hx
  simp [e]

-- a run adds one start, and one end other than stopped when it went through
theorem Ran1.completed {cs : Nat → Comp K V} {s F : State K V} {c rk : Nat}
    {seen : List (K × Option V)} {vals : List Nat} {st : Option Nat} {setv : Option V}
    (h : Ran1 cs s c rk F seen vals st setv) (p r d : Nat) :
    completed F p r d = completed s p r d +
      if p = s.pulses ∧ r = s.round ∧ d = c ∧ st = none then 1 else 0 := by
  obtain ⟨rf, e, _, _, _, _, _, he, _, eq, w, th, dues, hl, hd⟩ := h.run
  simp only [completed_ends, hl, ends_append]
  rw [ends_dues p r d dues (fun x hx => (hd x hx).2.2)]
  have h1 : ends p r d [(⟨s.pulses, s.round, .starts c (s.runs c + 1) rk⟩ : Entry V)] = 0 := by
    simp [ends]
  have h2 : ends p r d (setv.map fun v => (⟨s.pulses, s.round, .set c v⟩ : Entry V)).toList = 0 := by
    cases setv <;> simp [ends]
  rw [h1, h2]
  have h3 : ends p r d [(⟨s.pulses, s.round, .ends c (s.runs c + 1) e eq w th⟩ : Entry V)] =
      if p = s.pulses ∧ r = s.round ∧ d = c ∧ e ≠ .stopped then 1 else 0 := by
    simp only [ends, List.filter_cons, List.filter_nil]
    by_cases hp : p = s.pulses
    · subst hp
      by_cases hr : r = s.round
      · subst hr
        by_cases hdc : d = c
        · subst hdc; cases e <;> simp
        · simp [hdc, Ne.symm hdc]
      · simp [hr, Ne.symm hr]
    · simp [hp, Ne.symm hp]
  rw [h3]
  have he' : (e ≠ .stopped) ↔ st = none := by
    cases st <;> simp_all
  simp only [Nat.zero_add, Nat.add_zero, he']

theorem Ran1.started {cs : Nat → Comp K V} {s F : State K V} {c rk : Nat}
    {seen : List (K × Option V)} {vals : List Nat} {st : Option Nat} {setv : Option V}
    (h : Ran1 cs s c rk F seen vals st setv) (p r d : Nat) :
    started F p r d = started s p r d +
      if p = s.pulses ∧ r = s.round ∧ d = c then 1 else 0 := by
  obtain ⟨rf, e, _, _, _, _, _, he, _, eq, w, th, dues, hl, hd⟩ := h.run
  simp only [started_starts, hl, starts_append]
  rw [starts_dues p r d dues (fun x hx => (hd x hx).2.2)]
  have h2 : starts p r d (setv.map fun v => (⟨s.pulses, s.round, .set c v⟩ : Entry V)).toList = 0 := by
    cases setv <;> simp [starts]
  have h3 : starts p r d [(⟨s.pulses, s.round, .ends c (s.runs c + 1) e eq w th⟩ : Entry V)] = 0 := by
    simp [starts]
  rw [h2, h3]
  have h1 : starts p r d [(⟨s.pulses, s.round, .starts c (s.runs c + 1) rk⟩ : Entry V)] =
      if p = s.pulses ∧ r = s.round ∧ d = c then 1 else 0 := by
    simp only [starts, List.filter_cons, List.filter_nil]
    by_cases hp : p = s.pulses
    · subst hp
      by_cases hr : r = s.round
      · subst hr
        by_cases hdc : d = c
        · subst hdc; simp
        · simp [hdc, Ne.symm hdc]
      · simp [hr, Ne.symm hr]
    · simp [hp, Ne.symm hp]
  rw [h1]
  simp

-- the order

-- the learned graph (order.ts edges)
abbrev graph (s : State K V) (p q : Nat) : Prop := q ∈ edges s p

theorem pick_le (key : Nat → Nat × Nat) :
    ∀ (l : List Nat) (init : Option Nat) (b : Nat), l.foldl (fun best p => match best with
        | none => some p
        | some b =>
          if (key p).1 < (key b).1 || ((key p).1 == (key b).1 && (key p).2 < (key b).2) then some p
          else some b) init = some b →
      (∀ b0, init = some b0 → (key b).1 ≤ (key b0).1) ∧ ∀ p ∈ l, (key b).1 ≤ (key p).1
  | [], init, b, h => by
    simp only [List.foldl_nil] at h
    subst h
    exact ⟨fun b0 h => by cases h; exact Nat.le_refl _, by simp⟩
  | p :: l, init, b, h => by
    simp only [List.foldl_cons] at h
    obtain ⟨h1, h2⟩ := pick_le key l _ b h
    cases init with
    | none =>
      simp only at h1
      exact ⟨by simp, fun q hq => by
        rcases List.mem_cons.1 hq with rfl | hq
        · exact h1 _ rfl
        · exact h2 q hq⟩
    | some b0 =>
      simp only at h1
      split at h1
      · rename_i hlt
        have hp := h1 p rfl
        have : (key p).1 ≤ (key b0).1 := by
          simp only [Bool.or_eq_true, decide_eq_true_eq, Bool.and_eq_true, beq_iff_eq] at hlt
          omega
        exact ⟨fun b1 hb1 => by cases hb1; omega, fun q hq => by
          rcases List.mem_cons.1 hq with rfl | hq
          · exact hp
          · exact h2 q hq⟩
      · rename_i hlt
        have hb := h1 b0 rfl
        have : (key b0).1 ≤ (key p).1 := by
          simp only [Bool.or_eq_true, decide_eq_true_eq, Bool.and_eq_true, beq_iff_eq] at hlt
          omega
        exact ⟨fun b1 hb1 => by cases hb1; exact hb, fun q hq => by
          rcases List.mem_cons.1 hq with rfl | hq
          · omega
          · exact h2 q hq⟩

-- next answers one of least rank among the ready
theorem next_min {rank : State K V → Nat → Nat} {s : State K V} {c : Nat}
    (h : next rank s = some c) : ∀ p, ready s p = true → p < s.made → rank s c ≤ rank s p := by
  intro p hp hm
  simp only [next] at h
  exact (pick_le _ _ none c h).2 p (by simp [hp, hm])

-- along the graph the rank never rises
theorem rank_tg {s : State K V} {r : Nat → Nat} (hr : ranked (graph s) r) {a b : Nat}
    (h : TransGen (graph s) a b) : r b ≤ r a := by
  induction h with
  | single h => exact (hr _ _ h).1
  | tail _ h ih => exact Nat.le_trans (hr _ _ h).1 ih

-- what c's graph reaches is not due when next answers c, c on no cycle (Lemma R, Lemma N)
theorem ahead {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Reach cs rank s) (hr : ranked (graph s) (rank s)) {c x : Nat}
    (hn : next rank s = some c) (hcyc : ¬TransGen (graph s) c c) (hx : TransGen (graph s) c x) :
    s.due x = none := by
  cases hd : s.due x with
  | none => rfl
  | some m =>
    exfalso
    obtain ⟨z, hz, hzx⟩ := tg_head hx
    have hzc : ¬TransGen (graph s) z c := fun h' => hcyc (TransGen.trans (.single hz) h')
    have h1 : rank s z < rank s c := (hr c z hz).2 hzc
    have h2 : rank s x ≤ rank s z := by
      rcases hzx with rfl | hzx
      · exact Nat.le_refl _
      · exact rank_tg hr hzx
    obtain ⟨q, hq, hqm, hqr⟩ := next_below hA h.wide hr (p := x) (by simp [hd])
    have := next_min hn q hq hqm
    omega

-- a round's run phase

-- from s, its run phase: the state after i runs. nothing ready, it stays (step then ends the
-- run phase)
def trace (cs : Nat → Comp K V) (rank : State K V → Nat → Nat) (s : State K V) : Nat → State K V
  | 0 => s
  | i + 1 => match next rank (trace cs rank s i) with
    | some c => first cs (trace cs rank s i) c (rank (trace cs rank s i) c)
    | none => trace cs rank s i

-- c runs in the round
def picked (cs : Nat → Comp K V) (rank : State K V → Nat → Nat) (s : State K V) (c : Nat) : Prop :=
  ∃ i, next rank (trace cs rank s i) = some c

theorem trace_some {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V} {i c : Nat}
    (h : next rank (trace cs rank s i) = some c) :
    trace cs rank s (i + 1) = first cs (trace cs rank s i) c (rank (trace cs rank s i) c) := by
  simp [trace, h]

theorem trace_none {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V} {i : Nat}
    (h : next rank (trace cs rank s i) = none) : trace cs rank s (i + 1) = trace cs rank s i := by
  simp [trace, h]

theorem trace_ran1 {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V} {i c : Nat}
    (hA : A2 cs) (h : next rank (trace cs rank s i) = some c) :
    ∃ seen vals st setv, Ran1 cs (trace cs rank s i) c (rank (trace cs rank s i) c)
      (trace cs rank s (i + 1)) seen vals st setv := by
  rw [trace_some h]; exact first_ran1 cs _ c _ (hA c)

-- a run phase keeps the pulse, round, phase and computations
theorem trace_frame {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) : ∀ i, (trace cs rank s i).pulses = s.pulses ∧ (trace cs rank s i).round = s.round ∧
      (trace cs rank s i).phase = s.phase ∧ (trace cs rank s i).made = s.made
  | 0 => ⟨rfl, rfl, rfl, rfl⟩
  | i + 1 => by
    obtain ⟨a, b, c, d⟩ := trace_frame hA i
    cases hn : next rank (trace cs rank s i) with
    | none => rw [trace_none hn]; exact ⟨a, b, c, d⟩
    | some x =>
      obtain ⟨_, _, _, _, h⟩ := trace_ran1 hA hn
      exact ⟨h.pulses.trans a, h.round.trans b, h.phase.trans c, h.made.trans d⟩

-- and each state of it is one the host and the pulses reach
theorem trace_reach {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Reach cs rank s) (hph : s.phase = .runs) : ∀ i, Reach cs rank (trace cs rank s i)
  | 0 => h
  | i + 1 => by
    cases hn : next rank (trace cs rank s i) with
    | none => rw [trace_none hn]; exact trace_reach hA h hph i
    | some c =>
      refine .step (trace_reach hA h hph i) ?_
      have hp : (trace cs rank s i).phase = .runs := (trace_frame hA i).2.2.1.trans hph
      simp only [Model.step, hp, hn, trace_some hn]

-- the trace is the round's run phase: each step a run, until nothing is ready and the acts begin
theorem trace_step {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (hph : s.phase = .runs) (i : Nat) :
    step cs rank (trace cs rank s i) = some (match next rank (trace cs rank s i) with
      | some _ => trace cs rank s (i + 1)
      | none => { trace cs rank s i with phase := .acts }) := by
  have hp : (trace cs rank s i).phase = .runs := (trace_frame hA i).2.2.1.trans hph
  cases hn : next rank (trace cs rank s i) with
  | none => simp only [Model.step, hp, hn]
  | some c => simp only [Model.step, hp, hn, trace_some hn]

-- picked: due then
theorem picked_due {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V} {i c : Nat}
    (h : next rank (trace cs rank s i) = some c) :
    ((trace cs rank s i).due c).isSome ∧ c < (trace cs rank s i).made := by
  obtain ⟨h1, h2⟩ := next_ready h
  simp only [ready, Bool.and_eq_true] at h1
  exact ⟨h1.1, h2⟩

-- Theorem 4

-- condition (L), learned, of the round whose run phase starts at s
structure Learned (cs : Nat → Comp K V) (rank : State K V → Nat → Nat) (s : State K V) :
    Prop where
  -- each run in the round reads only keys its computation's latest run before the round read
  -- (the tracker's, s.reads)
  same : ∀ i c, next rank (trace cs rank s i) = some c →
    ∀ q ∈ (eval (trace cs rank s i).store (cs c).f).2, q.1 ∈ s.reads c
  -- whose writers it has learned, none itself
  learned : ∀ c, picked cs rank s c → ∀ k ∈ s.reads c, ∀ w, s.writers k = some w →
    w ≠ c ∧ w ∈ s.values c
  -- W does not change: each change in the run phase (a set, A2) names W(k)
  writers : ∀ i, (trace cs rank s i).writers = s.writers
  -- the learned graph at the round's start has no cycle
  acyclic : ∀ x, ¬TransGen (graph s) x x

-- the invariant of a run phase under (L), after i runs: each computation completed at most one
-- run and none stopped; one that has not run is as it was; one that ran read only keys its
-- earlier run read and has learned their writers; nothing its graph reaches is due again
structure Steady (cs : Nat → Comp K V) (rank : State K V → Nat → Nat) (s : State K V) (i : Nat) :
    Prop where
  count : ∀ d, completed s s.pulses s.round d ≤ completed (trace cs rank s i) s.pulses s.round d ∧
    completed (trace cs rank s i) s.pulses s.round d ≤ completed s s.pulses s.round d + 1
  went : ∀ d, started (trace cs rank s i) s.pulses s.round d + completed s s.pulses s.round d =
    completed (trace cs rank s i) s.pulses s.round d + started s s.pulses s.round d
  idle : ∀ d, completed (trace cs rank s i) s.pulses s.round d = completed s s.pulses s.round d →
    (trace cs rank s i).reads d = s.reads d ∧ (trace cs rank s i).values d = s.values d ∧
      (trace cs rank s i).after d = s.after d
  ran : ∀ d, completed s s.pulses s.round d < completed (trace cs rank s i) s.pulses s.round d →
    (∀ k ∈ (trace cs rank s i).reads d, k ∈ s.reads d) ∧
    (∀ w ∈ (trace cs rank s i).values d, w ∈ s.values d) ∧
    (∀ k ∈ (trace cs rank s i).reads d, ∀ w, s.writers k = some w →
      w ∈ (trace cs rank s i).values d) ∧
    (trace cs rank s i).after d = none
  clear : ∀ d, completed s s.pulses s.round d < completed (trace cs rank s i) s.pulses s.round d →
    ∀ x, (x = d ∨ TransGen (graph (trace cs rank s i)) d x) →
      (trace cs rank s i).due x = none ∨ ¬picked cs rank s x

-- the graph only shrinks
theorem Steady.sub {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V} {i : Nat}
    (hA : A2 cs) (st : Steady cs rank s i) : ∀ p q, graph (trace cs rank s i) p q → graph s p q := by
  intro p q h
  have hm := (trace_frame (rank := rank) (s := s) hA i).2.2.2
  simp only [graph, edges, List.mem_filter, List.mem_append, Option.mem_toList,
    Bool.and_eq_true, bne_iff_ne, ne_eq, decide_eq_true_eq] at h ⊢
  rw [hm] at h
  rcases Nat.lt_or_ge (completed s s.pulses s.round p)
    (completed (trace cs rank s i) s.pulses s.round p) with hc | hc
  · obtain ⟨_, h2, _, h4⟩ := st.ran p hc
    rw [h4] at h
    rcases h.1 with h1 | h1
    · exact ⟨Or.inl (h2 q h1), h.2⟩
    · simp at h1
  · obtain ⟨_, h2, h3⟩ := st.idle p (Nat.le_antisymm (st.count p).1 hc |>.symm)
    rw [h2, h3] at h
    exact h

theorem steady_zero (cs : Nat → Comp K V) (rank : State K V → Nat → Nat) (s : State K V) :
    Steady cs rank s 0 where
  count _ := ⟨Nat.le_refl _, Nat.le_succ _⟩
  went _ := Nat.add_comm _ _
  idle _ _ := ⟨rfl, rfl, rfl⟩
  ran _ h := absurd h (Nat.lt_irrefl _)
  clear _ h := absurd h (Nat.lt_irrefl _)

-- a run under (L): it does not stop, and the invariant holds after it
theorem steady_step {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (hr : ∀ t : State K V, ranked (graph t) (rank t)) (h0 : Reach cs rank s)
    (hph : s.phase = .runs) (hL : Learned cs rank s) {i : Nat} (st : Steady cs rank s i) :
    Steady cs rank s (i + 1) ∧ ∀ c, next rank (trace cs rank s i) = some c →
      ∃ seen vals setv, Ran1 cs (trace cs rank s i) c (rank (trace cs rank s i) c)
        (trace cs rank s (i + 1)) seen vals none setv := by
  cases hn : next rank (trace cs rank s i) with
  | none =>
    refine ⟨?_, fun c h => by cases h⟩
    have e := trace_none hn
    exact { count := fun d => by rw [e]; exact st.count d, went := fun d => by rw [e]; exact st.went d,
            idle := fun d => by rw [e]; exact st.idle d, ran := fun d => by rw [e]; exact st.ran d,
            clear := fun d => by rw [e]; exact st.clear d }
  | some c =>
    obtain ⟨seen, vals, so, setv, h⟩ := trace_ran1 hA hn
    generalize hS : trace cs rank s i = S at h hn st
    generalize hF : trace cs rank s (i + 1) = F at h
    have hR : Reach cs rank S := hS ▸ trace_reach hA h0 hph i
    have g := hR.good hA
    have hfS := trace_frame (rank := rank) (s := s) hA i
    rw [hS] at hfS
    have hWS : S.writers = s.writers := hS ▸ hL.writers i
    have hWF : F.writers = s.writers := hF ▸ hL.writers (i + 1)
    obtain ⟨hcd, hcm⟩ := picked_due (hS ▸ hn : next rank (trace cs rank s i) = some c)
    rw [hS] at hcd hcm
    have hpk : picked cs rank s c := ⟨i, hS ▸ hn⟩
    -- c has not completed a run in the round: its graph reaches only what is not due
    have hnd : ¬completed s s.pulses s.round c < completed S s.pulses s.round c := by
      intro hc
      have := hS ▸ st.clear c (hS ▸ hc) c (Or.inl rfl)
      rcases this with h1 | h1
      · rw [h1] at hcd; cases hcd
      · exact h1 hpk
    have hceq : completed S s.pulses s.round c = completed s s.pulses s.round c :=
      Nat.le_antisymm (Nat.le_of_not_lt hnd) (hS ▸ (st.count c).1)
    obtain ⟨hRc, hVc, hAc⟩ := hS ▸ st.idle c (hS ▸ hceq)
    have hsub : ∀ p q, graph S p q → graph s p q := hS ▸ st.sub hA
    have hacS : ∀ x, ¬TransGen (graph S) x x := fun x hx => hL.acyclic x (tg_mono hsub hx)
    -- what c reads: keys its run before read, with learned writers, not c
    have hlc := hL.learned c hpk
    have hkey : ∀ q ∈ seen, q.1 ∈ s.reads c := fun q hq =>
      hL.same i c (hS ▸ hn) q (by rw [hS]; exact h.eval_seen q hq)
    -- no stop: a writer it reads is in its graph, so not due
    have hso : so = none := by
      cases so with
      | none => rfl
      | some w =>
        exfalso
        obtain ⟨hwd, _, _, hwc, ⟨q, hq, hqw⟩, _⟩ := h.stop w rfl
        rw [hWS] at hqw
        obtain ⟨_, hwv⟩ := hlc q.1 (hkey q hq) w hqw
        have hg : graph S c w := by
          simp only [graph, edges, List.mem_filter, List.mem_append, Bool.and_eq_true, bne_iff_ne,
            ne_eq, decide_eq_true_eq]
          exact ⟨Or.inl (hVc ▸ hwv), hwc, g.writers_made q.1 w (by rw [hWS]; exact hqw)⟩
        have := ahead hA hR (hr S) hn (hacS c) (.single hg)
        rw [this] at hwd; cases hwd
    subst hso
    obtain ⟨_, hFa, hFv⟩ := h.go rfl
    -- the writers c learned: in its graph before
    have hvals : ∀ w ∈ vals, w ∈ s.values c := by
      intro w hw
      obtain ⟨q, hq, hqw, _⟩ := (h.known w).1 hw
      rw [hWS] at hqw
      exact (hlc q.1 (hkey q hq) w hqw).2
    have hsubF : ∀ p q, graph F p q → graph S p q := by
      intro p q hpq
      simp only [graph, edges, List.mem_filter, List.mem_append, Option.mem_toList,
        Bool.and_eq_true, bne_iff_ne, ne_eq, decide_eq_true_eq] at hpq ⊢
      rw [h.made] at hpq
      by_cases hpc : p = c
      · subst hpc
        rw [hFv, hFa] at hpq
        rcases hpq.1 with h1 | h1
        · exact ⟨Or.inl (hVc ▸ hvals q h1), hpq.2⟩
        · simp at h1
      · rw [h.values p hpc, h.after p hpc] at hpq
        exact hpq
    have hc1 := h.completed
    have hs1 := h.started
    have hpS : S.pulses = s.pulses := hfS.1
    have hrS : S.round = s.round := hfS.2.1
    rw [hpS, hrS] at hc1 hs1
    have cF : ∀ d, completed F s.pulses s.round d =
        completed S s.pulses s.round d + if d = c then 1 else 0 := by
      intro d; rw [hc1]; by_cases hdc : d = c <;> simp [hdc]
    have sF : ∀ d, started F s.pulses s.round d =
        started S s.pulses s.round d + if d = c then 1 else 0 := by
      intro d; rw [hs1]; by_cases hdc : d = c <;> simp [hdc]
    have hstep : ∀ c', some c = some c' → ∃ seen vals setv,
        Ran1 cs S c' (rank S c') F seen vals none setv := by
      intro c' hc'; cases hc'; exact ⟨seen, vals, setv, h⟩
    refine ⟨?_, hstep⟩
    refine { count := ?_, went := ?_, idle := ?_, ran := ?_, clear := ?_ } <;> rw [hF]
    · intro d
      rw [cF d]
      have := hS ▸ st.count d
      by_cases hdc : d = c
      · subst hdc; simp [hceq]
      · simp [hdc]; exact this
    · intro d
      rw [cF d, sF d]
      have := hS ▸ st.went d
      omega
    · intro d hd
      by_cases hdc : d = c
      · subst hdc; rw [cF, hceq] at hd; simp at hd
      · rw [cF d] at hd; simp only [hdc, ite_false, Nat.add_zero] at hd
        obtain ⟨h1, h2, h3⟩ := hS ▸ st.idle d (hS ▸ hd)
        refine ⟨?_, ?_, ?_⟩
        · rw [h.reads, put_ne _ _ hdc, h1]
        · rw [h.values d hdc, h2]
        · rw [h.after d hdc, h3]
    · intro d hd
      by_cases hdc : d = c
      · subst hdc
        refine ⟨?_, ?_, ?_, hFa⟩
        · intro k hk
          rw [h.reads] at hk; simp at hk
          obtain ⟨b, hb⟩ := hk
          exact hkey _ hb
        · intro w hw; rw [hFv] at hw; exact hvals w hw
        · intro k hk w hkw
          rw [h.reads] at hk; simp at hk
          obtain ⟨b, hb⟩ := hk
          rw [hFv]
          exact (h.known w).2 ⟨_, hb, by rw [hWS]; exact hkw, (hlc k (hkey _ hb) w hkw).1⟩
      · rw [cF d] at hd; simp only [hdc, ite_false, Nat.add_zero] at hd
        obtain ⟨h1, h2, h3, h4⟩ := hS ▸ st.ran d (hS ▸ hd)
        refine ⟨?_, ?_, ?_, ?_⟩
        · rw [h.reads, put_ne _ _ hdc]; exact h1
        · rw [h.values d hdc]; exact h2
        · rw [h.reads, put_ne _ _ hdc, h.values d hdc]; exact h3
        · rw [h.after d hdc]; exact h4
    · intro d hd x hx
      refine (Classical.em (F.due x = none)).elim Or.inl (fun hFd => Or.inr fun hpx => ?_)
      have hFd' : (F.due x).isSome := by
        cases e : F.due x with
        | none => exact absurd e hFd
        | some _ => rfl
      -- a new due one reads c's key, whose writer is c: an edge to c in the graph
      have hnew : ∀ k v, setv = some v → (cs c).kind = .compute (some k) → k ∈ F.reads x →
          x ≠ c ∧ graph F x c := by
        intro k v hv hk hkx
        have hWk : s.writers k = some c := by
          rw [← hWF, h.named v hv k hk]; simp
        have hxc : x ≠ c := by
          intro hxc; subst hxc
          rw [h.reads] at hkx; simp at hkx
          obtain ⟨b, hb⟩ := hkx
          exact (hlc k (hkey _ hb) x hWk).1 rfl
        refine ⟨hxc, ?_⟩
        rw [h.reads, put_ne _ _ hxc] at hkx
        have hcv : c ∈ S.values x := by
          rcases Nat.lt_or_ge (completed s s.pulses s.round x) (completed S s.pulses s.round x)
            with hc | hc
          · exact (hS ▸ st.ran x (hS ▸ hc)).2.2.1 k hkx c hWk
          · obtain ⟨h1, h2, _⟩ := hS ▸ st.idle x
              (hS ▸ Nat.le_antisymm hc (hS ▸ (st.count x).1))
            rw [h1] at hkx; rw [h2]
            exact (hL.learned x hpx k hkx c hWk).2
        simp only [graph, edges, List.mem_filter, List.mem_append, Bool.and_eq_true, bne_iff_ne,
          ne_eq, decide_eq_true_eq]
        exact ⟨Or.inl (h.values x hxc ▸ hcv), fun e => hxc e.symm, h.made ▸ hcm⟩
      by_cases hdc : d = c
      · subst hdc
        rcases h.fresh x hFd' with ⟨hxc, hxd⟩ | ⟨_, hso⟩ | ⟨k, v, hv, hk, hkx, _⟩
        · rcases hx with rfl | hx
          · exact hxc rfl
          · have := ahead hA hR (hr S) hn (hacS d) (tg_mono hsubF hx)
            rw [this] at hxd; cases hxd
        · cases hso
        · obtain ⟨hxc, hxg⟩ := hnew k v hv hk hkx
          rcases hx with rfl | hx
          · exact hxc rfl
          · exact hL.acyclic d (tg_mono (fun a b hab => hsub a b (hsubF a b hab)) (.tail hx hxg))
      · rw [cF d] at hd; simp only [hdc, ite_false, Nat.add_zero] at hd
        have hx' : x = d ∨ TransGen (graph S) d x := hx.imp_right (tg_mono hsubF)
        have hcl := hS ▸ st.clear d (hS ▸ hd)
        rcases h.fresh x hFd' with ⟨_, hxd⟩ | ⟨_, hso⟩ | ⟨k, v, hv, hk, hkx, _⟩
        · rcases hcl x hx' with h1 | h1
          · rw [h1] at hxd; cases hxd
          · exact h1 hpx
        · cases hso
        · obtain ⟨_, hxg⟩ := hnew k v hv hk hkx
          have hdcS : TransGen (graph S) d c := by
            rcases hx' with rfl | hx'
            · exact .single (hsubF _ _ hxg)
            · exact .tail hx' (hsubF _ _ hxg)
          rcases hcl c (Or.inr hdcS) with h1 | h1
          · rw [h1] at hcd; cases hcd
          · exact h1 hpk

theorem steady {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (hr : ∀ t : State K V, ranked (graph t) (rank t)) (h0 : Reach cs rank s)
    (hph : s.phase = .runs) (hL : Learned cs rank s) : ∀ i, Steady cs rank s i
  | 0 => steady_zero cs rank s
  | i + 1 => (steady_step hA hr h0 hph hL (steady hA hr h0 hph hL i)).1

-- Theorem 4, under (L): no run in the round stops
theorem nostop {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (hr : ∀ t : State K V, ranked (graph t) (rank t)) (h0 : Reach cs rank s)
    (hph : s.phase = .runs) (hL : Learned cs rank s) {i c : Nat}
    (hn : next rank (trace cs rank s i) = some c) :
    ∃ r, (trace cs rank s (i + 1)).ran c = some r ∧ r.stopped = none ∧ r.ended ≠ some .stopped := by
  obtain ⟨seen, vals, setv, h⟩ := (steady_step hA hr h0 hph hL (steady hA hr h0 hph hL i)).2 c hn
  obtain ⟨rf, e, h1, _, h3, _, h5, h6, _⟩ := h.run
  refine ⟨rf, h1, h3, ?_⟩
  rw [h5]; intro he; cases he; simp at h6

-- Theorem 4, under (L): each computation completes at most one run in the round, and starts at
-- most one
theorem once {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (hr : ∀ t : State K V, ranked (graph t) (rank t)) (h0 : Reach cs rank s)
    (hph : s.phase = .runs) (hL : Learned cs rank s) (i d : Nat) :
    completed (trace cs rank s i) s.pulses s.round d ≤ completed s s.pulses s.round d + 1 ∧
    started (trace cs rank s i) s.pulses s.round d ≤ started s s.pulses s.round d + 1 := by
  have st := steady hA hr h0 hph hL i
  have h1 := st.count d
  have h2 := st.went d
  exact ⟨h1.2, by omega⟩

-- the log only grows, by what each run adds
theorem trace_log {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) : ∀ n, ∃ l, (trace cs rank s n).log = s.log ++ l
  | 0 => ⟨[], by simp [trace]⟩
  | n + 1 => by
    obtain ⟨l, hl⟩ := trace_log hA n
    cases hn : next rank (trace cs rank s n) with
    | none => rw [trace_none hn]; exact ⟨l, hl⟩
    | some c =>
      obtain ⟨_, _, _, _, h⟩ := trace_ran1 hA hn
      obtain ⟨_, _, _, _, _, _, _, _, _, _, _, _, dues, hlog, _⟩ := h.run
      rw [hlog, hl]
      exact ⟨_, by simp only [List.append_assoc]; exact rfl⟩

-- a set logged in the run phase: by the run of c at some i, which gave set v
theorem trace_set {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) {c : Nat} {v : V} {p r : Nat} : ∀ n, (⟨p, r, .set c v⟩ : Entry V) ∈
      (trace cs rank s n).log.drop s.log.length →
      ∃ i < n, next rank (trace cs rank s i) = some c ∧ ∃ seen vals st,
        Ran1 cs (trace cs rank s i) c (rank (trace cs rank s i) c) (trace cs rank s (i + 1))
          seen vals st (some v)
  | 0, h => by simp [trace] at h
  | n + 1, h => by
    obtain ⟨l, hl⟩ := trace_log (rank := rank) (s := s) hA n
    cases hn : next rank (trace cs rank s n) with
    | none =>
      rw [trace_none hn] at h
      obtain ⟨i, hi, h'⟩ := trace_set hA n h
      exact ⟨i, by omega, h'⟩
    | some c' =>
      obtain ⟨seen, vals, st, setv, h1⟩ := trace_ran1 hA hn
      obtain ⟨_, _, _, _, _, _, _, _, _, _, _, _, dues, hlog, hdues⟩ := h1.run
      rw [hlog, hl] at h
      simp only [List.append_assoc, List.drop_left] at h
      rcases List.mem_append.1 h with h | h
      · have : (⟨p, r, .set c v⟩ : Entry V) ∈ (trace cs rank s n).log.drop s.log.length := by
          rw [hl]; simpa using h
        obtain ⟨i, hi, h'⟩ := trace_set hA n this
        exact ⟨i, by omega, h'⟩
      · simp only [List.mem_cons, List.mem_append, List.not_mem_nil, or_false] at h
        rcases h with h | h | h | h
        · cases h
        · cases setv with
          | none => simp at h
          | some v' =>
            simp at h
            obtain ⟨_, _, rfl, rfl⟩ := h
            exact ⟨n, by omega, hn, seen, vals, st, h1⟩
        · obtain ⟨_, _, a, b, w, e⟩ := hdues _ h
          cases e
        · cases h

theorem trace_add (cs : Nat → Comp K V) (rank : State K V → Nat → Nat) (s : State K V) (i : Nat) :
    ∀ k, trace cs rank s (i + k) = trace cs rank (trace cs rank s i) k
  | 0 => rfl
  | k + 1 => by
    show trace cs rank s (i + k + 1) = _
    simp only [trace, trace_add cs rank s i k]

-- counts only grow along a run phase
theorem trace_grows {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) {i j : Nat} (hij : i ≤ j) (p r d : Nat) :
    completed (trace cs rank s i) p r d ≤ completed (trace cs rank s j) p r d := by
  obtain ⟨k, rfl⟩ := Nat.exists_eq_add_of_le hij
  rw [trace_add]
  obtain ⟨l, hl⟩ := trace_log (rank := rank) (s := trace cs rank s i) hA k
  simp only [completed_ends, hl, ends_append]
  omega

-- nothing ready, nothing due (Lemma N)
theorem idle_none {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Reach cs rank s) (hn : next rank s = none) (d : Nat) : s.due d = none := by
  cases hd : s.due d with
  | none => rfl
  | some m =>
    have := next_total hA h.wide (p := d) (by simp [hd])
    rw [hn] at this; cases this

-- Theorem 4, with Theorem 2: each set in the round is given the round's settled value: what its
-- compute gives from scratch on the store when the run phase ends
theorem settles {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (hr : ∀ t : State K V, ranked (graph t) (rank t)) (h0 : Reach cs rank s)
    (hph : s.phase = .runs) (hL : Learned cs rank s) {n c p r : Nat} {v : V}
    (hend : next rank (trace cs rank s n) = none)
    (hset : (⟨p, r, .set c v⟩ : Entry V) ∈ (trace cs rank s n).log.drop s.log.length) :
    (eval (trace cs rank s n).store (cs c).f).1 = .value v := by
  obtain ⟨i, hi, hn, seen, vals, so, h⟩ := trace_set hA n hset
  obtain ⟨rf, e, hrf, _, _, _, hend', _, hsv, _⟩ := h.run
  obtain ⟨_, he, hout, _⟩ := hsv v rfl
  subst he
  have hpk : picked cs rank s c := ⟨i, hn⟩
  -- c completed at i, so it is not due after, and its run stays its latest
  have hc : ∀ j, i + 1 ≤ j → completed s s.pulses s.round c <
      completed (trace cs rank s j) s.pulses s.round c := by
    intro j hj
    have h1 := h.completed s.pulses s.round c
    have hf := trace_frame (rank := rank) (s := s) hA i
    rw [hf.1, hf.2.1] at h1
    have h2 := ((steady hA hr h0 hph hL i).count c).1
    have h3 := trace_grows (rank := rank) (s := s) hA hj s.pulses s.round c
    have : so = none := by
      have := (hsv v rfl).1; exact this
    subst this
    simp at h1
    omega
  have hstay : ∀ k, (trace cs rank s (i + 1 + k)).ran c = some rf := by
    intro k
    induction k with
    | zero => exact hrf
    | succ k ih =>
      rw [← Nat.add_assoc]
      cases hn' : next rank (trace cs rank s (i + 1 + k)) with
      | none => rw [trace_none hn']; exact ih
      | some c' =>
        obtain ⟨_, _, _, _, h'⟩ := trace_ran1 hA hn'
        have hcc : c' ≠ c := by
          intro hcc; subst hcc
          have hd := (picked_due hn').1
          rcases (steady hA hr h0 hph hL (i + 1 + k)).clear c' (hc (i + 1 + k) (by omega)) c'
            (Or.inl rfl) with h1 | h1
          · rw [h1] at hd; cases hd
          · exact h1 hpk
        rw [h'.ran c (Ne.symm hcc)]; exact ih
  have hrn : (trace cs rank s n).ran c = some rf := by
    have := hstay (n - (i + 1)); rwa [show i + 1 + (n - (i + 1)) = n by omega] at this
  have hRn := trace_reach hA h0 hph n
  obtain ⟨o, ho, hev, _⟩ := quiescence hA hRn.wide hrn (idle_none hA hRn hend c) (Or.inl hend')
  rw [hout] at ho; cases ho
  rw [hev]

-- and each act left at the run phase's end is given its effect's settled value (Theorem 3 says
-- the same at the act itself)
theorem queued {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Reach cs rank s) (hn : next rank s = none) {e : Nat} {v : V}
    (ha : (e, v) ∈ s.acts) : (eval s.store (cs e).f).1 = .value v := by
  obtain ⟨_, r, hr, _, hdone, ho⟩ := (h.good hA).acts e v ha
  obtain ⟨o, ho', hev, _⟩ := quiescence hA h.wide hr (idle_none hA h hn e) (Or.inl hdone)
  rw [ho] at ho'; cases ho'
  rw [hev]

-- (L)'s writers, from a static condition: each compute that runs in the round is the writer of
-- its key at the round's start (declared with make's key, or learned)
theorem keyed {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V} (hA : A2 cs)
    (hk : ∀ c k, picked cs rank s c → (cs c).kind = .compute (some k) → s.writers k = some c) :
    ∀ i, (trace cs rank s i).writers = s.writers
  | 0 => rfl
  | i + 1 => by
    have ih := keyed hA hk i
    cases hn : next rank (trace cs rank s i) with
    | none => rw [trace_none hn]; exact ih
    | some c =>
      obtain ⟨_, _, _, _, h⟩ := trace_ran1 hA hn
      rcases h.writers with h1 | ⟨k, v, _, hkk, h1⟩
      · rw [h1, ih]
      · rw [h1, ih]; exact put_self (hk c k ⟨i, hn⟩ hkk)

-- causes: a run's cause is on its own computation, or on what its parents are on
theorem on_mk (z : Nat) (o : Nat × Nat) (ps : List Why) :
    on z (.mk o ps) = true → o.1 = z ∨ ∃ y ∈ ps, on z y = true := by
  intro h
  simp only [on, plain, Cause.back, Bool.or_eq_true, beq_iff_eq, List.any_eq_true] at h
  rcases h with h | ⟨⟨x, hx⟩, _, hb⟩
  · exact Or.inl h
  · right
    simp only [List.mem_map, List.mem_attach, true_and, Subtype.exists] at hx
    obtain ⟨y, hy, rfl⟩ := hx
    exact ⟨y, hy, hb⟩

-- Theorem 4.1

-- the read-writer relation of the round from s: a run of d in it read a key whose writer is w
-- (w = d included: a computation reading its own key)
def uses (cs : Nat → Comp K V) (rank : State K V → Nat → Nat) (s : State K V) (d w : Nat) : Prop :=
  ∃ i r, next rank (trace cs rank s i) = some d ∧ (trace cs rank s (i + 1)).ran d = some r ∧
    ∃ q ∈ r.seen, s.writers q.1 = some w

-- condition (D), declared and fresh, of the round whose run phase starts at s
structure Fresh (cs : Nat → Comp K V) (rank : State K V → Nat → Nat) (s : State K V) :
    Prop where
  -- each computation that runs in the round is due at its start
  due : ∀ c, picked cs rank s c → (s.due c).isSome
  -- W does not change: each key changed in the run phase (by a set, A2) has W(k) its changer from
  -- the round's start
  writers : ∀ i, (trace cs rank s i).writers = s.writers
  -- the read-writer relation of the round has no cycle (a computation reading its own key is one)
  acyclic : ∀ x, ¬TransGen (uses cs rank s) x x
  -- nothing waits at the round's start (rest_end: a run phase ends with nothing due)
  rest : ∀ x, s.after x = none
  -- no mark's cause is kept at the round's start (causes.ts from): a pulse's first round
  -- (close_kept, make_kept, write_kept, outside_kept)
  kept : ∀ x, s.kept x = []

-- the invariant of a run phase under (D), after i runs: each computation completed at most one run,
-- and once it has it is not due; the writers of what it read have completed one, or were not due
-- at the start; a run that stopped stays due; one due at the start stays due until it runs; afters
-- are reads of the round; causes kept are of computations that completed a run
structure Calm (cs : Nat → Comp K V) (rank : State K V → Nat → Nat) (s : State K V) (i : Nat) :
    Prop where
  count : ∀ d, completed s s.pulses s.round d ≤ completed (trace cs rank s i) s.pulses s.round d ∧
    completed (trace cs rank s i) s.pulses s.round d ≤ completed s s.pulses s.round d + 1
  hold : ∀ d, completed s s.pulses s.round d < completed (trace cs rank s i) s.pulses s.round d →
    (trace cs rank s i).due d = none
  known : ∀ d, completed s s.pulses s.round d < completed (trace cs rank s i) s.pulses s.round d →
    ∀ k ∈ (trace cs rank s i).reads d, ∀ w, s.writers k = some w →
      completed s s.pulses s.round w < completed (trace cs rank s i) s.pulses s.round w ∨
        s.due w = none
  stays : ∀ d, started s s.pulses s.round d < started (trace cs rank s i) s.pulses s.round d →
    completed s s.pulses s.round d < completed (trace cs rank s i) s.pulses s.round d ∨
      ((trace cs rank s i).due d).isSome
  waits : ∀ d m, ¬started s s.pulses s.round d < started (trace cs rank s i) s.pulses s.round d →
    s.due d = some m → (trace cs rank s i).due d = some m
  after : ∀ x y, (trace cs rank s i).after x = some y → uses cs rank s x y
  causes : ∀ x y, y ∈ (trace cs rank s i).kept x → ∀ z, on z y = true →
    completed s s.pulses s.round z < completed (trace cs rank s i) s.pulses s.round z
  cause : ∀ x, started s s.pulses s.round x < started (trace cs rank s i) s.pulses s.round x →
    ∀ z, on z ((trace cs rank s i).cause x) = true →
      z = x ∨ completed s s.pulses s.round z < completed (trace cs rank s i) s.pulses s.round z

theorem calm_zero (cs : Nat → Comp K V) (rank : State K V → Nat → Nat) (s : State K V)
    (hD : Fresh cs rank s) : Calm cs rank s 0 where
  count _ := ⟨Nat.le_refl _, Nat.le_succ _⟩
  hold _ h := absurd h (Nat.lt_irrefl _)
  known _ h := absurd h (Nat.lt_irrefl _)
  stays _ h := absurd h (Nat.lt_irrefl _)
  waits _ _ _ h := h
  after x y h := by simp [trace, hD.rest x] at h
  causes x y h := by simp [trace, hD.kept x] at h
  cause _ h := absurd h (Nat.lt_irrefl _)

-- Fresh's rest holds where a run phase ends (and the acts move no after): nothing is due, and
-- only a due one waits (Lemma N)
theorem rest_end {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Reach cs rank s) (hn : next rank s = none) (x : Nat) : s.after x = none := by
  cases e : s.after x with
  | none => rfl
  | some w =>
    have := ((lemma_n hA h.wide).2 x w e)
    rw [idle_none hA h hn x] at this; cases this

-- and its kept: close clears every cause, and the host's make, write and changed (from outside)
-- keep none
theorem close_kept (s : State K V) (x : Nat) : (close s).kept x = [] := rfl

theorem outside_kept (cs : Nat → Comp K V) :
    ∀ (keys : List K) (s : State K V) x y, y ∈ (changed cs s keys none).kept x → y ∈ s.kept x := by
  intro keys s
  simp only [changed, runof, Option.filter_none]
  generalize s.tick + 1 = t
  have fold : ∀ (ks : List K) (s1 : State K V), ∀ x y,
      y ∈ (ks.foldl (fun s k => tell (learn s k none) k t none) s1).kept x → y ∈ s1.kept x := by
    intro ks
    induction ks with
    | nil => intro s1 x y h; exact h
    | cons k ks ih =>
      intro s1 x y h
      simp only [List.foldl_cons] at h
      have h1 := ih _ x y h
      have m := marks_fold t none (readers s1 k) s1 (by simp)
      rcases m.kept x y h1 with h2 | h2
      · exact h2
      · simp at h2
  intro x y h
  exact fold keys { s with tick := t } x y h

theorem make_kept (cs : Nat → Comp K V) (s : State K V) (x : Nat) : (make cs s).kept x = s.kept x := by
  simp only [make]
  split <;> simp [mark, settle, Model.due, say] <;> split <;> rfl

theorem write_kept (cs : Nat → Comp K V) (s : State K V) (kvs : List (K × V)) (x : Nat) (y : Why)
    (h : y ∈ (write cs s kvs).kept x) : y ∈ s.kept x := by
  obtain ⟨st, e, _⟩ := stores_shape s kvs
  have := outside_kept cs _ _ x y h
  rw [e] at this; exact this

-- waiting after, at a run's start: an after of the round, from w to c
theorem waits_start {s : State K V} {c rk w : Nat} (h : waits (start s c rk) w c = true) :
    TransGen (aft s) w c := by
  have h1 : c ∈ chain (start s c rk) ((start s c rk).made + 1) w := by
    simpa [waits] using h
  have h2 := chain_tg h1
  refine tg_mono ?_ h2
  intro a b hab
  simp only [aft, start, say] at hab ⊢
  by_cases hac : a = c
  · subst hac; simp at hab
  · rwa [put_ne _ _ hac] at hab

theorem trace_starts {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) {i j : Nat} (hij : i ≤ j) (p r d : Nat) :
    started (trace cs rank s i) p r d ≤ started (trace cs rank s j) p r d := by
  obtain ⟨k, rfl⟩ := Nat.exists_eq_add_of_le hij
  rw [trace_add]
  obtain ⟨l, hl⟩ := trace_log (rank := rank) (s := trace cs rank s i) hA k
  simp only [started_starts, hl, starts_append]
  omega

-- a run under (D) keeps the invariant
theorem calm_step {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (hD : Fresh cs rank s) {i : Nat}
    (st : Calm cs rank s i) : Calm cs rank s (i + 1) := by
  have hs0 := trace_starts (rank := rank) (s := s) hA (Nat.zero_le i) s.pulses s.round
  simp only [trace] at hs0
  cases hn : next rank (trace cs rank s i) with
  | none =>
    have e := trace_none hn
    exact { count := fun d => by rw [e]; exact st.count d, hold := fun d => by rw [e]; exact st.hold d,
            known := fun d => by rw [e]; exact st.known d, stays := fun d => by rw [e]; exact st.stays d,
            waits := fun d => by rw [e]; exact st.waits d, after := fun d => by rw [e]; exact st.after d,
            causes := fun d => by rw [e]; exact st.causes d, cause := fun d => by rw [e]; exact st.cause d }
  | some c =>
    obtain ⟨seen, vals, so, setv, h⟩ := trace_ran1 hA hn
    have hpk : picked cs rank s c := ⟨i, hn⟩
    have hs0c := hD.due c hpk
    have hWF0 := hD.writers (i + 1)
    -- what c's run read: each a use of the round
    have huses : ∀ q ∈ seen, ∀ w, s.writers q.1 = some w → uses cs rank s c w := by
      intro q hq w hw
      obtain ⟨rf, _, hrf, hseen, _⟩ := h.run
      exact ⟨i, rf, hn, hrf, q, hseen ▸ hq, hw⟩
    have hnoself : ∀ q ∈ seen, s.writers q.1 ≠ some c := fun q hq hw =>
      hD.acyclic c (.single (huses q hq c hw))
    obtain ⟨stc, sth, stk, sts, stw, sta, stcs, stca⟩ := st
    generalize hS : trace cs rank s i = S at h hn hs0 stc sth stk sts stw sta stcs stca
    generalize hF : trace cs rank s (i + 1) = F at h hWF0
    have hWS : S.writers = s.writers := hS ▸ hD.writers i
    have hWF : F.writers = s.writers := hWF0
    obtain ⟨hcd, hcm⟩ := picked_due (hS ▸ hn : next rank (trace cs rank s i) = some c)
    rw [hS] at hcd hcm
    have hnd : ¬completed s s.pulses s.round c < completed S s.pulses s.round c := by
      intro hc; rw [sth c hc] at hcd; cases hcd
    have hceq : completed S s.pulses s.round c = completed s s.pulses s.round c :=
      Nat.le_antisymm (Nat.le_of_not_lt hnd) (stc c).1
    -- a writer it read, not c, was not due, when the run went through: else it waits after c (an
    -- after cycle in the round's uses) or is due by c's doing (a cause on c: c completed)
    have hnotdue : so = none → ∀ q ∈ seen, ∀ w, S.writers q.1 = some w → w ≠ c → S.due w = none := by
      intro hso q hq w hqw hwc
      cases hwd : S.due w with
      | none => rfl
      | some m =>
        exfalso
        rcases (h.go hso).1 q hq w hqw hwc (by simp [hwd]) with hw | hw
        · have h1 := waits_start hw
          have h2 : TransGen (uses cs rank s) w c := tg_mono (fun a b hab => sta a b hab) h1
          exact hD.acyclic c (TransGen.trans (.single (huses q hq w (hWS ▸ hqw))) h2)
        · simp only [came, Bool.and_eq_true, List.any_eq_true] at hw
          obtain ⟨_, y, hy, hyc⟩ := hw
          have : y ∈ S.kept w := by simpa [start, say, put_ne _ _ hwc] using hy
          exact hnd (stcs w y this c hyc)
    have hc1 := h.completed
    have hs1 := h.started
    have hfS := trace_frame (rank := rank) (s := s) hA i
    rw [hS] at hfS
    rw [hfS.1, hfS.2.1] at hc1 hs1
    have sF : ∀ d, started F s.pulses s.round d =
        started S s.pulses s.round d + if d = c then 1 else 0 := by
      intro d; rw [hs1]; by_cases hdc : d = c <;> simp [hdc]
    have hgrow : ∀ d, completed S s.pulses s.round d ≤ completed F s.pulses s.round d := by
      intro d; rw [hc1]; omega
    -- done before: done after
    have hdone : ∀ d, completed s s.pulses s.round d < completed S s.pulses s.round d →
        completed s s.pulses s.round d < completed F s.pulses s.round d :=
      fun d hd => Nat.lt_of_lt_of_le hd (hgrow d)
    have hcause : ∀ x, started s s.pulses s.round x < started F s.pulses s.round x →
        (∀ z, on z (.mk (c, S.runs c + 1) (S.kept c)) = true →
          z = c ∨ completed s s.pulses s.round z < completed F s.pulses s.round z) →
        ∀ z, on z (F.cause x) = true →
          z = x ∨ completed s s.pulses s.round z < completed F s.pulses s.round z := by
      intro x hx hcz z hz
      rw [h.cause] at hz
      by_cases hxc : x = c
      · subst hxc; simp at hz; exact hcz z hz
      · rw [put_ne _ _ hxc] at hz
        rw [sF x] at hx; simp only [hxc, ite_false, Nat.add_zero] at hx
        exact (stca x hx z hz).imp_right (hdone z)
    have hcz0 : ∀ z, on z (.mk (c, S.runs c + 1) (S.kept c)) = true →
        z = c ∨ completed s s.pulses s.round z < completed S s.pulses s.round z := by
      intro z hz
      rcases on_mk z _ _ hz with h1 | ⟨y, hy, hyz⟩
      · exact Or.inl h1.symm
      · exact Or.inr (stcs c y hy z hyz)
    have hwaits : ∀ d m, ¬started s s.pulses s.round d < started F s.pulses s.round d →
        s.due d = some m → F.due d = some m := by
      intro d m hd hdm
      have hdc : d ≠ c := by
        intro hdc; rw [hdc, sF] at hd; have h2 := hs0 c; simp at hd; omega
      rw [sF d] at hd; simp only [hdc, ite_false, Nat.add_zero] at hd
      exact h.due d m hdc (stw d m hd hdm)
    have hstays : ∀ d, d ≠ c → started s s.pulses s.round d < started F s.pulses s.round d →
        completed s s.pulses s.round d < completed F s.pulses s.round d ∨ (F.due d).isSome := by
      intro d hdc hd
      rw [sF d] at hd; simp only [hdc, ite_false, Nat.add_zero] at hd
      rcases sts d hd with h1 | h1
      · exact Or.inl (hdone d h1)
      · right
        obtain ⟨m, hm⟩ := Option.isSome_iff_exists.1 h1
        simp [h.due d m hdc hm]
    have hknown : ∀ d, d ≠ c → completed s s.pulses s.round d < completed F s.pulses s.round d →
        ∀ k ∈ F.reads d, ∀ w, s.writers k = some w →
          completed s s.pulses s.round w < completed F s.pulses s.round w ∨ s.due w = none := by
      intro d hdc hd k hk w hkw
      rw [hc1] at hd; simp only [hdc, false_and, and_false, ite_false, Nat.add_zero] at hd
      rw [h.reads, put_ne _ _ hdc] at hk
      exact (stk d hd k hk w hkw).imp_left (hdone w)
    -- the key c's set wrote: c is its writer
    have hsetk : ∀ k v, setv = some v → (cs c).kind = .compute (some k) → s.writers k = some c := by
      intro k v hv hk
      rw [← hWF, h.named v hv k hk]; simp
    cases so with
    | some w =>
      obtain ⟨_, _, _, _, ⟨q, hq, hqw⟩, hFa, hFd, _, hsetv⟩ := h.stop w rfl
      subst hsetv
      have cF : ∀ d, completed F s.pulses s.round d = completed S s.pulses s.round d := by
        intro d; rw [hc1]; simp
      refine { count := ?_, hold := ?_, known := ?_, stays := ?_, waits := ?_, after := ?_,
               causes := ?_, cause := ?_ } <;> rw [hF]
      · intro d; rw [cF]; exact stc d
      · intro d hd
        rw [cF] at hd
        have hdc : d ≠ c := fun e => hnd (e ▸ hd)
        cases e : F.due d with
        | none => rfl
        | some m =>
          exfalso
          rcases h.fresh d (by simp [e]) with ⟨_, h1⟩ | ⟨h1, _⟩ | ⟨_, _, h1, _⟩
          · rw [sth d hd] at h1; cases h1
          · exact hdc h1
          · cases h1
      · intro d hd
        have hdc : d ≠ c := fun e => hnd (e ▸ (cF d ▸ hd))
        exact hknown d hdc hd
      · intro d hd
        by_cases hdc : d = c
        · subst hdc; exact Or.inr hFd
        · exact hstays d hdc hd
      · exact hwaits
      · intro x y hxy
        by_cases hxc : x = c
        · subst hxc; rw [hFa] at hxy; cases hxy; exact huses q hq _ (hWS ▸ hqw)
        · rw [h.after x hxc] at hxy; exact sta x y hxy
      · intro x y hy z hz
        rcases h.kept x y hy with h1 | ⟨h1, _⟩
        · exact hdone z (stcs x y h1 z hz)
        · cases h1
      · intro x hx
        refine hcause x hx ?_
        intro z hz
        exact (hcz0 z hz).imp_right (hdone z)
    | none =>
      have cF : ∀ d, completed F s.pulses s.round d =
          completed S s.pulses s.round d + if d = c then 1 else 0 := by
        intro d; rw [hc1]; by_cases hdc : d = c <;> simp [hdc]
      have hcF : completed s s.pulses s.round c < completed F s.pulses s.round c := by
        rw [cF, hceq]; simp
      refine { count := ?_, hold := ?_, known := ?_, stays := ?_, waits := ?_, after := ?_,
               causes := ?_, cause := ?_ } <;> rw [hF]
      · intro d
        rw [cF]
        by_cases hdc : d = c
        · subst hdc; simp [hceq]
        · simp [hdc]; exact stc d
      · intro d hd
        cases e : F.due d with
        | none => rfl
        | some m =>
          exfalso
          rcases h.fresh d (by simp [e]) with ⟨hdc, h1⟩ | ⟨_, h1⟩ | ⟨k, v, hv, hk, hkd, _⟩
          · rw [cF d] at hd; simp only [hdc, ite_false, Nat.add_zero] at hd
            rw [sth d hd] at h1; cases h1
          · cases h1
          · have hkc := hsetk k v hv hk
            by_cases hdc : d = c
            · subst hdc
              rw [h.reads] at hkd; simp at hkd
              obtain ⟨b, hb⟩ := hkd
              exact hnoself _ hb hkc
            · rw [cF d] at hd; simp only [hdc, ite_false, Nat.add_zero] at hd
              rw [h.reads, put_ne _ _ hdc] at hkd
              rcases stk d hd k hkd c hkc with h1 | h1
              · exact hnd h1
              · rw [h1] at hs0c; cases hs0c
      · intro d hd k hk w hkw
        by_cases hdc : d = c
        · subst hdc
          rw [h.reads] at hk; simp at hk
          obtain ⟨b, hb⟩ := hk
          have hwc : w ≠ d := fun e => hnoself _ hb (e ▸ hkw)
          have hw := hnotdue rfl _ hb w (by rw [hWS]; exact hkw) hwc
          by_cases hbw : started s s.pulses s.round w < started S s.pulses s.round w
          · rcases sts w hbw with h1 | h1
            · exact Or.inl (hdone w h1)
            · rw [hw] at h1; cases h1
          · right
            cases e : s.due w with
            | none => rfl
            | some m => rw [stw w m hbw e] at hw; cases hw
        · exact hknown d hdc hd k hk w hkw
      · intro d hd
        by_cases hdc : d = c
        · subst hdc; exact Or.inl hcF
        · exact hstays d hdc hd
      · exact hwaits
      · intro x y hxy
        by_cases hxc : x = c
        · subst hxc; rw [(h.go rfl).2.1] at hxy; cases hxy
        · rw [h.after x hxc] at hxy; exact sta x y hxy
      · intro x y hy z hz
        rcases h.kept x y hy with h1 | ⟨_, h1⟩
        · exact hdone z (stcs x y h1 z hz)
        · subst h1
          rcases hcz0 z hz with h2 | h2
          · subst h2; exact hcF
          · exact hdone z h2
      · intro x hx
        refine hcause x hx ?_
        intro z hz
        rcases hcz0 z hz with h2 | h2
        · exact Or.inl h2
        · exact Or.inr (hdone z h2)

theorem calm {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (hD : Fresh cs rank s) : ∀ i, Calm cs rank s i
  | 0 => calm_zero cs rank s hD
  | i + 1 => calm_step hA hD (calm hA hD i)

-- Theorem 4.1, under (D): each computation completes at most one run in the round
theorem fresh {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (hD : Fresh cs rank s) (i d : Nat) :
    completed (trace cs rank s i) s.pulses s.round d ≤ completed s s.pulses s.round d + 1 :=
  ((calm hA hD i).count d).2

-- what never runs in the round completes nothing in it
theorem unpicked {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) {d : Nat} (hd : ¬picked cs rank s d) :
    ∀ i, completed (trace cs rank s i) s.pulses s.round d = completed s s.pulses s.round d
  | 0 => rfl
  | i + 1 => by
    cases hn : next rank (trace cs rank s i) with
    | none => rw [trace_none hn]; exact unpicked hA hd i
    | some c =>
      obtain ⟨_, _, _, _, h⟩ := trace_ran1 hA hn
      have hdc : d ≠ c := fun e => hd ⟨i, e ▸ hn⟩
      rw [h.completed, unpicked hA hd i]
      simp [hdc]

-- Theorem 4.1, under (D): when the run phase ends, each computation due at the round's start has
-- completed exactly one run in it, and the others none
theorem exactly {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h0 : Reach cs rank s) (hph : s.phase = .runs) (hD : Fresh cs rank s) {n : Nat}
    (hend : next rank (trace cs rank s n) = none) (d : Nat) :
    completed (trace cs rank s n) s.pulses s.round d =
      completed s s.pulses s.round d + if (s.due d).isSome then 1 else 0 := by
  have st := calm hA hD n
  have hidle := idle_none hA (trace_reach hA h0 hph n) hend
  cases hd : s.due d with
  | none =>
    simp only [Option.isSome_none, Bool.false_eq_true, ite_false, Nat.add_zero]
    exact unpicked hA (fun hp => by have := hD.due d hp; rw [hd] at this; cases this) n
  | some m =>
    simp only [Option.isSome_some, ite_true]
    have hb : started s s.pulses s.round d < started (trace cs rank s n) s.pulses s.round d := by
      refine Nat.lt_of_not_le fun hle => ?_
      have := st.waits d m (Nat.not_lt_of_le hle) hd
      rw [hidle d] at this; cases this
    rcases st.stays d hb with h1 | h1
    · have := (st.count d).2; omega
    · rw [hidle d] at h1; cases h1

-- Proposition 4.2

-- y was made due at step j by a report of c: c ran there, its set reported a key y read
def report (cs : Nat → Comp K V) (rank : State K V → Nat → Nat) (s : State K V) (j y c : Nat) :
    Prop :=
  next rank (trace cs rank s j) = some c ∧ (trace cs rank s j).due y = none ∧
    ((trace cs rank s (j + 1)).due y).isSome ∧
    ∃ k, (cs c).kind = .compute (some k) ∧ k ∈ (trace cs rank s j).reads y

-- reporters back from y, due at step τ, to step t: y was due at t, or a report of c at some j in
-- [t, τ) made it due, and c's reporters go back from j
inductive Back (cs : Nat → Comp K V) (rank : State K V → Nat → Nat) (s : State K V) (t : Nat) :
    Nat → Nat → List Nat → Prop
  | due {τ y : Nat} : ((trace cs rank s t).due y).isSome → Back cs rank s t τ y []
  | made {τ y j c : Nat} {ys : List Nat} : t ≤ j → j < τ → report cs rank s j y c →
      Back cs rank s t j c ys → Back cs rank s t τ y (c :: ys)

-- each consecutive pair an edge
def links (G : Nat → Nat → Prop) : List Nat → Prop
  | a :: b :: rest => G a b ∧ links G (b :: rest)
  | _ => True

-- a newly due one: reported by the run there (A2)
theorem trace_report {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) {j y c : Nat} (hn : next rank (trace cs rank s j) = some c)
    (h1 : (trace cs rank s j).due y = none) (h2 : ((trace cs rank s (j + 1)).due y).isSome) :
    y ≠ c ∧ report cs rank s j y c := by
  obtain ⟨_, _, _, _, h⟩ := trace_ran1 hA hn
  have hyc : y ≠ c := by
    intro e; subst e
    have := (picked_due hn).1; rw [h1] at this; cases this
  refine ⟨hyc, hn, h1, h2, ?_⟩
  rcases h.fresh y h2 with ⟨_, h3⟩ | ⟨h3, _⟩ | ⟨k, _, _, hk, hky, _⟩
  · rw [h1] at h3; cases h3
  · exact absurd h3 hyc
  · rw [h.reads, put_ne _ _ hyc] at hky
    exact ⟨k, hk, hky⟩

-- a first step at which y became due
theorem trace_became {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    {t y : Nat} (h0 : (trace cs rank s t).due y = none) :
    ∀ k, ((trace cs rank s (t + k)).due y).isSome →
      ∃ j, t ≤ j ∧ j < t + k ∧ (trace cs rank s j).due y = none ∧
        ((trace cs rank s (j + 1)).due y).isSome
  | 0, h => by simp [h0] at h
  | k + 1, h => by
    cases e : (trace cs rank s (t + k)).due y with
    | none => exact ⟨t + k, by omega, by omega, e, h⟩
    | some _ =>
      obtain ⟨j, h1, h2, h3, h4⟩ := trace_became h0 k (by simp [e])
      exact ⟨j, h1, by omega, h3, h4⟩

-- every one due at τ has reporters back to t
theorem back_exists {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (t : Nat) : ∀ n τ, τ ≤ n → t ≤ τ → ∀ y, ((trace cs rank s τ).due y).isSome →
      ∃ ys, Back cs rank s t τ y ys
  | 0, τ, hτ, ht, y, hy => by
    have : τ = t := by omega
    subst this
    exact ⟨[], .due hy⟩
  | n + 1, τ, hτ, ht, y, hy => by
    cases e : (trace cs rank s t).due y with
    | some _ => exact ⟨[], .due (by simp [e])⟩
    | none =>
      obtain ⟨k, rfl⟩ := Nat.exists_eq_add_of_le ht
      obtain ⟨j, hj1, hj2, hj3, hj4⟩ := trace_became e k hy
      cases hn : next rank (trace cs rank s j) with
      | none => rw [trace_none hn, hj3] at hj4; cases hj4
      | some c =>
        obtain ⟨_, hrep⟩ := trace_report hA hn hj3 hj4
        obtain ⟨ys, hys⟩ := back_exists hA t n j (by omega) hj1 c (picked_due hn).1
        exact ⟨c :: ys, .made hj1 hj2 hrep hys⟩

-- the end of a chain of reporters was due at t
theorem Back.last {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V} {t : Nat}
    {τ y : Nat} {ys : List Nat} (h : Back cs rank s t τ y ys) :
    ∀ z, (y :: ys).getLast? = some z → ((trace cs rank s t).due z).isSome := by
  induction h with
  | due hy => intro z hz; simp at hz; subst hz; exact hy
  | made _ _ _ _ ih =>
    intro z hz
    rename_i c ys' _ _ _ _
    exact ih z (by simpa [List.getLast?_cons_cons] using hz)

theorem links_tg {G : Nat → Nat → Prop} :
    ∀ (a b : Nat) (rest : List Nat), links G (a :: b :: rest) →
      ∀ z, (b :: rest).getLast? = some z → TransGen G a z
  | a, b, [], h, z, hz => by
    simp at hz; subst hz; exact .single h.1
  | a, b, c :: rest, h, z, hz => by
    have := links_tg b c rest h.2 z (by simpa [List.getLast?_cons_cons] using hz)
    exact TransGen.trans (.single h.1) this

-- reads stay while a computation does not run
theorem trace_reads {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) {d j : Nat} :
    ∀ k, (∀ l, l < k → next rank (trace cs rank s (j + l)) ≠ some d) →
      (trace cs rank s (j + k)).reads d = (trace cs rank s j).reads d
  | 0, _ => rfl
  | k + 1, h => by
    have ih := trace_reads hA k (fun l hl => h l (by omega))
    rw [← Nat.add_assoc]
    cases hn : next rank (trace cs rank s (j + k)) with
    | none => rw [trace_none hn]; exact ih
    | some c =>
      obtain ⟨_, _, _, _, h'⟩ := trace_ran1 hA hn
      have hdc : d ≠ c := fun e => h k (by omega) (e ▸ hn)
      rw [h'.reads, put_ne _ _ hdc, ih]

-- dues stay while a computation does not run
theorem trace_due {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) {d j : Nat} (hd : ((trace cs rank s j).due d).isSome) :
    ∀ k, (∀ l, l < k → next rank (trace cs rank s (j + l)) ≠ some d) →
      ((trace cs rank s (j + k)).due d).isSome
  | 0, _ => hd
  | k + 1, h => by
    have ih := trace_due hA hd k (fun l hl => h l (by omega))
    rw [← Nat.add_assoc]
    cases hn : next rank (trace cs rank s (j + k)) with
    | none => rw [trace_none hn]; exact ih
    | some c =>
      obtain ⟨_, _, _, _, h'⟩ := trace_ran1 hA hn
      have hdc : d ≠ c := fun e => h k (by omega) (e ▸ hn)
      obtain ⟨m, hm⟩ := Option.isSome_iff_exists.1 ih
      simp [h'.due d m hdc hm]

-- Proposition 4.2: d's run R at t, then at i (d not run since) x's set reports a key k that R
-- read and makes d due again. R went through; were k's writer at R's read x (b) and x due at t,
-- the read went through only as x waits after d or is due by d's doing (else W(k) was unknown or
-- another: a). either way the reporters behind x go back to t, ending at one due then (d itself:
-- a loop of reports), and, d on no cycle of the learned graph at t (ranked), the chain d, x, ...
-- is not in the learned graph at t
theorem why {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (hr : ∀ t : State K V, ranked (graph t) (rank t)) (h0 : Reach cs rank s)
    (hph : s.phase = .runs) {t i d x : Nat} (ht : next rank (trace cs rank s t) = some d)
    (hti : t < i) (hd : ∀ j, t < j → j ≤ i → next rank (trace cs rank s j) ≠ some d)
    (hi : next rank (trace cs rank s i) = some x) (hn : (trace cs rank s i).due d = none)
    (hm : ((trace cs rank s (i + 1)).due d).isSome)
    (hcyc : ¬TransGen (graph (trace cs rank s t)) d d) :
    ∃ k ys, (cs x).kind = .compute (some k) ∧ k ∈ (trace cs rank s (t + 1)).reads d ∧
      ((trace cs rank s t).writers k = some x → ((trace cs rank s t).due x).isSome →
        waits (start (trace cs rank s t) d (rank (trace cs rank s t) d)) x d = true ∨
        came (start (trace cs rank s t) d (rank (trace cs rank s t) d)) x d = true) ∧
      Back cs rank s t i x ys ∧ ¬links (graph (trace cs rank s t)) (d :: x :: ys) := by
  obtain ⟨_, _, _, k, hk, hkd⟩ := (trace_report hA hi hn hm).2
  have hreads : (trace cs rank s i).reads d = (trace cs rank s (t + 1)).reads d := by
    have := trace_reads (rank := rank) (s := s) hA (d := d) (j := t + 1) (i - (t + 1))
      (fun l hl => hd (t + 1 + l) (by omega) (by omega))
    rwa [show t + 1 + (i - (t + 1)) = i by omega] at this
  obtain ⟨ys, hys⟩ := back_exists hA t i i (Nat.le_refl _) (by omega) x (picked_due hi).1
  have hxd : x ≠ d := fun e => hd i hti (Nat.le_refl _) (e ▸ hi)
  refine ⟨k, ys, hk, hreads ▸ hkd, ?_, hys, ?_⟩
  · -- R went through: a stopped run stays due, and d was not due at i
    intro hkx hxt
    obtain ⟨seen, vals, so, setv, h⟩ := trace_ran1 hA ht
    cases so with
    | some w =>
      exfalso
      have h1 := (h.stop w rfl).2.2.2.2.2.2.1
      have := trace_due (rank := rank) (s := s) hA (d := d) (j := t + 1) h1 (i - (t + 1))
        (fun l hl => hd (t + 1 + l) (by omega) (by omega))
      rw [show t + 1 + (i - (t + 1)) = i by omega, hn] at this
      cases this
    | none =>
      have hk' : k ∈ (trace cs rank s (t + 1)).reads d := hreads ▸ hkd
      rw [h.reads] at hk'; simp at hk'
      obtain ⟨b, hb⟩ := hk'
      exact (h.go rfl).1 _ hb x hkx hxd hxt
  · intro hl
    obtain ⟨z, hz⟩ : ∃ z, (x :: ys).getLast? = some z := by
      cases h : (x :: ys).getLast? with
      | none => simp at h
      | some z => exact ⟨z, rfl⟩
    have hdz := links_tg d x ys hl z hz
    have hR := trace_reach hA h0 hph t
    have h1 := ahead hA hR (hr _) ht hcyc hdz
    have h2 := hys.last z hz
    rw [h1] at h2; cases h2

end Model

-- checks on the model (#guard), each confirmed against the TS (scheduler.ts) as run
namespace Model.Check

open Model

-- proof.md §6's measured first pulse: parents [[],[0],[1],[1,2],[2],[3,4]] made in order
-- [1,5,4,0,3,2]; compute i reads its parents' keys and sets 1 + their sum (none: 0) at k{i}.
-- computations are named by n, the order made: c5 is 1
def dagf : List Nat → Int → Prog String J
  | [], acc => .value (.num (acc + 1))
  | p :: rest, acc => .read s!"k{p}" fun x => dagf rest (acc + J.int x)
def parents : List (List Nat) := [[], [0], [1], [1, 2], [2], [3, 4]]
def order : List Nat := [1, 5, 4, 0, 3, 2]
def dag (declared : Bool) : Nat → Comp String J := fun n =>
  let i := order.getD n 0
  { kind := .compute (some s!"k{i}"), f := dagf (parents.getD i []) 0, equal := jeq,
    key := if declared then some s!"k{i}" else none }
def dag1 (declared : Bool) := go (dag declared) (makes (dag declared) 6 empty)
-- learned: c5 completes 4 runs in the round, c1, c4, c3 two (the TS: [1,2,1,2,2,4] by i)
#guard (List.range 6).map (completed (dag1 false) 0 0) == [2, 4, 2, 1, 2, 1]
-- every key declared: one complete run each, 6 stops
#guard (List.range 6).map (completed (dag1 true) 0 0) == [1, 1, 1, 1, 1, 1]
#guard ((List.range 6).map (started (dag1 true) 0 0)).sum == 12
-- Fresh's rest and kept at that pulse's start
#guard (List.range 6).all fun x =>
  (Model.begin (makes (dag true) 6 empty)).after x == none &&
  ((Model.begin (makes (dag true) 6 empty)).kept x).isEmpty

-- (L) holds in the next pulse, compute 0 reading an input x: once each (the TS: the same).
-- at its start each writer read is learned and not the reader, the graph has no cycle, and at
-- its end W has not moved
def dagx (declared : Bool) : Nat → Comp String J := fun n =>
  let i := order.getD n 0
  { kind := .compute (some s!"k{i}"), equal := jeq,
    f := if i = 0 then .read "x" fun x => dagf [] (J.int x) else dagf (parents.getD i []) 0,
    key := if declared then some s!"k{i}" else none }
def dagx1 (b : Bool) := write (dagx b) (go (dagx b) (makes (dagx b) 6
  (write (dagx b) empty [("x", .num 1)]))) [("x", .num 2)]
def dagx2 (b : Bool) := go (dagx b) (dagx1 b)
#guard [false, true].all fun b => (List.range 6).map (completed (dagx2 b) 1 0) == [1, 1, 1, 1, 1, 1]
#guard [false, true].all fun b => (List.range 6).all fun c => ((dagx1 b).reads c).all fun k =>
  match (dagx1 b).writers k with
  | some w => w != c && ((dagx1 b).values c).contains w
  | none => true
#guard [false, true].all fun b => (List.range 6).all fun p => !(reach 6 (edges (dagx1 b)) p).contains p
#guard [false, true].all fun b => (List.range 6).all fun c =>
  (dagx2 b).writers s!"k{order.getD c 0}" == (dagx1 b).writers s!"k{order.getD c 0}"

-- a counterexample to §6's (L) as written (G has no self edges): 12-loop-set's third pulse.
-- the compute read c, whose writer is itself; its graph is empty, nothing waits, W is its own
-- and does not move; yet it completes two runs in the round (the TS: done, then looping). so
-- Learned asks that no writer read be the reader itself
def l2b := Model.begin (write selfloop l2 [("c", .num 10)])
#guard l2b.writers "c" == some 0 && l2b.reads 0 == ["c"] && edges l2b 0 == [] && l2b.after 0 == none
#guard completed l3 2 0 0 == 2

-- a counterexample to Theorem 4.1 as written (E_ρ has no self pairs): the same compute with its
-- key declared, in its first pulse: due at the start, W(c) = itself from the start, reports only
-- from its set, E_ρ empty; two complete runs (the TS: done, then looping). so Fresh's uses counts
-- a computation reading its own key as a cycle
def selfk : Nat → Comp String J
  | _ => { kind := .compute (some "c"), equal := jeq, key := some "c",
           f := .read "c" fun x => .value (.num (J.int x + 1)) }
#guard completed (go selfk (make selfk empty)) 0 0 0 == 2

-- a counterexample to Theorem 4.1 in a later round: a mark kept from an earlier round of the
-- pulse lets a read of a due writer through (causes.ts from). w (0) reads a, sets k (declared);
-- d (1) reads g, f, and k when f is 1, its value g; the effect e (2) on d's key writes f, then a,
-- at 2. a host write of g: round 0 runs d, then e; e's act marks d and w, both carrying e's
-- cause, which came out of d's run. round 1: d and w due at its start, W(k) = w from the start,
-- reports only from sets, its uses {d → w} acyclic, nothing waits; d runs first (rank 0, earlier
-- mark), reads k while w is due and does not stop (w's kept cause is on d); w then sets k, and d
-- completes a second run. the TS does the same. so Fresh asks that no cause be kept at the start
def came3 : Nat → Comp String J
  | 0 => { kind := .compute (some "k"), equal := jeq, key := some "k",
           f := .read "a" fun a => .value (.num (J.int a + 1)) }
  | 1 => cmp (.read "g" fun g => .read "f" fun f =>
           if f = some (.num 1) then .read "k" fun _ => .value (g.getD .null)
           else .value (g.getD .null)) "dk"
  | _ => eff (.read "dk" fun x => .value (x.getD .null))
           (fun v _ => if v = .num 2 then [("f", .num 1), ("a", .num 5)] else [])
def came0 := write came3 (write came3 (write came3 empty [("g", .num 1)]) [("f", .num 0)])
  [("a", .num 0)]
def came1 := write came3 (go came3 (makes came3 3 came0)) [("g", .num 2)]
-- steps until round 1 begins
def upto : Nat → State String J → State String J
  | 0, s => s
  | f + 1, s => if s.round = 1 then s else match step came3 rk s with
    | some s' => upto f s'
    | none => s
def came2 := upto 100 (Model.begin came1)
#guard came2.round == 1 && came2.phase == .runs
#guard (came2.due 0).isSome && (came2.due 1).isSome && came2.writers "k" == some 0
#guard came2.writers "g" == none && came2.writers "f" == none && came2.writers "a" == none
#guard (List.range 3).all fun x => came2.after x == none
#guard !(came2.kept 0).isEmpty
#guard completed (go came3 came1) 1 1 1 == 2
#guard (List.range 3).map (completed (go came3 came1) 1 0) == [0, 1, 1]

end Model.Check
