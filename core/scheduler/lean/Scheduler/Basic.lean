-- LLM generated working output
-- what the other files share: causes (causes.ts, Cause) and being on a path back to a run.
-- Causes.lean proves causes.ts's loop and from against back; Model.lean uses back as their spec.

-- a cause: a run of a computation, and the causes of the marks it was given (causes.ts, Cause)
inductive Cause (α : Type) where
  | mk (of : α) (parents : List (Cause α))

namespace Cause

variable {α : Type}

def of : Cause α → α
  | mk o _ => o

def parents : Cause α → List (Cause α)
  | mk _ ps => ps

-- on a path back to a run of t: it is of t, or one of its parents is (causes.ts, loop's `on`)
def back [DecidableEq α] (t : α) : Cause α → Bool
  | mk o ps => o == t || ps.attach.any (fun ⟨p, _⟩ => back t p)

end Cause

-- rank.ts's promise, over the edges e (order.ts, edges: a computation to the writers its last run
-- read and the one it waits after): along an edge the rank never rises, and leaving a strongly
-- connected component it falls. Rank.lean proves rank.ts keeps it; Model.lean assumes it of its rank
def ranked {α : Type} (e : α → α → Prop) (rank : α → Nat) : Prop :=
  ∀ p q, e p q → rank q ≤ rank p ∧ (¬ Relation.TransGen e q p → rank q < rank p)
