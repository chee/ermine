;;; scheduler.lisp — computations over the host's keys, run in pulses: ranks, stops, loops cut by
;;; their causes, async landings, scopes that own what is made in them. The harness plays the host.
(in-package :ermine)

;;; ---------------------------------------------------------------- state

(defstruct (owner (:constructor %make-owner))
  id name kind info parent (children '()) (cleanups '()) disposed
  ;; computations
  f act-expr set-expr to equal early
  (runs 0) latest info-run (last +none+) made-tick
  due due-tick (values '()) waits aside
  (chains '()) latest-loop looping
  tnode)                                ; its name in the tracker

(defstruct crun comp n mark chain given flag cut state reads promise (values '()) stopped)
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
  (when (gethash name *owners*) (oops "name taken: ~a" name)))

(defun adopt (parent child)
  (setf (owner-children parent)
        (append (owner-children parent) (list (cons child (if *ctx* (ctx-origin *ctx*) :run))))))

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

(defun waits-of (c) (let ((w (owner-waits c))) (and (alive-p w) w)))
(defun live-computations () (remove-if-not #'alive-p *all*))

(defun edges-of (p)
  "what p is after: the writers its last run read, and the one it waits after (alive, not itself)"
  (let ((w (waits-of p)))
    (remove-if (lambda (q) (or (eq q p) (not (alive-p q))))
               (if w (cons w (owner-values p)) (owner-values p)))))
(defun reaches-p (p q)
  "p reaches q going up its edges"
  (let ((seen (make-hash-table :test 'eq)) (stack (edges-of p)))
    (loop while stack
          do (let ((x (pop stack)))
               (when (eq x q) (return-from reaches-p t))
               (unless (gethash x seen)
                 (setf (gethash x seen) t)
                 (setf stack (append (edges-of x) stack)))))
    nil))

(defun next-due ()
  "the due one to run: not waiting after a due one, no due one above it (reached up its edges, a
   cycle it is in aside); of those the earliest due, then the oldest"
  (let* ((due (remove-if-not (lambda (c) (and (alive-p c) (owner-due c))) *all*))
         (ready (remove-if (lambda (p)
                             (or (let ((w (waits-of p))) (and w (owner-due w)))
                                 (some (lambda (q) (and (not (eq q p)) (reaches-p p q) (not (reaches-p q p))))
                                       due)))
                           due))
         (best nil))
    (dolist (c (or ready due) best)
      (when (or (null best)
                (< (owner-due-tick c) (owner-due-tick best))
                (and (= (owner-due-tick c) (owner-due-tick best)) (< (owner-id c) (owner-id best))))
        (setf best c)))))

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
      (handler-case (dispose (car k) :writer writer)
        (error (e) (unless first-error (setf first-error e)))))))

(defun teardown (o &key (which :all) writer)
  "what is under o first, newest first, then its cleanups, newest first; every one runs, the first
   error comes back. o stays"
  (let ((first-error nil))
    (flet ((note (e) (when (and e (not first-error)) (setf first-error e))))
      (let ((kids (remove-if-not (lambda (k) (or (eq which :all) (eq (cdr k) which))) (owner-children o))))
        (setf (owner-children o) (set-difference (owner-children o) kids))
        (note (dispose-kids kids writer)))
      (let ((cls (remove-if-not (lambda (c) (or (eq which :all) (eq (cleanup-origin c) which))) (owner-cleanups o))))
        (setf (owner-cleanups o) (set-difference (owner-cleanups o) cls))
        (dolist (cl (reverse cls))
          (note (run-cleanup cl (if (computation-p o) (and (owner-latest o) o) writer))))))
    first-error))

(defun shed (c)
  "before a run, like Solid: what is under c goes, newest first (what one threw held), and its
   cleanups are set aside, to run once the run is done"
  (let* ((which (if (eq (owner-kind c) :effect) :run :all))
         (kids (remove-if-not (lambda (k) (or (eq which :all) (eq (cdr k) which))) (owner-children c))))
    (setf (owner-children c) (set-difference (owner-children c) kids))
    (let ((e (dispose-kids kids c))) (when e (hold-error e)))
    (let ((cls (remove-if-not (lambda (x) (or (eq which :all) (eq (cleanup-origin x) which))) (owner-cleanups c))))
      (setf (owner-cleanups c) (set-difference (owner-cleanups c) cls))
      (setf (owner-aside c) (append (owner-aside c) cls)))))

(defun lay (c r)
  "the cleanups set aside before r, once r is done: newest first; one that throws ends the rest,
   its error held"
  (let ((fs (owner-aside c)))
    (setf (owner-aside c) nil)
    (let ((*running* r))
      (dolist (cl (reverse fs))
        (let ((e (run-cleanup cl c)))
          (when e (hold-error e) (return)))))))

(defun unact (c) (setf *acts* (remove c *acts* :key #'car)))

(defun dispose (o &key writer)
  "o and all under it gone; every cleanup runs, and the first error comes out, after them all"
  (unless (owner-disposed o)
    (let ((outer *thrown*) (err nil))
      (setf *thrown* nil)
      (setf (owner-disposed o) t)
      (when (computation-p o)
        ;; going: not due, untracked, the writer of nothing, its act undone
        (setf (owner-due o) nil)
        (unact o)
        (untrack-all o)
        (maphash (lambda (k w) (when (eq w o) (remhash k *key-writer*))) *key-writer*)
        ;; set aside before its run: older than the rest
        (setf (owner-cleanups o) (append (owner-aside o) (owner-cleanups o))
              (owner-aside o) nil))
      (setf err (teardown o :writer (if (computation-p o) o writer)))
      (when (owner-name o)
        (when (eq (gethash (owner-name o) *owners*) o) (remhash (owner-name o) *owners*))
        (setf (gethash (owner-name o) *gone*) o))
      (when (owner-parent o)
        (setf (owner-children (owner-parent o)) (remove o (owner-children (owner-parent o)) :key #'car)))
      (when (computation-p o) (setf (owner-latest o) nil))
      (when (and err (not *thrown*)) (setf *thrown* (list err)))
      (rethrow outer))))

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
              (check-name name)
              (let ((under (if parent (lookup parent) (open-scope))))
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
              (let ((old (gethash name *owners*)))
                (when (and old (owner-disposed old)) (remhash name *owners*)))
              (make-computation :effect name (open-scope) f :act act :early (eq (evaluate early) :true)))
            :null))
         ((string= tag "dispose")
          (dispose (lookup (evaluate body)) :writer (ctx-writer *ctx*))
          :null)
         (t (oops "unknown form ~a" tag)))))))

(defun add-cleanup (o x)
  (if (owner-disposed o)
      (if (eq o (ctx-owner *ctx*))
          ;; added to the scope open, gone already: at once
          (let ((err (run-cleanup (make-cleanup :expr x :owner o :origin :run :env *ctx*) (ctx-writer *ctx*))))
            (when err (error err)))
          (oops "disposed"))
      (setf (owner-cleanups o)
            (append (owner-cleanups o)
                    (list (make-cleanup :expr x :owner o :origin (ctx-origin *ctx*) :env *ctx*))))))

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
        (bracket
          (holding (when now (due-moment c tick writer)))
          (holding (fire "mark" nil))
          ;; early: its first run now, and its act
          (when (and early now)
            (holding (run-computation c))
            (let ((queued (assoc c *acts*)))
              (when queued
                (unact c)
                (act c (cdr queued))))))))
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
    ;; its cleanups, set aside before it, once it is done
    (when (and (owner-aside c) (eq (owner-latest c) r) (alive-p c)) (lay c r))
    ;; flagged, and cut a loop (in its cleanups too): a failure ends looping, and so does a result
    ;; equal to the last
    (when (and (crun-flag r) (crun-cut r) (or (eq ended :failed) (and (eq ended :done) (eq equal t))))
      (return-from finish
        (finish r :looping :equal equal :error error :waits waits :through (crun-flag r))))
    (when (alive-p c)
      (when (and (not (eq ended :done)) (crun-given r))
        (setf (owner-chains c) (append (crun-given r) (owner-chains c))))
      (setf (crun-given r) '())
      (when (eq ended :looping) (setf (owner-looping c) t))
      (unless (eq ended :stopped) (setf (owner-values c) (crun-values r))))
    (setf (crun-state r) (if (eq ended :pending) :pending :ended))
    ;; ended, unless awaited: no longer a run known to loop
    (unless (eq ended :pending) (setf (crun-flag r) nil))
    (holding (end-moment r ended :equal equal :error error :waits waits :through through))))

