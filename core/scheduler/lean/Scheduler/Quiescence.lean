-- LLM generated working output
-- theorems on the model (Model.lean). proof.md is the guide; its §13 says what changed.
--
-- the states: Reach, what the host (make, write, changed from outside) and pulses (begin, step,
-- close) reach from empty. the invariant: Good (Core: order, runs, reads; then acts and lasts),
-- kept by every transition (Reach.good). proved, for every reachable state:
-- - lemma_n: after-chains have no cycle; only a due computation waits after one
-- - next_total: something due, next answers one; next_below: one of no greater rank (ranked)
-- - fresh_reads (Lemma F): not due, its latest run done, failed or pending: every key it read still
--   holds what it read
-- - quiescence (Theorem 2): then that run is f from scratch on the store: the same outcome and
--   reads, and the tracker holds those keys. quiescence_done (a: a compute's last is that value,
--   or equal to it), quiescence_failed (b), quiescence_pending (c); quiescent: nothing due, every
--   compute done; quiescent_effects: and no act left, every effect done
-- - act_fresh, step_acts (Theorem 3): an act is called with its effect's value from scratch on the
--   store at the act
-- - cutoff (Theorem 5 a): a run equal to the last changes neither the store nor the last.
--   acts_iff, act_last, act_skip (Theorem 5 c): an unflagged effect run queues an act iff its value
--   is not equal to the last acted on; an act sets the last; due again, it is skipped
--
-- assumed (each a hypothesis where used):
-- - A2 cs: no f writes in its run (nowrites). every theorem but act_skip and act_last; cutoff and
--   acts_iff need it of the one computation only. Lemma N should not need it (writes in runs do not
--   touch afters), but its proof goes through the same invariant
-- - the host's changes name no computation: Reach's write and changed are from outside. a change
--   named by a computation whose latest run was flagged is cut as that run's loop, and Theorem 2
--   fails (Model.Check, the last scenario; the TS does the same)
-- - next_below: the rank is ranked over the current edges (Basic.lean; Rank.lean)
-- - nothing of equal: near is "the same, or equal said so"; no A4
-- - A8 (sync) and the rest of Model.lean's departures, by construction
import Scheduler.Model

namespace Model

open Relation

set_option linter.unusedSectionVars false
set_option linter.unusedSimpArgs false

variable {K V : Type} [DecidableEq K] [DecidableEq V]

-- the after relation: a waits after b
def aft (s : State K V) (a b : Nat) : Prop := s.after a = some b

-- transitive closures, without mathlib

theorem tg_head {α : Type} {r : α → α → Prop} {a b : α} (h : TransGen r a b) :
    ∃ z, r a z ∧ (z = b ∨ TransGen r z b) := by
  induction h with
  | single h => exact ⟨_, h, Or.inl rfl⟩
  | tail _ h2 ih =>
    obtain ⟨z, hz, hzb⟩ := ih
    refine ⟨z, hz, Or.inr ?_⟩
    rcases hzb with rfl | hzb
    · exact .single h2
    · exact .tail hzb h2

theorem tg_mono {α : Type} {r q : α → α → Prop} (hrq : ∀ a b, r a b → q a b) {a b : α}
    (h : TransGen r a b) : TransGen q a b := by
  induction h with
  | single h => exact .single (hrq _ _ h)
  | tail _ h2 ih => exact .tail ih (hrq _ _ h2)

-- chains

theorem chain_congr {s s' : State K V} (h : s'.after = s.after) :
    ∀ f x, chain s' f x = chain s f x
  | 0, _ => rfl
  | f + 1, x => by simp only [chain, h, chain_congr h f]

