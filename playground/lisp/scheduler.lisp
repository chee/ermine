;;; scheduler.lisp — computations over the host's keys, run in pulses: order, stops, loops cut by
;;; their causes, async landings, scopes that own what is made in them. The harness plays the host.
(in-package :ermine)

;;; ---------------------------------------------------------------- state

(defstruct (owner (:constructor %make-owner))
  id name kind info parent (children '()) (cleanups '()) disposed
  ;; computations
  f act-expr set-expr to equal early
  (runs 0) latest info-run (last +none+) made-tick
  due due-tick (values '()) waits aside
  ;; names: children of earlier runs (old, oldest first), cleanups queued for the round's end,
  ;; the loop that queued them, an effect's act going on
  (old-children '()) old queued cuts doing
  ;; ranks: rank, the making it is of, what is after it (owner → edges)
  (rank 0) (ranked 0) afters
  (chains '()) latest-loop looping
  tnode)                                ; its name in the tracker

(defstruct crun comp n mark chain given flag cut state reads promise (values '()) stopped)
(defvar *queued* '() "computations with cleanups queued, oldest first, for the round's end")
(defstruct chain comp pulse given)
(defstruct cleanup expr owner origin env)
(defstruct promise name run cont env (state :pending) outcome)
(defstruct ctx owner writer name run (value +none+) (previous +none+) (origin :run) maker)

(defvar *owners* (make-hash-table :test 'equal) "name → owner, while not torn down")
(defvar *all* '() "every computation made, newest first")
(defvar *ids* 0)
(defvar *tick* 0)
(defvar *values* (make-hash-table :test 'equal))
(defvar *key-writer* (make-hash-table :test 'equal))
(defvar *moments* '())
(defvar *pulse-moments* 0)
(defvar *log* '())
(defvar *forgotten* '())
(defvar *started* '())
(defvar *promises* (make-hash-table :test 'equal) "name → a promise not yet settled")
(defvar *settled* '() "settled promises waiting to land, oldest first")
(defvar *acts* '() "queued acts: (effect . run), in the order their runs ended")
(defvar *pulse* 0)
(defvar *in-pulse* nil)
(defvar *ctx* nil)
(defvar *results* (make-hash-table :test 'eq) "a run → the value it gave")
(defvar *comp-by-node* (make-hash-table :test 'equal) "tracker node → computation")
(defvar *gone* (make-hash-table :test 'equal) "name → the last owner of it torn down")

(define-condition sched-error (error) ((msg :initarg :msg :reader msg))
  (:report (lambda (c s) (format s "~a" (msg c)))))
(defun oops (fmt &rest args) (error 'sched-error :msg (apply #'format nil fmt args)))
(define-condition pending-signal (error) () (:report "pending"))
(define-condition stop-signal (error) ((waits :initarg :waits :reader waits)) (:report "stopped"))
(defvar *thrown* nil "nil, or (error): the first error a listener or a cleanup after a run threw, held")
(defvar *armed* nil "nil, or (on at message): a listener armed to throw, once")
(defvar *escaped* nil "nil, or (error): what a listener threw where nothing could take it (a settling, a making), out of the next pulse")
(defvar *running* nil "the run whose f, set, act or cleanups are going on")
(defvar +pending+ '+pending+)

(defun computation-p (o) (and o (member (owner-kind o) '(:compute :effect))))
(defun alive-p (o) (and o (not (owner-disposed o))))

(defun fire (on names)
  "the harness's own listener on, told: throws once when armed (at: one of names)"
  (when (and *armed* (equal (first *armed*) on)
             (or (null (second *armed*)) (member (second *armed*) names :test #'equal)))
    (let ((msg (third *armed*)))
      (setf *armed* nil)
      (oops "~a" msg))))

(defun moment (m &optional on name)
  "a moment told: kept, counted (endless past 10000), then the listener on armed to throw"
  (push m *moments*)
  (when (and *in-pulse* (> (incf *pulse-moments*) 10000)) (oops "endless"))
  (when on (fire on (list name))))

;;; finish, then rethrow: what a listener threw is held while what was going on finishes
(defun hold-error (e) (unless *thrown* (setf *thrown* (list e))))
(defmacro holding (&body body)
  "body, an error it signals held"
  `(handler-case (progn ,@body) (sched-error (e) (hold-error e))))
(defun rethrow (outer)
  (let ((tt *thrown*))
    (setf *thrown* outer)
    (when tt (error (first tt)))))
;;; what a listener threw in a settling or a making: kept past the request, out of a pulse once done
(defun escape-error (e) (unless *escaped* (setf *escaped* (list e))))
(defmacro bracket (&body body)
  "a bracket of its own: what was held in it comes out at its end; what was held around it stays"
  (let ((outer (gensym)))
    `(let ((,outer *thrown*))
       (setf *thrown* nil)
       (unwind-protect (progn ,@body) (rethrow ,outer)))))

;;; ---------------------------------------------------------------- equality

(defun js-is (a b)
  (cond ((and (realp a) (realp b)) (same-number a b))
        ((and (stringp a) (stringp b)) (string= a b))
        (t (eq a b))))
(defun stringify (x)
  "JSON.stringify: -0 as 0, NaN and the infinities as null"
  (with-output-to-string (o)
    (labels ((w (x)
               (cond ((and (floatp x) (or (minus-zero-p x))) (write-string "0" o))
                     ((realp x) (write-number x o))
                     ((jmap-p x) (write-char #\{ o)
                                 (loop for (e . more) on (jmap-entries x)
                                       do (write-json-string (car e) o) (write-char #\: o) (w (cdr e))
                                          (when more (write-char #\, o)))
                                 (write-char #\} o))
                     ((jlistp x) (write-char #\[ o)
                                 (loop for i from 0 below (length x)
                                       do (when (> i 0) (write-char #\, o)) (w (aref x i)))
                                 (write-char #\] o))
                     (t (write-json x o)))))
      (w x))))
(defun json-equal (a b) (string= (stringify a) (stringify b)))
(defun results-equal (c a b)
  (if (eq (owner-equal c) :json) (json-equal a b) (js-is a b)))

;;; ---------------------------------------------------------------- owners and info

(defun info-of (o)
  "an owner's pairs: a scope's as made; a computation's from its latest run (or the tick it was made at)"
  (cond ((null o) nil)
        ((computation-p o)
         (let ((r (owner-info-run o)) (owner-pair (owner-info o)))
           (append (if r (list (jlist "run" (crun-n r)) (jlist "mark" (crun-mark r)))
                       (list (jlist "mark" (owner-made-tick o))))
                   owner-pair)))
        (t (owner-info o))))
(defun pairs-json (pairs) (mklist pairs))
(defun owner-pairs (parent) (if parent (list (jlist "owner" (pairs-json (info-of parent)))) '()))

(defun lookup (name)
  "the owner by name, not torn down: no scope s"
  (or (gethash name *owners*) (gethash name *gone*)
      (oops "no scope ~a" (if (stringp name) name (json-text name)))))

(defun check-name (name)
  "a name taken by one not torn down and not old is refused: an old one's is taken over"
  (let ((o (gethash name *owners*)))
    (when (and o (not (owner-old o))) (oops "name taken: ~a" name))))

(defun adopt (parent child)
  (setf (owner-children parent)
        (append (owner-children parent) (list (cons child (if (owner-doing parent) :act :run))))))

(defun read-pairs (x)
  (if (jlistp x) (coerce x 'list) '()))

(defun make-scope (name info parent)
  "a scope under parent (nil: a root)"
  (when name (check-name name))
  (when (and parent (owner-disposed parent)) (oops "disposed"))
  (let ((pairs (read-pairs info)))
    (when (null pairs) (oops "empty"))
    (let ((s (%make-owner :id (incf *ids*) :name name :kind :scope :parent parent
                          :info (append pairs (owner-pairs parent)))))
      (when name (setf (gethash name *owners*) s))
      (when parent (adopt parent s))
      s)))

;;; ---------------------------------------------------------------- tracking (the tracker, by name)

(defun key-node (k) (concatenate 'string "k:" k))
(defun node-key (n) (subseq n 2))
(defun readers-of (k)
  "computations reading k, in the order they began reading it"
  (let ((n (gethash (key-node k) *tnodes*)))
    (if n
        (remove-duplicates (mapcar (lambda (l) (gethash (link-from l) *comp-by-node*)) (tnode-readers n))
                           :from-end t)
        '())))
(defun key-tracked-p (k)
  (let ((n (gethash (key-node k) *tnodes*))) (and n (tnode-readers n))))
(defun reads-keys (c)
  (let ((n (gethash (owner-tnode c) *tnodes*)))
    (if n (remove-duplicates (mapcar (lambda (l) (node-key (link-to l))) (tnode-reads n)) :test #'string=) '())))

;;; the key's first tracker, told: a listener's error comes back (the read is all done first)
(defun track-read (c k)
  (let ((before (key-tracked-p k)))
    (track (owner-tnode c) (key-node k))
    (when (and (not before) (key-tracked-p k))
      (push k *started*)
      (handler-case (progn (fire "started" (list k)) nil) (sched-error (e) e)))))

(defun forget (keys)
  "keys nobody tracks now: told, a listener's error held"
  (dolist (k keys)
    (unless (key-tracked-p k)
      (push k *forgotten*)
      (holding (fire "forgotten" (list k))))))
(defun end-tracking (c)
  (let ((before (reads-keys c)))
    (end-run (owner-tnode c))
    (forget before)))
(defun untrack-all (c)
  (let ((before (reads-keys c)))
    (untrack (owner-tnode c))
    (forget before)))

;;; ---------------------------------------------------------------- order
;;; what runs next: the lowest rank, then the earliest due, then the oldest. ranks (order.ts): a
;;; computation is after the writers its last run read and the one it waits after; made whole when
;;; first asked, then mended as edges change, only rising; a cycle shares one rank; a mend past
;;; 4*ranked+64 steps stops: made whole again at the next pick, where a rank may fall.

(defvar *making* 0 "the making of the ranks now (0: none, made at the next pick)")
(defvar *made* 0)
(defvar *ranked* 0 "how many have a rank")
(defvar *members* (make-hash-table :test 'eq) "members of a component of more than one")

(defun waits-of (c) (let ((w (owner-waits c))) (and w (alive-p w) w)))
(defun live-computations () (remove-if-not #'alive-p *all*))

(defun edges-of (p)
  "what p is after: the writers its last run read, and the one it waits after (alive, not itself)"
  (let ((w (waits-of p)))
    (remove-if (lambda (q) (or (eq q p) (not (alive-p q))))
               (if w (cons w (owner-values p)) (owner-values p)))))
(defun edge-p (p q) (and q (not (eq q p)) (alive-p q)))
(defun rank-of (p) (if (eql (owner-ranked p) *making*) (owner-rank p) 0))

(defun tarjan (nodes edges &optional floor)
  "strongly connected components, each ranked after the ones its members are after (rank.ts)"
  (let ((out (make-hash-table :test 'eq)) (index (make-hash-table :test 'eq))
        (low (make-hash-table :test 'eq)) (on (make-hash-table :test 'eq))
        (stack '()) (next 0))
    (labels ((visit (p)
               (setf (gethash p index) next (gethash p low) next)
               (incf next)
               (push p stack) (setf (gethash p on) t)
               (let ((es (funcall edges p)))
                 (dolist (q es)
                   (cond ((not (nth-value 1 (gethash q index)))
                          (visit q)
                          (setf (gethash p low) (min (gethash p low) (gethash q low))))
                         ((gethash q on)
                          (setf (gethash p low) (min (gethash p low) (gethash q index)))))))
               (when (= (gethash p low) (gethash p index))
                 (let ((members '()))
                   (loop for m = (pop stack)
                         do (remhash m on) (push m members)
                         until (eq m p))
                   (let ((r 0) (inside (make-hash-table :test 'eq)))
                     (dolist (x members) (setf (gethash x inside) t))
                     (dolist (x members)
                       (when floor (setf r (max r (funcall floor x))))
                       (dolist (q (funcall edges x))
                         (unless (gethash q inside) (setf r (max r (1+ (gethash q out)))))))
                     (dolist (x members) (setf (gethash x out) r)))))))
      (dolist (p nodes) (unless (nth-value 1 (gethash p index)) (visit p))))
    out))

(defun note-members (r edges)
  (maphash (lambda (p k)
             (dolist (q (funcall edges p))
               (when (eql (gethash q r) k)
                 (setf (gethash p *members*) t (gethash q *members*) t))))
           r))

(defun order-ranks ()
  (when (zerop *making*)
    (let ((r (tarjan (reverse (live-computations)) #'edges-of)))
      (setf *making* (incf *made*) *ranked* (hash-table-count r))
      (clrhash *members*)
      (maphash (lambda (p k) (setf (owner-rank p) k (owner-ranked p) *making*)) r)
      (note-members r #'edges-of))))

(defun order-local (start)
  "ranked again from start and everything after it, each at least one past what it is after outside"
  (let ((region (make-hash-table :test 'eq)) (stack (copy-list start)))
    (loop while stack
          do (let ((x (pop stack)))
               (unless (or (not (alive-p x)) (gethash x region))
                 (setf (gethash x region) t)
                 (when (owner-afters x) (maphash (lambda (y n) (declare (ignore n)) (push y stack)) (owner-afters x))))))
    (flet ((inner (p) (remove-if-not (lambda (q) (gethash q region)) (edges-of p)))
           (floor* (p) (let ((k 0))
                         (dolist (q (edges-of p) k)
                           (unless (gethash q region) (setf k (max k (1+ (rank-of q)))))))))
      (let ((r (let ((nodes '())) (maphash (lambda (p v) (declare (ignore v)) (push p nodes)) region)
                 (tarjan nodes #'inner #'floor*))))
        (maphash (lambda (p k)
                   (remhash p *members*)
                   (unless (eql (owner-ranked p) *making*) (incf *ranked*))
                   (setf (owner-rank p) k (owner-ranked p) *making*))
                 r)
        (note-members r #'inner)))))

(defun order-mend (work)
  "the edges of these changed: each rises to one past its edges' most, and what is after it too"
  (when (zerop *making*) (return-from order-mend))
  (let ((begun (make-hash-table :test 'eq)) (limit (+ (* 4 *ranked*) 64)))
    (dolist (x work) (setf (gethash x begun) t))
    (flet ((begun-list () (let ((l '())) (maphash (lambda (k v) (declare (ignore v)) (push k l)) begun) l)))
      (loop for steps from 0
            while work
            do (when (> steps limit) (setf *making* 0) (return-from order-mend))
               (let ((x (pop work)))
                 (when (alive-p x)
                   (when (gethash x *members*)
                     (return-from order-mend (order-local (append (list x) work (begun-list)))))
                   (let ((k 0))
                     (dolist (q (owner-values x)) (when (edge-p x q) (setf k (max k (1+ (rank-of q))))))
                     (when (edge-p x (owner-waits x)) (setf k (max k (1+ (rank-of (owner-waits x))))))
                     (when (> k (rank-of x))
                       (setf (owner-rank x) k (owner-ranked x) *making*)
                       (when (owner-afters x)
                         (let ((ys '()))
                           (maphash (lambda (y n) (declare (ignore n)) (push y ys)) (owner-afters x))
                           (dolist (y ys)
                             (when (gethash y begun) (return-from order-mend (order-local (begun-list))))
                             (push y work))))))))))))

(defun order-link (p q)
  (let ((m (or (owner-afters q) (setf (owner-afters q) (make-hash-table :test 'eq)))))
    (incf (gethash p m 0))))
(defun order-unlink (p q)
  (let ((m (owner-afters q)))
    (when m
      (let ((n (1- (gethash p m 0))))
        (if (> n 0) (setf (gethash p m) n) (remhash p m))))))

(defun order-sees (p next)
  "the writers p's run read: owner-values becomes next"
  (let ((old (owner-values p)) (changed nil))
    (setf (owner-values p) next)
    (dolist (q old)
      (unless (member q next :test #'eq)
        (order-unlink p q) (when (edge-p p q) (setf changed t))))
    (dolist (q next)
      (unless (member q old :test #'eq)
        (order-link p q) (when (edge-p p q) (setf changed t))))
    (when changed (order-mend (list p)))))

(defun order-waits (p q)
  "p waits after q (nil: after none)"
  (unless (eq (owner-waits p) q)
    (let ((changed nil) (was (owner-waits p)))
      (when was (order-unlink p was) (when (edge-p p was) (setf changed t)))
      (setf (owner-waits p) q)
      (when q (order-link p q) (when (edge-p p q) (setf changed t)))
      (when changed (order-mend (list p))))))

(defun order-started (p)
  (unless (zerop *making*)
    (setf (owner-rank p) 0 (owner-ranked p) *making*)
    (incf *ranked*)))

(defun order-gone (p)
  "p goes: out of the ranks, after nothing; what was after it keeps its rank"
  (dolist (q (owner-values p)) (order-unlink p q))
  (setf (owner-values p) '())
  (when (owner-waits p) (order-unlink p (owner-waits p)))
  (setf (owner-waits p) nil)
  (when (and (eql (owner-ranked p) *making*) (/= *making* 0)) (decf *ranked*))
  (setf (owner-ranked p) 0)
  (let ((m (owner-afters p)))
    (setf (owner-afters p) nil)
    (when (and (gethash p *members*) m)
      (remhash p *members*)
      (let ((l '())) (maphash (lambda (k v) (declare (ignore v)) (push k l)) m) (order-local l)))
    (remhash p *members*)))

(defun order-rank (c) (order-ranks) (rank-of c))

(defun next-due ()
  "the due one to run, with its rank: not waiting after a due one; lowest rank, then the earliest
   due, then the oldest"
  (order-ranks)
  (let ((best nil) (best-rank 0))
    (dolist (c *all*)
      (when (and (alive-p c) (owner-due c)
                 (not (let ((w (waits-of c))) (and w (owner-due w)))))
        (let ((r (rank-of c)))
          (when (or (null best)
                    (< r best-rank)
                    (and (= r best-rank)
                         (or (< (owner-due-tick c) (owner-due-tick best))
                             (and (= (owner-due-tick c) (owner-due-tick best))
                                  (< (owner-id c) (owner-id best))))))
            (setf best c best-rank r)))))
    (values best best-rank)))

;;; ---------------------------------------------------------------- chains and loops

(defun chain-given* (ch) (if (= (chain-pulse ch) *pulse*) (chain-given ch) '()))
(defun loop-through (ch c)
  "the computations on the paths of ch that lead back to c, or nil"
  (let ((found '()))
    (labels ((walk (ch path)
               (let ((path (cons (chain-comp ch) path)))
                 (if (eq (chain-comp ch) c)
                     (dolist (x path) (pushnew x found))
                     (dolist (g (chain-given* ch)) (walk g path))))))
      (when ch (walk ch '())))
    (when found
      (sort found #'< :key #'owner-id))))

;;; ---------------------------------------------------------------- marks

(defun named-run (named)
  "what a change names: a run, a computation (its latest run), or nil (from outside)"
  (cond ((crun-p named) named)
        ((computation-p named) (owner-latest named))
        (t nil)))

(defun due-moment (c tick writer)
  (moment (jmap "due" (owner-name c) "tick" tick "writer" (and writer (owner-name writer)))))

(defun change (keys named)
  "the keys changed (one mark, one tick), named by a run, a computation or nothing. every listener
   is told; the first error one threw comes out after"
  (let* ((tick (incf *tick*))
         (run (named-run named))
         (comp (cond ((crun-p named) (crun-comp named))
                     ((and (computation-p named) run) named)
                     (t nil)))
         (chain (and run (eq run (owner-latest (crun-comp run))) (crun-chain run)))
         (now '()) (failed nil))
    (dolist (k keys)
      ;; a compute alive, named by a run of it or by it, becomes the keys' writer
      (when (and comp (eq (owner-kind comp) :compute) (alive-p comp))
        (setf (gethash k *key-writer*) comp))
      (dolist (c (readers-of k))
        (when (mark-on c tick run chain) (push c now))))
    (setf now (nreverse now))
    (handler-case (dolist (c now) (due-moment c tick comp))
      (sched-error (e) (setf failed e)))
    (handler-case (fire "mark" keys)
      (sched-error (e) (unless failed (setf failed e))))
    (when failed (error failed))
    tick))

(defun mark-on (c tick run chain)
  "c is due by a change: true when it was not already"
  (when (alive-p c)
    (let* ((through (loop-through chain c))
           (cut (and through run (crun-flag run))))
      (when chain (push chain (owner-chains c)))
      (cond
        (cut (setf (crun-cut run) t) nil)
        (t
         (setf (owner-latest-loop c) through)
         (cond ((and through (owner-looping c)) nil)
               (t (setf (owner-looping c) nil)
                  (make-due c tick))))))))

(defun make-due (c tick)
  (unless (owner-due c)
    (setf (owner-due c) t (owner-due-tick c) tick)
    t))

;;; ---------------------------------------------------------------- teardown and dispose

(defun run-cleanup (cl writer)
  "a cleanup's expression, its scope open; what it throws comes back"
  (let ((*ctx* (make-ctx :owner (cleanup-owner cl) :writer writer
                         :name (if (computation-p (cleanup-owner cl)) (cleanup-owner cl) writer)
                         :value (ctx-value (cleanup-env cl)) :previous (ctx-previous (cleanup-env cl)))))
    (handler-case (progn (evaluate (cleanup-expr cl)) nil)
      (error (e) e))))

(defun dispose-kids (kids writer)
  "kids, newest first, each disposed; the first error"
  (let ((first-error nil))
    (dolist (k (reverse kids) first-error)
      (handler-case (dispose (car k) :writer writer :nested t)
        (error (e) (unless first-error (setf first-error e)))))))

(defun cleanups-of (o which)
  "o's cleanups to run, oldest first: a computation's the queued, those set aside, its act's, its runs'"
  (let ((own (owner-cleanups o)))
    (cond ((eq which :act) (remove-if-not (lambda (c) (eq (cleanup-origin c) :act)) own))
          ((computation-p o)
           (append (owner-queued o) (owner-aside o)
                   (remove-if-not (lambda (c) (eq (cleanup-origin c) :act)) own)
                   (remove-if-not (lambda (c) (eq (cleanup-origin c) :run)) own)))
          (t own))))

(defun teardown (o &key (which :all) writer)
  "what is under o first (what is old on it too), newest first, then its cleanups, newest first;
   every one runs, the first error comes back. o stays. which :act: only its act's"
  (let ((first-error nil))
    (flet ((note (e) (when (and e (not first-error)) (setf first-error e))))
      (let ((kids (if (eq which :all)
                      (append (owner-old-children o) (owner-children o))
                      (remove-if-not (lambda (k) (eq (cdr k) which)) (owner-children o)))))
        (dolist (k kids) (setf (owner-old (car k)) nil))
        (if (eq which :all)
            (setf (owner-old-children o) nil (owner-children o) nil)
            (setf (owner-children o) (set-difference (owner-children o) kids)))
        (note (dispose-kids kids writer)))
      (let ((cls (cleanups-of o which)))
        (if (eq which :all)
            (setf (owner-cleanups o) nil (owner-queued o) nil (owner-aside o) nil)
            (setf (owner-cleanups o) (set-difference (owner-cleanups o) cls)))
        (dolist (cl (reverse cls))
          (note (run-cleanup cl (if (computation-p o) (and (owner-latest o) o) writer))))))
    first-error))

(defun lift-children (c)
  "as a run starts: what its runs made (an effect's act's stays) is old, alive as ever; its
   cleanups are set aside"
  (let ((lifted (remove-if-not (lambda (k) (eq (cdr k) :run)) (owner-children c))))
    (when lifted
      (dolist (k lifted) (setf (owner-old (car k)) t))
      (setf (owner-children c) (set-difference (owner-children c) lifted)
            (owner-old-children c) (append (owner-old-children c) lifted))))
  (let ((cls (remove-if-not (lambda (x) (eq (cleanup-origin x) :run)) (owner-cleanups c))))
    (setf (owner-cleanups c) (set-difference (owner-cleanups c) cls)
          (owner-aside c) (append (owner-aside c) cls))))

(defun claim (c)
  "an old child of the run open's computation, made again: back under its owner, newest, and due
   (a tick, told as a due by the run open). not old: nil"
  (when (and (owner-old c) (alive-p c))
    (let ((parent (owner-parent c)))
      (setf (owner-old-children parent) (remove c (owner-old-children parent) :key #'car)
            (owner-old c) nil)
      (adopt-as parent c :run)
      (let ((r *running*)) (when (and r (crun-flag r)) (setf (crun-cut r) t)))
      (let* ((tick (incf *tick*)) (r *running*) (writer (and r (crun-comp r)))
             (now (let ((chain (and r (eq r (owner-latest (crun-comp r))) (crun-chain r))))
                    (mark-on c tick r chain))))
        (bracket
          (holding (when now (due-moment c tick writer)))
          (holding (fire "mark" nil)))))
    t))

(defun adopt-as (parent child origin)
  (setf (owner-children parent) (append (owner-children parent) (list (cons child origin)))))

(defun drop-unclaimed-children (c r)
  "r done: what is still old on c goes, newest first (the first error held); its cleanups set
   aside are queued, for the round's end"
  (when (owner-old-children c)
    (let ((kids (owner-old-children c)))
      (setf (owner-old-children c) nil)
      (dolist (k kids) (setf (owner-old (car k)) nil))
      (let ((*running* r))
        (let ((e (dispose-kids kids c))) (when e (hold-error e))))))
  (when (and (owner-aside c) (alive-p c))
    (unless (owner-queued c) (setf *queued* (append *queued* (list c))))
    (setf (owner-queued c) (append (owner-queued c) (owner-aside c)))
    (when (crun-flag r) (setf (owner-cuts c) (crun-flag r)))
    (setf (owner-aside c) nil)))

(defun run-queued-cleanups ()
  "the cleanups queued, once the round's runs are done: each computation's newest first, with no
   catch: the first that throws ends the rest of its, its error held. a bracket"
  (when *queued*
    (bracket
      (let ((qs *queued*))
        (setf *queued* nil)
        (dolist (c qs)
          (let ((fs (owner-queued c)) (cuts (owner-cuts c)))
            (setf (owner-queued c) nil (owner-cuts c) nil)
            (when (and fs (alive-p c) (owner-latest c))
              (let* ((r (owner-latest c)) (flag (crun-flag r)) (*running* r))
                (when cuts (setf (crun-flag r) cuts))
                (unwind-protect
                     (dolist (cl (reverse fs))
                       (let ((e (run-cleanup cl c)))
                         (when e (hold-error e) (return))))
                  (setf (crun-flag r) flag))))))))))

(defun unact (c) (setf *acts* (remove c *acts* :key #'car)))

(defun dispose (o &key writer nested)
  "o and all under it gone; every cleanup runs, and the first error comes out, after them all: a
   listener's anywhere under before a cleanup's. nested (a teardown's): a listener's stays held"
  (unless (owner-disposed o)
    (let ((outer *thrown*) (err nil))
      (unless nested (setf *thrown* nil))
      (setf (owner-disposed o) t)
      (when (computation-p o)
        ;; going: not due, untracked, the writer of nothing, its act undone
        (setf (owner-due o) nil)
        (unact o)
        (order-gone o)
        (untrack-all o)
        (maphash (lambda (k w) (when (eq w o) (remhash k *key-writer*))) *key-writer*)
        (setf *queued* (remove o *queued*)))
      (setf err (teardown o :writer (if (computation-p o) o writer)))
      (when (owner-name o)
        (when (eq (gethash (owner-name o) *owners*) o) (remhash (owner-name o) *owners*))
        (setf (gethash (owner-name o) *gone*) o))
      (when (owner-parent o)
        (setf (owner-children (owner-parent o)) (remove o (owner-children (owner-parent o)) :key #'car)
              (owner-old-children (owner-parent o)) (remove o (owner-old-children (owner-parent o)) :key #'car)))
      (setf (owner-old o) nil)
      (when (computation-p o) (setf (owner-latest o) nil))
      (if nested
          (when err (error err))
          (progn (when (and err (not *thrown*)) (setf *thrown* (list err)))
                 (rethrow outer))))))

;;; ---------------------------------------------------------------- expressions

(defun given (which)
  (let ((v (if (equal which "value") (ctx-value *ctx*) (ctx-previous *ctx*))))
    (if (eq v +none+) :null v)))

(defun num-or-null (x)
  (cond ((eq x :null) 0) ((realp x) x) (t (oops "not a number: ~a" (stringify x)))))

(defun js-mod (a b)
  (let ((a (num-or-null a)) (b (num-or-null b)))
    (when (zerop b) (oops "mod by 0"))
    (norm-number (if (and (integerp a) (integerp b)) (rem a b) (rem (coerce a 'double-float) (coerce b 'double-float))))))

(defun read-host-key (k)
  (unless (stringp k) (oops "bad key"))
  (let ((run (ctx-run *ctx*)))
    (when (and run (alive-p (crun-comp run)))
      (let* ((c (crun-comp run)) (w (gethash k *key-writer*)))
        (push k (crun-reads run))
        ;; every listener told; what one threw comes out once the read is all done
        (let ((failed (track-read c k)))
          (when (and w (not (eq c w))) (pushnew w (crun-values run)))
          (when (and (alive-p w) (not (eq w c)) (owner-due w)
                     (not (waits-reach w c))
                     (not (some (lambda (ch) (and (eq (chain-comp ch) c) (= (chain-pulse ch) *pulse*)))
                                (owner-chains w))))
            (setf (crun-stopped run) w))
          (when failed (error failed))
          (when (crun-stopped run) (error 'stop-signal :waits (crun-stopped run))))))
    (multiple-value-bind (v there) (gethash k *values*)
      (if there v :null))))

(defun waits-reach (w c)
  "w waits after c, or after one that does"
  (loop for x = (waits-of w) then (waits-of x)
        for n from 0 below 1000
        while x
        thereis (eq x c)))

(defun open-scope ()
  (or (ctx-owner *ctx*) (oops "unscoped")))

(defun in-run (s thunk &key (writer (ctx-writer *ctx*)) name)
  "thunk in run(s): untracked, s open"
  (when (owner-disposed s) (oops "disposed"))
  (let ((*ctx* (make-ctx :owner s :writer writer
                         :name (or name (if (computation-p s) s (ctx-name *ctx*)))
                         :value (ctx-value *ctx*) :previous (ctx-previous *ctx*)
                         :origin (ctx-origin *ctx*) :maker (ctx-maker *ctx*))))
    (funcall thunk)))

(defun form-of (e)
  (let ((entries (jmap-entries e)))
    (if (= (length entries) 1) (values (car (first entries)) (cdr (first entries))) (values nil nil))))

(defun args (x) (if (jlistp x) (coerce x 'list) (list x)))

(defun evaluate (e)
  (cond
    ((jlistp e) (mklist (map 'list #'evaluate e)))
    ((not (jmap-p e)) e)
    (t
     (multiple-value-bind (tag body) (form-of e)
       (cond
         ((null tag) (oops "unknown form ~a" (if (jmap-entries e) (car (first (jmap-entries e))) "undefined")))
         ((string= tag "quote") body)
         ((string= tag "read") (read-host-key (evaluate body)))
         ((string= tag "sum")
          (norm-number (reduce #'+ (mapcar (lambda (x) (num-or-null (evaluate x))) (args body)) :initial-value 0)))
         ((string= tag "mod") (destructuring-bind (a b) (mapcar #'evaluate (args body)) (js-mod a b)))
         ((string= tag "eq") (destructuring-bind (a b) (mapcar #'evaluate (args body))
                               (if (json-equal a b) :true :false)))
         ((string= tag "if") (destructuring-bind (test then else) (args body)
                               (if (eq (evaluate test) :true) (evaluate then) (evaluate else))))
         ((string= tag "given") (given body))
         ((string= tag "log") (let ((v (evaluate body))) (push v *log*) v))
         ((string= tag "do") (let ((v :null)) (dolist (x (args body) v) (setf v (evaluate x)))))
         ((string= tag "write") (eval-write (args body)))
         ((string= tag "throw")
          (let ((v (evaluate body)))
            (if (eq v +pending+) (error 'pending-signal)
                (oops "~a" (if (stringp v) v (stringify v))))))
         ((string= tag "pending") +pending+)
         ((string= tag "wait") (eval-wait (args body)))
         ((string= tag "run")
          ;; the computation a write would name (after an await too), else the scope open
          (let* ((n (ctx-name *ctx*))
                 (s (cond ((crun-p n) (crun-comp n)) ((computation-p n) n) (t (open-scope)))))
            (in-run s (lambda () (evaluate body)))))
         ((string= tag "in")
          (destructuring-bind (s x) (args body)
            (let ((o (lookup (evaluate s))))
              (in-run o (lambda () (evaluate x))))))
         ((string= tag "scope")
          (destructuring-bind (s info &optional (p :null)) (args body)
            (let ((name (evaluate s)) (parent (if (eq p :null) nil (evaluate p))))
              (let ((under (if parent (lookup parent) (open-scope))))
                (check-name name)
                (when (owner-disposed under) (oops "disposed"))
                (make-scope name (evaluate info) under)))
            :null))
         ((string= tag "within")
          (destructuring-bind (info x) (args body)
            (let ((s (make-scope nil (evaluate info) (open-scope))))
              (in-run s (lambda () (evaluate x))))))
         ((string= tag "current") (current-json))
         ((string= tag "cleanup")
          (destructuring-bind (s x) (args body)
            (let* ((sv (evaluate s))
                   (o (if (eq sv :null) (open-scope) (lookup sv))))
              (add-cleanup o x))
            :null))
         ((string= tag "effect")
          (destructuring-bind (c f act &optional (early :false)) (args body)
            (let ((name (evaluate c)))
              (unless (stringp name) (oops "a effect with no name"))
              (unless (claimed name f act)
                (make-computation :effect name (open-scope) f :act act :early (eq (evaluate early) :true))))
            :null))
         ((string= tag "compute")
          (destructuring-bind (c f &optional (to :null)) (args body)
            (let ((name (evaluate c)))
              (unless (stringp name) (oops "a compute with no name"))
              (unless (claimed name f nil)
                (make-computation :compute name (open-scope) f :to (if (eq to :null) nil to))))
            :null))
         ((string= tag "dispose")
          (dispose (lookup (evaluate body)) :writer (ctx-writer *ctx*))
          :null)
         (t (oops "unknown form ~a" tag)))))))

(defun claimed (name f act)
  "the computation name, old under the scope open, claimed and given new code: true"
  (let ((o (gethash name *owners*)))
    (when (and o (computation-p o) (owner-old o) (eq (owner-parent o) (ctx-owner *ctx*))
               (alive-p o))
      (setf (owner-f o) f)
      (when act (setf (owner-act-expr o) act))
      (claim o))))

(defun add-cleanup (o x)
  (if (owner-disposed o)
      (if (eq o (ctx-owner *ctx*))
          ;; added to the scope open, gone already: at once
          (let ((err (run-cleanup (make-cleanup :expr x :owner o :origin :run :env *ctx*) (ctx-writer *ctx*))))
            (when err (error err)))
          (oops "disposed"))
      (setf (owner-cleanups o)
            (append (owner-cleanups o)
                    (list (make-cleanup :expr x :owner o :origin (if (owner-doing o) :act :run) :env *ctx*))))))

(defun eval-write (a)
  (destructuring-bind (k x &optional (by nil by-p)) a
    (let* ((key (evaluate k))
           (named (cond ((not by-p) (ctx-name *ctx*))
                        ((eq by :null) nil)
                        ((equal by "open") (ctx-writer *ctx*))
                        (t (let ((o (lookup (evaluate by))))
                             (and (computation-p o) o))))))
      (unless (stringp key) (oops "bad key"))
      (let ((v (evaluate x)))
        (setf (gethash key *values*) v)
        (change (list key) named)
        v))))

(defun current-json ()
  (let ((o (ctx-owner *ctx*)) (w (ctx-writer *ctx*)))
    (if (null o) :null
        (jmap "scope" (or (owner-name o) :null)
              "pairs" (pairs-json (info-of o))
              "writer" (and w (owner-name w))))))

(defun eval-wait (a)
  (destructuring-bind (p &optional (cont nil)) a
    (let* ((name (evaluate p))
           (pr (make-promise :name name :run (ctx-run *ctx*) :cont cont
                             :env (make-ctx :owner nil :writer nil
                                            :name (or (ctx-run *ctx*) (ctx-name *ctx*))
                                            :value (ctx-value *ctx*) :previous (ctx-previous *ctx*)))))
      (setf (gethash name *promises*) pr)
      pr)))

;;; ---------------------------------------------------------------- computations

(defun make-computation (kind name scope f &key act set to equal declared early)
  (check-name name)
  (when (owner-disposed scope) (oops "disposed"))
  (let* ((c (%make-owner :id (incf *ids*) :name name :kind kind :parent scope :f f :act-expr act
                         :set-expr set :to to :equal equal :early early
                         :info (owner-pairs scope))))
    (setf (owner-tnode c) (format nil "c:~d" (owner-id c))
          (gethash (owner-tnode c) *comp-by-node*) c
          (gethash name *owners*) c)
    (adopt scope c)
    (push c *all*)
    (when declared (setf (gethash to *key-writer*) c))
    (order-started c)
    ;; made in a run known to loop: the loop is cut there
    (let ((r *running*)) (when (and r (crun-flag r)) (setf (crun-cut r) t)))
    (let* ((tick (incf *tick*))
           (r *running*)
           (writer (and r (crun-comp r))))
      (setf (owner-made-tick c) tick)
      ;; made in a run, set, act or cleanup: it carries that run's cause
      (when (and r (eq r (owner-latest (crun-comp r))))
        (push (crun-chain r) (owner-chains c)))
      (let ((now (make-due c tick)))
        ;; a making gives back the computation: what a listener threw comes out of a pulse
        (handler-case
            (bracket
              (holding (when now (due-moment c tick writer)))
              (holding (fire "mark" nil))
              ;; early: its first run now, and its act
              (when (and early now)
                (holding (run-computation c (order-rank c)))
                (let ((queued (assoc c *acts*)))
                  (when queued
                    (unact c)
                    (act c (cdr queued))))))
          (sched-error (e) (escape-error e)))))
    c))

(defun equal-field (c result)
  (and (not (eq (owner-last c) +none+)) (results-equal c (owner-last c) result)))

(defun end-moment (r ended &key (equal :none) error waits through)
  (let ((c (crun-comp r)))
    (moment (jmap "ends" (owner-name c) "run" (crun-n r) "ended" (string-downcase (symbol-name ended))
                  "equal" (cond ((eq equal :none) nil) (equal :true) (t :false))
                  "error" (and error (princ-to-string error)) "waits" (and waits (owner-name waits))
                  "through" (and through (mklist (mapcar #'owner-name through)))
                  "reads" (mklist (reverse (crun-reads r))))
            "ends" (owner-name c))))

(defun queue-act (c r)
  (setf *acts* (append (remove c *acts* :key #'car) (list (cons c r)))))

(defun finish (r ended &key (equal :none) error waits through)
  "a run ends: done, pending, failed (error), stopped (waits), looping (through)"
  (let ((c (crun-comp r)))
    ;; flagged, and cut a loop (in its cleanups too): a failure ends looping, and so does a result
    ;; equal to the last
    (when (and (crun-flag r) (crun-cut r) (or (eq ended :failed) (and (eq ended :done) (eq equal t))))
      (return-from finish
        (finish r :looping :equal equal :error error :waits waits :through (crun-flag r))))
    ;; done, its latest: what it did not make again goes, its old cleanups are queued
    (when (and (eq ended :done) (eq (owner-latest c) r) (alive-p c)) (drop-unclaimed-children c r))
    (when (alive-p c)
      (when (and (not (eq ended :done)) (crun-given r))
        (setf (owner-chains c) (append (crun-given r) (owner-chains c))))
      (setf (crun-given r) '())
      (when (eq ended :looping) (setf (owner-looping c) t))
      (unless (eq ended :stopped) (order-sees c (crun-values r))))
    (setf (crun-state r) (if (eq ended :pending) :pending :ended))
    ;; ended, unless awaited: no longer a run known to loop
    (unless (eq ended :pending) (setf (crun-flag r) nil))
    (holding (end-moment r ended :equal equal :error error :waits waits :through through))))

(defun stop (r)
  (let ((c (crun-comp r)) (w (crun-stopped r)))
    (order-waits c w)
    (setf (owner-due c) t (owner-due-tick c) (crun-mark r))
    (finish r :stopped :waits w)))

(defun set-result (c value)
  "a compute's result given to set: kept at its key and marked; then its set; what that throws"
  (setf (owner-last c) value)
  (handler-case
      (progn
        (when (owner-to c)
          (setf (gethash (owner-to c) *values*) value)
          (change (list (owner-to c)) c))
        (when (owner-set-expr c)
          (let ((*ctx* (make-ctx :owner c :writer c :name c :value value :previous value :maker c)))
            (evaluate (owner-set-expr c))))
        nil)
    (pending-signal () (setf (owner-last c) +none+) "pending")
    (error (e) (setf (owner-last c) +none+) e)))

(defun result (r value)
  "a result: equal to the last, it stops there. a compute's goes to set; an effect's waits for the acts"
  (let* ((c (crun-comp r)) (equal (equal-field c value)))
    (setf (gethash r *results*) value)
    (cond
      ;; flagged: a new result, or a loop it cut, ends looping
      ((and (crun-flag r) (or (not equal) (crun-cut r)))
       (finish r :looping :equal equal :through (crun-flag r)))
      ((eq (owner-kind c) :effect)
       (unless equal (queue-act c r))
       (finish r :done :equal equal))
      ((not equal)
       (let ((err (let ((*running* r)) (set-result c value))))
         (if err
             (finish r :failed :equal nil :error err)
             (finish r :done :equal nil))))
      (t (finish r :done :equal t)))))

(defun begin (c rank)
  "one run of c: its start, what is under it old, its f, its end"
  (let* ((n (1+ (owner-runs c)))
         (r (make-crun :comp c :n n :mark (owner-due-tick c) :state :running
                       :given (owner-chains c) :flag (owner-latest-loop c)))
         (outcome nil) (value nil))
    (setf (owner-chains c) '()
          (crun-chain r) (make-chain :comp c :pulse *pulse* :given (crun-given r))
          (owner-due c) nil
          (owner-runs c) n (owner-latest c) r)
    (order-waits c nil)
    ;; an effect acts on its latest run's value only
    (unact c)
    (holding (moment (jmap "starts" (owner-name c) "run" n "rank" rank) "starts" (owner-name c)))
    (let ((*running* r))
      ;; what is under it is old, its cleanups set aside, till the run is done
      (when (owner-disposed c) (return-from begin nil))
      (lift-children c)
      (setf (owner-info-run c) r)
      (let ((*ctx* (make-ctx :owner c :writer c :name r :run r
                             :previous (owner-last c) :origin :run)))
        (begin-run (owner-tnode c))
        (handler-case
            (let ((v (evaluate (owner-f c))))
              (cond ((eq v +pending+) (setf outcome :pending))
                    ((promise-p v) (setf outcome :pending (crun-promise r) v))
                    (t (setf outcome :done value v))))
          (pending-signal () (setf outcome :pending))
          (error (e) (setf outcome :failed value e)))
        (end-tracking c)))
    (when (owner-disposed c) (return-from begin nil))
    (cond ((crun-stopped r) (stop r))
          ((eq outcome :failed) (finish r :failed :error value))
          ((eq outcome :pending) (finish r :pending))
          (t (result r value)))))

(defun run-computation (c rank)
  "one run of c, a bracket of its own: what a listener or a cleanup after it threw comes out after"
  (bracket (begin c rank)))

(defun act (c r)
  "an effect acts on its run's value: what is under it goes first; the first error of those and
   its act is the act's"
  (when (or (not (alive-p c)) (owner-due c)) (return-from act nil))
  (let ((failed nil) (*running* r))
    (let ((*ctx* (make-ctx :owner c :writer c :name c :maker c :origin :act)))
      (setf failed (teardown c :which :act :writer c)))
    (when (owner-disposed c) (return-from act nil))
    (let* ((value (crun-result-value r)) (previous (owner-last c)))
      (setf (owner-last c) value)
      (let ((*ctx* (make-ctx :owner c :writer c :name c :maker c :origin :act :value value :previous previous)))
        (setf (owner-doing c) t)
        (unwind-protect
             (handler-case (evaluate (owner-act-expr c))
               (error (e) (unless failed (setf failed e))))
          (setf (owner-doing c) nil)))
      (holding (moment (jmap "acts" (owner-name c) "run" (crun-n r) "early" (and (owner-early c) :true)
                             "error" (and failed (princ-to-string failed)))
                       "acts" (owner-name c))))))

;;; the value a run gave, kept on it for its act
(defun crun-result-value (r) (gethash r *results* :null))

;;; ---------------------------------------------------------------- landing and pulses

(defun land (pr)
  (let* ((r (promise-run pr)) (c (and r (crun-comp r))))
    (when (and r (alive-p c) (eq r (owner-latest c)) (not (owner-due c)) (eq (crun-state r) :pending))
      (bracket
        (destructuring-bind (kind . v) (promise-outcome pr)
          (ecase kind
            (:value (result r v))
            (:pending (finish r :pending))
            (:error (finish r :failed :error v))))))))

(defun settle (name kind value)
  (let ((pr (gethash name *promises*)))
    (unless pr (oops "no promise ~a" name))
    (remhash name *promises*)
    (setf (promise-state pr) :settled)
    (setf (promise-outcome pr)
          (if (eq kind :error) (cons :error value)
              (if (promise-cont pr)
                  (let ((*ctx* (promise-env pr)))
                    (handler-case
                        (let ((v (evaluate (promise-cont pr))))
                          (if (eq v +pending+) (cons :pending nil) (cons :value v)))
                      (pending-signal () (cons :pending nil))
                      (error (e) (cons :error e))))
                  (cons :value value))))
    (when (promise-run pr) (setf *settled* (append *settled* (list pr))))
    ;; told once its result will land: a settling has no caller to throw to
    (let* ((r (promise-run pr)) (c (and r (crun-comp r))))
      (when (and r (alive-p c) (eq r (owner-latest c)))
        (handler-case (fire "settles" nil) (sched-error (e) (escape-error e)))))))

(defun owner-of-p (a b)
  "a owns b, at any depth"
  (loop for p = (owner-parent b) then (owner-parent p) while p thereis (eq p a)))

(defun act-queue (early)
  (loop
    (let* ((queue (remove-if-not (lambda (x) (eq (and (owner-early (car x)) t) early)) *acts*))
           (pick (find-if (lambda (x)
                            (notany (lambda (y) (and (not (eq y x)) (owner-of-p (car y) (car x)))) queue))
                          queue)))
      (unless pick (return))
      (setf *acts* (remove pick *acts*))
      (bracket (act (car pick) (cdr pick))))))

(defun pulse ()
  (incf *pulse*)
  (setf *pulse-moments* 0)
  (let ((*in-pulse* t) (outer *thrown*) (failed nil))
    (setf *thrown* nil)
    (handler-case
        (loop
          (loop while *settled* do (land (pop *settled*)))
          (loop (multiple-value-bind (c rank) (next-due) (unless c (return)) (run-computation c rank)))
          (run-queued-cleanups)
          (act-queue t)
          (act-queue nil)
          (unless (or (next-due) *settled* *acts*) (return)))
      (error (e) (setf failed e)))
    ;; left early: the cleanups queued run all the same, what they throw after the first
    (handler-case (run-queued-cleanups) (error (e) (unless failed (setf failed e))))
    (dolist (c *all*) (setf (owner-chains c) '()))
    ;; held from a settling or a making: the answer's error, before the pulse's own
    (when *escaped* (setf failed (first *escaped*) *escaped* nil))
    (when failed (setf *thrown* (list failed)))
    (rethrow outer)))

;;; ---------------------------------------------------------------- the harness

(defun answer-error (e)
  (jmap "error" (typecase e
                  (pending-signal "pending")
                  (t (princ-to-string e)))))

(defun scope-arg (req name)
  (multiple-value-bind (s there) (jget req name)
    (unless there (oops "no scope undefined"))
    (lookup s)))

(defun top-ctx () (make-ctx :owner nil :writer nil :name nil))

(defharness "scheduler" (req)
  (let ((op (op-of req)) (*ctx* (top-ctx)))
    (setf *thrown* nil)
    (handler-case
        (cond
          ((string= op "root")
           (let ((name (jget req "name")))
             (check-name name)
             (make-scope name (jget req "info") nil)
             (jmap)))
          ((string= op "scope")
           (let ((name (jget req "name")))
             (let ((parent (and (jhas req "parent") (lookup (jget req "parent")))))
               (check-name name)
               (unless parent (oops "unscoped"))
               (make-scope name (jget req "info") parent)
               (jmap))))
          ((or (string= op "compute") (string= op "effect"))
           (let ((name (jget req "name")) (s (scope-arg req "scope")))
             (when (owner-disposed s) (oops "disposed"))
             (check-name name)
             (let ((*ctx* (make-ctx :owner s :writer nil :name nil)))
               (if (string= op "compute")
                   (make-computation :compute name s (jget req "f")
                                     :to (jget req "to") :equal (if (equal (jget req "equal") "json") :json :is)
                                     :declared (eq (jget req "declared") :true) :set (jget req "set"))
                   (make-computation :effect name s (jget req "f") :act (jget req "act")
                                     :equal (if (equal (jget req "equal") "json") :json :is)
                                     :early (eq (jget req "early") :true))))
             (jmap)))
          ((string= op "cleanup")
           (let ((s (scope-arg req "scope")))
             (when (owner-disposed s) (oops "disposed"))
             (add-cleanup s (jget req "do"))
             (jmap)))
          ((string= op "dispose")
           (dispose (scope-arg req "scope"))
           (jmap))
          ((string= op "listener")
           (let ((on (jget req "on")))
             (unless (member on '("mark" "starts" "ends" "acts" "forgotten" "started" "settles") :test #'equal)
               (oops "unknown listener ~a" on))
             (setf *armed* (list on (and (jhas req "at") (jget req "at")) (jget req "throw")))
             (jmap)))
          ((string= op "run")
           (let ((s (scope-arg req "scope")))
             (handler-case
                 (let ((v (in-run s (lambda () (evaluate (jget req "do"))) :writer nil)))
                   (if (or (eq v +pending+) (promise-p v)) (jmap) (jmap "value" v)))
               (pending-signal () (jmap "error" "pending")))))
          ((string= op "write")
           (let ((values (jget req "values")) (keys '()))
             (dolist (e (jmap-entries values))
               (setf (gethash (car e) *values*) (cdr e))
               (push (car e) keys))
             (jmap "tick" (change (nreverse keys) nil))))
          ((string= op "changed")
           (let ((keys (coerce (jget req "keys") 'list)))
             (unless (every #'stringp keys) (oops "bad key"))
             (jmap "tick" (change keys nil))))
          ((string= op "pulse") (pulse) (jmap))
          ((string= op "resolve") (settle (jget req "promise") :value (jget req "value")) (jmap))
          ((string= op "reject") (settle (jget req "promise") :error (jget req "error")) (jmap))
          ((string= op "get")
           (multiple-value-bind (v there) (gethash (jget req "key") *values*)
             (jmap "value" (if there v :null))))
          ((string= op "log") (prog1 (jmap "log" (mklist (reverse *log*))) (setf *log* '())))
          ((string= op "moments")
           (let ((reads (eq (jget req "reads") :true)) (ms (reverse *moments*)))
             (setf *moments* '())
             (jmap "moments" (mklist (mapcar (lambda (m)
                                               (if (and (jhas m "ends") (not reads))
                                                   (%make-jmap :entries (remove "reads" (jmap-entries m) :key #'car :test #'string=))
                                                   m))
                                             ms)))))
          ((string= op "forgotten") (prog1 (jmap "keys" (mklist (reverse *forgotten*))) (setf *forgotten* '())))
          ((string= op "started") (prog1 (jmap "keys" (mklist (reverse *started*))) (setf *started* '())))
          ((string= op "tick") (jmap "tick" *tick*))
          ((string= op "current") (jmap "value" (current-json)))
          (t (oops "unknown op ~a" op)))
      (error (e) (answer-error e)))))