(defun stop (r)
  (let ((c (crun-comp r)) (w (crun-stopped r)))
    (setf (owner-waits c) w (owner-due c) t (owner-due-tick c) (crun-mark r))
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

(defun begin (c)
  "one run of c: its start, what is under it gone, its f, its end"
  (let* ((n (1+ (owner-runs c)))
         (r (make-crun :comp c :n n :mark (owner-due-tick c) :state :running
                       :given (owner-chains c) :flag (owner-latest-loop c)))
         (outcome nil) (value nil))
    (setf (owner-chains c) '()
          (crun-chain r) (make-chain :comp c :pulse *pulse* :given (crun-given r))
          (owner-due c) nil (owner-waits c) nil
          (owner-runs c) n (owner-latest c) r)
    ;; an effect acts on its latest run's value only
    (unact c)
    (holding (moment (jmap "starts" (owner-name c) "run" n) "starts" (owner-name c)))
    (let ((*running* r))
      ;; what is under it goes first; its cleanups wait till the run is done
      (let ((*ctx* (make-ctx :owner c :writer c :name r :run nil)))
        (shed c))
      (when (owner-disposed c) (return-from begin nil))
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

(defun run-computation (c)
  "one run of c, a bracket of its own: what a listener or a cleanup after it threw comes out after"
  (bracket (begin c)))

(defun act (c r)
  "an effect acts on its run's value: what is under it goes first; the first error of those and
   its act is the act's"
  (when (or (not (alive-p c)) (owner-due c)) (return-from act nil))
  (let ((failed nil) (*running* r))
    (let ((*ctx* (make-ctx :owner c :writer c :name c :maker c :origin :act)))
      (setf failed (teardown c :which :all :writer c)))
    (when (owner-disposed c) (return-from act nil))
    (let* ((value (crun-result-value r)) (previous (owner-last c)))
      (setf (owner-last c) value)
      (let ((*ctx* (make-ctx :owner c :writer c :name c :maker c :origin :act :value value :previous previous)))
        (handler-case (evaluate (owner-act-expr c))
          (error (e) (unless failed (setf failed e)))))
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
    (when (promise-run pr) (setf *settled* (append *settled* (list pr))))))

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
          (loop for c = (next-due) while c do (run-computation c))
          (act-queue t)
          (act-queue nil)
          (unless (or (next-due) *settled* *acts*) (return)))
      (error (e) (setf failed e)))
    (dolist (c *all*) (setf (owner-chains c) '()))
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
             (check-name name)
             (let ((parent (if (jhas req "parent") (lookup (jget req "parent")) (oops "unscoped"))))
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
             (unless (member on '("mark" "starts" "ends" "acts" "forgotten" "started") :test #'equal)
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