theorem waits_congr {s s' : State K V} (h : s'.after = s.after) (hm : s'.made = s.made) (w c : Nat) :
    waits s' w c = waits s w c := by
  simp only [waits, chain_congr h, hm]

theorem chain_tg {s : State K V} : ∀ {f x y}, y ∈ chain s f x → TransGen (aft s) x y
  | 0, _, _, h => by simp [chain] at h
  | f + 1, x, y, h => by
    simp only [chain] at h
    split at h
    · simp at h
    · rename_i z hz
      rcases List.mem_cons.1 h with rfl | h
      · exact .single hz
      · exact TransGen.trans (.single hz) (chain_tg h)

theorem chain_full_or_mem {s : State K V} : ∀ {f x y}, TransGen (aft s) x y →
    (chain s f x).length = f ∨ y ∈ chain s f x
  | 0, _, _, _ => Or.inl rfl
  | f + 1, x, y, h => by
    obtain ⟨z, hz, hzy⟩ := tg_head h
    simp only [chain, show s.after x = some z from hz]
    rcases hzy with rfl | hzy
    · exact Or.inr (List.mem_cons_self ..)
    · rcases chain_full_or_mem (f := f) hzy with h1 | h1
      · exact Or.inl (by simp [h1])
      · exact Or.inr (List.mem_cons_of_mem _ h1)

theorem chain_nodup {s : State K V} (hac : ∀ x, ¬TransGen (aft s) x x) :
    ∀ f x, (x :: chain s f x).Nodup
  | 0, _ => by simp [chain]
  | f + 1, x => by
    simp only [chain]
    split
    · simp
    · rename_i z hz
      refine List.nodup_cons.2 ⟨?_, chain_nodup hac f z⟩
      intro hx
      rcases List.mem_cons.1 hx with rfl | hx
      · exact hac _ (.single hz)
      · exact hac _ (TransGen.trans (.single hz) (chain_tg hx))

theorem chain_lt {s : State K V} (hlt : ∀ a b, s.after a = some b → b < s.made) :
    ∀ f x y, y ∈ chain s f x → y < s.made
  | 0, _, _, h => by simp [chain] at h
  | f + 1, x, y, h => by
    simp only [chain] at h
    split at h
    · simp at h
    · rename_i z hz
      rcases List.mem_cons.1 h with rfl | h
      · exact hlt _ _ hz
      · exact chain_lt hlt f z y h

-- waitsAfter answers the after relation while it is acyclic
theorem waits_of_tg {s : State K V} (hac : ∀ x, ¬TransGen (aft s) x x)
    (hlt : ∀ a b, s.after a = some b → b < s.made) {w c : Nat} (hw : w < s.made)
    (h : TransGen (aft s) w c) : waits s w c = true := by
  rcases chain_full_or_mem (f := s.made + 1) h with h1 | h1
  · exfalso
    have hsub : (w :: chain s (s.made + 1) w) ⊆ List.range s.made := by
      intro y hy
      rcases List.mem_cons.1 hy with rfl | hy
      · exact List.mem_range.2 hw
      · exact List.mem_range.2 (chain_lt hlt _ _ _ hy)
    have := (chain_nodup hac (s.made + 1) w).length_le_of_subset hsub
    simp [h1] at this
    omega
  · simp [waits, h1]

theorem waits_ran_reads (s : State K V) (x : Nat → Option (Run K V)) (y : Nat → List K) (w c : Nat) :
    waits { s with ran := x, reads := y } w c = waits s w c :=
  waits_congr (s := s) (s' := { s with ran := x, reads := y }) rfl rfl w c

-- a new edge c → w, from a c that waited after nothing
theorem tg_put {after : Nat → Option Nat} {c w : Nat} (hc : after c = none) {a b : Nat}
    (h : TransGen (fun x y => put after c (some w) x = some y) a b) :
    TransGen (fun x y => after x = some y) a b ∨
      ((a = c ∨ TransGen (fun x y => after x = some y) a c) ∧
        (w = b ∨ TransGen (fun x y => after x = some y) w b)) := by
  induction h with
  | @single y h =>
    by_cases hx : a = c
    · subst hx; simp at h; exact Or.inr ⟨Or.inl rfl, Or.inl h⟩
    · rw [put_ne _ _ hx] at h; exact Or.inl (.single h)
  | @tail y z _ h2 ih =>
    by_cases hy : y = c
    · subst hy
      simp at h2
      subst h2
      rcases ih with ih | ⟨ih, _⟩
      · exact Or.inr ⟨Or.inr ih, Or.inl rfl⟩
      · exact Or.inr ⟨ih, Or.inl rfl⟩
    · rw [put_ne _ _ hy] at h2
      rcases ih with ih | ⟨ih1, ih2⟩
      · exact Or.inl (.tail ih h2)
      · refine Or.inr ⟨ih1, Or.inr ?_⟩
        rcases ih2 with rfl | ih2
        · exact .single h2
        · exact .tail ih2 h2

-- reads: a run followed along what it read

-- the tree, given the reads in order, ends with o (A2: no writes)
def follow : Prog K V → List (K × Option V) → Option (Out V)
  | .value v, [] => some (.value v)
  | .error, [] => some .error
  | .pending, [] => some .pending
  | .read k next, q :: rest => if q.1 = k then follow (next q.2) rest else none
  | _, _ => none

-- locality: a store agreeing with what a run read gives what the run gave, reading the same
theorem eval_follow {st : K → Option V} :
    ∀ (p : Prog K V) (seen : List (K × Option V)) (o : Out V), follow p seen = some o →
      (∀ q ∈ seen, st q.1 = q.2) → eval st p = (o, seen)
  | .value v, [], o, h, _ => by simp [follow] at h; simp [eval, h]
  | .error, [], o, h, _ => by simp [follow] at h; simp [eval, h]
  | .pending, [], o, h, _ => by simp [follow] at h; simp [eval, h]
  | .read k next, q :: rest, o, h, hst => by
    simp only [follow] at h
    split at h
    · rename_i hk
      have hq := hst q (List.mem_cons_self ..)
      have := eval_follow (next q.2) rest o h (fun x hx => hst x (List.mem_cons_of_mem _ hx))
      simp only [eval]
      rw [hk] at hq
      rw [hq, this]
      simp [← hk]
    · simp at h
  | .value _, _ :: _, _, h, _ => by simp [follow] at h
  | .error, _ :: _, _, h, _ => by simp [follow] at h
  | .pending, _ :: _, _, h, _ => by simp [follow] at h
  | .read .., [], _, h, _ => by simp [follow] at h
  | .write .., _, _, h, _ => by cases ‹List _› <;> simp [follow] at h

-- puts

theorem put_put {α β : Type} [DecidableEq α] (f : α → β) (a : α) (b b' : β) :
    put (put f a b) a b' = put f a b' := by
  funext x; by_cases h : x = a <;> simp [put, h]

theorem put_self {α β : Type} [DecidableEq α] {f : α → β} {a : α} {b : β} (h : f a = b) :
    put f a b = f := by
  funext x; by_cases hx : x = a <;> simp [put, hx, h]

-- a run, A2: it reads, and may stop; it changes only its record and its read keys

theorem exec_spec (cs : Nat → Comp K V) (c : Nat) :
    ∀ (p : Prog K V), nowrites p → ∀ (s : State K V) (r : Run K V), s.ran c = some r →
    r.stopped = none →
    ∃ (seen : List (K × Option V)) (vals : List Nat) (st : Option Nat),
      (exec cs c s p).1 = { s with
        ran := put s.ran c (some { r with seen := r.seen ++ seen, values := vals, stopped := st }),
        reads := put s.reads c (s.reads c ++ seen.map (·.1)) } ∧
      (∀ q ∈ seen, s.store q.1 = q.2) ∧
      (st = none → follow p seen = some (exec cs c s p).2) ∧
      (∀ w, st = some w → (s.due w).isSome ∧ waits s w c = false ∧ w ≠ c ∧
        ∃ k, s.writers k = some w)
  | .value v, _, s, r, hr, hs => by
    refine ⟨[], r.values, none, ?_, by simp, by simp [follow, exec], by simp⟩
    have : { r with seen := r.seen ++ [], values := r.values, stopped := none } = r := by
      cases r; simp_all
    rw [this, put_self hr]
    simp only [exec, List.map_nil, List.append_nil, put_self (rfl : s.reads c = _)]
  | .error, _, s, r, hr, hs => by
    refine ⟨[], r.values, none, ?_, by simp, by simp [follow, exec], by simp⟩
    have : { r with seen := r.seen ++ [], values := r.values, stopped := none } = r := by
      cases r; simp_all
    rw [this, put_self hr]
    simp only [exec, List.map_nil, List.append_nil, put_self (rfl : s.reads c = _)]
  | .pending, _, s, r, hr, hs => by
    refine ⟨[], r.values, none, ?_, by simp, by simp [follow, exec], by simp⟩
    have : { r with seen := r.seen ++ [], values := r.values, stopped := none } = r := by
      cases r; simp_all
    rw [this, put_self hr]
    simp only [exec, List.map_nil, List.append_nil, put_self (rfl : s.reads c = _)]
  | .write .., hp, _, _, _, _ => absurd hp (by simp [nowrites])
  | .read k next, hp, s, r, hr, hs => by
    have hs1 : edit { s with reads := put s.reads c (s.reads c ++ [k]) } c
        (fun r => { r with seen := r.seen ++ [(k, s.store k)] }) =
        { s with reads := put s.reads c (s.reads c ++ [k]),
                 ran := put s.ran c (some { r with seen := r.seen ++ [(k, s.store k)] }) } := by
      simp [edit, hr]
    simp only [exec]
    rw [hs1]
    generalize hd : ({ s with reads := put s.reads c (s.reads c ++ [k]),
                              ran := put s.ran c (some { r with seen := r.seen ++ [(k, s.store k)] }) } :
        State K V) = s1
    have e1 : s1.writers = s.writers := by rw [← hd]
    have e2 : s1.due = s.due := by rw [← hd]
    have e3 : s1.after = s.after := by rw [← hd]
    have e4 : s1.made = s.made := by rw [← hd]
    have e5 : s1.store = s.store := by rw [← hd]
    have e6 : s1.ran c = some { r with seen := r.seen ++ [(k, s.store k)] } := by rw [← hd]; simp
    have hp' := fun x => (show nowrites (Prog.read k next) from hp) x
    -- the rest of the run, from s1
    have rest : ∀ (vs : List Nat) (s2 : State K V),
        s2 = { s with ran := put s.ran c (some { r with seen := r.seen ++ [(k, s.store k)], values := vs }),
                      reads := put s.reads c (s.reads c ++ [k]) } →
        ∃ seen vals st,
          (exec cs c s2 (next (s.store k))).1 = { s with
            ran := put s.ran c (some { r with seen := r.seen ++ seen, values := vals, stopped := st }),
            reads := put s.reads c (s.reads c ++ seen.map (·.1)) } ∧
          (∀ q ∈ seen, s.store q.1 = q.2) ∧
          (st = none → follow (.read k next) seen = some (exec cs c s2 (next (s.store k))).2) ∧
          (∀ w, st = some w → (s.due w).isSome ∧ waits s w c = false ∧ w ≠ c ∧
            ∃ k, s.writers k = some w) := by
      intro vs s2 hs2
      have h2 : s2.ran c = some { r with seen := r.seen ++ [(k, s.store k)], values := vs } := by
        rw [hs2]; simp
      obtain ⟨seen, vals, st, heq, hstore, hfollow, hstop⟩ :=
        exec_spec cs c (next (s.store k)) (hp' _) s2 _ h2 (by simpa using hs)
      refine ⟨(k, s.store k) :: seen, vals, st, ?_, ?_, ?_, ?_⟩
      · rw [heq, hs2]
        simp [put_put]
      · intro q hq
        rcases List.mem_cons.1 hq with rfl | hq
        · rfl
        · have := hstore q hq; rw [hs2] at this; exact this
      · intro hst
        simp [follow, hfollow hst]
      · intro w hw
        have h3 := hstop w hw
        have hwc : waits s2 w c = waits s w c := waits_congr (by rw [hs2]) (by rw [hs2]) w c
        rw [hwc] at h3
        rw [hs2] at h3
        exact h3
    have hs1' : s1 =
        { s with
          ran := put s.ran c (some { r with seen := r.seen ++ [(k, s.store k)], values := r.values }),
          reads := put s.reads c (s.reads c ++ [k]) } := by
      rw [← hd]
    cases hw : s.writers k with
    | none =>
      simp only [e1, hw]
      exact rest _ s1 hs1'
    | some w =>
      simp only [e1, hw]
      by_cases hwc : w = c
      · simp only [hwc, ite_true]
        exact rest _ s1 hs1'
      · simp only [hwc, ite_false]
        have hs2 : edit s1 c (fun r => { r with values := ins w r.values }) =
            { s with
              ran := put s.ran c (some { r with seen := r.seen ++ [(k, s.store k)],
                                                values := ins w r.values }),
              reads := put s.reads c (s.reads c ++ [k]) } := by
          rw [hs1']; simp [edit, put_put]
        rw [hs2]
        split
        · rename_i hcond
          refine ⟨[(k, s.store k)], ins w r.values, some w, ?_, ?_, ?_, ?_⟩
          · simp [edit, put_put]
          · simp
          · simp
          · intro w' hw'
            simp only [Option.some.injEq] at hw'
            subst hw'
            simp only [Bool.and_eq_true, Bool.not_eq_eq_eq_not, Bool.not_true] at hcond
            refine ⟨hcond.1.1, ?_, hwc, k, hw⟩
            rw [← hcond.1.2]
            exact (waits_ran_reads s _ _ w c).symm
        · exact rest _ _ rfl

-- marks: what a change moves, and what it leaves

-- s' is s after changes said by an unflagged run or from outside: the runs, reads, afters, acts and
-- lasts are as they were; due only grows, at made computations; looping only ends, when due;
-- writers learned have runs; a key whose value moved has its readers due (or looping)
structure Moves (s s' : State K V) : Prop where
  made : s'.made = s.made
  reads : s'.reads = s.reads
  ran : s'.ran = s.ran
  after : s'.after = s.after
  acts : s'.acts = s.acts
  last : s'.last = s.last
  due : ∀ d m, s.due d = some m → s'.due d = some m
  fresh : ∀ d, (s'.due d).isSome → (s.due d).isSome ∨ d < s.made
  looping : ∀ d, s'.looping d = true → s.looping d = true ∧ s'.due d = s.due d
  writers : ∀ k w, s'.writers k = some w → s.writers k = some w ∨ (s.ran w).isSome
  store : ∀ k, s'.store k ≠ s.store k → ∀ d, d < s.made → k ∈ s.reads d →
    (s'.due d).isSome ∨ s.looping d = true

theorem Moves.isSome {s s' : State K V} (h : Moves s s') {d : Nat} (hd : (s.due d).isSome) :
    (s'.due d).isSome := by
  obtain ⟨m, hm⟩ := Option.isSome_iff_exists.1 hd
  simp [h.due d m hm]

theorem Moves.refl (s : State K V) : Moves s s :=
  ⟨rfl, rfl, rfl, rfl, rfl, rfl, fun _ _ h => h, fun _ h => Or.inl h, fun _ h => ⟨h, rfl⟩,
    fun _ _ h => Or.inl h, fun _ h => absurd rfl h⟩

theorem Moves.trans {s s' s'' : State K V} (h1 : Moves s s') (h2 : Moves s' s'') : Moves s s'' where
  made := h2.made.trans h1.made
  reads := h2.reads.trans h1.reads
  ran := h2.ran.trans h1.ran
  after := h2.after.trans h1.after
  acts := h2.acts.trans h1.acts
  last := h2.last.trans h1.last
  due d m h := h2.due d m (h1.due d m h)
  fresh d h := by
    rcases h2.fresh d h with h | h
    · exact h1.fresh d h
    · exact Or.inr (h1.made ▸ h)
  looping d h := by
    obtain ⟨h, e⟩ := h2.looping d h
    obtain ⟨h', e'⟩ := h1.looping d h
    exact ⟨h', e.trans e'⟩
  writers k w h := by
    rcases h2.writers k w h with h | h
    · exact h1.writers k w h
    · exact Or.inr (h1.ran ▸ h)
  store k hk d hd hr := by
    by_cases e : s'.store k = s.store k
    · have hk' : s''.store k ≠ s'.store k := by rw [e]; exact hk
      rcases h2.store k hk' d (h1.made ▸ hd) (h1.reads ▸ hr) with h | h
      · exact Or.inl h
      · exact Or.inr (h1.looping d h).1
    · rcases h1.store k e d hd hr with h | h
      · exact Or.inl (h2.isSome h)
      · exact Or.inr h

-- the shapes of the small steps

theorem causeof_shape (s : State K V) (c : Nat) :
    ∃ a b g k, causeof s c = ({ s with cause := a, when := b, went := g }, k) := by
  unfold causeof
  split
  · exact ⟨s.cause, s.when, s.went, _, rfl⟩
  · exact ⟨_, _, _, _, rfl⟩

theorem keep_shape (s : State K V) (t : Nat) (k : Why) : ∃ kp, keep s t k = { s with kept := kp } := by
  unfold keep
  split
  · exact ⟨s.kept, rfl⟩
  · exact ⟨_, rfl⟩

-- a mark by an unflagged run (or from outside): moves, and leaves d due or looping
theorem mark_moves (s : State K V) (d t : Nat) (who : Option Nat) (hd : d < s.made)
    (hw : ∀ c, who = some c → ((s.ran c).bind (·.loop)) = none) :
    Moves s (mark s d t who) ∧ (((mark s d t who).due d).isSome ∨ s.looping d = true) := by
  -- settle on a state with s's runs, reads and dues, given an unflagged loop
  have key : ∀ (s1 : State K V) (who : Option Nat) (l : Option (List Nat)), s1.made = s.made →
      s1.reads = s.reads → s1.ran = s.ran → s1.after = s.after → s1.acts = s.acts →
      s1.last = s.last → s1.due = s.due → s1.looping = s.looping → s1.writers = s.writers →
      s1.store = s.store →
      Moves s (settle s1 d t who l false) ∧
        (((settle s1 d t who l false).due d).isSome ∨ s.looping d = true) := by
    intro s1 who l e1 e2 e3 e4 e5 e6 e7 e8 e9 e10
    simp only [settle, Bool.and_false, Bool.false_eq_true, ite_false]
    split
    · rename_i h
      simp only [Bool.and_eq_true] at h
      refine ⟨⟨e1, e2, e3, e4, e5, e6, ?_, ?_, ?_, ?_, ?_⟩, Or.inr (by simpa [e8] using h.1)⟩
      · intro x m hx; simpa [e7] using hx
      · intro x hx; simp [e7] at hx; exact Or.inl hx
      · intro x hx; simp [e8, e7] at hx ⊢; exact hx
      · intro k w hk; simp [e9] at hk; exact Or.inl hk
      · intro k hk; simp [e10] at hk
    · simp only [due]
      split
      · rename_i hdue
        refine ⟨⟨e1, e2, e3, e4, e5, e6, ?_, ?_, ?_, ?_, ?_⟩, Or.inl (by simpa [e7] using hdue)⟩
        · intro x m hx; simpa [e7] using hx
        · intro x hx; simp [e7] at hx; exact Or.inl hx
        · intro x hx
          by_cases hxd : x = d
          · subst hxd; simp at hx
          · simp [put_ne _ _ hxd, e8, e7] at hx ⊢; exact hx
        · intro k w hk; simp [e9] at hk; exact Or.inl hk
        · intro k hk; simp [e10] at hk
      · rename_i hdue
        refine ⟨⟨by simp [say, e1], by simp [say, e2], by simp [say, e3], by simp [say, e4],
          by simp [say, e5], by simp [say, e6], ?_, ?_, ?_, ?_, ?_⟩, Or.inl (by simp [say])⟩
        · intro x m hx
          by_cases hxd : x = d
          · subst hxd; simp [e7, hx] at hdue
          · simp [say, put_ne _ _ hxd, e7, hx]
        · intro x hx
          by_cases hxd : x = d
          · subst hxd; exact Or.inr hd
          · simp [say, put_ne _ _ hxd, e7] at hx; exact Or.inl hx
        · intro x hx
          by_cases hxd : x = d
          · subst hxd; simp [say] at hx
          · simp [say, put_ne _ _ hxd, e8, e7] at hx ⊢; exact hx
        · intro k w hk; simp [say, e9] at hk; exact Or.inl hk
        · intro k hk; simp [say, e10] at hk
  cases who with
  | none => exact key s none none rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl
  | some c =>
    simp only [mark]
    obtain ⟨a, b, g, k, hc⟩ := causeof_shape s c
    rw [hc]
    simp only []
    obtain ⟨kp, hk⟩ := keep_shape { s with cause := a, when := b, went := g } d k
    rw [hk]
    have hf : (((s.ran c).bind (·.loop)).isSome) = false := by simp [hw c rfl]
    simp only [hf]
    exact key _ _ _ rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl

theorem marks_moves (t : Nat) (r : Option Nat) :
    ∀ (ds : List Nat) (s : State K V), (∀ c, r = some c → ((s.ran c).bind (·.loop)) = none) →
    (∀ d ∈ ds, d < s.made) →
    Moves s (ds.foldl (fun s d => mark s d t r) s) ∧
      ∀ d ∈ ds, ((ds.foldl (fun s d => mark s d t r) s).due d).isSome ∨ s.looping d = true
  | [], s, _, _ => ⟨Moves.refl s, by simp⟩
  | d :: ds, s, hr, hd => by
    simp only [List.foldl_cons]
    obtain ⟨m1, h1⟩ := mark_moves s d t r (hd d (by simp)) hr
    have hr' : ∀ c, r = some c → (((mark s d t r).ran c).bind (·.loop)) = none := by
      rw [m1.ran]; exact hr
    have hd' : ∀ x ∈ ds, x < (mark s d t r).made := by
      rw [m1.made]; exact fun x hx => hd x (by simp [hx])
    obtain ⟨m2, h2⟩ := marks_moves t r ds (mark s d t r) hr' hd'
    refine ⟨m1.trans m2, ?_⟩
    intro x hx
    rcases List.mem_cons.1 hx with rfl | hx
    · rcases h1 with h1 | h1
      · exact Or.inl (m2.isSome h1)
      · exact Or.inr h1
    · rcases h2 x hx with h | h
      · exact Or.inl h
      · exact Or.inr (m1.looping x h).1

theorem tell_moves (s : State K V) (k : K) (t : Nat) (r : Option Nat)
    (hr : ∀ c, r = some c → ((s.ran c).bind (·.loop)) = none) :
    Moves s (tell s k t r) ∧
      ∀ d, d < s.made → k ∈ s.reads d → ((tell s k t r).due d).isSome ∨ s.looping d = true := by
  obtain ⟨m, h⟩ := marks_moves t r (readers s k) s hr (fun d hd => by
    simp [readers] at hd; exact hd.1)
  exact ⟨m, fun d hd hk => h d (by simp [readers, hd, hk])⟩

theorem learn_moves (s : State K V) (k : K) (w : Option Nat)
    (hw : ∀ c, w = some c → (s.ran c).isSome) : Moves s (learn s k w) := by
  cases w with
  | none => exact Moves.refl s
  | some c =>
    refine ⟨rfl, rfl, rfl, rfl, rfl, rfl, fun _ _ h => h, fun _ h => Or.inl h, fun _ h => ⟨h, rfl⟩,
      ?_, fun _ h => absurd rfl h⟩
    intro k' w' h
    by_cases hk : k' = k
    · subst hk; simp [learn] at h; subst h; exact Or.inr (hw c rfl)
    · simp [learn, put_ne _ _ hk] at h; exact Or.inl h

-- a change said by an unflagged run (or from outside): moves, and what read its keys is due or
-- looping
theorem changed_moves (cs : Nat → Comp K V) (s : State K V) (keys : List K) (who : Option Nat)
    (hw : ∀ c, who = some c → ((s.ran c).bind (·.loop)) = none) :
    Moves s (changed cs s keys who) ∧
      ∀ k ∈ keys, ∀ d, d < s.made → k ∈ s.reads d →
        ((changed cs s keys who).due d).isSome ∨ s.looping d = true := by
  simp only [changed]
  generalize ht : s.tick + 1 = t
  generalize hs0 : ({ s with tick := t } : State K V) = s0
  have m0 : Moves s s0 := by
    subst hs0
    exact ⟨rfl, rfl, rfl, rfl, rfl, rfl, fun _ _ h => h, fun _ h => Or.inl h, fun _ h => ⟨h, rfl⟩,
      fun _ _ h => Or.inl h, fun _ h => absurd rfl h⟩
  generalize hr : runof s0 who = r
  have hr1 : ∀ c, r = some c → (s.ran c).isSome ∧ ((s.ran c).bind (·.loop)) = none := by
    intro c hc
    subst hr
    simp only [runof, Option.filter_eq_some_iff] at hc
    rw [m0.ran] at hc
    exact ⟨hc.2, hw c hc.1⟩
  generalize hwr : (r.filter fun c => match (cs c).kind with
    | .compute _ => true | .effect _ => false) = w
  have hw1 : ∀ c, w = some c → r = some c := by
    intro c hc; subst hwr; exact (Option.filter_eq_some_iff.1 hc).1
  -- the fold over keys, from any state with s's runs
  have fold : ∀ (ks : List K) (s1 : State K V), s1.ran = s.ran →
      Moves s1 (ks.foldl (fun s k => tell (learn s k w) k t r) s1) ∧
      ∀ k ∈ ks, ∀ d, d < s1.made → k ∈ s1.reads d →
        ((ks.foldl (fun s k => tell (learn s k w) k t r) s1).due d).isSome ∨
          s1.looping d = true := by
    intro ks
    induction ks with
    | nil => intro s1 _; exact ⟨Moves.refl s1, by simp⟩
    | cons k ks ih =>
      intro s1 e1
      simp only [List.foldl_cons]
      have ml := learn_moves s1 k w (fun c hc => by
        rw [e1]; exact (hr1 c (hw1 c hc)).1)
      obtain ⟨mt, ht⟩ := tell_moves (learn s1 k w) k t r (fun c hc => by
        rw [ml.ran, e1]; exact (hr1 c hc).2)
      obtain ⟨mf, hf⟩ := ih _ (by rw [mt.ran, ml.ran, e1])
      refine ⟨(ml.trans mt).trans mf, ?_⟩
      intro k' hk' d hd hrd
      rcases List.mem_cons.1 hk' with rfl | hk'
      · have hd' : d < (learn s1 k' w).made := by rw [ml.made]; exact hd
        have hrd' : k' ∈ (learn s1 k' w).reads d := by rw [ml.reads]; exact hrd
        rcases ht d hd' hrd' with h | h
        · exact Or.inl (mf.isSome h)
        · exact Or.inr (ml.looping d h).1
      · have hd' : d < (tell (learn s1 k w) k t r).made := by rw [mt.made, ml.made]; exact hd
        have hrd' : k' ∈ (tell (learn s1 k w) k t r).reads d := by
          rw [mt.reads, ml.reads]; exact hrd
        rcases hf k' hk' d hd' hrd' with h | h
        · exact Or.inl h
        · exact Or.inr ((ml.trans mt).looping d h).1
  obtain ⟨mf, hf⟩ := fold keys s0 m0.ran
  refine ⟨m0.trans mf, ?_⟩
  intro k hk d hd hrd
  rcases hf k hk d (by rw [m0.made]; exact hd) (by rw [m0.reads]; exact hrd) with h | h
  · exact Or.inl h
  · exact Or.inr (m0.looping d h).1

-- a key written, then said changed by an unflagged run (or from outside): moves
theorem write_moves (cs : Nat → Comp K V) (s : State K V) (k : K) (v : V) (who : Option Nat)
    (hw : ∀ c, who = some c → ((s.ran c).bind (·.loop)) = none) :
    Moves s (changed cs (store s k v) [k] who) := by
  obtain ⟨m, h⟩ := changed_moves cs (store s k v) [k] who hw
  refine ⟨m.made, m.reads, m.ran, m.after, m.acts, m.last, m.due, m.fresh, m.looping, m.writers, ?_⟩
  intro k' hk d hd hr
  by_cases e : (changed cs (store s k v) [k] who).store k' = (store s k v).store k'
  · have hk' : k' = k := by
      refine Classical.byContradiction fun hne => ?_
      rw [e] at hk
      simp [store, put_ne _ _ hne] at hk
    subst hk'
    exact h k' (by simp) d hd hr
  · exact m.store k' e d hd hr

-- writes, each said changed by an unflagged e
theorem writes_moves (cs : Nat → Comp K V) (e : Nat) :
    ∀ (ws : List (K × V)) (s : State K V), ((s.ran e).bind (·.loop)) = none →
      Moves s (ws.foldl (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some e)) s)
  | [], s, _ => Moves.refl s
  | kv :: ws, s, h => by
    simp only [List.foldl_cons]
    have m := write_moves cs s kv.1 kv.2 (some e) (fun c hc => by cases hc; exact h)
    exact m.trans (writes_moves cs e ws _ (by rw [m.ran]; exact h))

-- the invariant

-- an effect
def iseffect (c : Comp K V) : Bool :=
  match c.kind with
  | .effect _ => true
  | .compute _ => false

-- v is the last, or equal to it
def near (eq : V → V → Option Bool) (v : V) (l : Option V) : Prop :=
  ∃ x, l = some x ∧ (x = v ∨ eq v x = some true)

-- a run that ended done, failed or pending: the store should still give it
def settled (r : Run K V) : Prop :=
  r.ended = some .done ∨ r.ended = some .failed ∨ r.ended = some .pending

-- what holds of every state the host and the pulses reach (A2): of the order, the runs and reads
structure Core (cs : Nat → Comp K V) (s : State K V) : Prop where
  -- Lemma N: a computation waits after one only while due, and after-chains have no cycle
  after_due : ∀ x w, s.after x = some w → (s.due x).isSome ∧ w < s.made
  acyclic : ∀ x, ¬TransGen (aft s) x x
  due_made : ∀ x, (s.due x).isSome → x < s.made
  writers_made : ∀ k w, s.writers k = some w → w < s.made
  ran_made : ∀ c, (s.ran c).isSome → c < s.made
  -- the tracker holds the keys the latest run read
  reads : ∀ c, s.reads c = ((s.ran c).map fun r => r.seen.map (·.1)).getD []
  -- a run not stopped read along f to what it gave
  follows : ∀ c r, s.ran c = some r → r.ended ≠ some .stopped →
    ∃ o, r.out = some o ∧ follow (cs c).f r.seen = some o
  -- Lemma F: not due, done, failed or pending: what it read is still there
  fresh : ∀ c r, s.ran c = some r → s.due c = none → settled r → ∀ q ∈ r.seen, s.store q.1 = q.2
  looping : ∀ c, s.looping c = true → s.due c = none ∧ ∃ r, s.ran c = some r ∧
    r.ended = some .looping
  pending : ∀ c r, s.ran c = some r → r.ended = some .pending → r.out = some .pending

-- and of the acts and lasts
structure Good (cs : Nat → Comp K V) (s : State K V) : Prop extends Core cs s where
  -- an act queued: its effect's latest run, unflagged, done with that value
  acts : ∀ e v, (e, v) ∈ s.acts → iseffect (cs e) = true ∧ ∃ r, s.ran e = some r ∧
    r.loop = none ∧ r.ended = some .done ∧ r.out = some (.value v)
  -- a compute done: its last is its value, or equal to it
  computes : ∀ c r, iseffect (cs c) = false → s.ran c = some r → r.ended = some .done →
    ∃ v, r.out = some (.value v) ∧ near (cs c).equal v (s.last c)
  -- an effect done: acted on (or equal), or its act queued, or due again
  effects : ∀ e r, iseffect (cs e) = true → s.ran e = some r → r.ended = some .done →
    ∃ v, r.out = some (.value v) ∧
      (near (cs e).equal v (s.last e) ∨ (e, v) ∈ s.acts ∨ (s.due e).isSome)
  -- failed: f threw, or equal threw on its value against the last
  failed : ∀ c r, s.ran c = some r → r.ended = some .failed →
    r.out = some .error ∨ ∃ v, r.out = some (.value v) ∧ same (cs c).equal v (s.last c) = none

theorem Core.moves {cs : Nat → Comp K V} {s s' : State K V} (g : Core cs s) (m : Moves s s') :
    Core cs s' where
  after_due x w h := by
    rw [m.after] at h
    obtain ⟨h1, h2⟩ := g.after_due x w h
    exact ⟨m.isSome h1, m.made ▸ h2⟩
  acyclic x h := by
    have e : aft s' = aft s := by funext a b; simp [aft, m.after]
    exact g.acyclic x (e ▸ h)
  due_made x h := by
    rcases m.fresh x h with h | h
    · exact m.made ▸ g.due_made x h
    · exact m.made ▸ h
  writers_made k w h := by
    rcases m.writers k w h with h | h
    · exact m.made ▸ g.writers_made k w h
    · exact m.made ▸ g.ran_made w h
  ran_made c h := m.made ▸ g.ran_made c (m.ran ▸ h)
  reads c := by rw [m.reads, m.ran]; exact g.reads c
  follows c r h := g.follows c r (m.ran ▸ h)
  fresh c r h hd hs q hq := by
    have h' : s.ran c = some r := m.ran ▸ h
    have hd' : s.due c = none := by
      cases e : s.due c with
      | none => rfl
      | some x => rw [m.due c x e] at hd; simp at hd
    by_cases e : s'.store q.1 = s.store q.1
    · rw [e]; exact g.fresh c r h' hd' hs q hq
    · exfalso
      have hc : c < s.made := g.ran_made c (by simp [h'])
      have hr : q.1 ∈ s.reads c := by
        rw [g.reads c, h']; simp only [Option.map_some, Option.getD_some]
        exact List.mem_map_of_mem hq
      rcases m.store q.1 e c hc hr with h1 | h1
      · simp [hd] at h1
      · obtain ⟨_, r', h2, h3⟩ := g.looping c h1
        rw [h'] at h2; cases h2
        rcases hs with h4 | h4 | h4 <;> rw [h4] at h3 <;> cases h3
  looping c h := by
    obtain ⟨h1, e⟩ := m.looping c h
    obtain ⟨h2, r, h3, h4⟩ := g.looping c h1
    exact ⟨e.trans h2, r, m.ran ▸ h3, h4⟩
  pending c r h := g.pending c r (m.ran ▸ h)

theorem Good.moves {cs : Nat → Comp K V} {s s' : State K V} (g : Good cs s) (m : Moves s s') :
    Good cs s' where
  toCore := g.toCore.moves m
  acts e v h := by
    rw [m.acts] at h
    obtain ⟨h1, r, h2⟩ := g.acts e v h
    exact ⟨h1, r, m.ran ▸ h2⟩
  computes c r hc h hd := by
    obtain ⟨v, h1, h2⟩ := g.computes c r hc (m.ran ▸ h) hd
    exact ⟨v, h1, m.last ▸ h2⟩
  effects e r he h hd := by
    obtain ⟨v, h1, h2⟩ := g.effects e r he (m.ran ▸ h) hd
    refine ⟨v, h1, ?_⟩
    rcases h2 with h2 | h2 | h2
    · exact Or.inl (m.last ▸ h2)
    · exact Or.inr (Or.inl (m.acts ▸ h2))
    · exact Or.inr (Or.inr (m.isSome h2))
  failed c r h hf := m.last ▸ g.failed c r (m.ran ▸ h) hf

-- a state with the same everything the invariant reads
theorem Moves.of_eq {s s' : State K V} (e1 : s'.store = s.store) (e2 : s'.made = s.made)
    (e3 : s'.reads = s.reads) (e4 : s'.writers = s.writers) (e5 : s'.after = s.after)
    (e6 : s'.due = s.due) (e7 : s'.ran = s.ran) (e8 : s'.looping = s.looping)
    (e9 : s'.acts = s.acts) (e10 : s'.last = s.last) : Moves s s' :=
  ⟨e2, e3, e7, e5, e9, e10, fun _ _ h => e6 ▸ h, fun _ h => Or.inl (e6 ▸ h),
    fun _ h => ⟨e8 ▸ h, e6 ▸ rfl⟩, fun _ _ h => Or.inl (e4 ▸ h), fun _ h => absurd (e1 ▸ rfl) h⟩

-- the host

theorem Good.empty (cs : Nat → Comp K V) : Good cs (empty : State K V) where
  after_due x w h := by simp [Model.empty] at h
  acyclic x h := by
    obtain ⟨z, hz, _⟩ := tg_head h
    simp [aft, Model.empty] at hz
  due_made x h := by simp [Model.empty] at h
  writers_made k w h := by simp [Model.empty] at h
  ran_made c h := by simp [Model.empty] at h
  reads c := by simp [Model.empty]
  follows c r h := by simp [Model.empty] at h
  fresh c r h := by simp [Model.empty] at h
  looping c h := by simp [Model.empty] at h
  pending c r h := by simp [Model.empty] at h
  acts e v h := by simp [Model.empty] at h
  computes c r _ h := by simp [Model.empty] at h
  effects e r _ h := by simp [Model.empty] at h
  failed c r h := by simp [Model.empty] at h

theorem Good.begin {cs : Nat → Comp K V} {s : State K V} (g : Good cs s) : Good cs (begin s) :=
  g.moves (Moves.of_eq rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl)

theorem Good.close {cs : Nat → Comp K V} {s : State K V} (g : Good cs s) : Good cs (close s) :=
  g.moves (Moves.of_eq rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl)

theorem Good.tell {cs : Nat → Comp K V} {s : State K V} (g : Good cs s) (keys : List K) :
    Good cs (changed cs s keys none) :=
  g.moves (changed_moves cs s keys none (by simp)).1

theorem stores_shape (s : State K V) :
    ∀ (kvs : List (K × V)), ∃ st, kvs.foldl (fun s kv => store s kv.1 kv.2) s = { s with store := st } ∧
      ∀ k, st k ≠ s.store k → k ∈ kvs.map (·.1)
  | [] => ⟨s.store, rfl, fun _ h => absurd rfl h⟩
  | kv :: kvs => by
    obtain ⟨st, h1, h2⟩ := stores_shape (store s kv.1 kv.2) kvs
    refine ⟨st, by simp only [List.foldl_cons, h1]; rfl, ?_⟩
    intro k hk
    by_cases e : st k = (store s kv.1 kv.2).store k
    · rw [e] at hk
      by_cases hkv : k = kv.1
      · simp [hkv]
      · simp [store, put_ne _ _ hkv] at hk
    · exact List.mem_cons_of_mem _ (h2 k e)

theorem Good.write {cs : Nat → Comp K V} {s : State K V} (g : Good cs s) (kvs : List (K × V)) :
    Good cs (write cs s kvs) := by
  obtain ⟨st, h1, h2⟩ := stores_shape s kvs
  simp only [Model.write, h1]
  obtain ⟨m, h⟩ := changed_moves cs { s with store := st } (kvs.map (·.1)) none (by simp)
  refine g.moves ⟨m.made, m.reads, m.ran, m.after, m.acts, m.last, m.due, m.fresh, m.looping,
    m.writers, ?_⟩
  intro k hk d hd hr
  by_cases e : (changed cs { s with store := st } (kvs.map (·.1)) none).store k = st k
  · rw [e] at hk
    exact h k (h2 k hk) d hd hr
  · exact m.store k e d hd hr

theorem Good.make {cs : Nat → Comp K V} {s : State K V} (g : Good cs s) : Good cs (make cs s) := by
  simp only [Model.make]
  -- made grows by one; the new one may be a key's writer
  have g1 : Good cs { (match (cs s.made).key with
      | some k => { s with made := s.made + 1, writers := put s.writers k (some s.made) }
      | none => { s with made := s.made + 1 }) with tick :=
      (match (cs s.made).key with
      | some k => { s with made := s.made + 1, writers := put s.writers k (some s.made) }
      | none => { s with made := s.made + 1 }).tick + 1 } := by
    have core : ∀ (s' : State K V), s'.made = s.made + 1 → s'.store = s.store → s'.reads = s.reads →
        s'.after = s.after → s'.due = s.due → s'.ran = s.ran → s'.looping = s.looping →
        s'.acts = s.acts → s'.last = s.last → (∀ k w, s'.writers k = some w → w < s.made + 1) →
        Good cs s' := by
      intro s' e1 e2 e3 e4 e5 e6 e7 e8 e9 e10
      exact {
        after_due := fun x w h => by
          rw [e4] at h; obtain ⟨h1, h2⟩ := g.after_due x w h
          exact ⟨e5 ▸ h1, by omega⟩
        acyclic := fun x h => by
          have e : aft s' = aft s := by funext a b; simp [aft, e4]
          exact g.acyclic x (e ▸ h)
        due_made := fun x h => by have := g.due_made x (e5 ▸ h); omega
        writers_made := fun k w h => by rw [e1]; exact e10 k w h
        ran_made := fun c h => by have := g.ran_made c (e6 ▸ h); omega
        reads := fun c => by rw [e3, e6]; exact g.reads c
        follows := fun c r h => g.follows c r (e6 ▸ h)
        fresh := fun c r h hd hs => by rw [e2]; exact g.fresh c r (e6 ▸ h) (e5 ▸ hd) hs
        looping := fun c h => by
          obtain ⟨h1, r, h2, h3⟩ := g.looping c (e7 ▸ h)
          exact ⟨e5 ▸ h1, r, e6 ▸ h2, h3⟩
        pending := fun c r h => g.pending c r (e6 ▸ h)
        acts := fun e v h => by
          obtain ⟨h1, r, h2⟩ := g.acts e v (e8 ▸ h)
          exact ⟨h1, r, e6 ▸ h2⟩
        computes := fun c r hc h hd => by
          obtain ⟨v, h1, h2⟩ := g.computes c r hc (e6 ▸ h) hd
          exact ⟨v, h1, e9 ▸ h2⟩
        effects := fun e r he h hd => by
          obtain ⟨v, h1, h2⟩ := g.effects e r he (e6 ▸ h) hd
          exact ⟨v, h1, e9 ▸ e8 ▸ e5 ▸ h2⟩
        failed := fun c r h hf => e9 ▸ g.failed c r (e6 ▸ h) hf }
    cases hk : (cs s.made).key with
    | none =>
      exact core _ rfl rfl rfl rfl rfl rfl rfl rfl rfl (fun k w h => by
        have := g.writers_made k w h; omega)
    | some k =>
      refine core _ rfl rfl rfl rfl rfl rfl rfl rfl rfl (fun k' w h => ?_)
      by_cases e : k' = k
      · subst e; simp at h; omega
      · simp [put_ne _ _ e] at h; have := g.writers_made k' w h; omega
  exact g1.moves (mark_moves _ s.made _ none (by cases (cs s.made).key <;> simp) (by simp)).1

-- the core does not read acts, lasts or the log
theorem Core.with {cs : Nat → Comp K V} {s : State K V} (g : Core cs s) (a : List (Nat × V))
    (l : Nat → Option V) (lg : List (Entry V)) : Core cs { s with acts := a, last := l, log := lg } :=
  ⟨g.1, g.2, g.3, g.4, g.5, g.6, g.7, g.8, g.9, g.10⟩

-- an act: its effect not due, it acts on its run's value; due, it is skipped
theorem Good.act {cs : Nat → Comp K V} {s : State K V} (g : Good cs s) {e : Nat} {v : V}
    {rest : List (Nat × V)} (hs : s.acts = (e, v) :: rest) :
    Good cs (act cs { s with acts := rest } e v) := by
  obtain ⟨he, r0, hr0, hl0, hd0, ho0⟩ := g.acts e v (by simp [hs])
  have hrest : ∀ x, x ∈ rest → x ∈ s.acts := fun x hx => by simp [hs, hx]
  -- the effects other than e, and e when due, in a state whose acts are rest
  simp only [Model.act]
  split
  · rename_i hdue
    exact {
      toCore := g.toCore.with rest s.last s.log
      acts := fun e' v' h => g.acts e' v' (hrest _ h)
      computes := fun c r hc h hd => g.computes c r hc h hd
      effects := fun e' r he' h hd => by
        obtain ⟨v', h1, h2⟩ := g.effects e' r he' h hd
        refine ⟨v', h1, ?_⟩
        by_cases ee : e' = e
        · subst ee; exact Or.inr (Or.inr hdue)
        · rcases h2 with h2 | h2 | h2
          · exact Or.inl h2
          · rw [hs] at h2
            rcases List.mem_cons.1 h2 with h2 | h2
            · cases h2; exact absurd rfl ee
            · exact Or.inr (Or.inl h2)
          · exact Or.inr (Or.inr h2)
      failed := fun c r h hf => g.failed c r h hf }
  · rename_i hdue
    have hk : ∃ g', (cs e).kind = .effect g' := by
      simp only [iseffect] at he; split at he
      · exact ⟨_, ‹_›⟩
      · cases he
    obtain ⟨act', hk⟩ := hk
    simp only [hk]
    generalize hs1 : say { s with acts := rest } (.act e v (s.last e)) = s1
    have c1 : Core cs s1 := by rw [← hs1]; exact g.toCore.with rest s.last _
    have e1 : s1.ran = s.ran := by rw [← hs1]; rfl
    have e2 : s1.acts = rest := by rw [← hs1]; rfl
    have e3 : s1.last = s.last := by rw [← hs1]; rfl
    have e4 : s1.due = s.due := by rw [← hs1]; rfl
    have m := writes_moves cs e (act' v (s.last e)) s1 (by rw [e1, hr0]; simp [hl0])
    generalize hs2 : (act' v (s.last e)).foldl
      (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some e)) s1 = s2 at m
    have c2 := c1.moves m
    exact {
      toCore := c2.with _ _ _
      acts := fun e' v' h => by
        have h' : (e', v') ∈ rest := by simpa [say, m.acts, e2] using h
        obtain ⟨h1, r, h2⟩ := g.acts e' v' (hrest _ h')
        exact ⟨h1, r, by simpa [say, m.ran, e1] using h2⟩
      computes := fun c r hc h hd => by
        have hce : c ≠ e := by intro ce; subst ce; rw [he] at hc; cases hc
        obtain ⟨v', h1, h2⟩ := g.computes c r hc (by simpa [say, m.ran, e1] using h) hd
        exact ⟨v', h1, by simpa [say, put_ne _ _ hce, m.last, e3] using h2⟩
      effects := fun e' r he' h hd => by
        have h' : s.ran e' = some r := by simpa [say, m.ran, e1] using h
        obtain ⟨v', h1, h2⟩ := g.effects e' r he' h' hd
        refine ⟨v', h1, ?_⟩
        by_cases ee : e' = e
        · subst ee
          rw [hr0] at h'; cases h'
          rw [ho0] at h1; cases h1
          exact Or.inl ⟨v, by simp [say], Or.inl rfl⟩
        · rcases h2 with h2 | h2 | h2
          · exact Or.inl (by simpa [say, put_ne _ _ ee, m.last, e3] using h2)
          · rw [hs] at h2
            rcases List.mem_cons.1 h2 with h2 | h2
            · cases h2; exact absurd rfl ee
            · exact Or.inr (Or.inl (by simpa [say, m.acts, e2] using h2))
          · exact Or.inr (Or.inr (by
              have := m.isSome (show (s1.due e').isSome from by rw [e4]; exact h2)
              simpa [say] using this))
      failed := fun c r h hf => by
        have h' : s.ran c = some r := by simpa [say, m.ran, e1] using h
        have hce : c ≠ e := by
          intro ce; subst ce; rw [hr0] at h'; cases h'; rw [hd0] at hf; cases hf
        have := g.failed c r h' hf
        simpa [say, put_ne _ _ hce, m.last, e3] using this }

-- runs

-- c's new run, as it is at f's end
def begun (s : State K V) (c : Nat) (vals : List Nat) (st : Option Nat)
    (seen : List (K × Option V)) : Run K V :=
  { n := s.runs c + 1, mark := (s.due c).getD 0, given := s.kept c, loop := s.loop c,
    values := vals, stopped := st, seen := seen }

-- a run, A2: start, f read along the store, the end; what the state is when it is told how f ended
theorem first_spec (cs : Nat → Comp K V) (s : State K V) (c rk : Nat) (hp : nowrites (cs c).f) :
    ∃ (s3 : State K V) (o : Out V) (seen : List (K × Option V)) (vals : List Nat)
      (st : Option Nat),
      first cs s c rk = ending cs s3 c o ∧
      s3.ran = put s.ran c (some (begun s c vals st seen)) ∧
      s3.reads = put s.reads c (seen.map (·.1)) ∧
      s3.store = s.store ∧ s3.made = s.made ∧ s3.writers = s.writers ∧ s3.last = s.last ∧
      s3.looping = s.looping ∧ s3.due = put s.due c none ∧ s3.after = put s.after c none ∧
      s3.acts = s.acts.filter (fun a => a.1 ≠ c) ∧ s3.cut c = false ∧
      (∀ q ∈ seen, s.store q.1 = q.2) ∧
      (st = none → follow (cs c).f seen = some o) ∧
      (∀ w, st = some w → (s.due w).isSome ∧ waits (start s c rk) w c = false ∧ w ≠ c ∧
        ∃ k, s.writers k = some w) := by
  have h0 : (start s c rk).ran c = some (begun s c [] none []) := by simp [start, say, begun]
  obtain ⟨seen, vals, st, heq, hst, hfo, hstop⟩ :=
    exec_spec cs c (cs c).f hp (start s c rk) _ h0 rfl
  simp only [first]
  generalize hx : exec cs c (start s c rk) (cs c).f = x at heq hfo
  obtain ⟨s2, o⟩ := x
  simp only at heq hfo
  subst heq
  refine ⟨_, o, seen, vals, st, rfl, ?_, ?_, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl,
    by simp [start, say], hst, hfo, ?_⟩
  · simp [start, say, put_put, begun]
  · simp [start, say, put_put, begun]
  · intro w hw
    obtain ⟨h1, h2, h3, h4⟩ := hstop w hw
    refine ⟨?_, h2, h3, h4⟩
    simpa [start, say, put_ne _ _ h3] using h1

-- what a run of c leaves, F from s, its record rf: enough for the invariant
structure Post (cs : Nat → Comp K V) (s : State K V) (c rk : Nat) (F : State K V) (rf : Run K V) :
    Prop where
  made : F.made = s.made
  ran_c : F.ran c = some rf
  ran : ∀ d, d ≠ c → F.ran d = s.ran d
  reads : F.reads = put s.reads c (rf.seen.map (·.1))
  after : F.after = put s.after c none ∨ ∃ w, F.after = put s.after c (some w) ∧
    waits (start s c rk) w c = false ∧ w ≠ c ∧ w < s.made ∧ (F.due c).isSome
  due : ∀ d m, d ≠ c → s.due d = some m → F.due d = some m
  fresh : ∀ d, (F.due d).isSome → (s.due d).isSome ∨ d < s.made
  looping : ∀ d, d ≠ c → F.looping d = true → s.looping d = true ∧ F.due d = s.due d
  looping_c : F.looping c = true → F.due c = none ∧ rf.ended = some .looping
  writers : ∀ k w, F.writers k = some w → s.writers k = some w ∨ (s.ran w).isSome ∨ w = c
  store : ∀ k, F.store k ≠ s.store k → ∀ d, d < s.made → d ≠ c → k ∈ s.reads d →
    (F.due d).isSome ∨ s.looping d = true
  follows : rf.ended ≠ some .stopped → ∃ o, rf.out = some o ∧ follow (cs c).f rf.seen = some o
  fresh_c : F.due c = none → settled rf → ∀ q ∈ rf.seen, F.store q.1 = q.2
  pending : rf.ended = some .pending → rf.out = some .pending
  acts : ∀ e v, (e, v) ∈ F.acts → (e ≠ c ∧ (e, v) ∈ s.acts) ∨
    (e = c ∧ iseffect (cs c) = true ∧ rf.loop = none ∧ rf.ended = some .done ∧
      rf.out = some (.value v))
  acts_keep : ∀ e v, e ≠ c → (e, v) ∈ s.acts → (e, v) ∈ F.acts
  last : ∀ d, d ≠ c → F.last d = s.last d
  computes : iseffect (cs c) = false → rf.ended = some .done →
    ∃ v, rf.out = some (.value v) ∧ near (cs c).equal v (F.last c)
  effects : iseffect (cs c) = true → rf.ended = some .done →
    ∃ v, rf.out = some (.value v) ∧
      (near (cs c).equal v (F.last c) ∨ (c, v) ∈ F.acts ∨ (F.due c).isSome)
  failed : rf.ended = some .failed →
    rf.out = some .error ∨ ∃ v, rf.out = some (.value v) ∧ same (cs c).equal v (F.last c) = none

theorem Good.post {cs : Nat → Comp K V} {s F : State K V} {c rk : Nat} {rf : Run K V}
    (g : Good cs s) (hc : (s.due c).isSome) (p : Post cs s c rk F rf) : Good cs F := by
  have hcm : c < s.made := g.due_made c hc
  have hd' : ∀ d, d ≠ c → F.due d = none → s.due d = none := by
    intro d hd h
    cases e : s.due d with
    | none => rfl
    | some m => rw [p.due d m hd e] at h; cases h
  exact {
    after_due := fun x w h => by
      by_cases hx : x = c
      · subst hx
        rcases p.after with e | ⟨w', e, _, _, h3, h4⟩
        · rw [e] at h; simp at h
        · rw [e] at h; simp at h; subst h; exact ⟨h4, p.made ▸ h3⟩
      · have h' : s.after x = some w := by
          rcases p.after with e | ⟨w', e, _⟩ <;> (rw [e, put_ne _ _ hx] at h; exact h)
        obtain ⟨h1, h2⟩ := g.after_due x w h'
        obtain ⟨m, hm⟩ := Option.isSome_iff_exists.1 h1
        exact ⟨by simp [p.due x m hx hm], p.made ▸ h2⟩
    acyclic := fun x h => by
      -- the afters with c's cleared: s's, less one
      have sub : ∀ a b, TransGen (fun x y => put s.after c none x = some y) a b →
          TransGen (aft s) a b := by
        intro a b h
        refine tg_mono (fun x y hxy => ?_) h
        by_cases hx : x = c
        · subst hx; simp at hxy
        · simp [put_ne _ _ hx] at hxy; exact hxy
      rcases p.after with e | ⟨w, e, hw1, hw2, hw3, _⟩
      · have e' : aft F = fun x y => put s.after c none x = some y := by
          funext a b; simp [aft, e]
        exact g.acyclic x (sub x x (e' ▸ h))
      · have e' : aft F = fun x y => put (put s.after c none) c (some w) x = some y := by
          funext a b; simp [aft, e, put_put]
        rw [e'] at h
        rcases tg_put (by simp) h with h | ⟨h1, h2⟩
        · exact g.acyclic x (sub x x h)
        · -- then w reaches c with c's after cleared: waitsAfter would have said so
          have hwc : TransGen (fun x y => put s.after c none x = some y) w c := by
            rcases h1 with rfl | h1 <;> rcases h2 with h2 | h2
            · exact absurd h2 hw2
            · exact h2
            · subst h2; exact h1
            · exact TransGen.trans h2 h1
          have ea : aft (start s c rk) = fun x y => put s.after c none x = some y := by
            funext a b; simp [aft, start, say]
          have hst : waits (start s c rk) w c = true := by
            refine waits_of_tg ?_ ?_ (by simpa [start, say] using hw3) ?_
            · intro y hy
              rw [ea] at hy
              exact g.acyclic y (sub y y hy)
            · intro a b hab
              have : put s.after c none a = some b := by simpa [start, say] using hab
              by_cases ha : a = c
              · subst ha; simp at this
              · rw [put_ne _ _ ha] at this
                simpa [start, say] using (g.after_due a b this).2
            · rw [ea]; exact hwc
          rw [hw1] at hst; cases hst
    due_made := fun x h => by
      rcases p.fresh x h with h | h
      · exact p.made ▸ g.due_made x h
      · exact p.made ▸ h
    writers_made := fun k w h => by
      rcases p.writers k w h with h | h | h
      · exact p.made ▸ g.writers_made k w h
      · exact p.made ▸ g.ran_made w h
      · exact p.made ▸ (h ▸ hcm)
    ran_made := fun d h => by
      by_cases hd : d = c
      · exact p.made ▸ (hd ▸ hcm)
      · exact p.made ▸ g.ran_made d (p.ran d hd ▸ h)
    reads := fun d => by
      by_cases hd : d = c
      · subst hd; simp [p.reads, p.ran_c]
      · rw [p.reads, put_ne _ _ hd, p.ran d hd]; exact g.reads d
    follows := fun d r h hs => by
      by_cases hd : d = c
      · subst hd; rw [p.ran_c] at h; cases h; exact p.follows hs
      · exact g.follows d r (p.ran d hd ▸ h) hs
    fresh := fun d r h hdue hs q hq => by
      by_cases hd : d = c
      · subst hd; rw [p.ran_c] at h; cases h; exact p.fresh_c hdue hs q hq
      · have h' : s.ran d = some r := p.ran d hd ▸ h
        by_cases e : F.store q.1 = s.store q.1
        · rw [e]; exact g.fresh d r h' (hd' d hd hdue) hs q hq
        · exfalso
          have hr : q.1 ∈ s.reads d := by
            rw [g.reads d, h']; simp only [Option.map_some, Option.getD_some]
            exact List.mem_map_of_mem hq
          rcases p.store q.1 e d (g.ran_made d (by simp [h'])) hd hr with h1 | h1
          · simp [hdue] at h1
          · obtain ⟨_, r', h2, h3⟩ := g.looping d h1
            rw [h'] at h2; cases h2
            rcases hs with h4 | h4 | h4 <;> rw [h4] at h3 <;> cases h3
    looping := fun d h => by
      by_cases hd : d = c
      · subst hd; obtain ⟨h1, h2⟩ := p.looping_c h; exact ⟨h1, rf, p.ran_c, h2⟩
      · obtain ⟨h1, e⟩ := p.looping d hd h
        obtain ⟨h2, r, h3, h4⟩ := g.looping d h1
        exact ⟨e.trans h2, r, (p.ran d hd).trans h3, h4⟩
    pending := fun d r h hp => by
      by_cases hd : d = c
      · subst hd; rw [p.ran_c] at h; cases h; exact p.pending hp
      · exact g.pending d r (p.ran d hd ▸ h) hp
    acts := fun e v h => by
      rcases p.acts e v h with ⟨h1, h2⟩ | ⟨h1, h2, h3⟩
      · obtain ⟨h3, r, h4⟩ := g.acts e v h2
        exact ⟨h3, r, (p.ran e h1).trans h4.1, h4.2⟩
      · subst h1; exact ⟨h2, rf, p.ran_c, h3⟩
    computes := fun d r hcd h hdone => by
      by_cases hd : d = c
      · subst hd; rw [p.ran_c] at h; cases h; exact p.computes hcd hdone
      · obtain ⟨v, h1, h2⟩ := g.computes d r hcd (p.ran d hd ▸ h) hdone
        exact ⟨v, h1, (p.last d hd).symm ▸ h2⟩
    effects := fun e r he h hdone => by
      by_cases hd : e = c
      · subst hd; rw [p.ran_c] at h; cases h; exact p.effects he hdone
      · obtain ⟨v, h1, h2⟩ := g.effects e r he (p.ran e hd ▸ h) hdone
        refine ⟨v, h1, ?_⟩
        rcases h2 with h2 | h2 | h2
        · exact Or.inl ((p.last e hd).symm ▸ h2)
        · exact Or.inr (Or.inl (p.acts_keep e v hd h2))
        · obtain ⟨m, hm⟩ := Option.isSome_iff_exists.1 h2
          exact Or.inr (Or.inr (by simp [p.due e m hd hm]))
    failed := fun d r h hf => by
      by_cases hd : d = c
      · subst hd; rw [p.ran_c] at h; cases h; exact p.failed hf
      · exact (p.last d hd).symm ▸ g.failed d r (p.ran d hd ▸ h) hf }

theorem finish_eq (s : State K V) (c : Nat) (r : Run K V) (h : s.ran c = some r) (e : Ended)
    (eq : Option Bool) (w : Option Nat) (th : Option (List Nat)) :
    finish s c e eq w th = { s with
      kept := if e = .done then
          put s.kept c ((s.kept c).filter fun k => !(r.given.any fun g => g.of == k.of))
        else s.kept,
      looping := if e = .looping then put s.looping c true else s.looping,
      values := if e ≠ .stopped then put s.values c r.values else s.values,
      ran := put s.ran c (some { r with ended := some e }),
      log := s.log ++ [⟨s.pulses, s.round, .ends c r.n e eq w th⟩] } := by
  cases e <;> simp [finish, h, say]

theorem stop_eq (s : State K V) (c : Nat) (r : Run K V) (h : s.ran c = some r)
    (hd : s.due c = none) :
    stop s c =
      { s with
        loop := put s.loop c r.loop, after := put s.after c r.stopped,
        due := put s.due c (some r.mark), ran := put s.ran c (some { r with ended := some .stopped }),
        log := s.log ++ [⟨s.pulses, s.round, .ends c r.n .stopped none r.stopped none⟩] } := by
  simp [stop, h, hd, finish, say]

theorem say_moves (s : State K V) (e : Event V) : Moves s (say s e) :=
  Moves.of_eq rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl

theorem set_moves (cs : Nat → Comp K V) (s : State K V) (c : Nat) (v : V)
    (h : ((s.ran c).bind (·.loop)) = none) : Moves s (set cs s c v) := by
  have m := say_moves s (.set c v)
  simp only [set]
  split
  · exact m.trans (write_moves cs _ _ _ (some c) (fun c' hc => by cases hc; rw [m.ran]; exact h))
  · exact m

-- a run's end that leaves the store, the dues (c not due) and the afters (c after nothing)
theorem post_plain {cs : Nat → Comp K V} {s F : State K V} {c rk : Nat} {rf : Run K V}
    (hm : F.made = s.made) (hr : F.ran = put s.ran c (some rf))
    (hreads : F.reads = put s.reads c (rf.seen.map (·.1))) (ha : F.after = put s.after c none)
    (hd : F.due = put s.due c none) (hst : F.store = s.store) (hw : F.writers = s.writers)
    (hl : ∀ d, d ≠ c → F.looping d = s.looping d)
    (hlc : F.looping c = true → rf.ended = some .looping)
    (hlast : ∀ d, d ≠ c → F.last d = s.last d)
    (X : List (Nat × V)) (hacts : F.acts = s.acts.filter (fun a => a.1 ≠ c) ++ X)
    (hX : ∀ x ∈ X, x.1 = c ∧ iseffect (cs c) = true ∧ rf.loop = none ∧ rf.ended = some .done ∧
      rf.out = some (.value x.2))
    (hseen : ∀ q ∈ rf.seen, s.store q.1 = q.2)
    (hfol : rf.ended ≠ some .stopped → ∃ o, rf.out = some o ∧ follow (cs c).f rf.seen = some o)
    (hpend : rf.ended = some .pending → rf.out = some .pending)
    (hcomp : iseffect (cs c) = false → rf.ended = some .done →
      ∃ v, rf.out = some (.value v) ∧ near (cs c).equal v (F.last c))
    (heff : iseffect (cs c) = true → rf.ended = some .done →
      ∃ v, rf.out = some (.value v) ∧
        (near (cs c).equal v (F.last c) ∨ (c, v) ∈ F.acts ∨ (F.due c).isSome))
    (hfail : rf.ended = some .failed →
      rf.out = some .error ∨ ∃ v, rf.out = some (.value v) ∧ same (cs c).equal v (F.last c) = none) :
    Post cs s c rk F rf where
  made := hm
  ran_c := by rw [hr]; simp
  ran d hd := by rw [hr, put_ne _ _ hd]
  reads := hreads
  after := Or.inl ha
  due d m hdc h := by rw [hd, put_ne _ _ hdc]; exact h
  fresh d h := by
    by_cases hdc : d = c
    · subst hdc; rw [hd] at h; simp at h
    · rw [hd, put_ne _ _ hdc] at h; exact Or.inl h
  looping d hdc h := by
    rw [hl d hdc] at h
    exact ⟨h, by rw [hd, put_ne _ _ hdc]⟩
  looping_c h := ⟨by rw [hd]; simp, hlc h⟩
  writers k w h := Or.inl (hw ▸ h)
  store k h := absurd (hst ▸ rfl) h
  follows := hfol
  fresh_c _ _ q hq := by rw [hst]; exact hseen q hq
  pending := hpend
  acts e v h := by
    rw [hacts] at h
    rcases List.mem_append.1 h with h | h
    · simp only [List.mem_filter, decide_eq_true_eq] at h
      exact Or.inl ⟨h.2, h.1⟩
    · obtain ⟨h1, h2⟩ := hX _ h
      exact Or.inr ⟨h1, h2⟩
  acts_keep e v hec h := by
    rw [hacts]; exact List.mem_append_left _ (by simp [h, hec])
  last := hlast
  computes := hcomp
  effects := heff
  failed := hfail

theorem near_of_same {eq : V → V → Option Bool} {v : V} {l : Option V}
    (h : same eq v l = some true) : near eq v l := by
  cases l with
  | none => simp [same] at h
  | some x => exact ⟨x, rfl, Or.inr h⟩

-- a run step keeps the invariant (A2)
theorem Good.first {cs : Nat → Comp K V} {s : State K V} (g : Good cs s)
    (hA : ∀ c, nowrites (cs c).f) {c : Nat} (hc : (s.due c).isSome) (rk : Nat) :
    Good cs (first cs s c rk) := by
  obtain ⟨s3, o, seen, vals, st, hf, e_ran, e_reads, e_store, e_made, e_writers, e_last,
    e_looping, e_due, e_after, e_acts, e_cut, hseen, hfol, hstop⟩ := first_spec cs s c rk (hA c)
  rw [hf]
  have hcm : c < s.made := g.due_made c hc
  have hlc : s.looping c = false := by
    cases h : s.looping c with
    | false => rfl
    | true => have := (g.looping c h).1; rw [this] at hc; cases hc
  have hr3 : s3.ran c = some (begun s c vals st seen) := by rw [e_ran]; simp
  have hd3 : s3.due c = none := by rw [e_due]; simp
  simp only [ending, hr3, Option.bind_some]
  cases st with
  | some w =>
    simp only [begun, Option.isSome_some, ite_true]
    obtain ⟨h1, h2, h3, k, h4⟩ := hstop w rfl
    rw [stop_eq s3 c _ hr3 hd3]
    exact g.post hc (rk := rk) (rf := { begun s c vals (some w) seen with ended := some .stopped }) {
      made := by simp [e_made, begun]
      ran_c := by simp
      ran := fun d hd => by simp [e_ran, put_ne _ _ hd, begun]
      reads := by simp [e_reads, begun]
      after := Or.inr ⟨w, by simp [e_after, put_put, begun], h2, h3,
        by have := g.writers_made k w h4; exact this, by simp⟩
      due := fun d m hd h => by simp [e_due, put_ne _ _ hd, h, begun]
      fresh := fun d h => by
        by_cases hd : d = c
        · subst hd; exact Or.inr hcm
        · simp [e_due, put_ne _ _ hd, begun] at h; exact Or.inl h
      looping := fun d hd h => by
        simp [e_looping, begun] at h
        exact ⟨h, by simp [e_due, put_ne _ _ hd, begun]⟩
      looping_c := fun h => by simp [e_looping, hlc, begun] at h
      writers := fun k' w' h => Or.inl (by simpa [e_writers] using h)
      store := fun k' h => absurd (by simp [e_store, begun]) h
      follows := fun h => absurd rfl h
      fresh_c := fun h => by simp [begun] at h
      pending := fun h => by simp [begun] at h
      acts := fun e v h => by
        simp only [e_acts, List.mem_filter, decide_eq_true_eq] at h
        exact Or.inl ⟨h.2, h.1⟩
      acts_keep := fun e v hec h => by simp [e_acts, h, hec, begun]
      last := fun d _ => by simp [e_last, begun]
      computes := fun _ h => by simp [begun] at h
      effects := fun _ h => by simp [begun] at h
      failed := fun h => by simp [begun] at h }
  | none =>
    simp only [begun, Option.isSome_none, Bool.false_eq_true, ite_false]
    have hfo := hfol rfl
    have hr4 : (edit s3 c fun r => { r with out := some o }).ran c =
        some { begun s c vals none seen with out := some o } := by simp [edit, hr3]
    -- the plain ends: the store, dues and afters left as at f's end
    have plain : ∀ (e : Ended) (eq : Option Bool) (th : Option (List Nat)) (X : List (Nat × V))
        (F : State K V), F = finish { (edit s3 c fun r => { r with out := some o }) with
          acts := s3.acts ++ X } c e eq none th →
        e ≠ .stopped → (e = .pending → o = .pending) →
        (∀ x ∈ X, x.1 = c ∧ iseffect (cs c) = true ∧ s.loop c = none ∧ e = .done ∧
          o = .value x.2) →
        (iseffect (cs c) = false → e = .done → ∃ v, o = .value v ∧ near (cs c).equal v (s.last c)) →
        (iseffect (cs c) = true → e = .done → ∃ v, o = .value v ∧
          (near (cs c).equal v (s.last c) ∨ (c, v) ∈ X)) →
        (e = .failed → o = .error ∨ ∃ v, o = .value v ∧ same (cs c).equal v (s.last c) = none) →
        Good cs F := by
      intro e eq th X F hF hne hpe hX hcomp heff hfail
      rw [finish_eq ({ (edit s3 c fun r => { r with out := some o }) with acts := s3.acts ++ X })
        c _ (by simpa using hr4)] at hF
      subst hF
      refine g.post hc (post_plain (rk := rk)
          (rf := { begun s c vals none seen with out := some o, ended := some e })
          (by simp [e_made, edit, begun]) (by simp [edit, e_ran, put_put, begun])
        (by simp [e_reads, begun, edit]) (by simp [e_after, edit, begun]) (by simp [e_due, edit, begun]) (by simp [e_store, edit, begun])
        (by simp [e_writers, edit, begun]) ?_ ?_ (by simp [e_last, edit, begun]) X (by simp [e_acts, edit, begun]) ?_ ?_ ?_ ?_ ?_ ?_ ?_)
      · intro d hd
        by_cases hl : e = .looping
        · simp [hl, put_ne _ _ hd, e_looping, edit, begun]
        · simp [hl, e_looping, edit, begun]
      · intro h
        by_cases hl : e = .looping
        · simp [hl, edit, begun]
        · simp [hl, e_looping, hlc, edit, begun] at h
      · intro x hx
        obtain ⟨h1, h2, h3, h4, h5⟩ := hX x hx
        exact ⟨h1, h2, by simp [begun, h3, edit], by simp [h4, edit, begun], by simp [h5, edit, begun]⟩
      · intro q hq; exact hseen q (by simpa [begun] using hq)
      · intro _; exact ⟨o, by simp, by simpa [begun] using hfo⟩
      · intro h; simp at h; simp [hpe h, edit, begun]
      · intro he h
        simp at h
        obtain ⟨v, h1, h2⟩ := hcomp he h
        exact ⟨v, by simp [h1, edit, begun], by simpa [e_last, edit] using h2⟩
      · intro he h
        simp at h
        obtain ⟨v, h1, h2⟩ := heff he h
        refine ⟨v, by simp [h1, edit, begun], ?_⟩
        rcases h2 with h2 | h2
        · exact Or.inl (by simpa [e_last, edit] using h2)
        · exact Or.inr (Or.inl (by simp [h2, edit, begun]))
      · intro h
        simp at h
        rcases hfail h with h1 | ⟨v, h1, h2⟩
        · exact Or.inl (by simp [h1])
        · exact Or.inr ⟨v, by simp [h1], by simpa [e_last, edit] using h2⟩
    cases o with
    | error =>
      simp only
      refine plain .failed none none [] _ ?_ (by simp) (by simp) (by simp) (by simp) (by simp)
        (fun _ => Or.inl rfl)
      simp only [List.append_nil]; rfl
    | pending =>
      simp only
      refine plain .pending none none [] _ ?_ (by simp) (fun _ => rfl) (by simp) (by simp)
        (by simp) (by simp)
      simp only [List.append_nil]; rfl
    | value v =>
      simp only [result]
      have hl4 : (edit s3 c fun r => { r with out := some (Out.value v) }).last c = s.last c := by
        simp [edit, e_last]
      rw [hl4]
      have hflag : ((edit s3 c fun r => { r with out := some (Out.value v) }).ran c).bind (·.loop) =
          s.loop c := by simp [edit, hr3, begun]
      have hcut : (edit s3 c fun r => { r with out := some (Out.value v) }).cut c = false := by
        simp [edit, e_cut]
      cases hsm : same (cs c).equal v (s.last c) with
      | none =>
        simp only
        refine plain .failed none none [] _ ?_ (by simp) (by simp) (by simp) (by simp) (by simp)
          (fun _ => Or.inr ⟨v, rfl, hsm⟩)
        simp only [List.append_nil]; rfl
      | some e =>
        simp only [hflag, hcut, Bool.or_false]
        by_cases hlp : ((s.loop c).isSome && !e) = true
        · simp only [hlp, ite_true]
          refine plain .looping (some e) (s.loop c) [] _ ?_ (by simp) (by simp) (by simp) (by simp)
            (by simp) (by simp)
          simp only [List.append_nil]; rfl
        · simp only [hlp, Bool.false_eq_true, ite_false]
          have hnear : e = true → near (cs c).equal v (s.last c) := fun he =>
            near_of_same (he ▸ hsm)
          cases hk : (cs c).kind with
          | effect a =>
            have hie : iseffect (cs c) = true := by simp [iseffect, hk]
            simp only
            cases e with
            | true =>
              simp only [ite_true]
              refine plain .done (some true) none [] _ ?_ (by simp) (by simp) (by simp)
                (fun h => by rw [hie] at h; cases h)
                (fun _ _ => ⟨v, rfl, Or.inl (hnear rfl)⟩) (by simp)
              simp only [List.append_nil]; rfl
            | false =>
              simp only [Bool.false_eq_true, ite_false]
              have hln : s.loop c = none := by
                cases h : s.loop c with
                | none => rfl
                | some _ => simp [h] at hlp
              refine plain .done (some false) none [(c, v)] _ rfl (by simp) (by simp)
                (fun x hx => by simp at hx; subst hx; exact ⟨rfl, hie, hln, rfl, rfl⟩)
                (fun h => by rw [hie] at h; cases h)
                (fun _ _ => ⟨v, rfl, Or.inr (by simp)⟩) (by simp)
          | compute to =>
            have hie : iseffect (cs c) = false := by simp [iseffect, hk]
            simp only
            cases e with
            | true =>
              simp only [ite_true]
              refine plain .done (some true) none [] _ ?_ (by simp) (by simp) (by simp)
                (fun _ _ => ⟨v, rfl, hnear rfl⟩)
                (fun h => by rw [hie] at h; cases h) (by simp)
              simp only [List.append_nil]; rfl
            | false =>
              simp only [Bool.false_eq_true, ite_false]
              have hln : s.loop c = none := by
                cases h : s.loop c with
                | none => rfl
                | some _ => simp [h] at hlp
              -- the set: what it changes is due, or was looping
              generalize hs4 : (edit s3 c fun r => { r with out := some (Out.value v) }) = s4
                at hflag hcut hr4
              have f_made : s4.made = s.made := by rw [← hs4]; simp [edit, e_made]
              have f_reads : s4.reads = put s.reads c (seen.map (·.1)) := by
                rw [← hs4]; simp [edit, e_reads]
              have f_ran : s4.ran = put s.ran c
                  (some { begun s c vals none seen with out := some (.value v) }) := by
                rw [← hs4]; simp [edit, e_ran, put_put, hr3]
              have f_store : s4.store = s.store := by rw [← hs4]; simp [edit, e_store]
              have f_writers : s4.writers = s.writers := by rw [← hs4]; simp [edit, e_writers]
              have f_last : s4.last = s.last := by rw [← hs4]; simp [edit, e_last]
              have f_looping : s4.looping = s.looping := by rw [← hs4]; simp [edit, e_looping]
              have f_due : s4.due = put s.due c none := by rw [← hs4]; simp [edit, e_due]
              have f_after : s4.after = put s.after c none := by rw [← hs4]; simp [edit, e_after]
              have f_acts : s4.acts = s.acts.filter (fun a => a.1 ≠ c) := by
                rw [← hs4]; simp [edit, e_acts]
              have m := set_moves cs s4 c v (by rw [hflag, hln])
              generalize hs5 : set cs s4 c v = s5 at m
              have hr5 : s5.ran c = some { begun s c vals none seen with out := some (.value v) } := by
                rw [m.ran, f_ran]; simp
              rw [finish_eq ({ s5 with last := put s5.last c (some v) }) c _ hr5]
              exact g.post hc (rk := rk)
                (rf := { begun s c vals none seen with out := some (.value v), ended := some .done }) {
                made := by simp [m.made, f_made]
                ran_c := by simp
                ran := fun d hd => by simp [m.ran, f_ran, put_ne _ _ hd]
                reads := by simp [m.reads, f_reads, begun]
                after := Or.inl (by simp [m.after, f_after])
                due := fun d m' hd h => by
                  have : s4.due d = some m' := by rw [f_due, put_ne _ _ hd]; exact h
                  simp [m.due d m' this]
                fresh := fun d h => by
                  rcases m.fresh d (by simpa using h) with h | h
                  · by_cases hd : d = c
                    · subst hd; exact Or.inr hcm
                    · rw [f_due, put_ne _ _ hd] at h; exact Or.inl h
                  · exact Or.inr (f_made ▸ h)
                looping := fun d hd h => by
                  obtain ⟨h1, h2⟩ := m.looping d (by simpa using h)
                  exact ⟨by rw [f_looping] at h1; exact h1, by simp [h2, f_due, put_ne _ _ hd]⟩
                looping_c := fun h => by
                  obtain ⟨h1, _⟩ := m.looping c (by simpa using h)
                  rw [f_looping, hlc] at h1; cases h1
                writers := fun k w h => by
                  rcases m.writers k w (by simpa using h) with h | h
                  · exact Or.inl (by rw [f_writers] at h; exact h)
                  · by_cases hw : w = c
                    · exact Or.inr (Or.inr hw)
                    · rw [f_ran, put_ne _ _ hw] at h; exact Or.inr (Or.inl h)
                store := fun k h d hd hdc hr => by
                  have h' : s5.store k ≠ s4.store k := by rw [f_store]; simpa using h
                  rcases m.store k h' d (f_made ▸ hd) (by rw [f_reads, put_ne _ _ hdc]; exact hr)
                    with h | h
                  · exact Or.inl (by simpa using h)
                  · exact Or.inr (by rw [f_looping] at h; exact h)
                follows := fun _ => ⟨.value v, by simp, by simpa [begun] using hfo⟩
                fresh_c := fun hdue _ q hq => by
                  have hq' : q ∈ seen := by simpa [begun] using hq
                  have hdue' : s5.due c = none := by simpa using hdue
                  by_cases e : s5.store q.1 = s4.store q.1
                  · simp only []
                    rw [e, f_store]; exact hseen q hq'
                  · exfalso
                    rcases m.store q.1 e c (f_made ▸ hcm)
                      (by rw [f_reads]; simp; exact ⟨q.2, hq'⟩) with h | h
                    · rw [hdue'] at h; cases h
                    · rw [f_looping, hlc] at h; cases h
                pending := fun h => by simp at h
                acts := fun e w h => by
                  have h' : (e, w) ∈ s4.acts := by rw [← m.acts]; simpa using h
                  rw [f_acts] at h'
                  simp only [List.mem_filter, decide_eq_true_eq] at h'
                  exact Or.inl ⟨h'.2, h'.1⟩
                acts_keep := fun e w hec h => by
                  have : (e, w) ∈ s4.acts := by rw [f_acts]; simp [h, hec]
                  simpa [m.acts] using this
                last := fun d hd => by simp [put_ne _ _ hd, m.last, f_last]
                computes := fun _ _ => ⟨v, by simp, v, by simp, Or.inl rfl⟩
                effects := fun h => by rw [hie] at h; cases h
                failed := fun h => by simp at h }

-- order.ts next answers a ready one
theorem pick_mem {P : Nat → Prop} (key : Nat → Nat × Nat) :
    ∀ (l : List Nat) (init : Option Nat), (∀ b, init = some b → P b) → (∀ p ∈ l, P p) →
      ∀ b, l.foldl (fun best p => match best with
        | none => some p
        | some b =>
          if (key p).1 < (key b).1 || ((key p).1 == (key b).1 && (key p).2 < (key b).2) then some p
          else some b) init = some b → P b
  | [], init, hi, _, b, h => hi b h
  | p :: l, init, hi, hl, b, h => by
    simp only [List.foldl_cons] at h
    refine pick_mem key l _ ?_ (fun q hq => hl q (List.mem_cons_of_mem _ hq)) b h
    intro b' hb'
    cases init with
    | none => cases hb'; exact hl p (List.mem_cons_self ..)
    | some b0 =>
      have hb0 := hi b0 rfl
      have hp := hl p (List.mem_cons_self ..)
      simp only at hb'
      split at hb' <;> (cases hb'; assumption)

theorem pick_some (key : Nat → Nat × Nat) :
    ∀ (l : List Nat) (init : Option Nat), (init.isSome ∨ l ≠ []) →
      (l.foldl (fun best p => match best with
        | none => some p
        | some b =>
          if (key p).1 < (key b).1 || ((key p).1 == (key b).1 && (key p).2 < (key b).2) then some p
          else some b) init).isSome
  | [], init, h => by simpa using h
  | p :: l, init, _ => by
    simp only [List.foldl_cons]
    refine pick_some key l _ (Or.inl ?_)
    cases init with
    | none => rfl
    | some b0 => simp only; split <;> rfl

theorem next_ready {rank : State K V → Nat → Nat} {s : State K V} {c : Nat}
    (h : next rank s = some c) : ready s c = true ∧ c < s.made := by
  simp only [next] at h
  exact pick_mem (P := fun p => ready s p = true ∧ p < s.made) _ _ none (by simp)
    (fun p hp => by simp at hp; exact ⟨hp.2, hp.1⟩) c h

theorem Good.step {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s s' : State K V}
    (g : Good cs s) (hA : ∀ c, nowrites (cs c).f) (h : step cs rank s = some s') : Good cs s' := by
  simp only [Model.step] at h
  split at h
  · split at h
    · rename_i c hc
      cases h
      have := (next_ready hc).1
      simp only [ready, Bool.and_eq_true] at this
      exact g.first hA this.1 _
    · cases h
      exact g.moves (Moves.of_eq rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl)
  · split at h
    · rename_i a rest ha
      cases h
      exact g.act (show s.acts = (a.1, a.2) :: rest from ha)
    · split at h
      · cases h
        exact g.moves (Moves.of_eq rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl)
      · cases h

-- the states the host and the pulses reach: made, written, told changed (from outside), pulses
-- begun, stepped and ended
inductive Reach (cs : Nat → Comp K V) (rank : State K V → Nat → Nat) : State K V → Prop
  | empty : Reach cs rank empty
  | make {s} : Reach cs rank s → Reach cs rank (make cs s)
  | write {s} (kvs : List (K × V)) : Reach cs rank s → Reach cs rank (write cs s kvs)
  | tell {s} (keys : List K) : Reach cs rank s → Reach cs rank (changed cs s keys none)
  | begin {s} : Reach cs rank s → Reach cs rank (begin s)
  | step {s s'} : Reach cs rank s → step cs rank s = some s' → Reach cs rank s'
  | close {s} : Reach cs rank s → step cs rank s = none → Reach cs rank (close s)

-- A2: no writes in runs
def A2 (cs : Nat → Comp K V) : Prop := ∀ c, nowrites (cs c).f

theorem Reach.good {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Reach cs rank s) : Good cs s := by
  induction h with
  | empty => exact Good.empty cs
  | make _ ih => exact ih.make
  | write kvs _ ih => exact ih.write kvs
  | tell keys _ ih => exact ih.tell keys
  | begin _ ih => exact ih.begin
  | step _ h ih => exact ih.step hA h
  | close _ _ ih => exact ih.close

-- a pulse, run to its end, reaches what it ends at
theorem steps_reach {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} :
    ∀ (f : Nat) (s s' : State K V), Reach cs rank s → steps cs rank f s = some s' →
      Reach cs rank s'
  | 0, _, _, _, h => by simp [steps] at h
  | f + 1, s, s', hs, h => by
    simp only [steps] at h
    split at h
    · rename_i s1 h1
      exact steps_reach f s1 s' (.step hs h1) h
    · rename_i h1
      cases h
      exact .close hs h1

theorem pulse_reach {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {fuel : Nat}
    {s s' : State K V} (hs : Reach cs rank s) (h : pulse cs rank fuel s = some s') :
    Reach cs rank s' :=
  steps_reach fuel _ s' (.begin hs) h

-- Lemma N

-- after-chains are acyclic, and only a due computation waits after one (track's waitsAfter)
theorem lemma_n {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Reach cs rank s) :
    (∀ x, ¬TransGen (aft s) x x) ∧ (∀ x w, s.after x = some w → (s.due x).isSome) :=
  ⟨(h.good hA).acyclic, fun x w hx => ((h.good hA).after_due x w hx).1⟩

-- an after-chain from a made computation is shorter than made + 1
theorem chain_short {cs : Nat → Comp K V} {s : State K V} (g : Core cs s) {x : Nat}
    (hx : x < s.made) : (chain s (s.made + 1) x).length < s.made + 1 := by
  have hsub : (x :: chain s (s.made + 1) x) ⊆ List.range s.made := by
    intro y hy
    rcases List.mem_cons.1 hy with rfl | hy
    · exact List.mem_range.2 hx
    · exact List.mem_range.2 (chain_lt (fun a b h => (g.after_due a b h).2) _ _ _ hy)
  have := (chain_nodup g.acyclic (s.made + 1) x).length_le_of_subset hsub
  simp at this
  omega

-- following afters from a due one reaches a ready one, keeping any P that afters keep
theorem walk_ready {cs : Nat → Comp K V} {s : State K V} (g : Core cs s) (P : Nat → Prop)
    (hP : ∀ x z, P x → s.after x = some z → P z) :
    ∀ f x, (s.due x).isSome → x < s.made → P x → (chain s f x).length < f →
      ∃ y, ready s y = true ∧ y < s.made ∧ P y
  | 0, _, _, _, _, h => absurd h (Nat.not_lt_zero _)
  | f + 1, x, hd, hx, px, hl => by
    cases ha : s.after x with
    | none => exact ⟨x, by simp [ready, hd, ha], hx, px⟩
    | some z =>
      cases hz : s.due z with
      | none => exact ⟨x, by simp [ready, hd, ha, hz], hx, px⟩
      | some _ =>
        have hl' : (chain s f z).length < f := by
          simp only [chain, ha, List.length_cons] at hl; omega
        exact walk_ready g P hP f z (by simp [hz]) (g.after_due x z ha).2 (hP x z px ha) hl'

-- next is total: something due, something is ready, and next answers one
theorem next_total {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Reach cs rank s) {p : Nat} (hp : (s.due p).isSome) :
    (next rank s).isSome := by
  have g := (h.good hA).toCore
  obtain ⟨y, hy, hym, _⟩ := walk_ready g (fun _ => True) (fun _ _ _ _ => trivial) _ p hp
    (g.due_made p hp) trivial (chain_short g (g.due_made p hp))
  simp only [next]
  exact pick_some _ _ none (Or.inr (List.ne_nil_of_mem (a := y) (by simp [hym, hy])))

-- and below any due one there is a ready one of no greater rank, the rank ranked (Rank.lean)
theorem next_below {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Reach cs rank s) (hr : ranked (fun p q => q ∈ edges s p) (rank s))
    {p : Nat} (hp : (s.due p).isSome) :
    ∃ q, ready s q = true ∧ q < s.made ∧ rank s q ≤ rank s p := by
  have g := (h.good hA).toCore
  refine walk_ready g (fun x => rank s x ≤ rank s p) ?_ _ p hp (g.due_made p hp) (Nat.le_refl _)
    (chain_short g (g.due_made p hp))
  intro x z hx hz
  have hzx : z ≠ x := by
    intro e; subst e; exact g.acyclic z (.single hz)
  have he : z ∈ edges s x := by
    simp [edges, hz, hzx, (g.after_due x z hz).2]
  exact Nat.le_trans (hr x z he).1 hx

-- Lemma F and Theorem 2

-- Lemma F: a computation not due, whose latest run ended done, failed or pending: every key it
-- read still holds what it read
theorem fresh_reads {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Reach cs rank s) {c : Nat} {r : Run K V} (hr : s.ran c = some r)
    (hd : s.due c = none) (hs : settled r) : ∀ q ∈ r.seen, s.store q.1 = q.2 :=
  (h.good hA).fresh c r hr hd hs

-- Theorem 2: such a computation's latest run is its run from scratch on the store now: the same
-- outcome, the same reads, and its tracked keys are those reads
theorem quiescence {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Reach cs rank s) {c : Nat} {r : Run K V} (hr : s.ran c = some r)
    (hd : s.due c = none) (hs : settled r) :
    ∃ o, r.out = some o ∧ eval s.store (cs c).f = (o, r.seen) ∧
      s.reads c = (eval s.store (cs c).f).2.map (·.1) := by
  have g := h.good hA
  have hns : r.ended ≠ some .stopped := by
    rcases hs with e | e | e <;> rw [e] <;> simp
  obtain ⟨o, ho, hf⟩ := g.follows c r hr hns
  have he := eval_follow (st := s.store) _ _ _ hf (g.fresh c r hr hd hs)
  refine ⟨o, ho, he, ?_⟩
  rw [he, g.reads c, hr]; rfl

-- (a) done, a compute: its last is its value from scratch on the store, or equal to it
theorem quiescence_done {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Reach cs rank s) {c : Nat} {r : Run K V} (hc : iseffect (cs c) = false)
    (hr : s.ran c = some r) (hd : s.due c = none) (hdone : r.ended = some .done) :
    ∃ v, (eval s.store (cs c).f).1 = .value v ∧ near (cs c).equal v (s.last c) ∧
      s.reads c = (eval s.store (cs c).f).2.map (·.1) := by
  obtain ⟨o, ho, he, hreads⟩ := quiescence hA h hr hd (Or.inl hdone)
  obtain ⟨v, hv, hn⟩ := (h.good hA).computes c r hc hr hdone
  rw [ho] at hv; cases hv
  exact ⟨v, by rw [he], hn, hreads⟩

-- (c) pending: pending from scratch too
theorem quiescence_pending {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Reach cs rank s) {c : Nat} {r : Run K V} (hr : s.ran c = some r)
    (hd : s.due c = none) (hp : r.ended = some .pending) :
    (eval s.store (cs c).f).1 = .pending := by
  obtain ⟨o, ho, he, _⟩ := quiescence hA h hr hd (Or.inr (Or.inr hp))
  rw [(h.good hA).pending c r hr hp] at ho; cases ho
  rw [he]

-- (b) failed: from scratch, f throws too, or gives a value whose equal throws against the last
theorem quiescence_failed {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Reach cs rank s) {c : Nat} {r : Run K V} (hr : s.ran c = some r)
    (hd : s.due c = none) (hf : r.ended = some .failed) :
    (eval s.store (cs c).f).1 = .error ∨
      ∃ v, (eval s.store (cs c).f).1 = .value v ∧ same (cs c).equal v (s.last c) = none := by
  obtain ⟨o, ho, he, _⟩ := quiescence hA h hr hd (Or.inr (Or.inl hf))
  rw [he]
  rcases (h.good hA).failed c r hr hf with h1 | ⟨v, h1, h2⟩
  · rw [ho] at h1; cases h1; exact Or.inl rfl
  · rw [ho] at h1; cases h1; exact Or.inr ⟨v, rfl, h2⟩

-- when nothing is due (a round's run phase over, or a pulse's end): every compute done holds its
-- value from scratch on the store, up to equal
theorem quiescent {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Reach cs rank s) (hq : ∀ d, s.due d = none) :
    ∀ c r, iseffect (cs c) = false → s.ran c = some r → r.ended = some .done →
      ∃ v, (eval s.store (cs c).f).1 = .value v ∧ near (cs c).equal v (s.last c) ∧
        s.reads c = (eval s.store (cs c).f).2.map (·.1) :=
  fun _ _ hc hr hdone => quiescence_done hA h hc hr (hq _) hdone

-- and when no act is left either (a pulse's end): every effect done has acted on its value from
-- scratch on the store, or it is equal to the one it acted on
theorem quiescent_effects {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Reach cs rank s) (hq : ∀ d, s.due d = none) (ha : s.acts = []) :
    ∀ e r, iseffect (cs e) = true → s.ran e = some r → r.ended = some .done →
      ∃ v, (eval s.store (cs e).f).1 = .value v ∧ near (cs e).equal v (s.last e) := by
  intro e r he hr hdone
  obtain ⟨o, ho, hev, _⟩ := quiescence hA h hr (hq e) (Or.inl hdone)
  obtain ⟨v, hv, h2⟩ := (h.good hA).effects e r he hr hdone
  rw [ho] at hv; cases hv
  refine ⟨v, by rw [hev], ?_⟩
  rcases h2 with h2 | h2 | h2
  · exact h2
  · rw [ha] at h2; cases h2
  · rw [hq e] at h2; cases h2

-- Theorem 3: an act is called with the effect's value from scratch on the store at the act
theorem act_fresh {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Reach cs rank s) {e : Nat} {v : V} {rest : List (Nat × V)}
    (ha : s.acts = (e, v) :: rest) (hd : s.due e = none) :
    (eval s.store (cs e).f).1 = .value v := by
  have g := h.good hA
  obtain ⟨_, r, hr, _, hdone, ho⟩ := g.acts e v (by simp [ha])
  obtain ⟨o, ho', he, _⟩ := quiescence hA h hr hd (Or.inl hdone)
  rw [ho] at ho'; cases ho'
  rw [he]

-- the act step: when step takes that act, it calls act with that value, the store unchanged
-- since, and the last acted on
theorem step_acts {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s s' : State K V}
    (hA : A2 cs) (h : Reach cs rank s) {e : Nat} {v : V} {rest : List (Nat × V)}
    (hph : s.phase = .acts) (ha : s.acts = (e, v) :: rest) (hd : s.due e = none)
    (hs : step cs rank s = some s') :
    s' = act cs { s with acts := rest } e v ∧ (eval s.store (cs e).f).1 = .value v := by
  refine ⟨?_, act_fresh hA h ha hd⟩
  simp only [Model.step, hph, ha] at hs
  cases hs; rw [hph]

-- Theorem 5

-- what a run ended with, given how f ended (A2 for c): stopped, or o recorded, and the result's
-- branches; the store and lasts as before unless set was called
theorem ending_value {cs : Nat → Comp K V} {s3 : State K V} {c : Nat} {r : Run K V}
    (hr3 : s3.ran c = some r) (hst : r.stopped = none) (v : V) :
    ending cs s3 c (.value v) = result cs (edit s3 c fun r => { r with out := some (.value v) }) c v := by
  simp [ending, hr3, hst]

-- (a) cutoff: a run whose value is equal to the last changes neither the store nor the last
theorem cutoff (cs : Nat → Comp K V) (s : State K V) (c rk : Nat) (hp : nowrites (cs c).f)
    {v : V} (hout : ((first cs s c rk).ran c).bind (·.out) = some (.value v))
    (heq : same (cs c).equal v (s.last c) = some true) :
    (first cs s c rk).store = s.store ∧ (first cs s c rk).last = s.last := by
  obtain ⟨s3, o, seen, vals, st, hf, e_ran, e_reads, e_store, e_made, e_writers, e_last,
    e_looping, e_due, e_after, e_acts, e_cut, hseen, hfol, hstop⟩ := first_spec cs s c rk hp
  rw [hf] at hout ⊢
  have hr3 : s3.ran c = some (begun s c vals st seen) := by rw [e_ran]; simp
  have hd3 : s3.due c = none := by rw [e_due]; simp
  cases st with
  | some w =>
    simp only [ending, hr3, begun, Option.bind_some, Option.isSome_some, ite_true] at hout ⊢
    rw [stop_eq s3 c _ hr3 hd3] at hout
    simp [begun] at hout
  | none =>
    cases o with
    | error =>
      simp only [ending, hr3, begun, Option.bind_some, Option.isSome_none, Bool.false_eq_true,
        ite_false] at hout
      rw [finish_eq _ c _ (by simp [edit, hr3]; rfl)] at hout
      simp at hout
    | pending =>
      simp only [ending, hr3, begun, Option.bind_some, Option.isSome_none, Bool.false_eq_true,
        ite_false] at hout
      rw [finish_eq _ c _ (by simp [edit, hr3]; rfl)] at hout
      simp at hout
    | value v' =>
      rw [ending_value hr3 rfl] at hout ⊢
      generalize hs4 : (edit s3 c fun r => { r with out := some (Out.value v') }) = s4 at hout ⊢
      have hr4 : s4.ran c = some { begun s c vals none seen with out := some (.value v') } := by
        rw [← hs4]; simp [edit, hr3]
      have hl4 : s4.last = s.last := by rw [← hs4]; simp [edit, e_last]
      have hst4 : s4.store = s.store := by rw [← hs4]; simp [edit, e_store]
      -- every end but set's leaves the store and lasts
      have keep : ∀ (t : State K V) (e : Ended) (eq : Option Bool) (th : Option (List Nat)),
          t.store = s.store → t.last = s.last → (∃ r, t.ran c = some r) →
          (finish t c e eq none th).store = s.store ∧ (finish t c e eq none th).last = s.last := by
        intro t e eq th h1 h2 ⟨r, h3⟩
        rw [finish_eq t c r h3]; exact ⟨h1, h2⟩
      simp only [result] at hout ⊢
      rw [hl4] at hout ⊢
      cases hsm : same (cs c).equal v' (s.last c) with
      | none => exact keep _ _ _ _ hst4 hl4 ⟨_, hr4⟩
      | some e =>
        simp only [hsm] at hout ⊢
        by_cases hlp : (((s4.ran c).bind fun x => x.loop).isSome && (!e || s4.cut c)) = true
        · rw [ite_eq_left hlp]; exact keep _ _ _ _ hst4 hl4 ⟨_, hr4⟩
        · rw [ite_eq_right hlp] at hout ⊢
          cases hk : (cs c).kind with
          | effect a =>
            simp only [hk]
            cases e
            · exact keep _ _ _ _ hst4 rfl ⟨_, hr4⟩
            · exact keep _ _ _ _ hst4 hl4 ⟨_, hr4⟩
          | compute to =>
            simp only [hk] at hout ⊢
            cases e with
            | true => exact keep _ _ _ _ hst4 hl4 ⟨_, hr4⟩
            | false =>
              -- set: then v' is v, and not equal to the last
              exfalso
              simp only [Bool.false_eq_true, ite_false] at hout
              have hfl : ((s4.ran c).bind (·.loop)) = none := by
                rw [hr4]
                simp only [Option.bind_some, begun]
                cases h : s.loop c with
                | none => rfl
                | some _ => exact absurd (by simp [hr4, begun, h]) hlp
              have m := set_moves cs s4 c v' hfl
              rw [finish_eq _ c _ (show ({ set cs s4 c v' with last := _ } : State K V).ran c = _
                from by rw [m.ran]; exact hr4)] at hout
              simp at hout
              subst hout
              rw [heq] at hsm; cases hsm

-- (c) an effect's unflagged run queues an act iff its value is not equal to the one it acted on
-- last (its older act dropped)
theorem acts_iff (cs : Nat → Comp K V) (s : State K V) (e rk : Nat) (hp : nowrites (cs e).f)
    (he : iseffect (cs e) = true) (hl : s.loop e = none) {v : V}
    (hout : ((first cs s e rk).ran e).bind (·.out) = some (.value v)) :
    (e, v) ∈ (first cs s e rk).acts ↔ same (cs e).equal v (s.last e) = some false := by
  obtain ⟨s3, o, seen, vals, st, hf, e_ran, e_reads, e_store, e_made, e_writers, e_last,
    e_looping, e_due, e_after, e_acts, e_cut, hseen, hfol, hstop⟩ := first_spec cs s e rk hp
  rw [hf] at hout ⊢
  have hr3 : s3.ran e = some (begun s e vals st seen) := by rw [e_ran]; simp
  have hd3 : s3.due e = none := by rw [e_due]; simp
  have hnot : (e, v) ∉ s3.acts := by rw [e_acts]; simp
  cases st with
  | some w =>
    simp only [ending, hr3, begun, Option.bind_some, Option.isSome_some, ite_true] at hout
    rw [stop_eq s3 e _ hr3 hd3] at hout
    simp [begun] at hout
  | none =>
    cases o with
    | error =>
      simp only [ending, hr3, begun, Option.bind_some, Option.isSome_none, Bool.false_eq_true,
        ite_false] at hout
      rw [finish_eq _ e _ (by simp [edit, hr3]; rfl)] at hout
      simp at hout
    | pending =>
      simp only [ending, hr3, begun, Option.bind_some, Option.isSome_none, Bool.false_eq_true,
        ite_false] at hout
      rw [finish_eq _ e _ (by simp [edit, hr3]; rfl)] at hout
      simp at hout
    | value v' =>
      rw [ending_value hr3 rfl] at hout ⊢
      generalize hs4 : (edit s3 e fun r => { r with out := some (Out.value v') }) = s4 at hout ⊢
      have hr4 : s4.ran e = some { begun s e vals none seen with out := some (.value v') } := by
        rw [← hs4]; simp [edit, hr3]
      have hl4 : s4.last = s.last := by rw [← hs4]; simp [edit, e_last]
      have ha4 : s4.acts = s3.acts := by rw [← hs4]; simp [edit]
      have hfl : ((s4.ran e).bind fun x => x.loop) = none := by rw [hr4]; simp [begun, hl]
      obtain ⟨act', hk⟩ : ∃ a, (cs e).kind = .effect a := by
        simp only [iseffect] at he; split at he
        · exact ⟨_, ‹_›⟩
        · cases he
      -- every end here is finish, which keeps the run's out: so v' is v
      have hvv : ∀ (t : State K V) (e' : Ended) (eq : Option Bool) (th : Option (List Nat)),
          t.ran e = s4.ran e → ((finish t e e' eq none th).ran e).bind (·.out) = some (.value v) →
          v' = v := by
        intro t e' eq th h1 h2
        rw [finish_eq t e _ (h1.trans hr4)] at h2
        simp at h2; exact h2
      simp only [result, hl4, hfl, hk] at hout ⊢
      cases hsm : same (cs e).equal v' (s.last e) with
      | none =>
        simp only [hsm] at hout ⊢
        have := hvv s4 _ _ _ rfl hout
        subst this
        rw [finish_eq s4 e _ hr4]
        simp [ha4, hnot, hsm]
      | some b =>
        simp only [hsm, Option.isSome_none, Bool.false_and, Bool.false_eq_true, ite_false]
          at hout ⊢
        cases b with
        | true =>
          simp only [ite_true] at hout ⊢
          have := hvv s4 _ _ _ rfl hout
          subst this
          rw [finish_eq s4 e _ hr4]
          simp [ha4, hnot, hsm]
        | false =>
          simp only [Bool.false_eq_true, ite_false] at hout ⊢
          have := hvv _ _ _ _ (by rfl) hout
          subst this
          rw [finish_eq _ e _ (show ({ s4 with acts := s4.acts ++ [(e, v')], last := s.last } :
            State K V).ran e = _ from hr4)]
          simp [hsm]

-- the act: due again, skipped; else act called with (v, the last acted on), and v is the last
theorem act_skip (cs : Nat → Comp K V) (s : State K V) (e : Nat) (v : V)
    (hd : (s.due e).isSome) : act cs s e v = s := by
  simp [Model.act, hd]

theorem act_last (cs : Nat → Comp K V) (s : State K V) (e : Nat) (v : V)
    {g : V → Option V → List (K × V)} (hk : (cs e).kind = .effect g) (hd : s.due e = none) :
    (act cs s e v).last e = some v := by
  simp [Model.act, hd, hk, say]

end Model
