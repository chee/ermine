-- LLM generated working output
-- theorems on the model (Model.lean). proof.md is the guide; its §13 says what changed.
--
-- the states: Reach, what the host (make, write, changed from outside) and pulses (begin, step,
-- close) reach from empty; Wide, Reach with the host's writes and changes also named by a
-- computation whose latest run is unflagged (Reach.wide). the invariant: Good (Core: order, runs,
-- reads, and no latest run holding a given: finish gives it back; then acts, early or not, and
-- lasts), with Sleeps (the asleep: not due, reading nothing), kept by every transition (Wide.inv:
-- Hush, what a step does to the asleep: it only wakes, and moves reads and dues of the awake or of
-- readers). proved, for every state Wide reaches:
-- - lemma_n: after-chains have no cycle; only a due computation waits after one
-- - next_total: something due, next answers one; next_below: one of no greater rank (ranked)
-- - fresh_reads (Lemma F): not due, its latest run done, failed or pending: every key it read still
--   holds what it read
-- - quiescence (Theorem 2): then that run is f from scratch on the store: the same outcome and
--   reads, and the tracker holds those keys. quiescence_done (a: a compute's last is that value,
--   or equal to it), quiescence_failed (b), quiescence_pending (c); quiescent: nothing due, every
--   compute done; quiescent_effects: and no act left, every effect done
-- - act_fresh, step_acts (Theorem 3): an act is called with its effect's value from scratch on the
--   store at the act: the head of the queue, early acts first (C7: an early act's writes mark at
--   once, so after one the store is not settled: computes it made due are behind until the next
--   round; the theorem is about the act's own effect, which holds)
-- - cutoff (Theorem 5 a): a run equal to the last changes neither the store nor the last.
--   acts_iff, act_last, act_skip (Theorem 5 c): an unflagged effect run queues an act iff its value
--   is not equal to the last acted on; an act sets the last; due again, it is skipped
--
-- assumed (each a hypothesis where used):
-- - A2 cs: no f writes in its run (nowrites), and Quiet: no going writes (an attended compute's
--   teardowns). every theorem but act_skip and act_last; cutoff and acts_iff need it of the one
--   computation only, and nothing asleep at the start of the run (hz). without Quiet a going's
--   write marks the going one itself: asleep and due, it runs asleep (Model.Check, selfgo). Lemma N should not need it (writes in runs do not
--   touch afters), but its proof goes through the same invariant
-- - a change the host names is by a computation whose latest run is unflagged (Wide). a run's flag
--   ends with it unless it ended pending (L1), so that is any but one whose latest run ended
--   pending while flagged: naming such a one, its own mark is cut as that run's loop, and its
--   pending run may hold stale reads, (c) failing (Model.Check, hostcut; the TS the same).
--   Async.lean, whose invariant knows cuts, allows any between pulses, (c) asking the loop not cut
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

-- wakes: what a read of a key nobody tracked does, beside the run

theorem attending_lt {cs : Nat → Comp K V} {n : Nat} {k : K} {a : Nat}
    (h : attending cs n k = some a) : a < n := by
  have := List.mem_of_getLast? h
  simp at this
  exact this.1

-- a wake moves only the dues, the writers, the attended, the tick, the loops and the log
theorem wake_shape (cs : Nat → Comp K V) (s : State K V) (k : K) :
    ∃ dy sl wr tk du lp lg lgs, wake cs s k = { s with
      dying := dy, asleep := sl, writers := wr, tick := tk, due := du, loop := lp, looping := lg,
      log := lgs } := by
  unfold wake
  cases attending cs s.made k with
  | none => exact ⟨_, _, _, _, _, _, _, _, rfl⟩
  | some a =>
    simp only
    split
    · simp only [mark, settle, Option.isSome_none, Bool.and_false, Bool.false_eq_true, ite_false,
        due, say]
      by_cases h : (s.due a).isSome = true
      · simp only [h, ite_true]; exact ⟨_, _, _, _, _, _, _, _, rfl⟩
      · simp only [h, ite_false, Bool.false_eq_true]; exact ⟨_, _, _, _, _, _, _, _, rfl⟩
    · exact ⟨_, _, _, _, _, _, _, _, rfl⟩

theorem wakes_shape (cs : Nat → Comp K V) : ∀ (ws : List K) (s : State K V),
    ∃ dy sl wr tk du lp lg lgs, wakes cs s ws = { s with
      dying := dy, asleep := sl, writers := wr, tick := tk, due := du, loop := lp, looping := lg,
      log := lgs }
  | [], s => ⟨_, _, _, _, _, _, _, _, rfl⟩
  | k :: ws, s => by
    simp only [wakes, List.foldl_cons]
    obtain ⟨dy, sl, wr, tk, du, lp, lg, lgs, h1⟩ := wake_shape cs s k
    obtain ⟨dy', sl', wr', tk', du', lp', lg', lgs', h2⟩ := wakes_shape cs ws (wake cs s k)
    simp only [wakes] at h2
    rw [h2, h1]
    exact ⟨_, _, _, _, _, _, _, _, rfl⟩

@[simp] theorem wakes_ran (cs : Nat → Comp K V) (s : State K V) (ws : List K) :
    (wakes cs s ws).ran = s.ran := by
  obtain ⟨_, _, _, _, _, _, _, _, h⟩ := wakes_shape cs ws s; rw [h]

@[simp] theorem wakes_reads (cs : Nat → Comp K V) (s : State K V) (ws : List K) :
    (wakes cs s ws).reads = s.reads := by
  obtain ⟨_, _, _, _, _, _, _, _, h⟩ := wakes_shape cs ws s; rw [h]

@[simp] theorem wakes_store (cs : Nat → Comp K V) (s : State K V) (ws : List K) :
    (wakes cs s ws).store = s.store := by
  obtain ⟨_, _, _, _, _, _, _, _, h⟩ := wakes_shape cs ws s; rw [h]

@[simp] theorem wakes_made (cs : Nat → Comp K V) (s : State K V) (ws : List K) :
    (wakes cs s ws).made = s.made := by
  obtain ⟨_, _, _, _, _, _, _, _, h⟩ := wakes_shape cs ws s; rw [h]

@[simp] theorem wakes_after (cs : Nat → Comp K V) (s : State K V) (ws : List K) :
    (wakes cs s ws).after = s.after := by
  obtain ⟨_, _, _, _, _, _, _, _, h⟩ := wakes_shape cs ws s; rw [h]

@[simp] theorem wakes_acts (cs : Nat → Comp K V) (s : State K V) (ws : List K) :
    (wakes cs s ws).acts = s.acts := by
  obtain ⟨_, _, _, _, _, _, _, _, h⟩ := wakes_shape cs ws s; rw [h]

@[simp] theorem wakes_earlies (cs : Nat → Comp K V) (s : State K V) (ws : List K) :
    (wakes cs s ws).earlies = s.earlies := by
  obtain ⟨_, _, _, _, _, _, _, _, h⟩ := wakes_shape cs ws s; rw [h]

@[simp] theorem wakes_last (cs : Nat → Comp K V) (s : State K V) (ws : List K) :
    (wakes cs s ws).last = s.last := by
  obtain ⟨_, _, _, _, _, _, _, _, h⟩ := wakes_shape cs ws s; rw [h]

@[simp] theorem wakes_values (cs : Nat → Comp K V) (s : State K V) (ws : List K) :
    (wakes cs s ws).values = s.values := by
  obtain ⟨_, _, _, _, _, _, _, _, h⟩ := wakes_shape cs ws s; rw [h]

@[simp] theorem wakes_kept (cs : Nat → Comp K V) (s : State K V) (ws : List K) :
    (wakes cs s ws).kept = s.kept := by
  obtain ⟨_, _, _, _, _, _, _, _, h⟩ := wakes_shape cs ws s; rw [h]

@[simp] theorem wakes_went (cs : Nat → Comp K V) (s : State K V) (ws : List K) :
    (wakes cs s ws).went = s.went := by
  obtain ⟨_, _, _, _, _, _, _, _, h⟩ := wakes_shape cs ws s; rw [h]

@[simp] theorem wakes_cause (cs : Nat → Comp K V) (s : State K V) (ws : List K) :
    (wakes cs s ws).cause = s.cause := by
  obtain ⟨_, _, _, _, _, _, _, _, h⟩ := wakes_shape cs ws s; rw [h]

@[simp] theorem wakes_when (cs : Nat → Comp K V) (s : State K V) (ws : List K) :
    (wakes cs s ws).when = s.when := by
  obtain ⟨_, _, _, _, _, _, _, _, h⟩ := wakes_shape cs ws s; rw [h]

@[simp] theorem wakes_cut (cs : Nat → Comp K V) (s : State K V) (ws : List K) :
    (wakes cs s ws).cut = s.cut := by
  obtain ⟨_, _, _, _, _, _, _, _, h⟩ := wakes_shape cs ws s; rw [h]

@[simp] theorem wakes_runs (cs : Nat → Comp K V) (s : State K V) (ws : List K) :
    (wakes cs s ws).runs = s.runs := by
  obtain ⟨_, _, _, _, _, _, _, _, h⟩ := wakes_shape cs ws s; rw [h]

@[simp] theorem wakes_pulses (cs : Nat → Comp K V) (s : State K V) (ws : List K) :
    (wakes cs s ws).pulses = s.pulses := by
  obtain ⟨_, _, _, _, _, _, _, _, h⟩ := wakes_shape cs ws s; rw [h]

@[simp] theorem wakes_pulsing (cs : Nat → Comp K V) (s : State K V) (ws : List K) :
    (wakes cs s ws).pulsing = s.pulsing := by
  obtain ⟨_, _, _, _, _, _, _, _, h⟩ := wakes_shape cs ws s; rw [h]

@[simp] theorem wakes_phase (cs : Nat → Comp K V) (s : State K V) (ws : List K) :
    (wakes cs s ws).phase = s.phase := by
  obtain ⟨_, _, _, _, _, _, _, _, h⟩ := wakes_shape cs ws s; rw [h]

@[simp] theorem wakes_round (cs : Nat → Comp K V) (s : State K V) (ws : List K) :
    (wakes cs s ws).round = s.round := by
  obtain ⟨_, _, _, _, _, _, _, _, h⟩ := wakes_shape cs ws s; rw [h]

-- a wake reads none of a run's record or the tracker
theorem wake_with (cs : Nat → Comp K V) (s : State K V) (k : K) (R : Nat → Option (Run K V))
    (Q : Nat → List K) :
    wake cs { s with ran := R, reads := Q } k = { wake cs s k with ran := R, reads := Q } := by
  unfold wake
  cases attending cs s.made k with
  | none => rfl
  | some a =>
    simp only
    split
    · simp only [mark, settle, Option.isSome_none, Bool.and_false, Bool.false_eq_true, ite_false,
        due, say]
      by_cases h : (s.due a).isSome = true <;> simp [h]
    · rfl

theorem wakes_with (cs : Nat → Comp K V) (R : Nat → Option (Run K V)) (Q : Nat → List K) :
    ∀ (ws : List K) (s : State K V),
    wakes cs { s with ran := R, reads := Q } ws = { wakes cs s ws with ran := R, reads := Q }
  | [], _ => rfl
  | k :: ws, s => by
    simp only [wakes, List.foldl_cons]
    rw [wake_with]
    exact wakes_with cs R Q ws _

theorem wakes_append (cs : Nat → Comp K V) (s : State K V) (a b : List K) :
    wakes cs (wakes cs s a) b = wakes cs s (a ++ b) := by
  simp [wakes, List.foldl_append]

-- a run, A2: it reads, and may stop; it changes only its record and its read keys, and wakes what
-- its reads of keys nobody tracked wake

theorem exec_spec (cs : Nat → Comp K V) (c : Nat) :
    ∀ (p : Prog K V), nowrites p → ∀ (s : State K V) (r : Run K V), s.ran c = some r →
    r.stopped = none →
    ∃ (seen : List (K × Option V)) (vals : List Nat) (st : Option Nat) (ws : List K),
      (exec cs c s p).1 = { wakes cs s ws with
        ran := put s.ran c (some { r with seen := r.seen ++ seen, values := vals, stopped := st }),
        reads := put s.reads c (s.reads c ++ seen.map (·.1)) } ∧
      (∀ q ∈ seen, s.store q.1 = q.2) ∧
      (st = none → follow p seen = some (exec cs c s p).2) ∧
      (∀ w, st = some w → ((wakes cs s ws).due w).isSome ∧ waits (wakes cs s ws) w c = false ∧
        w ≠ c ∧ ∃ k, (wakes cs s ws).writers k = some w)
  | .value v, _, s, r, hr, hs => by
    refine ⟨[], r.values, none, [], ?_, by simp, by simp [follow, exec], by simp⟩
    have : { r with seen := r.seen ++ [], values := r.values, stopped := none } = r := by
      cases r; simp_all
    rw [this, put_self hr]
    simp only [exec, List.map_nil, List.append_nil, put_self (rfl : s.reads c = _)]; rfl
  | .error, _, s, r, hr, hs => by
    refine ⟨[], r.values, none, [], ?_, by simp, by simp [follow, exec], by simp⟩
    have : { r with seen := r.seen ++ [], values := r.values, stopped := none } = r := by
      cases r; simp_all
    rw [this, put_self hr]
    simp only [exec, List.map_nil, List.append_nil, put_self (rfl : s.reads c = _)]; rfl
  | .pending, _, s, r, hr, hs => by
    refine ⟨[], r.values, none, [], ?_, by simp, by simp [follow, exec], by simp⟩
    have : { r with seen := r.seen ++ [], values := r.values, stopped := none } = r := by
      cases r; simp_all
    rw [this, put_self hr]
    simp only [exec, List.map_nil, List.append_nil, put_self (rfl : s.reads c = _)]; rfl
  | .write .., hp, _, _, _, _ => absurd hp (by simp [nowrites])
  | .read k next, hp, s, r, hr, hs => by
    -- what the read wakes: k, when nobody tracked it
    generalize hw0 : (if tracked s k then [] else [k]) = ws0
    generalize hW : wakes cs s ws0 = W
    have eW : ∀ (R : Nat → Option (Run K V)) (Q : Nat → List K),
        (if (!tracked s k) = true then wake cs { s with ran := R, reads := Q } k
          else { s with ran := R, reads := Q }) = { W with ran := R, reads := Q } := by
      intro R Q
      rw [← hW, ← hw0]
      by_cases ht : tracked s k
      · simp [ht, wakes]
      · simp [ht, wakes, wake_with]
    have hs1 : (if (!tracked s k) = true then
          wake cs (edit { s with reads := put s.reads c (s.reads c ++ [k]) } c
            (fun r => { r with seen := r.seen ++ [(k, s.store k)] })) k
        else edit { s with reads := put s.reads c (s.reads c ++ [k]) } c
            (fun r => { r with seen := r.seen ++ [(k, s.store k)] })) =
        { W with
          ran := put s.ran c (some { r with seen := r.seen ++ [(k, s.store k)], values := r.values }),
          reads := put s.reads c (s.reads c ++ [k]) } := by
      rw [← eW]; simp [edit, hr]
    simp only [exec]
    rw [hs1]
    have wr : W.ran = s.ran := by rw [← hW]; simp
    have wq : W.reads = s.reads := by rw [← hW]; simp
    have wst : W.store = s.store := by rw [← hW]; simp
    have hp' := fun x => (show nowrites (Prog.read k next) from hp) x
    -- the rest of the run, from s2
    have rest : ∀ (vs : List Nat) (s2 : State K V),
        s2 = { W with ran := put s.ran c (some { r with seen := r.seen ++ [(k, s.store k)], values := vs }),
                      reads := put s.reads c (s.reads c ++ [k]) } →
        ∃ seen vals st ws,
          (exec cs c s2 (next (s.store k))).1 = { wakes cs s ws with
            ran := put s.ran c (some { r with seen := r.seen ++ seen, values := vals, stopped := st }),
            reads := put s.reads c (s.reads c ++ seen.map (·.1)) } ∧
          (∀ q ∈ seen, s.store q.1 = q.2) ∧
          (st = none → follow (.read k next) seen = some (exec cs c s2 (next (s.store k))).2) ∧
          (∀ w, st = some w → ((wakes cs s ws).due w).isSome ∧ waits (wakes cs s ws) w c = false ∧
            w ≠ c ∧ ∃ k, (wakes cs s ws).writers k = some w) := by
      intro vs s2 hs2
      have h2 : s2.ran c = some { r with seen := r.seen ++ [(k, s.store k)], values := vs } := by
        rw [hs2]; simp
      obtain ⟨seen, vals, st, ws, heq, hstore, hfollow, hstop⟩ :=
        exec_spec cs c (next (s.store k)) (hp' _) s2 _ h2 (by simpa using hs)
      have ew : wakes cs s2 ws = { wakes cs s (ws0 ++ ws) with
          ran := put s.ran c (some { r with seen := r.seen ++ [(k, s.store k)], values := vs }),
          reads := put s.reads c (s.reads c ++ [k]) } := by
        rw [hs2, wakes_with, ← wakes_append, hW]
      refine ⟨(k, s.store k) :: seen, vals, st, ws0 ++ ws, ?_, ?_, ?_, ?_⟩
      · rw [heq, ew, hs2]
        simp [put_put]
      · intro q hq
        rcases List.mem_cons.1 hq with rfl | hq
        · rfl
        · have := hstore q hq; rw [hs2] at this; simpa [wst] using this
      · intro hst
        simp [follow, hfollow hst]
      · intro w hw
        have h3 := hstop w hw
        rw [ew] at h3
        have hwc := waits_ran_reads (wakes cs s (ws0 ++ ws)) (put s.ran c (some
          { r with seen := r.seen ++ [(k, s.store k)], values := vs }))
          (put s.reads c (s.reads c ++ [k])) w c
        rw [hwc] at h3
        exact h3
    have hs1' : ({ W with
          ran := put s.ran c (some { r with seen := r.seen ++ [(k, s.store k)], values := r.values }),
          reads := put s.reads c (s.reads c ++ [k]) } : State K V) =
        { W with
          ran := put s.ran c (some { r with seen := r.seen ++ [(k, s.store k)], values := r.values }),
          reads := put s.reads c (s.reads c ++ [k]) } := rfl
    simp only []
    cases hw : W.writers k with
    | none =>
      exact rest _ _ rfl
    | some w =>
      by_cases hwc : w = c
      · simp only [hwc, ite_true]
        exact rest _ _ rfl
      · simp only [hwc, ite_false]
        have hs2 : edit ({ W with
            ran := put s.ran c (some { r with seen := r.seen ++ [(k, s.store k)], values := r.values }),
            reads := put s.reads c (s.reads c ++ [k]) } : State K V) c
            (fun r => { r with values := ins w r.values }) =
            { W with
              ran := put s.ran c (some { r with seen := r.seen ++ [(k, s.store k)],
                                                values := ins w r.values }),
              reads := put s.reads c (s.reads c ++ [k]) } := by
          simp [edit, put_put]
        rw [hs2]
        split
        · rename_i hcond
          refine ⟨[(k, s.store k)], ins w r.values, some w, ws0, ?_, ?_, ?_, ?_⟩
          · rw [hW]; simp [edit, put_put]
          · simp
          · simp
          · intro w' hw'
            simp only [Option.some.injEq] at hw'
            subst hw'
            simp only [Bool.and_eq_true, Bool.not_eq_eq_eq_not, Bool.not_true] at hcond
            rw [hW]
            refine ⟨hcond.1.1, ?_, hwc, k, hw⟩
            rw [← hcond.1.2]
            exact (waits_ran_reads W _ _ w c).symm
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
  writers : ∀ k w, s'.writers k = some w → s.writers k = some w ∨ (s.ran w).isSome ∨ w < s.made
  store : ∀ k, s'.store k ≠ s.store k → ∀ d, d < s.made → k ∈ s.reads d →
    (s'.due d).isSome ∨ s.looping d = true
  earlies : s'.earlies = s.earlies

theorem Moves.isSome {s s' : State K V} (h : Moves s s') {d : Nat} (hd : (s.due d).isSome) :
    (s'.due d).isSome := by
  obtain ⟨m, hm⟩ := Option.isSome_iff_exists.1 hd
  simp [h.due d m hm]

theorem Moves.refl (s : State K V) : Moves s s :=
  ⟨rfl, rfl, rfl, rfl, rfl, rfl, fun _ _ h => h, fun _ h => Or.inl h, fun _ h => ⟨h, rfl⟩,
    fun _ _ h => Or.inl h, fun _ h => absurd rfl h, rfl⟩

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
    rcases h2.writers k w h with h | h | h
    · exact h1.writers k w h
    · exact Or.inr (Or.inl (h1.ran ▸ h))
    · exact Or.inr (Or.inr (h1.made ▸ h))
  store k hk d hd hr := by
    by_cases e : s'.store k = s.store k
    · have hk' : s''.store k ≠ s'.store k := by rw [e]; exact hk
      rcases h2.store k hk' d (h1.made ▸ hd) (h1.reads ▸ hr) with h | h
      · exact Or.inl h
      · exact Or.inr (h1.looping d h).1
    · rcases h1.store k e d hd hr with h | h
      · exact Or.inl (h2.isSome h)
      · exact Or.inr h
  earlies := h2.earlies.trans h1.earlies

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

theorem settle_form (s : State K V) (d t : Nat) (who : Option Nat) (l : Option (List Nat))
    (fl : Bool) : ∃ a b c e g, settle s d t who l fl =
      { s with cut := a, loop := b, looping := c, due := e, log := g } := by
  unfold settle
  split
  · cases who with
    | none => exact ⟨s.cut, s.loop, s.looping, s.due, s.log, rfl⟩
    | some c => exact ⟨_, s.loop, s.looping, s.due, s.log, rfl⟩
  · dsimp only
    split
    · exact ⟨s.cut, _, s.looping, s.due, s.log, rfl⟩
    · unfold Model.due; split
      · exact ⟨s.cut, _, _, s.due, s.log, rfl⟩
      · exact ⟨s.cut, _, _, _, _, rfl⟩

theorem mark_form (s : State K V) (d t : Nat) (who : Option Nat) :
    ∃ a b c e g k1 k2 k3 k4, mark s d t who = { s with
      cut := a, loop := b, looping := c, due := e, log := g, cause := k1, when := k2, went := k3,
      kept := k4 } := by
  cases who with
  | none =>
    obtain ⟨a, b, c, e, g, h⟩ := settle_form s d t none none false
    simp only [mark]; rw [h]; exact ⟨a, b, c, e, g, _, _, _, _, rfl⟩
  | some w =>
    simp only [mark]
    obtain ⟨a, b, g, k, hc⟩ := causeof_shape s w
    rw [hc]
    simp only []
    obtain ⟨kp, hk⟩ := keep_shape { s with cause := a, when := b, went := g } d k
    rw [hk]
    obtain ⟨a', b', c', e', g', h⟩ := settle_form
      { s with cause := a, when := b, went := g, kept := kp } d t (some w) _ _
    rw [h]
    exact ⟨_, _, _, _, _, _, _, _, _, rfl⟩

@[simp] theorem mark_ran (s : State K V) (d t : Nat) (who : Option Nat) :
    (mark s d t who).ran = s.ran := by
  obtain ⟨_, _, _, _, _, _, _, _, _, h⟩ := mark_form s d t who; rw [h]

@[simp] theorem mark_reads (s : State K V) (d t : Nat) (who : Option Nat) :
    (mark s d t who).reads = s.reads := by
  obtain ⟨_, _, _, _, _, _, _, _, _, h⟩ := mark_form s d t who; rw [h]

@[simp] theorem mark_store (s : State K V) (d t : Nat) (who : Option Nat) :
    (mark s d t who).store = s.store := by
  obtain ⟨_, _, _, _, _, _, _, _, _, h⟩ := mark_form s d t who; rw [h]

@[simp] theorem mark_made (s : State K V) (d t : Nat) (who : Option Nat) :
    (mark s d t who).made = s.made := by
  obtain ⟨_, _, _, _, _, _, _, _, _, h⟩ := mark_form s d t who; rw [h]

@[simp] theorem mark_after (s : State K V) (d t : Nat) (who : Option Nat) :
    (mark s d t who).after = s.after := by
  obtain ⟨_, _, _, _, _, _, _, _, _, h⟩ := mark_form s d t who; rw [h]

@[simp] theorem mark_acts (s : State K V) (d t : Nat) (who : Option Nat) :
    (mark s d t who).acts = s.acts := by
  obtain ⟨_, _, _, _, _, _, _, _, _, h⟩ := mark_form s d t who; rw [h]

@[simp] theorem mark_earlies (s : State K V) (d t : Nat) (who : Option Nat) :
    (mark s d t who).earlies = s.earlies := by
  obtain ⟨_, _, _, _, _, _, _, _, _, h⟩ := mark_form s d t who; rw [h]

@[simp] theorem mark_last (s : State K V) (d t : Nat) (who : Option Nat) :
    (mark s d t who).last = s.last := by
  obtain ⟨_, _, _, _, _, _, _, _, _, h⟩ := mark_form s d t who; rw [h]

@[simp] theorem mark_values (s : State K V) (d t : Nat) (who : Option Nat) :
    (mark s d t who).values = s.values := by
  obtain ⟨_, _, _, _, _, _, _, _, _, h⟩ := mark_form s d t who; rw [h]

@[simp] theorem mark_runs (s : State K V) (d t : Nat) (who : Option Nat) :
    (mark s d t who).runs = s.runs := by
  obtain ⟨_, _, _, _, _, _, _, _, _, h⟩ := mark_form s d t who; rw [h]

@[simp] theorem mark_asleep (s : State K V) (d t : Nat) (who : Option Nat) :
    (mark s d t who).asleep = s.asleep := by
  obtain ⟨_, _, _, _, _, _, _, _, _, h⟩ := mark_form s d t who; rw [h]

@[simp] theorem mark_dying (s : State K V) (d t : Nat) (who : Option Nat) :
    (mark s d t who).dying = s.dying := by
  obtain ⟨_, _, _, _, _, _, _, _, _, h⟩ := mark_form s d t who; rw [h]

@[simp] theorem mark_pulses (s : State K V) (d t : Nat) (who : Option Nat) :
    (mark s d t who).pulses = s.pulses := by
  obtain ⟨_, _, _, _, _, _, _, _, _, h⟩ := mark_form s d t who; rw [h]

@[simp] theorem mark_phase (s : State K V) (d t : Nat) (who : Option Nat) :
    (mark s d t who).phase = s.phase := by
  obtain ⟨_, _, _, _, _, _, _, _, _, h⟩ := mark_form s d t who; rw [h]

@[simp] theorem mark_round (s : State K V) (d t : Nat) (who : Option Nat) :
    (mark s d t who).round = s.round := by
  obtain ⟨_, _, _, _, _, _, _, _, _, h⟩ := mark_form s d t who; rw [h]

@[simp] theorem mark_pulsing (s : State K V) (d t : Nat) (who : Option Nat) :
    (mark s d t who).pulsing = s.pulsing := by
  obtain ⟨_, _, _, _, _, _, _, _, _, h⟩ := mark_form s d t who; rw [h]

@[simp] theorem mark_writers (s : State K V) (d t : Nat) (who : Option Nat) :
    (mark s d t who).writers = s.writers := by
  obtain ⟨_, _, _, _, _, _, _, _, _, h⟩ := mark_form s d t who; rw [h]

@[simp] theorem mark_tick (s : State K V) (d t : Nat) (who : Option Nat) :
    (mark s d t who).tick = s.tick := by
  obtain ⟨_, _, _, _, _, _, _, _, _, h⟩ := mark_form s d t who; rw [h]

theorem marks_form (t : Nat) (r : Option Nat) : ∀ (ds : List Nat) (s : State K V),
    ∃ a b c e g k1 k2 k3 k4, ds.foldl (fun s d => mark s d t r) s = { s with
      cut := a, loop := b, looping := c, due := e, log := g, cause := k1, when := k2, went := k3,
      kept := k4 }
  | [], s => ⟨_, _, _, _, _, _, _, _, _, rfl⟩
  | d :: ds, s => by
    simp only [List.foldl_cons]
    obtain ⟨_, _, _, _, _, _, _, _, _, h1⟩ := mark_form s d t r
    obtain ⟨_, _, _, _, _, _, _, _, _, h2⟩ := marks_form t r ds (mark s d t r)
    rw [h2, h1]
    exact ⟨_, _, _, _, _, _, _, _, _, rfl⟩

theorem changed_form (cs : Nat → Comp K V) (s : State K V) (keys : List K) (who : Option Nat) :
    ∃ a b c e g k1 k2 k3 k4 w tk, changed cs s keys who = { s with
      cut := a, loop := b, looping := c, due := e, log := g, cause := k1, when := k2, went := k3,
      kept := k4, writers := w, tick := tk } := by
  simp only [changed]
  generalize s.tick + 1 = t
  generalize runof { s with tick := t } who = r
  generalize (r.filter fun c => match (cs c).kind with
    | .compute _ => true | .effect _ => false) = w
  suffices ∀ (ks : List K) (s1 : State K V), ∃ a b c e g k1 k2 k3 k4 w' tk,
      ks.foldl (fun s k => tell (learn s k w) k t r) s1 = { s1 with
        cut := a, loop := b, looping := c, due := e, log := g, cause := k1, when := k2,
        went := k3, kept := k4, writers := w', tick := tk } by
    obtain ⟨_, _, _, _, _, _, _, _, _, _, _, h⟩ := this keys { s with tick := t }
    rw [h]; exact ⟨_, _, _, _, _, _, _, _, _, _, _, rfl⟩
  intro ks
  induction ks with
  | nil => intro s1; exact ⟨_, _, _, _, _, _, _, _, _, _, _, rfl⟩
  | cons k ks ih =>
    intro s1
    simp only [List.foldl_cons]
    have hl : ∃ w', learn s1 k w = { s1 with writers := w' } := by
      cases w <;> exact ⟨_, rfl⟩
    obtain ⟨w', hl⟩ := hl
    obtain ⟨_, _, _, _, _, _, _, _, _, h1⟩ := marks_form t r (readers (learn s1 k w) k) (learn s1 k w)
    obtain ⟨_, _, _, _, _, _, _, _, _, _, _, h2⟩ := ih (tell (learn s1 k w) k t r)
    rw [h2]; simp only [tell] at h1 ⊢; rw [h1, hl]
    exact ⟨_, _, _, _, _, _, _, _, _, _, _, rfl⟩

@[simp] theorem changed_ran (cs : Nat → Comp K V) (s : State K V) (keys : List K)
    (who : Option Nat) : (changed cs s keys who).ran = s.ran := by
  obtain ⟨_, _, _, _, _, _, _, _, _, _, _, h⟩ := changed_form cs s keys who; rw [h]

@[simp] theorem changed_reads (cs : Nat → Comp K V) (s : State K V) (keys : List K)
    (who : Option Nat) : (changed cs s keys who).reads = s.reads := by
  obtain ⟨_, _, _, _, _, _, _, _, _, _, _, h⟩ := changed_form cs s keys who; rw [h]

@[simp] theorem changed_store (cs : Nat → Comp K V) (s : State K V) (keys : List K)
    (who : Option Nat) : (changed cs s keys who).store = s.store := by
  obtain ⟨_, _, _, _, _, _, _, _, _, _, _, h⟩ := changed_form cs s keys who; rw [h]

@[simp] theorem changed_made (cs : Nat → Comp K V) (s : State K V) (keys : List K)
    (who : Option Nat) : (changed cs s keys who).made = s.made := by
  obtain ⟨_, _, _, _, _, _, _, _, _, _, _, h⟩ := changed_form cs s keys who; rw [h]

@[simp] theorem changed_after (cs : Nat → Comp K V) (s : State K V) (keys : List K)
    (who : Option Nat) : (changed cs s keys who).after = s.after := by
  obtain ⟨_, _, _, _, _, _, _, _, _, _, _, h⟩ := changed_form cs s keys who; rw [h]

@[simp] theorem changed_acts (cs : Nat → Comp K V) (s : State K V) (keys : List K)
    (who : Option Nat) : (changed cs s keys who).acts = s.acts := by
  obtain ⟨_, _, _, _, _, _, _, _, _, _, _, h⟩ := changed_form cs s keys who; rw [h]

@[simp] theorem changed_earlies (cs : Nat → Comp K V) (s : State K V) (keys : List K)
    (who : Option Nat) : (changed cs s keys who).earlies = s.earlies := by
  obtain ⟨_, _, _, _, _, _, _, _, _, _, _, h⟩ := changed_form cs s keys who; rw [h]

@[simp] theorem changed_last (cs : Nat → Comp K V) (s : State K V) (keys : List K)
    (who : Option Nat) : (changed cs s keys who).last = s.last := by
  obtain ⟨_, _, _, _, _, _, _, _, _, _, _, h⟩ := changed_form cs s keys who; rw [h]

@[simp] theorem changed_values (cs : Nat → Comp K V) (s : State K V) (keys : List K)
    (who : Option Nat) : (changed cs s keys who).values = s.values := by
  obtain ⟨_, _, _, _, _, _, _, _, _, _, _, h⟩ := changed_form cs s keys who; rw [h]

@[simp] theorem changed_runs (cs : Nat → Comp K V) (s : State K V) (keys : List K)
    (who : Option Nat) : (changed cs s keys who).runs = s.runs := by
  obtain ⟨_, _, _, _, _, _, _, _, _, _, _, h⟩ := changed_form cs s keys who; rw [h]

@[simp] theorem changed_asleep (cs : Nat → Comp K V) (s : State K V) (keys : List K)
    (who : Option Nat) : (changed cs s keys who).asleep = s.asleep := by
  obtain ⟨_, _, _, _, _, _, _, _, _, _, _, h⟩ := changed_form cs s keys who; rw [h]

@[simp] theorem changed_dying (cs : Nat → Comp K V) (s : State K V) (keys : List K)
    (who : Option Nat) : (changed cs s keys who).dying = s.dying := by
  obtain ⟨_, _, _, _, _, _, _, _, _, _, _, h⟩ := changed_form cs s keys who; rw [h]

@[simp] theorem changed_pulses (cs : Nat → Comp K V) (s : State K V) (keys : List K)
    (who : Option Nat) : (changed cs s keys who).pulses = s.pulses := by
  obtain ⟨_, _, _, _, _, _, _, _, _, _, _, h⟩ := changed_form cs s keys who; rw [h]

@[simp] theorem changed_phase (cs : Nat → Comp K V) (s : State K V) (keys : List K)
    (who : Option Nat) : (changed cs s keys who).phase = s.phase := by
  obtain ⟨_, _, _, _, _, _, _, _, _, _, _, h⟩ := changed_form cs s keys who; rw [h]

@[simp] theorem changed_round (cs : Nat → Comp K V) (s : State K V) (keys : List K)
    (who : Option Nat) : (changed cs s keys who).round = s.round := by
  obtain ⟨_, _, _, _, _, _, _, _, _, _, _, h⟩ := changed_form cs s keys who; rw [h]

@[simp] theorem changed_pulsing (cs : Nat → Comp K V) (s : State K V) (keys : List K)
    (who : Option Nat) : (changed cs s keys who).pulsing = s.pulsing := by
  obtain ⟨_, _, _, _, _, _, _, _, _, _, _, h⟩ := changed_form cs s keys who; rw [h]

-- a mark by an unflagged run (or from outside): moves, and leaves d due or looping
theorem mark_moves (s : State K V) (d t : Nat) (who : Option Nat) (hd : d < s.made)
    (hw : ∀ c, who = some c → ((s.ran c).bind (·.loop)) = none) :
    Moves s (mark s d t who) ∧ (((mark s d t who).due d).isSome ∨ s.looping d = true) := by
  -- settle on a state with s's runs, reads and dues, given an unflagged loop
  have key : ∀ (s1 : State K V) (who : Option Nat) (l : Option (List Nat)), s1.made = s.made →
      s1.reads = s.reads → s1.ran = s.ran → s1.after = s.after → s1.acts = s.acts →
      s1.last = s.last → s1.due = s.due → s1.looping = s.looping → s1.writers = s.writers →
      s1.store = s.store → s1.earlies = s.earlies →
      Moves s (settle s1 d t who l false) ∧
        (((settle s1 d t who l false).due d).isSome ∨ s.looping d = true) := by
    intro s1 who l e1 e2 e3 e4 e5 e6 e7 e8 e9 e10 e11
    simp only [settle, Bool.and_false, Bool.false_eq_true, ite_false]
    split
    · rename_i h
      simp only [Bool.and_eq_true] at h
      refine ⟨⟨e1, e2, e3, e4, e5, e6, ?_, ?_, ?_, ?_, ?_, ?_⟩, Or.inr (by simpa [e8] using h.1)⟩
      · intro x m hx; simpa [e7] using hx
      · intro x hx; simp [e7] at hx; exact Or.inl hx
      · intro x hx; simp [e8, e7] at hx ⊢; exact hx
      · intro k w hk; simp [e9] at hk; exact Or.inl hk
      · intro k hk; simp [e10] at hk
      · exact e11
    · simp only [due]
      split
      · rename_i hdue
        refine ⟨⟨e1, e2, e3, e4, e5, e6, ?_, ?_, ?_, ?_, ?_, ?_⟩, Or.inl (by simpa [e7] using hdue)⟩
        · intro x m hx; simpa [e7] using hx
        · intro x hx; simp [e7] at hx; exact Or.inl hx
        · intro x hx
          by_cases hxd : x = d
          · subst hxd; simp at hx
          · simp [put_ne _ _ hxd, e8, e7] at hx ⊢; exact hx
        · intro k w hk; simp [e9] at hk; exact Or.inl hk
        · intro k hk; simp [e10] at hk
        · exact e11
      · rename_i hdue
        refine ⟨⟨by simp [say, e1], by simp [say, e2], by simp [say, e3], by simp [say, e4],
          by simp [say, e5], by simp [say, e6], ?_, ?_, ?_, ?_, ?_, ?_⟩, Or.inl (by simp [say])⟩
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
        · simp [say, e11]
  cases who with
  | none => exact key s none none rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl
  | some c =>
    simp only [mark]
    obtain ⟨a, b, g, k, hc⟩ := causeof_shape s c
    rw [hc]
    simp only []
    obtain ⟨kp, hk⟩ := keep_shape { s with cause := a, when := b, went := g } d k
    rw [hk]
    have hf : (((s.ran c).bind (·.loop)).isSome) = false := by simp [hw c rfl]
    simp only [hf]
    exact key _ _ _ rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl

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
      ?_, fun _ h => absurd rfl h, rfl⟩
    intro k' w' h
    by_cases hk : k' = k
    · subst hk; simp [learn] at h; subst h; exact Or.inr (Or.inl (hw c rfl))
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
      fun _ _ h => Or.inl h, fun _ h => absurd rfl h, rfl⟩
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
  refine ⟨m.made, m.reads, m.ran, m.after, m.acts, m.last, m.due, m.fresh, m.looping, m.writers, ?_,
    m.earlies⟩
  intro k' hk d hd hr
  by_cases e : (changed cs (store s k v) [k] who).store k' = (store s k v).store k'
  · have hk' : k' = k := by
      refine Classical.byContradiction fun hne => ?_
      rw [e] at hk
      simp [store, put_ne _ _ hne] at hk
    subst hk'
    exact h k' (by simp) d hd hr
  · exact m.store k' e d hd hr

-- untrack moves only the going
theorem untrack1_shape (cs : Nat → Comp K V) (s : State K V) (k : K) :
    ∃ dy, untrack1 cs s k = { s with dying := dy } := by
  unfold untrack1
  split
  · exact ⟨s.dying, rfl⟩
  · split
    · split
      · exact ⟨_, rfl⟩
      · exact ⟨s.dying, rfl⟩
    · exact ⟨s.dying, rfl⟩

theorem untrack_shape (cs : Nat → Comp K V) : ∀ (ks : List K) (s : State K V),
    ∃ dy, untrack cs s ks = { s with dying := dy }
  | [], s => ⟨s.dying, rfl⟩
  | k :: ks, s => by
    simp only [untrack, List.foldl_cons]
    obtain ⟨dy, h1⟩ := untrack1_shape cs s k
    rw [h1]
    obtain ⟨dy', h2⟩ := untrack_shape cs ks { s with dying := dy }
    simp only [untrack] at h2
    rw [h2]
    exact ⟨dy', rfl⟩

@[simp] theorem untrack_ran (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).ran = s.ran := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

@[simp] theorem untrack_reads (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).reads = s.reads := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

@[simp] theorem untrack_store (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).store = s.store := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

@[simp] theorem untrack_made (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).made = s.made := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

@[simp] theorem untrack_after (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).after = s.after := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

@[simp] theorem untrack_acts (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).acts = s.acts := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

@[simp] theorem untrack_earlies (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).earlies = s.earlies := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

@[simp] theorem untrack_last (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).last = s.last := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

@[simp] theorem untrack_values (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).values = s.values := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

@[simp] theorem untrack_kept (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).kept = s.kept := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

@[simp] theorem untrack_went (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).went = s.went := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

@[simp] theorem untrack_cause (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).cause = s.cause := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

@[simp] theorem untrack_when (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).when = s.when := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

@[simp] theorem untrack_cut (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).cut = s.cut := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

@[simp] theorem untrack_runs (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).runs = s.runs := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

@[simp] theorem untrack_pulses (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).pulses = s.pulses := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

@[simp] theorem untrack_pulsing (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).pulsing = s.pulsing := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

@[simp] theorem untrack_phase (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).phase = s.phase := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

@[simp] theorem untrack_round (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).round = s.round := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

@[simp] theorem untrack_due (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).due = s.due := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

@[simp] theorem untrack_writers (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).writers = s.writers := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

@[simp] theorem untrack_looping (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).looping = s.looping := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

@[simp] theorem untrack_loop (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).loop = s.loop := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

@[simp] theorem untrack_asleep (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).asleep = s.asleep := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

@[simp] theorem untrack_tick (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).tick = s.tick := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

@[simp] theorem untrack_log (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    (untrack cs s ks).log = s.log := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

theorem untrack_eq (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    untrack cs s ks = { s with dying := (untrack cs s ks).dying } := by
  obtain ⟨_, h⟩ := untrack_shape cs ks s; rw [h]

-- a mark from outside moves only the one marked
theorem mark_none_other (s : State K V) (d t x : Nat) (hx : x ≠ d) :
    (mark s d t none).due x = s.due x ∧ (mark s d t none).looping x = s.looping x ∧
      (mark s d t none).asleep = s.asleep := by
  simp only [mark, settle, Option.isSome_none, Bool.and_false, Bool.false_eq_true, ite_false, due,
    say]
  split <;> simp [put_ne _ _ hx]

-- wakes leave what is not asleep as it is: not due more, its loop as it was
theorem wake_keep (cs : Nat → Comp K V) (s : State K V) (k : K) (c : Nat) (hc : s.asleep c = false) :
    (wake cs s k).due c = s.due c ∧ (wake cs s k).looping c = s.looping c ∧
      (wake cs s k).asleep c = false := by
  unfold wake
  cases attending cs s.made k with
  | none => exact ⟨rfl, rfl, hc⟩
  | some a =>
    simp only
    split
    · rename_i ha
      have hac : c ≠ a := by intro e; subst e; simp_all
      obtain ⟨h1, h2, h3⟩ := mark_none_other { s with
        asleep := put s.asleep a false,
        writers := put s.writers k (some a), tick := s.tick + 1 } a (s.tick + 1) c hac
      rw [h1, h2, h3]
      exact ⟨rfl, rfl, by simp [put_ne _ _ hac, hc]⟩
    · exact ⟨rfl, rfl, hc⟩

theorem wakes_keep (cs : Nat → Comp K V) (c : Nat) : ∀ (ws : List K) (s : State K V),
    s.asleep c = false →
    (wakes cs s ws).due c = s.due c ∧ (wakes cs s ws).looping c = s.looping c ∧
      (wakes cs s ws).asleep c = false
  | [], s, hc => ⟨rfl, rfl, hc⟩
  | k :: ws, s, hc => by
    obtain ⟨h1, h2, h3⟩ := wake_keep cs s k c hc
    obtain ⟨h4, h5, h6⟩ := wakes_keep cs c ws (wake cs s k) h3
    simp only [wakes, List.foldl_cons] at h4 h5 h6 ⊢
    exact ⟨h4.trans h1, h5.trans h2, h6⟩

-- nothing asleep: a wake does nothing
theorem wake_awake (cs : Nat → Comp K V) (s : State K V) (k : K) (hz : ∀ x, s.asleep x = false) :
    wake cs s k = s := by
  unfold wake
  cases attending cs s.made k with
  | none => rfl
  | some a => simp [hz a]

-- a wake moves
theorem wake_moves (cs : Nat → Comp K V) (s : State K V) (k : K) : Moves s (wake cs s k) := by
  unfold wake
  cases ha : attending cs s.made k with
  | none => exact Moves.refl s
  | some a =>
    have hlt := attending_lt ha
    simp only
    split
    · generalize hs2 : ({ s with
        asleep := put s.asleep a false,
        writers := put s.writers k (some a), tick := s.tick + 1 } : State K V) = s2
      have m2 : Moves s s2 := by
        subst hs2
        refine ⟨rfl, rfl, rfl, rfl, rfl, rfl, fun _ _ h => h, fun _ h => Or.inl h,
          fun _ h => ⟨h, rfl⟩, ?_, fun _ h => absurd rfl h, rfl⟩
        intro k' w h
        by_cases hk : k' = k
        · subst hk; simp at h; subst h; exact Or.inr (Or.inr hlt)
        · simp [put_ne _ _ hk] at h; exact Or.inl h
      have := (mark_moves s2 a (s.tick + 1) none (by rw [← hs2]; exact hlt) (by simp)).1
      exact m2.trans this
    · exact Moves.refl s

theorem wakes_moves (cs : Nat → Comp K V) : ∀ (ws : List K) (s : State K V), Moves s (wakes cs s ws)
  | [], s => Moves.refl s
  | k :: ws, s => (wake_moves cs s k).trans (wakes_moves cs ws (wake cs s k))

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
  -- a run's end gives back what it was given (finish): no latest run holds a given
  given : ∀ c r, s.ran c = some r → r.given = []

-- and of the acts and lasts
structure Good (cs : Nat → Comp K V) (s : State K V) : Prop extends Core cs s where
  -- an act queued (early or not): its effect's latest run, unflagged, done with that value
  acts : ∀ e v, (e, v) ∈ queue s → iseffect (cs e) = true ∧ ∃ r, s.ran e = some r ∧
    r.loop = none ∧ r.ended = some .done ∧ r.out = some (.value v)
  -- a compute done: its last is its value, or equal to it
  computes : ∀ c r, iseffect (cs c) = false → s.ran c = some r → r.ended = some .done →
    ∃ v, r.out = some (.value v) ∧ near (cs c).equal v (s.last c)
  -- an effect done: acted on (or equal), or its act queued, or due again
  effects : ∀ e r, iseffect (cs e) = true → s.ran e = some r → r.ended = some .done →
    ∃ v, r.out = some (.value v) ∧
      (near (cs e).equal v (s.last e) ∨ (e, v) ∈ queue s ∨ (s.due e).isSome)
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
    rcases m.writers k w h with h | h | h
    · exact m.made ▸ g.writers_made k w h
    · exact m.made ▸ g.ran_made w h
    · exact m.made ▸ h
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
  given c r h := g.given c r (m.ran ▸ h)

theorem Good.moves {cs : Nat → Comp K V} {s s' : State K V} (g : Good cs s) (m : Moves s s') :
    Good cs s' where
  toCore := g.toCore.moves m
  acts e v h := by
    rw [queue, m.acts, m.earlies] at h
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
    · exact Or.inr (Or.inl (by rw [queue, m.acts, m.earlies]; exact h2))
    · exact Or.inr (Or.inr (m.isSome h2))
  failed c r h hf := m.last ▸ g.failed c r (m.ran ▸ h) hf

-- a state with the same everything the invariant reads
theorem Moves.of_eq {s s' : State K V} (e1 : s'.store = s.store) (e2 : s'.made = s.made)
    (e3 : s'.reads = s.reads) (e4 : s'.writers = s.writers) (e5 : s'.after = s.after)
    (e6 : s'.due = s.due) (e7 : s'.ran = s.ran) (e8 : s'.looping = s.looping)
    (e9 : s'.acts = s.acts) (e10 : s'.last = s.last)
    (e11 : s'.earlies = s.earlies := by first | rfl | assumption | simp_all) : Moves s s' :=
  ⟨e2, e3, e7, e5, e9, e10, fun _ _ h => e6 ▸ h, fun _ h => Or.inl (e6 ▸ h),
    fun _ h => ⟨e8 ▸ h, e6 ▸ rfl⟩, fun _ _ h => Or.inl (e4 ▸ h), fun _ h => absurd (e1 ▸ rfl) h, e11⟩

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
  given c r h := by simp [Model.empty] at h
  acts e v h := by simp [Model.empty, queue] at h
  computes c r _ h := by simp [Model.empty] at h
  effects e r _ h := by simp [Model.empty] at h
  failed c r h := by simp [Model.empty] at h

theorem Good.begin {cs : Nat → Comp K V} {s : State K V} (g : Good cs s) : Good cs (begin s) :=
  g.moves (Moves.of_eq rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl)

theorem Good.close {cs : Nat → Comp K V} {s : State K V} (g : Good cs s) : Good cs (close s) :=
  g.moves (Moves.of_eq rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl)

-- a change said by an unflagged run (or from outside)
theorem Good.tell {cs : Nat → Comp K V} {s : State K V} (g : Good cs s) (keys : List K)
    (who : Option Nat) (hw : ∀ c, who = some c → ((s.ran c).bind (·.loop)) = none) :
    Good cs (changed cs s keys who) :=
  g.moves (changed_moves cs s keys who hw).1

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

-- the keys written, then said changed by an unflagged run (or from outside)
theorem Good.told {cs : Nat → Comp K V} {s : State K V} (g : Good cs s) (kvs : List (K × V))
    (who : Option Nat) (hw : ∀ c, who = some c → ((s.ran c).bind (·.loop)) = none) :
    Good cs (changed cs (kvs.foldl (fun s kv => store s kv.1 kv.2) s) (kvs.map (·.1)) who) := by
  obtain ⟨st, h1, h2⟩ := stores_shape s kvs
  rw [h1]
  obtain ⟨m, h⟩ := changed_moves cs { s with store := st } (kvs.map (·.1)) who hw
  refine g.moves ⟨m.made, m.reads, m.ran, m.after, m.acts, m.last, m.due, m.fresh, m.looping,
    m.writers, ?_, m.earlies⟩
  intro k hk d hd hr
  by_cases e : (changed cs { s with store := st } (kvs.map (·.1)) who).store k = st k
  · rw [e] at hk
    exact h k (h2 k hk) d hd hr
  · exact m.store k e d hd hr

theorem Good.write {cs : Nat → Comp K V} {s : State K V} (g : Good cs s) (kvs : List (K × V)) :
    Good cs (write cs s kvs) :=
  g.told kvs none (by simp)

theorem Good.grow {cs : Nat → Comp K V} {s : State K V} (g : Good cs s) :
    Good cs (Model.grow cs s) := by
  have g1' : Good cs (Model.grow cs s) := by
    simp only [Model.grow]
    have core : ∀ (s' : State K V), s'.made = s.made + 1 → s'.store = s.store → s'.reads = s.reads →
        s'.after = s.after → s'.due = s.due → s'.ran = s.ran → s'.looping = s.looping →
        s'.acts = s.acts → s'.last = s.last → (∀ k w, s'.writers k = some w → w < s.made + 1) →
        s'.earlies = s.earlies → Good cs s' := by
      intro s' e1 e2 e3 e4 e5 e6 e7 e8 e9 e10 e11
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
        given := fun c r h => g.given c r (e6 ▸ h)
        acts := fun e v h => by
          obtain ⟨h1, r, h2⟩ := g.acts e v (by rw [queue, e8, e11] at h; exact h)
          exact ⟨h1, r, e6 ▸ h2⟩
        computes := fun c r hc h hd => by
          obtain ⟨v, h1, h2⟩ := g.computes c r hc (e6 ▸ h) hd
          exact ⟨v, h1, e9 ▸ h2⟩
        effects := fun e r he h hd => by
          obtain ⟨v, h1, h2⟩ := g.effects e r he (e6 ▸ h) hd
          refine ⟨v, h1, ?_⟩
          rw [queue, e8, e11, e9, e5]; rw [queue] at h2; exact h2
        failed := fun c r h hf => e9 ▸ g.failed c r (e6 ▸ h) hf }
    split
    · rename_i k _
      refine core _ rfl rfl rfl rfl rfl rfl rfl rfl rfl (fun k' w h => ?_) rfl
      by_cases e : k' = k
      · subst e; simp at h; omega
      · simp [put_ne _ _ e] at h; have := g.writers_made k' w h; omega
    · exact core _ rfl rfl rfl rfl rfl rfl rfl rfl rfl (fun k w h => by
        have := g.writers_made k w h; omega) rfl
  exact g1'

-- the core does not read acts, lasts or the log
theorem Core.with {cs : Nat → Comp K V} {s : State K V} (g : Core cs s) (a : List (Nat × V))
    (l : Nat → Option V) (lg : List (Entry V)) : Core cs { s with acts := a, last := l, log := lg } :=
  ⟨g.1, g.2, g.3, g.4, g.5, g.6, g.7, g.8, g.9, g.10, g.11⟩

theorem Core.with2 {cs : Nat → Comp K V} {s : State K V} (g : Core cs s) (es a : List (Nat × V))
    (l : Nat → Option V) (lg : List (Entry V)) :
    Core cs { s with earlies := es, acts := a, last := l, log := lg } :=
  ⟨g.1, g.2, g.3, g.4, g.5, g.6, g.7, g.8, g.9, g.10, g.11⟩

-- an act: its effect not due, it acts on its run's value; due, it is skipped. s0 is s with its act
-- taken out of the queue (the head of one of the two, or by filter), what else is queued kept
theorem Good.act {cs : Nat → Comp K V} {s s0 : State K V} (g : Good cs s) {e : Nat} {v : V}
    {es as : List (Nat × V)} (h0 : s0 = { s with earlies := es, acts := as })
    (hin : (e, v) ∈ queue s) (hsub : ∀ x ∈ queue s0, x ∈ queue s)
    (hkeep : ∀ x ∈ queue s, x.1 ≠ e → x ∈ queue s0) :
    Good cs (act cs s0 e v) := by
  obtain ⟨he, r0, hr0, hl0, hd0, ho0⟩ := g.acts e v hin
  subst h0
  -- the effects other than e, and e when due, in a state whose queue is s0's
  simp only [Model.act]
  split
  · rename_i hdue
    exact {
      toCore := g.toCore.with2 es as s.last s.log
      acts := fun e' v' h => g.acts e' v' (hsub _ h)
      computes := fun c r hc h hd => g.computes c r hc h hd
      effects := fun e' r he' h hd => by
        obtain ⟨v', h1, h2⟩ := g.effects e' r he' h hd
        refine ⟨v', h1, ?_⟩
        by_cases ee : e' = e
        · subst ee; exact Or.inr (Or.inr hdue)
        · rcases h2 with h2 | h2 | h2
          · exact Or.inl h2
          · exact Or.inr (Or.inl (hkeep _ h2 ee))
          · exact Or.inr (Or.inr h2)
      failed := fun c r h hf => g.failed c r h hf }
  · rename_i hdue
    have hk : ∃ g', (cs e).kind = .effect g' := by
      simp only [iseffect] at he; split at he
      · exact ⟨_, ‹_›⟩
      · cases he
    obtain ⟨act', hk⟩ := hk
    simp only [hk]
    generalize hs1 : say { s with earlies := es, acts := as } (.act e v (s.last e)) = s1
    have c1 : Core cs s1 := by rw [← hs1]; exact g.toCore.with2 es as s.last _
    have e1 : s1.ran = s.ran := by rw [← hs1]; rfl
    have e2 : queue s1 = queue { s with earlies := es, acts := as } := by rw [← hs1]; rfl
    have e3 : s1.last = s.last := by rw [← hs1]; rfl
    have e4 : s1.due = s.due := by rw [← hs1]; rfl
    have m := writes_moves cs e (act' v (s.last e)) s1 (by rw [e1, hr0]; simp [hl0])
    generalize hs2 : (act' v (s.last e)).foldl
      (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some e)) s1 = s2 at m
    have c2 := c1.moves m
    have q2 : queue s2 = queue s1 := by rw [queue, queue, m.acts, m.earlies]
    exact {
      toCore := c2.with2 _ _ _ _
      acts := fun e' v' h => by
        have h' : (e', v') ∈ queue { s with earlies := es, acts := as } := by
          rw [← e2, ← q2]; simpa [queue, say] using h
        obtain ⟨h1, r, h2⟩ := g.acts e' v' (hsub _ h')
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
          · refine Or.inr (Or.inl ?_)
            have := hkeep _ h2 ee
            rw [← e2, ← q2] at this
            simpa [queue, say] using this
          · exact Or.inr (Or.inr (by
              have := m.isSome (show (s1.due e').isSome from by rw [e4]; exact h2)
              simpa [say] using this))
      failed := fun c r h hf => by
        have h' : s.ran c = some r := by simpa [say, m.ran, e1] using h
        have hce : c ≠ e := by
          intro ce; subst ce; rw [hr0] at h'; cases h'; rw [hd0] at hf; cases hf
        have := g.failed c r h' hf
        simpa [say, put_ne _ _ hce, m.last, e3] using this }

-- the head of the early queue, or of the other with the early empty, acted on
theorem Good.acthead {cs : Nat → Comp K V} {s : State K V} (g : Good cs s) {e : Nat} {v : V}
    {rest : List (Nat × V)} :
    (s.earlies = (e, v) :: rest → Good cs (Model.act cs { s with earlies := rest } e v)) ∧
    (s.earlies = [] → s.acts = (e, v) :: rest → Good cs (Model.act cs { s with acts := rest } e v)) := by
  constructor
  · intro h
    exact Good.act g (es := rest) (as := s.acts) rfl (by simp [queue, h])
      (fun x hx => by
        simp only [queue, h, List.mem_append, List.mem_cons] at hx ⊢
        rcases hx with h1 | h1 <;> simp_all)
      (fun x hx hne => by
        simp only [queue, h, List.mem_append, List.mem_cons] at hx ⊢
        rcases hx with (h1 | h1) | h1
        · subst h1; exact absurd rfl hne
        · exact Or.inl h1
        · exact Or.inr h1)
  · intro h1 h2
    exact Good.act g (es := s.earlies) (as := rest) rfl (by simp [queue, h1, h2])
      (fun x hx => by
        simp only [queue, h1, h2, List.mem_append, List.mem_cons, List.nil_append] at hx ⊢
        exact Or.inr hx)
      (fun x hx hne => by
        simp only [queue, h1, h2, List.mem_append, List.mem_cons, List.nil_append] at hx ⊢
        rcases hx with h3 | h3
        · subst h3; exact absurd rfl hne
        · exact h3)

-- runs

-- c's new run, as it is at f's end
def begun (s : State K V) (c : Nat) (vals : List Nat) (st : Option Nat)
    (seen : List (K × Option V)) : Run K V :=
  { n := s.runs c + 1, mark := (s.due c).getD 0, given := s.kept c, loop := s.loop c,
    values := vals, stopped := st, seen := seen }

-- a run, A2: start, f read along the store, the end; what the state is when it is told how f ended.
-- c not asleep: what its reads wake are others, made due from outside, their keys' writers
theorem first_spec (cs : Nat → Comp K V) (s : State K V) (c rk : Nat) (hp : nowrites (cs c).f)
    (hz : s.asleep c = false) :
    ∃ (s3 : State K V) (o : Out V) (seen : List (K × Option V)) (vals : List Nat)
      (st : Option Nat),
      first cs s c rk = ending cs s3 c o ∧
      s3.ran = put s.ran c (some (begun s c vals st seen)) ∧
      s3.reads = put s.reads c (seen.map (·.1)) ∧
      s3.store = s.store ∧ s3.made = s.made ∧ s3.last = s.last ∧
      s3.after = put s.after c none ∧
      s3.acts = s.acts.filter (fun a => a.1 ≠ c) ∧ s3.earlies = s.earlies.filter (fun a => a.1 ≠ c) ∧
      s3.cut c = false ∧ s3.due c = none ∧ s3.looping c = s.looping c ∧
      (∀ d m, d ≠ c → s.due d = some m → s3.due d = some m) ∧
      (∀ d, (s3.due d).isSome → (s.due d).isSome ∨ d < s.made) ∧
      (∀ d, d ≠ c → s3.looping d = true → s.looping d = true ∧ s3.due d = s.due d) ∧
      (∀ k w, s3.writers k = some w →
        s.writers k = some w ∨ (s.ran w).isSome ∨ w = c ∨ w < s.made) ∧
      (∀ q ∈ seen, s.store q.1 = q.2) ∧
      (st = none → follow (cs c).f seen = some o) ∧
      (∀ w, st = some w → (s3.due w).isSome ∧ waits (start s c rk) w c = false ∧ w ≠ c ∧
        ∃ k, s3.writers k = some w) := by
  have h0 : (start s c rk).ran c = some (begun s c [] none []) := by simp [start, say, begun]
  obtain ⟨seen, vals, st, ws, heq, hst, hfo, hstop⟩ :=
    exec_spec cs c (cs c).f hp (start s c rk) _ h0 rfl
  simp only [first]
  generalize hx : exec cs c (start s c rk) (cs c).f = x at heq hfo
  obtain ⟨s2, o⟩ := x
  simp only at heq hfo
  subst heq
  generalize hW : wakes cs (start s c rk) ws = W at hstop
  have m : Moves (start s c rk) W := hW ▸ wakes_moves cs ws (start s c rk)
  have hzs : (start s c rk).asleep c = false := by simp [start, say, hz]
  obtain ⟨k1, k2, _⟩ := wakes_keep cs c ws (start s c rk) hzs
  rw [hW] at k1 k2
  have e_ran : W.ran = (start s c rk).ran := by rw [← hW]; simp
  have e_reads : W.reads = (start s c rk).reads := by rw [← hW]; simp
  have hst0 : ∀ d, (start s c rk).due d = put s.due c none d := by intro d; simp [start, say]
  refine ⟨_, o, seen, vals, st, rfl, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_,
    ?_, ?_, ?_⟩
  · simp [start, say, put_put, begun]
  · simp [start, say, put_put, begun]
  · rw [← hW]; simp [start, say]
  · rw [← hW]; simp [start, say]
  · rw [← hW]; simp [start, say]
  · rw [← hW]; simp [start, say]
  · rw [← hW]; simp [start, say]
  · rw [← hW]; simp [start, say]
  · rw [← hW]; simp [start, say]
  · simp [k1, start, say]
  · simp [k2, start, say]
  · intro d n hd h
    simp only [untrack_due]
    exact m.due d n (by rw [hst0, put_ne _ _ hd]; exact h)
  · intro d h
    simp only [untrack_due] at h
    rcases m.fresh d h with h | h
    · by_cases hd : d = c
      · subst hd; rw [hst0] at h; simp at h
      · rw [hst0, put_ne _ _ hd] at h; exact Or.inl h
    · exact Or.inr (by simpa [start, say] using h)
  · intro d hd h
    simp only [untrack_due, untrack_looping] at h ⊢
    obtain ⟨h1, h2⟩ := m.looping d h
    refine ⟨by simpa [start, say] using h1, ?_⟩
    rw [h2, hst0, put_ne _ _ hd]
  · intro k w h
    simp only [untrack_writers] at h
    rcases m.writers k w h with h | h | h
    · exact Or.inl (by simpa [start, say] using h)
    · by_cases hw : w = c
      · exact Or.inr (Or.inr (Or.inl hw))
      · exact Or.inr (Or.inl (by simpa [start, say, put_ne _ _ hw] using h))
    · exact Or.inr (Or.inr (Or.inr (by simpa [start, say] using h)))
  · exact hst
  · exact hfo
  · intro w hw
    obtain ⟨h1, h2, h3, k, h4⟩ := hstop w hw
    refine ⟨by simpa using h1, ?_, h3, k, by simpa using h4⟩
    rw [← h2]
    exact (waits_congr (by rw [← hW]; simp) (by rw [← hW]; simp) w c).symm

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
  writers : ∀ k w, F.writers k = some w →
    s.writers k = some w ∨ (s.ran w).isSome ∨ w = c ∨ w < s.made
  store : ∀ k, F.store k ≠ s.store k → ∀ d, d < s.made → d ≠ c → k ∈ s.reads d →
    (F.due d).isSome ∨ s.looping d = true
  follows : rf.ended ≠ some .stopped → ∃ o, rf.out = some o ∧ follow (cs c).f rf.seen = some o
  fresh_c : F.due c = none → settled rf → ∀ q ∈ rf.seen, F.store q.1 = q.2
  pending : rf.ended = some .pending → rf.out = some .pending
  given : rf.given = []
  acts : ∀ e v, (e, v) ∈ queue F → (e ≠ c ∧ (e, v) ∈ queue s) ∨
    (e = c ∧ iseffect (cs c) = true ∧ rf.loop = none ∧ rf.ended = some .done ∧
      rf.out = some (.value v))
  acts_keep : ∀ e v, e ≠ c → (e, v) ∈ queue s → (e, v) ∈ queue F
  last : ∀ d, d ≠ c → F.last d = s.last d
  computes : iseffect (cs c) = false → rf.ended = some .done →
    ∃ v, rf.out = some (.value v) ∧ near (cs c).equal v (F.last c)
  effects : iseffect (cs c) = true → rf.ended = some .done →
    ∃ v, rf.out = some (.value v) ∧
      (near (cs c).equal v (F.last c) ∨ (c, v) ∈ queue F ∨ (F.due c).isSome)
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
      rcases p.writers k w h with h | h | h | h
      · exact p.made ▸ g.writers_made k w h
      · exact p.made ▸ g.ran_made w h
      · exact p.made ▸ (h ▸ hcm)
      · exact p.made ▸ h
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
    given := fun d r h => by
      by_cases hd : d = c
      · subst hd; rw [p.ran_c] at h; cases h; exact p.given
      · exact g.given d r (p.ran d hd ▸ h)
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

-- finish, but for a failure of a flagged run that cut a loop (fails): it ends as said, its flag
-- gone unless pending
theorem finish_eq (s : State K V) (c : Nat) (r : Run K V) (h : s.ran c = some r) (e : Ended)
    (eq : Option Bool) (w : Option Nat) (th : Option (List Nat))
    (hf : fails s c r e = false := by simp [fails]) :
    finish s c e eq w th = { s with
      kept := if e = .done then s.kept else put s.kept c (r.given ++ s.kept c),
      looping := if e = .looping then put s.looping c true else s.looping,
      values := if e ≠ .stopped then put s.values c r.values else s.values,
      ran := put s.ran c (some { r with
        ended := some e, given := [], loop := if e = .pending then r.loop else none }),
      log := s.log ++ [⟨s.pulses, s.round, .ends c r.n e eq w th⟩] } := by
  cases e <;> simp [finish, h, say, hf]

-- such a failure ends looping, through its loop
theorem finish_fails (s : State K V) (c : Nat) (r : Run K V) (h : s.ran c = some r) (e : Ended)
    (eq : Option Bool) (w : Option Nat) (th : Option (List Nat)) (hf : fails s c r e = true) :
    finish s c e eq w th = finish s c .looping eq w r.loop := by
  have h2 : fails s c r .looping = false := by simp [fails]
  simp only [finish, h, hf, h2, ite_true]
  rfl

-- finish, either way: as said, or looping
theorem finish_any (s : State K V) (c : Nat) (r : Run K V) (h : s.ran c = some r) (e : Ended)
    (eq : Option Bool) (w : Option Nat) (th : Option (List Nat)) :
    ∃ e' th', (e' = e ∧ fails s c r e = false ∨ e = .failed ∧ e' = .looping) ∧
      finish s c e eq w th = { s with
      kept := if e' = .done then s.kept else put s.kept c (r.given ++ s.kept c),
      looping := if e' = .looping then put s.looping c true else s.looping,
      values := if e' ≠ .stopped then put s.values c r.values else s.values,
      ran := put s.ran c (some { r with
        ended := some e', given := [], loop := if e' = .pending then r.loop else none }),
      log := s.log ++ [⟨s.pulses, s.round, .ends c r.n e' eq w th'⟩] } := by
  cases hf : fails s c r e
  · exact ⟨e, th, Or.inl ⟨rfl, rfl⟩, finish_eq s c r h e eq w th hf⟩
  · rw [finish_fails s c r h e eq w th hf]
    have he : e = .failed := by cases e <;> simp_all [fails]
    exact ⟨.looping, r.loop, Or.inr ⟨he, rfl⟩, finish_eq s c r h .looping eq w r.loop⟩

theorem stop_eq (s : State K V) (c : Nat) (r : Run K V) (h : s.ran c = some r)
    (hd : s.due c = none) :
    stop s c =
      { s with
        loop := put s.loop c r.loop, after := put s.after c r.stopped,
        due := put s.due c (some r.mark), kept := put s.kept c (r.given ++ s.kept c),
        ran := put s.ran c (some { r with ended := some .stopped, given := [], loop := none }),
        log := s.log ++ [⟨s.pulses, s.round, .ends c r.n .stopped none r.stopped none⟩] } := by
  simp [stop, h, hd, finish, say, fails]

theorem say_moves (s : State K V) (e : Event V) : Moves s (say s e) :=
  Moves.of_eq rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl

theorem set_moves (cs : Nat → Comp K V) (s : State K V) (c : Nat) (v : V)
    (h : ((s.ran c).bind (·.loop)) = none) : Moves s (set cs s c v) := by
  have m := say_moves s (.set c v)
  simp only [set]
  split
  · exact m.trans (write_moves cs _ _ _ (some c) (fun c' hc => by cases hc; rw [m.ran]; exact h))
  · exact m

-- a run's end that leaves the store and the afters (c after nothing), c not due, others' dues and
-- writers as a wake leaves them
theorem post_plain {cs : Nat → Comp K V} {s F : State K V} {c rk : Nat} {rf : Run K V}
    (hm : F.made = s.made) (hr : F.ran = put s.ran c (some rf))
    (hreads : F.reads = put s.reads c (rf.seen.map (·.1))) (ha : F.after = put s.after c none)
    (hd0 : F.due c = none) (hd : ∀ d m, d ≠ c → s.due d = some m → F.due d = some m)
    (hfr : ∀ d, (F.due d).isSome → (s.due d).isSome ∨ d < s.made)
    (hst : F.store = s.store)
    (hw : ∀ k w, F.writers k = some w → s.writers k = some w ∨ (s.ran w).isSome ∨ w = c ∨ w < s.made)
    (hl : ∀ d, d ≠ c → F.looping d = true → s.looping d = true ∧ F.due d = s.due d)
    (hlc : F.looping c = true → rf.ended = some .looping)
    (hlast : ∀ d, d ≠ c → F.last d = s.last d)
    (X : List (Nat × V)) (hq : ∀ x ∈ queue F, (x.1 ≠ c ∧ x ∈ queue s) ∨ x ∈ X)
    (hqk : ∀ x ∈ queue s, x.1 ≠ c → x ∈ queue F)
    (hX : ∀ x ∈ X, x.1 = c ∧ iseffect (cs c) = true ∧ rf.loop = none ∧ rf.ended = some .done ∧
      rf.out = some (.value x.2))
    (hseen : ∀ q ∈ rf.seen, s.store q.1 = q.2)
    (hfol : rf.ended ≠ some .stopped → ∃ o, rf.out = some o ∧ follow (cs c).f rf.seen = some o)
    (hpend : rf.ended = some .pending → rf.out = some .pending)
    (hcomp : iseffect (cs c) = false → rf.ended = some .done →
      ∃ v, rf.out = some (.value v) ∧ near (cs c).equal v (F.last c))
    (heff : iseffect (cs c) = true → rf.ended = some .done →
      ∃ v, rf.out = some (.value v) ∧
        (near (cs c).equal v (F.last c) ∨ (c, v) ∈ queue F ∨ (F.due c).isSome))
    (hfail : rf.ended = some .failed →
      rf.out = some .error ∨ ∃ v, rf.out = some (.value v) ∧ same (cs c).equal v (F.last c) = none)
    (hgiven : rf.given = [] := by rfl) :
    Post cs s c rk F rf where
  made := hm
  ran_c := by rw [hr]; simp
  ran d hd := by rw [hr, put_ne _ _ hd]
  reads := hreads
  after := Or.inl ha
  due := hd
  fresh := hfr
  looping := hl
  looping_c h := ⟨hd0, hlc h⟩
  writers := hw
  store k h := absurd (hst ▸ rfl) h
  follows := hfol
  fresh_c _ _ q hq := by rw [hst]; exact hseen q hq
  pending := hpend
  given := hgiven
  acts e v h := by
    rcases hq _ h with h | h
    · exact Or.inl h
    · obtain ⟨h1, h2⟩ := hX _ h
      exact Or.inr ⟨h1, h2⟩
  acts_keep e v hec h := hqk _ h hec
  last := hlast
  computes := hcomp
  effects := heff
  failed := hfail

theorem near_of_same {eq : V → V → Option Bool} {v : V} {l : Option V}
    (h : same eq v l = some true) : near eq v l := by
  cases l with
  | none => simp [same] at h
  | some x => exact ⟨x, rfl, Or.inr h⟩

-- a run step keeps the invariant (A2). c not asleep (Sleeps: a due one never is)
theorem Good.first {cs : Nat → Comp K V} {s : State K V} (g : Good cs s)
    (hA : ∀ c, nowrites (cs c).f) {c : Nat} (hc : (s.due c).isSome) (hz : s.asleep c = false)
    (rk : Nat) : Good cs (first cs s c rk) := by
  obtain ⟨s3, o, seen, vals, st, hf, e_ran, e_reads, e_store, e_made, e_last, e_after, e_acts,
    e_earlies, e_cut, e_dc, e_lc, e_due, e_fresh, e_looping, e_writers, hseen, hfol, hstop⟩ :=
    first_spec cs s c rk (hA c) hz
  rw [hf]
  have hcm : c < s.made := g.due_made c hc
  have hlc : s.looping c = false := by
    cases h : s.looping c with
    | false => rfl
    | true => have := (g.looping c h).1; rw [this] at hc; cases hc
  have hr3 : s3.ran c = some (begun s c vals st seen) := by rw [e_ran]; simp
  have hq3 : ∀ x ∈ queue s3, x.1 ≠ c ∧ x ∈ queue s := by
    intro x hx
    simp only [queue, e_acts, e_earlies, List.mem_append, List.mem_filter, decide_eq_true_eq] at hx
    rcases hx with h | h
    · exact ⟨h.2, List.mem_append_left _ h.1⟩
    · exact ⟨h.2, List.mem_append_right _ h.1⟩
  have hqk3 : ∀ x ∈ queue s, x.1 ≠ c → x ∈ queue s3 := by
    intro x hx hxc
    simp only [queue, List.mem_append] at hx
    simp only [queue, e_acts, e_earlies, List.mem_append, List.mem_filter, decide_eq_true_eq]
    rcases hx with h | h
    · exact Or.inl ⟨h, hxc⟩
    · exact Or.inr ⟨h, hxc⟩
  simp only [ending, hr3, Option.bind_some]
  cases st with
  | some w =>
    simp only [begun, Option.isSome_some, ite_true]
    obtain ⟨h1, h2, h3, k, h4⟩ := hstop w rfl
    rw [stop_eq s3 c _ hr3 e_dc]
    have hw : w < s.made := by
      rcases e_writers k w h4 with h | h | h | h
      · exact g.writers_made k w h
      · exact g.ran_made w h
      · exact absurd h h3
      · exact h
    exact g.post hc (rk := rk)
      (rf := { begun s c vals (some w) seen with ended := some .stopped, given := [], loop := none }) {
      made := by simp [e_made, begun]
      ran_c := by simp
      ran := fun d hd => by simp [e_ran, put_ne _ _ hd, begun]
      reads := by simp [e_reads, begun]
      after := Or.inr ⟨w, by simp [e_after, put_put, begun], h2, h3, hw, by simp⟩
      due := fun d m hd h => by simp [put_ne _ _ hd, e_due d m hd h, begun]
      fresh := fun d h => by
        by_cases hd : d = c
        · subst hd; exact Or.inr hcm
        · simp [put_ne _ _ hd, begun] at h; exact e_fresh d h
      looping := fun d hd h => by
        simp [begun] at h
        obtain ⟨h5, h6⟩ := e_looping d hd h
        exact ⟨h5, by simp [put_ne _ _ hd, h6, begun]⟩
      looping_c := fun h => by simp [e_lc, hlc, begun] at h
      writers := fun k' w' h => by simpa using e_writers k' w' (by simpa using h)
      store := fun k' h => absurd (by simp [e_store, begun]) h
      follows := fun h => absurd rfl h
      fresh_c := fun h => by simp [begun] at h
      pending := fun h => by simp [begun] at h
      given := rfl
      acts := fun e v h => Or.inl (hq3 _ (by simpa [queue] using h))
      acts_keep := fun e v hec h => by simpa [queue] using hqk3 _ h hec
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
    have plain : ∀ (e : Ended) (eq : Option Bool) (th : Option (List Nat)) (X1 X2 : List (Nat × V))
        (F : State K V), F = finish { (edit s3 c fun r => { r with out := some o }) with
          earlies := s3.earlies ++ X1, acts := s3.acts ++ X2 } c e eq none th →
        e ≠ .stopped → (e = .pending → o = .pending) →
        (∀ x ∈ X1 ++ X2, x.1 = c ∧ iseffect (cs c) = true ∧ s.loop c = none ∧ e = .done ∧
          o = .value x.2) →
        (iseffect (cs c) = false → e = .done → ∃ v, o = .value v ∧ near (cs c).equal v (s.last c)) →
        (iseffect (cs c) = true → e = .done → ∃ v, o = .value v ∧
          (near (cs c).equal v (s.last c) ∨ (c, v) ∈ X1 ++ X2)) →
        (e = .failed → o = .error ∨ ∃ v, o = .value v ∧ same (cs c).equal v (s.last c) = none) →
        Good cs F := by
      intro e eq th X1 X2 F hF hne hpe hX hcomp heff hfail
      rw [finish_eq ({ (edit s3 c fun r => { r with out := some o }) with
          earlies := s3.earlies ++ X1, acts := s3.acts ++ X2 })
        c _ (by simpa using hr4) e eq none th (by simp [fails, edit, e_cut])] at hF
      subst hF
      have hqF : ∀ x, x ∈ queue s3 ∨ x ∈ X1 ++ X2 ↔ x ∈ s3.earlies ++ X1 ++ (s3.acts ++ X2) := by
        intro x; simp only [queue, List.mem_append]
        constructor
        · rintro ((h | h) | (h | h))
          · exact Or.inl (Or.inl h)
          · exact Or.inr (Or.inl h)
          · exact Or.inl (Or.inr h)
          · exact Or.inr (Or.inr h)
        · rintro ((h | h) | (h | h))
          · exact Or.inl (Or.inl h)
          · exact Or.inr (Or.inl h)
          · exact Or.inl (Or.inr h)
          · exact Or.inr (Or.inr h)
      refine g.post hc (post_plain (rk := rk)
          (rf := { begun s c vals none seen with
            out := some o, ended := some e, given := [], loop := if e = .pending then s.loop c else none })
          (by simp [e_made, edit, begun]) (by simp [edit, e_ran, put_put, begun])
          (by simp [e_reads, begun, edit]) (by simp [e_after, edit, begun]) (by simp [e_dc, edit])
          (fun d m hd h => by simpa [edit] using e_due d m hd h)
          (fun d h => e_fresh d (by simpa [edit] using h))
          (by simp [e_store, edit, begun])
          (fun k w h => e_writers k w (by simpa [edit] using h)) ?_ ?_ (by simp [e_last, edit, begun])
          (X1 ++ X2) ?_ ?_ ?_ ?_ ?_ ?_ ?_ ?_ ?_)
      · intro d hd h
        by_cases hl : e = .looping
        · simp [hl, put_ne _ _ hd, edit] at h
          simpa [edit] using e_looping d hd h
        · simp [hl, edit] at h
          simpa [edit] using e_looping d hd h
      · intro h
        by_cases hl : e = .looping
        · simp [hl, edit, begun]
        · simp [hl, e_lc, hlc, edit, begun] at h
      · intro x hx
        have hx' : x ∈ s3.earlies ++ X1 ++ (s3.acts ++ X2) := by simpa [queue, edit] using hx
        rcases (hqF x).2 hx' with h | h
        · exact Or.inl (hq3 x h)
        · exact Or.inr h
      · intro x hx hxc
        have := (hqF x).1 (Or.inl (hqk3 x hx hxc))
        simpa [queue, edit] using this
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
        · refine Or.inr (Or.inl ?_)
          have := (hqF (c, v)).1 (Or.inr h2)
          simpa [queue, edit] using this
      · intro h
        simp at h
        rcases hfail h with h1 | ⟨v, h1, h2⟩
        · exact Or.inl (by simp [h1])
        · exact Or.inr ⟨v, by simp [h1], by simpa [e_last, edit] using h2⟩
    cases o with
    | error =>
      simp only
      refine plain .failed none none [] [] _ ?_ (by simp) (by simp) (by simp) (by simp) (by simp)
        (fun _ => Or.inl rfl)
      simp only [List.append_nil]; rfl
    | pending =>
      simp only
      refine plain .pending none none [] [] _ ?_ (by simp) (fun _ => rfl) (by simp) (by simp)
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
        refine plain .failed none none [] [] _ ?_ (by simp) (by simp) (by simp) (by simp) (by simp)
          (fun _ => Or.inr ⟨v, rfl, hsm⟩)
        simp only [List.append_nil]; rfl
      | some e =>
        simp only [hflag, hcut, Bool.or_false]
        by_cases hlp : ((s.loop c).isSome && !e) = true
        · simp only [hlp, ite_true]
          refine plain .looping (some e) (s.loop c) [] [] _ ?_ (by simp) (by simp) (by simp)
            (by simp) (by simp) (by simp)
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
              refine plain .done (some true) none [] [] _ ?_ (by simp) (by simp) (by simp)
                (fun h => by rw [hie] at h; cases h)
                (fun _ _ => ⟨v, rfl, Or.inl (hnear rfl)⟩) (by simp)
              simp only [List.append_nil]; rfl
            | false =>
              simp only [Bool.false_eq_true, ite_false]
              have hln : s.loop c = none := by
                cases h : s.loop c with
                | none => rfl
                | some _ => simp [h] at hlp
              have hX : ∀ x ∈ ([(c, v)] : List (Nat × V)), x.1 = c ∧ iseffect (cs c) = true ∧
                  s.loop c = none ∧ Ended.done = .done ∧ Out.value v = .value x.2 := by
                intro x hx; simp at hx; subst hx; exact ⟨rfl, hie, hln, rfl, rfl⟩
              split
              · refine plain .done (some false) none [(c, v)] [] _ (by simp only [List.append_nil]; rfl)
                  (by simp) (by simp)
                  (fun x hx => hX x (by simpa using hx))
                  (fun h => by rw [hie] at h; cases h)
                  (fun _ _ => ⟨v, rfl, Or.inr (by simp)⟩) (by simp)
              · refine plain .done (some false) none [] [(c, v)] _ (by simp only [List.append_nil]; rfl)
                  (by simp) (by simp)
                  (fun x hx => hX x (by simpa using hx))
                  (fun h => by rw [hie] at h; cases h)
                  (fun _ _ => ⟨v, rfl, Or.inr (by simp)⟩) (by simp)
          | compute to =>
            have hie : iseffect (cs c) = false := by simp [iseffect, hk]
            simp only
            cases e with
            | true =>
              simp only [ite_true]
              refine plain .done (some true) none [] [] _ ?_ (by simp) (by simp) (by simp)
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
              have f_writers : ∀ k w, s4.writers k = some w →
                  s.writers k = some w ∨ (s.ran w).isSome ∨ w = c ∨ w < s.made := by
                rw [← hs4]; intro k w h; exact e_writers k w (by simpa [edit] using h)
              have f_last : s4.last = s.last := by rw [← hs4]; simp [edit, e_last]
              have f_lc : s4.looping c = s.looping c := by rw [← hs4]; simp [edit, e_lc]
              have f_looping : ∀ d, d ≠ c → s4.looping d = true →
                  s.looping d = true ∧ s4.due d = s.due d := by
                rw [← hs4]; intro d hd h; simpa [edit] using e_looping d hd (by simpa [edit] using h)
              have f_dc : s4.due c = none := by rw [← hs4]; simp [edit, e_dc]
              have f_due : ∀ d m, d ≠ c → s.due d = some m → s4.due d = some m := by
                rw [← hs4]; intro d m hd h; simpa [edit] using e_due d m hd h
              have f_fresh : ∀ d, (s4.due d).isSome → (s.due d).isSome ∨ d < s.made := by
                rw [← hs4]; intro d h; exact e_fresh d (by simpa [edit] using h)
              have f_after : s4.after = put s.after c none := by rw [← hs4]; simp [edit, e_after]
              have f_q : queue s4 = queue s3 := by rw [← hs4]; simp [edit, queue]
              have m := set_moves cs s4 c v (by rw [hflag, hln])
              generalize hs5 : set cs s4 c v = s5 at m
              have hr5 : s5.ran c = some { begun s c vals none seen with out := some (.value v) } := by
                rw [m.ran, f_ran]; simp
              have q5 : queue s5 = queue s3 := by rw [queue, m.acts, m.earlies, ← queue, f_q]
              rw [finish_eq ({ s5 with last := put s5.last c (some v) }) c _ hr5 _ _ _ _
                (by simp [fails])]
              exact g.post hc (rk := rk)
                (rf := { begun s c vals none seen with out := some (.value v), ended := some .done, given := [] }) {
                made := by simp [m.made, f_made]
                ran_c := by simp [begun, hln]
                ran := fun d hd => by simp [m.ran, f_ran, put_ne _ _ hd]
                reads := by simp [m.reads, f_reads, begun]
                after := Or.inl (by simp [m.after, f_after])
                due := fun d m' hd h => by
                  simp [m.due d m' (f_due d m' hd h)]
                fresh := fun d h => by
                  rcases m.fresh d (by simpa using h) with h | h
                  · by_cases hd : d = c
                    · subst hd; exact Or.inr hcm
                    · exact f_fresh d h
                  · exact Or.inr (f_made ▸ h)
                looping := fun d hd h => by
                  obtain ⟨h1, h2⟩ := m.looping d (by simpa using h)
                  obtain ⟨h3, h4⟩ := f_looping d hd h1
                  exact ⟨h3, by simp [h2, h4]⟩
                looping_c := fun h => by
                  obtain ⟨h1, _⟩ := m.looping c (by simpa using h)
                  rw [f_lc, hlc] at h1; cases h1
                writers := fun k w h => by
                  rcases m.writers k w (by simpa using h) with h | h | h
                  · exact f_writers k w h
                  · by_cases hw : w = c
                    · exact Or.inr (Or.inr (Or.inl hw))
                    · rw [f_ran, put_ne _ _ hw] at h; exact Or.inr (Or.inl h)
                  · exact Or.inr (Or.inr (Or.inr (f_made ▸ h)))
                store := fun k h d hd hdc hr => by
                  have h' : s5.store k ≠ s4.store k := by rw [f_store]; simpa using h
                  rcases m.store k h' d (f_made ▸ hd) (by rw [f_reads, put_ne _ _ hdc]; exact hr)
                    with h | h
                  · exact Or.inl (by simpa using h)
                  · exact Or.inr (f_looping d hdc h).1
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
                    · rw [f_lc, hlc] at h; cases h
                pending := fun h => by simp at h
                given := rfl
                acts := fun e w h => by
                  have h' : (e, w) ∈ queue s5 := by simpa [queue] using h
                  rw [q5] at h'
                  exact Or.inl (hq3 _ h')
                acts_keep := fun e w hec h => by
                  have := hqk3 _ h hec
                  rw [← q5] at this
                  simpa [queue] using this
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

-- A2: the synchronous core writes only in sets and acts. runs: no f writes in its run. goes: no
-- going writes (Quiet: an attended compute's teardowns write nothing as it goes). a going that
-- writes what its compute read makes it due while asleep, and it runs asleep (Model.Check, selfgo,
-- as the TS); one that writes what others read can loop a pulse forever (Model.Check, endless)
structure A2 (cs : Nat → Comp K V) : Prop where
  runs : ∀ c, nowrites (cs c).f
  goes : Quiet cs

instance (cs : Nat → Comp K V) : CoeFun (A2 cs) (fun _ => ∀ c, nowrites (cs c).f) := ⟨A2.runs⟩

-- the attended asleep: what moves them

-- s' from s by steps that wake but put none to sleep: asleep only ends; reads and dues move only
-- for the awake, or (dues) for a reader
structure Hush (s s' : State K V) : Prop where
  asleep : ∀ x, s'.asleep x = true → s.asleep x = true
  reads : ∀ x, s'.reads x ≠ s.reads x → s'.asleep x = false
  due : ∀ x, s'.due x ≠ s.due x → s'.asleep x = false ∨ s.reads x ≠ []
  made : s'.made = s.made

theorem Hush.refl (s : State K V) : Hush s s :=
  ⟨fun _ h => h, fun _ h => absurd rfl h, fun _ h => absurd rfl h, rfl⟩

theorem Hush.of_eq {s s' : State K V} (e1 : s'.asleep = s.asleep) (e2 : s'.reads = s.reads)
    (e3 : s'.due = s.due) (e4 : s'.made = s.made := by first | rfl | simp) : Hush s s' :=
  ⟨fun _ h => e1 ▸ h, fun _ h => absurd (e2 ▸ rfl) h, fun _ h => absurd (e3 ▸ rfl) h, e4⟩

theorem Hush.trans {s s' s'' : State K V} (a : Hush s s') (b : Hush s' s'') : Hush s s'' where
  asleep x h := a.asleep x (b.asleep x h)
  reads x h := by
    by_cases e : s''.reads x = s'.reads x
    · rw [e] at h
      cases h2 : s''.asleep x
      · rfl
      · have := a.reads x h; rw [b.asleep x h2] at this; cases this
    · exact b.reads x e
  due x h := by
    have keep : s'.asleep x = false → s''.asleep x = false := by
      intro h1; cases h2 : s''.asleep x
      · rfl
      · rw [b.asleep x h2] at h1; cases h1
    by_cases e : s''.due x = s'.due x
    · rw [e] at h
      rcases a.due x h with h1 | h1
      · exact Or.inl (keep h1)
      · exact Or.inr h1
    · rcases b.due x e with h1 | h1
      · exact Or.inl h1
      · by_cases e2 : s'.reads x = s.reads x
        · exact Or.inr (e2 ▸ h1)
        · exact Or.inl (keep (a.reads x e2))
  made := b.made.trans a.made

theorem settle_hush (s : State K V) (d t : Nat) (who : Option Nat) (l : Option (List Nat))
    (fl : Bool) (hd : s.asleep d = false ∨ s.reads d ≠ []) : Hush s (settle s d t who l fl) := by
  unfold settle
  split
  · cases who <;> exact Hush.of_eq rfl rfl rfl
  · dsimp only
    split
    · exact Hush.of_eq rfl rfl rfl
    · unfold Model.due; split
      · exact Hush.of_eq rfl rfl rfl
      · refine ⟨fun _ h => h, fun _ h => absurd rfl h, fun x h => ?_, rfl⟩
        by_cases hx : x = d
        · subst hx; exact hd
        · simp [say, put_ne _ _ hx] at h

theorem mark_hush (s : State K V) (d t : Nat) (who : Option Nat)
    (hd : s.asleep d = false ∨ s.reads d ≠ []) : Hush s (mark s d t who) := by
  cases who with
  | none => exact settle_hush s d t none none false hd
  | some c =>
    simp only [mark]
    obtain ⟨a, b, g, k, hc⟩ := causeof_shape s c
    rw [hc]
    simp only []
    obtain ⟨kp, hk⟩ := keep_shape { s with cause := a, when := b, went := g } d k
    rw [hk]
    refine Hush.trans (Hush.of_eq ?_ ?_ ?_) (settle_hush _ d t _ _ _ ?_)
    · rfl
    · rfl
    · rfl
    · simpa using hd

theorem readers_reads {s : State K V} {k : K} {d : Nat} (h : d ∈ readers s k) : s.reads d ≠ [] := by
  simp [readers] at h
  intro e; rw [e] at h; simp at h

theorem marks_hush (t : Nat) (r : Option Nat) : ∀ (ds : List Nat) (s : State K V),
    (∀ d ∈ ds, s.reads d ≠ []) → Hush s (ds.foldl (fun s d => mark s d t r) s)
  | [], s, _ => Hush.refl s
  | d :: ds, s, h => by
    simp only [List.foldl_cons]
    have m := mark_hush s d t r (Or.inr (h d (by simp)))
    exact m.trans (marks_hush t r ds _ (fun x hx => by rw [mark_reads]; exact h x (by simp [hx])))

theorem changed_hush (cs : Nat → Comp K V) (s : State K V) (keys : List K) (who : Option Nat) :
    Hush s (changed cs s keys who) := by
  simp only [changed]
  generalize s.tick + 1 = t
  generalize runof { s with tick := t } who = r
  generalize (r.filter fun c => match (cs c).kind with
    | .compute _ => true | .effect _ => false) = w
  have h0 : Hush s { s with tick := t } := Hush.of_eq rfl rfl rfl
  suffices ∀ (ks : List K) (s1 : State K V), Hush s1 (ks.foldl (fun s k => tell (learn s k w) k t r) s1)
    from h0.trans (this keys _)
  intro ks
  induction ks with
  | nil => intro s1; exact Hush.refl s1
  | cons k ks ih =>
    intro s1
    simp only [List.foldl_cons]
    have hl : Hush s1 (learn s1 k w) := by
      cases w <;> exact Hush.of_eq rfl rfl rfl
    have ht : Hush (learn s1 k w) (tell (learn s1 k w) k t r) :=
      marks_hush t r _ _ (fun d hd => readers_reads hd)
    exact (hl.trans ht).trans (ih _)

theorem wake_hush (cs : Nat → Comp K V) (s : State K V) (k : K) : Hush s (wake cs s k) := by
  unfold wake
  cases attending cs s.made k with
  | none => exact Hush.refl s
  | some a =>
    simp only
    split
    · have h1 : Hush s { s with
          asleep := put s.asleep a false,
          writers := put s.writers k (some a), tick := s.tick + 1 } := by
        refine ⟨fun x h => ?_, fun _ h => absurd rfl h, fun _ h => absurd rfl h, rfl⟩
        by_cases hx : x = a
        · subst hx; simp at h
        · simpa [put_ne _ _ hx] using h
      exact h1.trans (mark_hush _ a _ none (Or.inl (by simp)))
    · exact Hush.of_eq rfl rfl rfl

theorem wakes_hush (cs : Nat → Comp K V) : ∀ (ws : List K) (s : State K V), Hush s (wakes cs s ws)
  | [], s => Hush.refl s
  | k :: ws, s => (wake_hush cs s k).trans (wakes_hush cs ws (wake cs s k))

@[simp] theorem finish_due (s : State K V) (c : Nat) (e : Ended) (eq : Option Bool)
    (w : Option Nat) (th : Option (List Nat)) : (finish s c e eq w th).due = s.due := by
  unfold finish
  split
  · rfl
  · simp only [say]
    repeat' split
    all_goals rfl

@[simp] theorem finish_asleep (s : State K V) (c : Nat) (e : Ended) (eq : Option Bool)
    (w : Option Nat) (th : Option (List Nat)) : (finish s c e eq w th).asleep = s.asleep := by
  unfold finish
  split
  · rfl
  · simp only [say]
    repeat' split
    all_goals rfl

@[simp] theorem finish_reads (s : State K V) (c : Nat) (e : Ended) (eq : Option Bool)
    (w : Option Nat) (th : Option (List Nat)) : (finish s c e eq w th).reads = s.reads := by
  unfold finish
  split
  · rfl
  · simp only [say]
    repeat' split
    all_goals rfl

@[simp] theorem finish_made (s : State K V) (c : Nat) (e : Ended) (eq : Option Bool)
    (w : Option Nat) (th : Option (List Nat)) : (finish s c e eq w th).made = s.made := by
  unfold finish
  split
  · rfl
  · simp only [say]
    repeat' split
    all_goals rfl

@[simp] theorem finish_store (s : State K V) (c : Nat) (e : Ended) (eq : Option Bool)
    (w : Option Nat) (th : Option (List Nat)) : (finish s c e eq w th).store = s.store := by
  unfold finish
  split
  · rfl
  · simp only [say]
    repeat' split
    all_goals rfl

@[simp] theorem finish_writers (s : State K V) (c : Nat) (e : Ended) (eq : Option Bool)
    (w : Option Nat) (th : Option (List Nat)) : (finish s c e eq w th).writers = s.writers := by
  unfold finish
  split
  · rfl
  · simp only [say]
    repeat' split
    all_goals rfl

@[simp] theorem finish_after (s : State K V) (c : Nat) (e : Ended) (eq : Option Bool)
    (w : Option Nat) (th : Option (List Nat)) : (finish s c e eq w th).after = s.after := by
  unfold finish
  split
  · rfl
  · simp only [say]
    repeat' split
    all_goals rfl

@[simp] theorem finish_acts (s : State K V) (c : Nat) (e : Ended) (eq : Option Bool)
    (w : Option Nat) (th : Option (List Nat)) : (finish s c e eq w th).acts = s.acts := by
  unfold finish
  split
  · rfl
  · simp only [say]
    repeat' split
    all_goals rfl

@[simp] theorem finish_earlies (s : State K V) (c : Nat) (e : Ended) (eq : Option Bool)
    (w : Option Nat) (th : Option (List Nat)) : (finish s c e eq w th).earlies = s.earlies := by
  unfold finish
  split
  · rfl
  · simp only [say]
    repeat' split
    all_goals rfl

@[simp] theorem finish_last (s : State K V) (c : Nat) (e : Ended) (eq : Option Bool)
    (w : Option Nat) (th : Option (List Nat)) : (finish s c e eq w th).last = s.last := by
  unfold finish
  split
  · rfl
  · simp only [say]
    repeat' split
    all_goals rfl

@[simp] theorem finish_dying (s : State K V) (c : Nat) (e : Ended) (eq : Option Bool)
    (w : Option Nat) (th : Option (List Nat)) : (finish s c e eq w th).dying = s.dying := by
  unfold finish
  split
  · rfl
  · simp only [say]
    repeat' split
    all_goals rfl

@[simp] theorem finish_tick (s : State K V) (c : Nat) (e : Ended) (eq : Option Bool)
    (w : Option Nat) (th : Option (List Nat)) : (finish s c e eq w th).tick = s.tick := by
  unfold finish
  split
  · rfl
  · simp only [say]
    repeat' split
    all_goals rfl

@[simp] theorem finish_pulses (s : State K V) (c : Nat) (e : Ended) (eq : Option Bool)
    (w : Option Nat) (th : Option (List Nat)) : (finish s c e eq w th).pulses = s.pulses := by
  unfold finish
  split
  · rfl
  · simp only [say]
    repeat' split
    all_goals rfl

@[simp] theorem finish_phase (s : State K V) (c : Nat) (e : Ended) (eq : Option Bool)
    (w : Option Nat) (th : Option (List Nat)) : (finish s c e eq w th).phase = s.phase := by
  unfold finish
  split
  · rfl
  · simp only [say]
    repeat' split
    all_goals rfl

@[simp] theorem finish_round (s : State K V) (c : Nat) (e : Ended) (eq : Option Bool)
    (w : Option Nat) (th : Option (List Nat)) : (finish s c e eq w th).round = s.round := by
  unfold finish
  split
  · rfl
  · simp only [say]
    repeat' split
    all_goals rfl

@[simp] theorem finish_runs (s : State K V) (c : Nat) (e : Ended) (eq : Option Bool)
    (w : Option Nat) (th : Option (List Nat)) : (finish s c e eq w th).runs = s.runs := by
  unfold finish
  split
  · rfl
  · simp only [say]
    repeat' split
    all_goals rfl

@[simp] theorem finish_when (s : State K V) (c : Nat) (e : Ended) (eq : Option Bool)
    (w : Option Nat) (th : Option (List Nat)) : (finish s c e eq w th).when = s.when := by
  unfold finish
  split
  · rfl
  · simp only [say]
    repeat' split
    all_goals rfl

@[simp] theorem finish_cut (s : State K V) (c : Nat) (e : Ended) (eq : Option Bool)
    (w : Option Nat) (th : Option (List Nat)) : (finish s c e eq w th).cut = s.cut := by
  unfold finish
  split
  · rfl
  · simp only [say]
    repeat' split
    all_goals rfl

@[simp] theorem finish_went (s : State K V) (c : Nat) (e : Ended) (eq : Option Bool)
    (w : Option Nat) (th : Option (List Nat)) : (finish s c e eq w th).went = s.went := by
  unfold finish
  split
  · rfl
  · simp only [say]
    repeat' split
    all_goals rfl

@[simp] theorem finish_cause (s : State K V) (c : Nat) (e : Ended) (eq : Option Bool)
    (w : Option Nat) (th : Option (List Nat)) : (finish s c e eq w th).cause = s.cause := by
  unfold finish
  split
  · rfl
  · simp only [say]
    repeat' split
    all_goals rfl

@[simp] theorem finish_loop (s : State K V) (c : Nat) (e : Ended) (eq : Option Bool)
    (w : Option Nat) (th : Option (List Nat)) : (finish s c e eq w th).loop = s.loop := by
  unfold finish
  split
  · rfl
  · simp only [say]
    repeat' split
    all_goals rfl

theorem finish_keep (X : State K V) (c : Nat) (e : Ended) (eq : Option Bool) (w : Option Nat)
    (th : Option (List Nat)) : Hush X (finish X c e eq w th) :=
  Hush.of_eq (finish_asleep ..) (finish_reads ..) (finish_due ..)

-- dues moved only at an awake c
theorem Hush.only {s s' : State K V} {c : Nat} (e1 : s'.asleep = s.asleep) (e2 : s'.reads = s.reads)
    (e3 : ∀ x, x ≠ c → s'.due x = s.due x) (hz : s.asleep c = false)
    (e4 : s'.made = s.made := by first | rfl | simp) : Hush s s' :=
  ⟨fun _ h => e1 ▸ h, fun _ h => absurd (e2 ▸ rfl) h, fun x h => by
    by_cases hx : x = c
    · subst hx; exact Or.inl (e1 ▸ hz)
    · exact absurd (e3 x hx) h, e4⟩

theorem set_hush (cs : Nat → Comp K V) (s : State K V) (c : Nat) (v : V) : Hush s (set cs s c v) := by
  simp only [set]
  split
  · refine Hush.trans ?_ (changed_hush cs _ _ _)
    exact Hush.of_eq rfl rfl rfl
  · exact Hush.of_eq rfl rfl rfl

-- the end of a run of an awake c
theorem ending_hush (cs : Nat → Comp K V) (s : State K V) (c : Nat) (o : Out V)
    (hz : s.asleep c = false) : Hush s (ending cs s c o) := by
  unfold ending
  split
  · unfold stop
    split
    · exact Hush.refl s
    · refine Hush.only (c := c) (by simp; split <;> rfl) (by simp; split <;> rfl) (fun x hx => ?_) hz
        (by simp; split <;> rfl)
      simp only [finish_due]
      split <;> simp [put_ne _ _ hx]
  · have fin : ∀ (X : State K V) e eq w th, X.asleep = s.asleep → X.reads = s.reads →
        X.due = s.due → X.made = s.made → Hush s (finish X c e eq w th) :=
      fun X e eq w th h1 h2 h3 h4 => Hush.of_eq (by simp [h1]) (by simp [h2]) (by simp [h3])
        (by simp [h4])
    split
    · exact fin _ _ _ _ _ rfl rfl rfl rfl
    · exact fin _ _ _ _ _ rfl rfl rfl rfl
    · rename_i v
      simp only [result]
      split
      · exact fin _ _ _ _ _ rfl rfl rfl rfl
      · split
        · exact fin _ _ _ _ _ rfl rfl rfl rfl
        · split
          · apply fin
            all_goals (repeat' split) <;> rfl
          · split
            · exact fin _ _ _ _ _ rfl rfl rfl rfl
            · have h1 := set_hush cs (edit s c fun r => { r with out := some (.value v) }) c v
              have h2 := (Hush.of_eq (s := s) (s' := edit s c fun r => { r with out := some (.value v) })
                rfl rfl rfl).trans h1
              refine (h2.trans ?_).trans (finish_keep _ _ _ _ _ _)
              exact Hush.of_eq rfl rfl rfl

-- a run of an awake c, A2
theorem first_hush (cs : Nat → Comp K V) (s : State K V) (c rk : Nat) (hp : nowrites (cs c).f)
    (hz : s.asleep c = false) : Hush s (first cs s c rk) := by
  have h0 : (start s c rk).ran c = some (begun s c [] none []) := by simp [start, say, begun]
  obtain ⟨seen, vals, st, ws, heq, _, _, _⟩ := exec_spec cs c (cs c).f hp (start s c rk) _ h0 rfl
  simp only [first]
  generalize hx : exec cs c (start s c rk) (cs c).f = x at heq
  obtain ⟨s2, o⟩ := x
  simp only at heq
  subst heq
  have hzs : (start s c rk).asleep c = false := by simp [start, say, hz]
  obtain ⟨_, _, hzw⟩ := wakes_keep cs c ws (start s c rk) hzs
  have h1 : Hush s (start s c rk) :=
    Hush.only (c := c) (by simp [start, say]) (by simp [start, say])
      (fun x hx => by simp [start, say, put_ne _ _ hx]) hz
  have h2 := h1.trans (wakes_hush cs ws (start s c rk))
  generalize hR : (some { begun s c [] none [] with
      seen := [] ++ seen, values := vals, stopped := st } : Option (Run K V)) = R
  have h3 : Hush (wakes cs (start s c rk) ws) { wakes cs (start s c rk) ws with
      ran := put (start s c rk).ran c R,
      reads := put (start s c rk).reads c ((start s c rk).reads c ++ seen.map (·.1)) } := by
    refine ⟨fun _ h => h, fun x h => ?_, fun _ h => absurd rfl h, rfl⟩
    by_cases hx : x = c
    · subst hx; exact hzw
    · simp [put_ne _ _ hx] at h
  generalize hS : ({ wakes cs (start s c rk) ws with
      ran := put (start s c rk).ran c R,
      reads := put (start s c rk).reads c ((start s c rk).reads c ++ seen.map (·.1)) } :
        State K V) = S at h3 ⊢
  have h4 : Hush S { S with
      reads := put S.reads c (((S.ran c).map fun r => r.seen.map (·.1)).getD []) } := by
    refine ⟨fun _ h => h, fun x h => ?_, fun _ h => absurd rfl h, rfl⟩
    by_cases hx : x = c
    · subst hx; rw [← hS]; exact hzw
    · simp [put_ne _ _ hx] at h
  have hzS : S.asleep c = false := by rw [← hS]; exact hzw
  have h5 : Hush S (untrack cs { S with
      reads := put S.reads c (((S.ran c).map fun r => r.seen.map (·.1)).getD []) } (S.reads c)) :=
    h4.trans (Hush.of_eq (untrack_asleep ..) (untrack_reads ..) (untrack_due ..))
  have h6 := ending_hush cs (untrack cs { S with
      reads := put S.reads c (((S.ran c).map fun r => r.seen.map (·.1)).getD []) } (S.reads c)) c o
    (by simpa using hzS)
  subst hS hR
  exact ((h2.trans h3).trans h5).trans h6

-- an act
theorem act_hush (cs : Nat → Comp K V) (s : State K V) (e : Nat) (v : V) : Hush s (act cs s e v) := by
  unfold act
  split
  · exact Hush.refl s
  · split
    · exact Hush.refl s
    · rename_i g _
      dsimp only
      suffices ∀ (ws : List (K × V)) (s1 : State K V),
          Hush s1 (ws.foldl (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some e)) s1) by
        have h1 := this (g v (s.last e)) (say s (.act e v (s.last e)))
        have h0 : Hush s (say s (.act e v (s.last e))) := Hush.of_eq rfl rfl rfl
        refine (h0.trans h1).trans ?_
        exact Hush.of_eq rfl rfl rfl
      intro ws
      induction ws with
      | nil => intro s1; exact Hush.refl s1
      | cons kv ws ih =>
        intro s1
        simp only [List.foldl_cons]
        refine Hush.trans ?_ (ih _)
        exact (Hush.of_eq (s := s1) (s' := store s1 kv.1 kv.2) rfl rfl rfl).trans
          (changed_hush cs _ _ _)

-- the asleep: not due, reading nothing
structure Sleeps (s : State K V) : Prop where
  due : ∀ c, s.asleep c = true → s.due c = none
  reads : ∀ c, s.asleep c = true → s.reads c = []

theorem Sleeps.hush {s s' : State K V} (S : Sleeps s) (h : Hush s s') : Sleeps s' where
  due c hc := by
    have hc0 := h.asleep c hc
    by_cases e : s'.due c = s.due c
    · rw [e]; exact S.due c hc0
    · rcases h.due c e with h1 | h1
      · rw [hc] at h1; cases h1
      · exact absurd (S.reads c hc0) h1
  reads c hc := by
    have hc0 := h.asleep c hc
    by_cases e : s'.reads c = s.reads c
    · rw [e]; exact S.reads c hc0
    · have := h.reads c e; rw [hc] at this; cases this

-- the going: the dying list, and untrack, move nothing the invariant reads
theorem Good.untrack {cs : Nat → Comp K V} {s : State K V} (g : Good cs s) (ks : List K) :
    Good cs (untrack cs s ks) := by
  obtain ⟨dy, h⟩ := untrack_shape cs ks s
  rw [h]; exact g.moves (Moves.of_eq rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl)

-- a going (A2: it writes nothing): d, up and untracked, asleep with no run, no reads, no last
theorem Good.bury {cs : Nat → Comp K V} {s : State K V} (g : Good cs s) (hQ : Quiet cs) (d : Nat) :
    Good cs (bury cs s d) := by
  unfold Model.bury
  cases hk : (cs d).key with
  | none => exact g
  | some k =>
    simp only
    split
    · exact g
    · rename_i ht
      simp only [Bool.or_eq_true, not_or, Bool.not_eq_true, Bool.not_eq_false] at ht
      have hnt : ∀ x, k ∉ s.reads x := by
        intro x hx
        have hxm : x < s.made := by
          have : s.reads x ≠ [] := by intro e; rw [e] at hx; simp at hx
          rw [g.reads x] at this
          have : (s.ran x).isSome := by cases h : s.ran x <;> simp_all
          exact g.ran_made x this
        have : x ∈ readers s k := by simp [readers, hxm, hx]
        simp [tracked, readers] at ht
        exact ht.2 x hxm hx
      rw [hQ d]
      simp only [List.foldl_nil]
      refine Good.untrack ?_ _
      exact {
        after_due := fun x w h => by
          by_cases hx : x = d
          · subst hx; simp at h
          · simp [put_ne _ _ hx] at h ⊢
            exact g.after_due x w h
        acyclic := fun x h => by
          refine g.acyclic x (tg_mono (fun a b hab => ?_) h)
          by_cases ha : a = d
          · subst ha; simp [aft] at hab
          · simpa [aft, put_ne _ _ ha] using hab
        due_made := fun x h => by
          by_cases hx : x = d
          · subst hx; simp at h
          · simp [put_ne _ _ hx] at h; exact g.due_made x h
        writers_made := g.writers_made
        ran_made := fun x h => by
          by_cases hx : x = d
          · subst hx; simp at h
          · simp [put_ne _ _ hx] at h; exact g.ran_made x (by simp [h])
        reads := fun x => by
          by_cases hx : x = d
          · subst hx; simp
          · simp [put_ne _ _ hx]; exact g.reads x
        follows := fun x r h => by
          by_cases hx : x = d
          · subst hx; simp at h
          · simp [put_ne _ _ hx] at h; exact g.follows x r h
        fresh := fun x r h hd hs q hq => by
          by_cases hx : x = d
          · subst hx; simp at h
          · simp [put_ne _ _ hx] at h hd
            have hq1 : q.1 ≠ k := by
              intro e; apply hnt x; rw [g.reads x, h]; simp; exact ⟨q.2, e ▸ hq⟩
            simp [put_ne _ _ hq1]
            exact g.fresh x r h hd hs q hq
        looping := fun x h => by
          by_cases hx : x = d
          · subst hx; simp at h
          · simp [put_ne _ _ hx] at h ⊢; exact g.looping x h
        pending := fun x r h => by
          by_cases hx : x = d
          · subst hx; simp at h
          · simp [put_ne _ _ hx] at h; exact g.pending x r h
        given := fun x r h => by
          by_cases hx : x = d
          · subst hx; simp at h
          · simp [put_ne _ _ hx] at h; exact g.given x r h
        acts := fun e v h => by
          obtain ⟨h1, r, h2, h3⟩ := g.acts e v (by simpa [queue] using h)
          have he : e ≠ d := by
            intro ed; subst ed
            simp [attends, iseffect] at ht h1
            split at h1 <;> simp_all
          exact ⟨h1, r, by simp [put_ne _ _ he, h2], h3⟩
        computes := fun c r hc h hd => by
          by_cases hx : c = d
          · subst hx; simp at h
          · simp [put_ne _ _ hx] at h ⊢; exact g.computes c r hc h hd
        effects := fun e r he h hd => by
          by_cases hx : e = d
          · subst hx; simp at h
          · simp [put_ne _ _ hx] at h ⊢
            obtain ⟨v, h1, h2⟩ := g.effects e r he h hd
            exact ⟨v, h1, by simpa [queue] using h2⟩
        failed := fun c r h hf => by
          by_cases hx : c = d
          · subst hx; simp at h
          · simp [put_ne _ _ hx] at h ⊢; exact g.failed c r h hf }

-- the host's make: grown, then asleep, or due (and an early effect's first run and act)
theorem Good.make {cs : Nat → Comp K V} {s : State K V} (g : Good cs s) (hA : A2 cs) :
    Good cs (make cs s) := by
  have g1 := g.grow (cs := cs)
  simp only [Model.make]
  have hm1 : (Model.grow cs s).made = s.made + 1 := by simp only [Model.grow]; split <;> rfl
  have hlt : s.made < (Model.grow cs s).made := by omega
  split
  · exact g1.moves (Moves.of_eq rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl)
  · obtain ⟨m, hd⟩ := mark_moves (Model.grow cs s) s.made (Model.grow cs s).tick none hlt (by simp)
    have g2 := g1.moves m
    have hdue : ((mark (Model.grow cs s) s.made (Model.grow cs s).tick none).due s.made).isSome := by
      rcases hd with hd | hd
      · exact hd
      · obtain ⟨_, r, h1, _⟩ := g1.looping s.made hd
        have := g1.ran_made s.made (by simp [h1])
        have e : (Model.grow cs s).ran = s.ran := by simp only [Model.grow]; split <;> rfl
        rw [e] at h1
        have := g.ran_made s.made (by simp [h1]); omega
    split
    · have hz : (mark (Model.grow cs s) s.made (Model.grow cs s).tick none).asleep s.made = false := by
        simp only [mark_asleep]; simp only [Model.grow]; split <;> simp
      have g3 := g2.first hA hdue hz 0
      simp only [actnow]
      split
      · rename_i a ha
        obtain ⟨a1, a2⟩ := a
        have hmem := List.mem_of_find?_eq_some ha
        have hfst : a1 = s.made := by simpa using List.find?_some ha
        rw [hfst] at hmem
        simp only [hfst]
        refine Good.act g3 (es := (Model.first cs _ s.made 0).earlies.filter (·.1 ≠ s.made))
          (as := (Model.first cs _ s.made 0).acts) rfl
          (by simp [queue, hmem]) ?_ ?_
        · intro x hx
          simp only [queue, List.mem_append, List.mem_filter] at hx ⊢
          rcases hx with h | h
          · exact Or.inl h.1
          · exact Or.inr h
        · intro x hx hne
          simp only [queue, List.mem_append, List.mem_filter, decide_eq_true_eq] at hx ⊢
          rcases hx with h | h
          · exact Or.inl ⟨h, hne⟩
          · exact Or.inr h
      · exact g3
    · exact g2

-- a step of a pulse keeps the invariant (A2), the asleep never due
theorem Good.step {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s s' : State K V}
    (g : Good cs s) (S : Sleeps s) (hA : A2 cs) (h : step cs rank s = some s') : Good cs s' := by
  simp only [Model.step] at h
  split at h
  · split at h
    · rename_i c hc
      cases h
      have := (next_ready hc).1
      simp only [ready, Bool.and_eq_true] at this
      have hz : s.asleep c = false := by
        cases h : s.asleep c
        · rfl
        · rw [S.due c h] at this; simp at this
      exact g.first hA this.1 hz _
    · cases h
      exact g.moves (Moves.of_eq rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl)
  · split at h
    · rename_i a rest ha
      cases h
      exact (g.acthead (e := a.1) (v := a.2)).1 (by simpa using ha)
    · rename_i he
      split at h
      · rename_i a rest ha
        cases h
        exact (g.acthead (e := a.1) (v := a.2)).2 he (by simpa using ha)
      · split at h
        · cases h
          exact g.moves (Moves.of_eq rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl)
        · split at h
          · cases h
          · cases h
            exact g.moves (Moves.of_eq rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl)
  · split at h
    · rename_i d rest _
      cases h
      exact (g.moves (s' := { s with dying := rest })
        (Moves.of_eq rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl)).bury hA.goes d
    · cases h
      exact g.moves (Moves.of_eq rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl)

-- Sleeps, through each step

theorem Sleeps.empty : Sleeps (empty : State K V) :=
  ⟨fun _ h => by simp [Model.empty] at h, fun _ h => by simp [Model.empty] at h⟩

theorem Sleeps.of_eq {s s' : State K V} (S : Sleeps s) (e1 : s'.asleep = s.asleep)
    (e2 : s'.reads = s.reads) (e3 : s'.due = s.due) (e4 : s'.made = s.made) : Sleeps s' :=
  S.hush (Hush.of_eq e1 e2 e3 e4)

theorem Sleeps.changed {cs : Nat → Comp K V} {s : State K V} (S : Sleeps s) (keys : List K)
    (who : Option Nat) : Sleeps (changed cs s keys who) :=
  S.hush (changed_hush cs s keys who)

theorem Sleeps.untrack {cs : Nat → Comp K V} {s : State K V} (S : Sleeps s) (ks : List K) :
    Sleeps (untrack cs s ks) := S.of_eq (by simp) (by simp) (by simp) (by simp)

-- a run's state: its computation never asleep
theorem Sleeps.first {cs : Nat → Comp K V} {s : State K V} (S : Sleeps s) (hA : ∀ c, nowrites (cs c).f)
    {c : Nat} (hc : (s.due c).isSome) (rk : Nat) : Sleeps (first cs s c rk) := by
  have hz : s.asleep c = false := by
    cases h : s.asleep c
    · rfl
    · rw [S.due c h] at hc; cases hc
  exact S.hush (first_hush cs s c rk (hA c) hz)

theorem Sleeps.act {cs : Nat → Comp K V} {s : State K V} (S : Sleeps s) (e : Nat) (v : V) :
    Sleeps (act cs s e v) := S.hush (act_hush cs s e v)

theorem Sleeps.grow {cs : Nat → Comp K V} {s : State K V} (S : Sleeps s) (g : Core cs s) :
    Sleeps (Model.grow cs s) := by
  have e : ∃ w, Model.grow cs s = { s with
      made := s.made + 1, asleep := put s.asleep s.made false, kept := put s.kept s.made [],
      writers := w, tick := s.tick + 1 } := by
    simp only [Model.grow]; split <;> exact ⟨_, rfl⟩
  obtain ⟨w, e⟩ := e
  rw [e]
  refine ⟨fun c hc => ?_, fun c hc => ?_⟩
  · by_cases h : c = s.made
    · subst h; simp at hc
    · simp [put_ne _ _ h] at hc; exact S.due c hc
  · by_cases h : c = s.made
    · subst h; simp at hc
    · simp [put_ne _ _ h] at hc; exact S.reads c hc

-- the host's make
theorem Sleeps.make {cs : Nat → Comp K V} {s : State K V} (S : Sleeps s) (g : Core cs s)
    (hA : ∀ c, nowrites (cs c).f) : Sleeps (make cs s) := by
  have S1 := S.grow (cs := cs) g
  have hm1 : (Model.grow cs s).made = s.made + 1 := by simp only [Model.grow]; split <;> rfl
  have e1 : (Model.grow cs s).due = s.due := by simp only [Model.grow]; split <;> rfl
  have e2 : (Model.grow cs s).reads = s.reads := by simp only [Model.grow]; split <;> rfl
  have e3 : (Model.grow cs s).ran = s.ran := by simp only [Model.grow]; split <;> rfl
  have ez : (Model.grow cs s).asleep s.made = false := by simp only [Model.grow]; split <;> simp
  simp only [Model.make]
  split
  · refine ⟨fun c hc => ?_, fun c hc => ?_⟩
    · by_cases h : c = s.made
      · subst h; rw [e1]
        cases hd : s.due s.made with
        | none => rfl
        | some _ => have := g.due_made _ (by rw [hd]; rfl); omega
      · simp only [put_ne _ _ h] at hc; exact S1.due c hc
    · by_cases h : c = s.made
      · subst h; rw [e2, g.reads]
        cases hr : s.ran s.made with
        | none => rfl
        | some _ => have := g.ran_made _ (by rw [hr]; rfl); omega
      · simp only [put_ne _ _ h] at hc; exact S1.reads c hc
  · have S2 := S1.hush (mark_hush _ s.made (Model.grow cs s).tick none (Or.inl ez))
    split
    · have hz : (mark (Model.grow cs s) s.made (Model.grow cs s).tick none).asleep s.made = false := by
        simp [ez]
      have S3 := S2.hush (first_hush cs _ s.made 0 (hA _) hz)
      simp only [actnow]
      split
      · refine Sleeps.act ?_ _ _; exact S3.of_eq rfl rfl rfl rfl
      · exact S3
    · exact S2

-- a going: d asleep, not due, reading nothing
theorem Sleeps.bury {cs : Nat → Comp K V} {s : State K V} (S : Sleeps s) (hQ : Quiet cs) (d : Nat) :
    Sleeps (bury cs s d) := by
  unfold Model.bury
  cases (cs d).key with
  | none => exact S
  | some k =>
    simp only
    split
    · exact S
    · rw [hQ d]
      simp only [List.foldl_nil]
      refine Sleeps.untrack ⟨fun c hc => ?_, fun c hc => ?_⟩ _
      · by_cases h : c = d
        · subst h; simp
        · simp [put_ne _ _ h] at hc ⊢; exact S.due c hc
      · by_cases h : c = d
        · subst h; simp
        · simp [put_ne _ _ h] at hc ⊢; exact S.reads c hc

theorem Sleeps.step {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s s' : State K V}
    (S : Sleeps s) (hA : A2 cs) (h : step cs rank s = some s') : Sleeps s' := by
  simp only [Model.step] at h
  split at h
  · split at h
    · rename_i c hc
      cases h
      have := (next_ready hc).1
      simp only [ready, Bool.and_eq_true] at this
      exact S.first hA this.1 _
    · cases h; exact S.of_eq rfl rfl rfl rfl
  · split at h
    · cases h; refine Sleeps.act ?_ _ _; exact S.of_eq rfl rfl rfl rfl
    · split at h
      · cases h; refine Sleeps.act ?_ _ _; exact S.of_eq rfl rfl rfl rfl
      · split at h
        · cases h; exact S.of_eq rfl rfl rfl rfl
        · split at h
          · cases h
          · cases h; exact S.of_eq rfl rfl rfl rfl
  · split at h
    · rename_i d rest _
      cases h
      exact (S.of_eq (s' := { s with dying := rest }) rfl rfl rfl rfl).bury hA.goes d
    · cases h; exact S.of_eq rfl rfl rfl rfl

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

-- Reach, and the host's writes and changes named by a computation (a write in run(c), or
-- mark(keys, c)) whose latest run is unflagged: with L1, any but one whose latest run ended pending
-- while flagged. naming such a one, its own mark is cut, and Theorem 2 fails for it (Model.Check,
-- hostcut; the TS the same). Theorem 2 below is stated over these
inductive Wide (cs : Nat → Comp K V) (rank : State K V → Nat → Nat) : State K V → Prop
  | empty : Wide cs rank empty
  | make {s} : Wide cs rank s → Wide cs rank (make cs s)
  | write {s} (kvs : List (K × V)) (who : Option Nat) : Wide cs rank s →
      (∀ c, who = some c → ((s.ran c).bind (·.loop)) = none) →
      Wide cs rank (changed cs (kvs.foldl (fun s kv => store s kv.1 kv.2) s) (kvs.map (·.1)) who)
  | tell {s} (keys : List K) (who : Option Nat) : Wide cs rank s →
      (∀ c, who = some c → ((s.ran c).bind (·.loop)) = none) → Wide cs rank (changed cs s keys who)
  | begin {s} : Wide cs rank s → Wide cs rank (begin s)
  | step {s s'} : Wide cs rank s → step cs rank s = some s' → Wide cs rank s'
  | close {s} : Wide cs rank s → step cs rank s = none → Wide cs rank (close s)

theorem Reach.wide {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (h : Reach cs rank s) : Wide cs rank s := by
  induction h with
  | empty => exact .empty
  | make _ ih => exact .make ih
  | write kvs _ ih => exact .write kvs none ih (by simp)
  | tell keys _ ih => exact .tell keys none ih (by simp)
  | begin _ ih => exact .begin ih
  | step _ h ih => exact .step ih h
  | close _ h ih => exact .close ih h

-- the invariant and the asleep, together, on every state Wide reaches (A2)
theorem Wide.inv {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Wide cs rank s) : Good cs s ∧ Sleeps s := by
  induction h with
  | empty => exact ⟨Good.empty cs, Sleeps.empty⟩
  | make _ ih => exact ⟨ih.1.make hA, ih.2.make ih.1.toCore hA⟩
  | write kvs who _ hw ih =>
    refine ⟨ih.1.told kvs who hw, Sleeps.changed ?_ _ _⟩
    obtain ⟨st, h1, _⟩ := stores_shape _ kvs
    rw [h1]; exact ih.2.of_eq rfl rfl rfl rfl
  | tell keys who _ hw ih => exact ⟨ih.1.tell keys who hw, ih.2.changed keys who⟩
  | begin _ ih => exact ⟨ih.1.begin, ih.2.of_eq rfl rfl rfl rfl⟩
  | step _ h ih => exact ⟨ih.1.step ih.2 hA h, ih.2.step hA h⟩
  | close _ _ ih => exact ⟨ih.1.close, ih.2.of_eq rfl rfl rfl rfl⟩

theorem Wide.good {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Wide cs rank s) : Good cs s := (h.inv hA).1

theorem Wide.sleeps {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Wide cs rank s) : Sleeps s := (h.inv hA).2

theorem Reach.good {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Reach cs rank s) : Good cs s := h.wide.good hA

theorem Reach.sleeps {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Reach cs rank s) : Sleeps s := h.wide.sleeps hA

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
    (hA : A2 cs) (h : Wide cs rank s) :
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
    (hA : A2 cs) (h : Wide cs rank s) {p : Nat} (hp : (s.due p).isSome) :
    (next rank s).isSome := by
  have g := (h.good hA).toCore
  obtain ⟨y, hy, hym, _⟩ := walk_ready g (fun _ => True) (fun _ _ _ _ => trivial) _ p hp
    (g.due_made p hp) trivial (chain_short g (g.due_made p hp))
  simp only [next]
  exact pick_some _ _ none (Or.inr (List.ne_nil_of_mem (a := y) (by simp [hym, hy])))

-- and below any due one there is a ready one of no greater rank, the rank ranked (Rank.lean)
theorem next_below {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Wide cs rank s) (hr : ranked (fun p q => q ∈ edges s p) (rank s))
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
    (hA : A2 cs) (h : Wide cs rank s) {c : Nat} {r : Run K V} (hr : s.ran c = some r)
    (hd : s.due c = none) (hs : settled r) : ∀ q ∈ r.seen, s.store q.1 = q.2 :=
  (h.good hA).fresh c r hr hd hs

-- Theorem 2: such a computation's latest run is its run from scratch on the store now: the same
-- outcome, the same reads, and its tracked keys are those reads
theorem quiescence {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Wide cs rank s) {c : Nat} {r : Run K V} (hr : s.ran c = some r)
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
    (hA : A2 cs) (h : Wide cs rank s) {c : Nat} {r : Run K V} (hc : iseffect (cs c) = false)
    (hr : s.ran c = some r) (hd : s.due c = none) (hdone : r.ended = some .done) :
    ∃ v, (eval s.store (cs c).f).1 = .value v ∧ near (cs c).equal v (s.last c) ∧
      s.reads c = (eval s.store (cs c).f).2.map (·.1) := by
  obtain ⟨o, ho, he, hreads⟩ := quiescence hA h hr hd (Or.inl hdone)
  obtain ⟨v, hv, hn⟩ := (h.good hA).computes c r hc hr hdone
  rw [ho] at hv; cases hv
  exact ⟨v, by rw [he], hn, hreads⟩

-- (c) pending: pending from scratch too
theorem quiescence_pending {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Wide cs rank s) {c : Nat} {r : Run K V} (hr : s.ran c = some r)
    (hd : s.due c = none) (hp : r.ended = some .pending) :
    (eval s.store (cs c).f).1 = .pending := by
  obtain ⟨o, ho, he, _⟩ := quiescence hA h hr hd (Or.inr (Or.inr hp))
  rw [(h.good hA).pending c r hr hp] at ho; cases ho
  rw [he]

-- (b) failed: from scratch, f throws too, or gives a value whose equal throws against the last
theorem quiescence_failed {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Wide cs rank s) {c : Nat} {r : Run K V} (hr : s.ran c = some r)
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
    (hA : A2 cs) (h : Wide cs rank s) (hq : ∀ d, s.due d = none) :
    ∀ c r, iseffect (cs c) = false → s.ran c = some r → r.ended = some .done →
      ∃ v, (eval s.store (cs c).f).1 = .value v ∧ near (cs c).equal v (s.last c) ∧
        s.reads c = (eval s.store (cs c).f).2.map (·.1) :=
  fun _ _ hc hr hdone => quiescence_done hA h hc hr (hq _) hdone

-- and when no act is left either (a pulse's end): every effect done has acted on its value from
-- scratch on the store, or it is equal to the one it acted on
theorem quiescent_effects {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Wide cs rank s) (hq : ∀ d, s.due d = none) (ha : queue s = []) :
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

-- Theorem 3: an act (early or not) is called with the effect's value from scratch on the store at
-- the act. the store may have moved since the round's runs, by acts before it (an early act's
-- write too: C7): only what is due again is behind, and a due effect does not act
theorem act_fresh {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Wide cs rank s) {e : Nat} {v : V}
    (ha : (e, v) ∈ queue s) (hd : s.due e = none) :
    (eval s.store (cs e).f).1 = .value v := by
  have g := h.good hA
  obtain ⟨_, r, hr, _, hdone, ho⟩ := g.acts e v ha
  obtain ⟨o, ho', he, _⟩ := quiescence hA h hr hd (Or.inl hdone)
  rw [ho] at ho'; cases ho'
  rw [he]

-- the act step: the queue's head (the early ones first) is acted on, with that value, the store
-- unchanged since, and the last acted on
theorem step_acts {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s s' : State K V}
    (hA : A2 cs) (h : Wide cs rank s) {e : Nat} {v : V} {rest : List (Nat × V)}
    (hph : s.phase = .acts) (ha : queue s = (e, v) :: rest) (hd : s.due e = none)
    (hs : step cs rank s = some s') :
    (∃ es as, es ++ as = rest ∧ s' = act cs { s with earlies := es, acts := as } e v) ∧
      (eval s.store (cs e).f).1 = .value v := by
  refine ⟨?_, act_fresh hA h (by rw [ha]; simp) hd⟩
  simp only [Model.step, hph] at hs
  simp only [queue] at ha
  cases he : s.earlies with
  | nil =>
    rw [he] at ha hs
    simp only [List.nil_append] at ha
    simp only [ha] at hs
    cases hs
    exact ⟨[], rest, rfl, by rw [hph]⟩
  | cons a es =>
    rw [he] at ha hs
    simp only [List.cons_append, List.cons.injEq] at ha
    obtain ⟨h1, h2⟩ := ha
    subst h1
    cases hs
    exact ⟨es, s.acts, h2, by rw [hph]⟩

-- Theorem 5

-- what a run ended with, given how f ended (A2 for c): stopped, or o recorded, and the result's
-- branches; the store and lasts as before unless set was called
theorem ending_value {cs : Nat → Comp K V} {s3 : State K V} {c : Nat} {r : Run K V}
    (hr3 : s3.ran c = some r) (hst : r.stopped = none) (v : V) :
    ending cs s3 c (.value v) = result cs (edit s3 c fun r => { r with out := some (.value v) }) c v := by
  simp [ending, hr3, hst]

-- (a) cutoff: a run whose value is equal to the last changes neither the store nor the last
theorem cutoff (cs : Nat → Comp K V) (s : State K V) (c rk : Nat) (hp : nowrites (cs c).f)
    (hz : s.asleep c = false)
    {v : V} (hout : ((first cs s c rk).ran c).bind (·.out) = some (.value v))
    (heq : same (cs c).equal v (s.last c) = some true) :
    (first cs s c rk).store = s.store ∧ (first cs s c rk).last = s.last := by
  obtain ⟨s3, o, seen, vals, st, hf, e_ran, e_reads, e_store, e_made, e_last, e_after, e_acts,
    e_earlies, e_cut, hd3, e_lc, e_due, e_fresh, e_looping, e_writers, hseen, hfol, hstop⟩ :=
    first_spec cs s c rk hp hz
  rw [hf] at hout ⊢
  have hr3 : s3.ran c = some (begun s c vals st seen) := by rw [e_ran]; simp
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
      rw [finish_eq _ c _ (by simp [edit, hr3]; rfl) _ _ _ _ (by simp [fails, edit, e_cut])] at hout
      simp at hout
    | pending =>
      simp only [ending, hr3, begun, Option.bind_some, Option.isSome_none, Bool.false_eq_true,
        ite_false] at hout
      rw [finish_eq _ c _ (by simp [edit, hr3]; rfl) _ _ _ _ (by simp [fails])] at hout
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
        obtain ⟨_, _, -, hfin⟩ := finish_any t c r h3 e eq none th
        rw [hfin]; exact ⟨h1, h2⟩
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
            · by_cases hy : isearly (cs c) = true
              · simp only [hy, ite_true]; exact keep _ _ _ _ hst4 rfl ⟨_, hr4⟩
              · simp only [hy, Bool.false_eq_true, ite_false]; exact keep _ _ _ _ hst4 rfl ⟨_, hr4⟩
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
                from by rw [m.ran]; exact hr4) _ _ _ _ (by simp [fails])] at hout
              simp at hout
              subst hout
              rw [heq] at hsm; cases hsm

-- (c) an effect's unflagged run queues an act iff its value is not equal to the one it acted on
-- last (its older act dropped)
theorem acts_iff (cs : Nat → Comp K V) (s : State K V) (e rk : Nat) (hp : nowrites (cs e).f)
    (hz : s.asleep e = false)
    (he : iseffect (cs e) = true) (hl : s.loop e = none) {v : V}
    (hout : ((first cs s e rk).ran e).bind (·.out) = some (.value v)) :
    (e, v) ∈ queue (first cs s e rk) ↔ same (cs e).equal v (s.last e) = some false := by
  obtain ⟨s3, o, seen, vals, st, hf, e_ran, e_reads, e_store, e_made, e_last, e_after, e_acts,
    e_earlies, e_cut, hd3, e_lc, e_due, e_fresh, e_looping, e_writers, hseen, hfol, hstop⟩ :=
    first_spec cs s e rk hp hz
  rw [hf] at hout ⊢
  have hr3 : s3.ran e = some (begun s e vals st seen) := by rw [e_ran]; simp
  have hnot : (e, v) ∉ queue s3 := by rw [queue, e_acts, e_earlies]; simp
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
      rw [finish_eq _ e _ (by simp [edit, hr3]; rfl) _ _ _ _ (by simp [fails, edit, e_cut])] at hout
      simp at hout
    | pending =>
      simp only [ending, hr3, begun, Option.bind_some, Option.isSome_none, Bool.false_eq_true,
        ite_false] at hout
      rw [finish_eq _ e _ (by simp [edit, hr3]; rfl) _ _ _ _ (by simp [fails])] at hout
      simp at hout
    | value v' =>
      rw [ending_value hr3 rfl] at hout ⊢
      generalize hs4 : (edit s3 e fun r => { r with out := some (Out.value v') }) = s4 at hout ⊢
      have hr4 : s4.ran e = some { begun s e vals none seen with out := some (.value v') } := by
        rw [← hs4]; simp [edit, hr3]
      have hl4 : s4.last = s.last := by rw [← hs4]; simp [edit, e_last]
      have ha4 : queue s4 = queue s3 := by rw [← hs4]; simp [edit, queue]
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
        obtain ⟨_, _, -, hfin⟩ := finish_any t e _ (h1.trans hr4) e' eq none th
        rw [hfin] at h2
        simp at h2; exact h2
      simp only [result, hl4, hfl, hk] at hout ⊢
      cases hsm : same (cs e).equal v' (s.last e) with
      | none =>
        simp only [hsm] at hout ⊢
        have := hvv s4 _ _ _ rfl hout
        subst this
        rw [finish_eq s4 e _ hr4 _ _ _ _ (by simp [fails, hl, hr4, begun])]
        have := ha4 ▸ hnot
        simp only [queue] at this
        simp [queue, this, hsm]
      | some b =>
        simp only [hsm, Option.isSome_none, Bool.false_and, Bool.false_eq_true, ite_false]
          at hout ⊢
        cases b with
        | true =>
          simp only [ite_true] at hout ⊢
          have := hvv s4 _ _ _ rfl hout
          subst this
          rw [finish_eq s4 e _ hr4 _ _ _ _ (by simp [fails])]
          have := ha4 ▸ hnot
          simp only [queue] at this
          simp [queue, this, hsm]
        | false =>
          simp only [Bool.false_eq_true, ite_false] at hout ⊢
          split at hout
          · rename_i hy
            simp only [hy, ite_true]
            have := hvv _ _ _ _ (by rfl) hout
            subst this
            rw [finish_eq _ e _ (show ({ s4 with earlies := s4.earlies ++ [(e, v')], last := s.last } :
              State K V).ran e = _ from hr4) _ _ _ _ (by simp [fails])]
            simp [hsm, queue]
          · rename_i hy
            simp only [hy, Bool.false_eq_true, ite_false]
            have := hvv _ _ _ _ (by rfl) hout
            subst this
            rw [finish_eq _ e _ (show ({ s4 with acts := s4.acts ++ [(e, v')], last := s.last } :
              State K V).ran e = _ from hr4) _ _ _ _ (by simp [fails])]
            simp [hsm, queue]

-- the act: due again, skipped; else act called with (v, the last acted on), and v is the last
theorem act_skip (cs : Nat → Comp K V) (s : State K V) (e : Nat) (v : V)
    (hd : (s.due e).isSome) : act cs s e v = s := by
  simp [Model.act, hd]

theorem act_last (cs : Nat → Comp K V) (s : State K V) (e : Nat) (v : V)
    {g : V → Option V → List (K × V)} (hk : (cs e).kind = .effect g) (hd : s.due e = none) :
    (act cs s e v).last e = some v := by
  simp [Model.act, hd, hk, say]

end Model
