;;; scheduler.lisp — computations over the host's keys, run in pulses: ranks, stops, loops cut by
;;; their causes, async landings, scopes that own what is made in them. The harness plays the host.
(in-package :ermine)

;;; ---------------------------------------------------------------- state

(defstruct (owner (:constructor %make-owner))
  id name kind info parent (children '()) (cleanups '()) disposed
  ;; computations
  f act-expr set-expr to equal early
  (runs 0) latest info-run (last +none+) made-tick
  due due-tick (rank 0) (floor 0) (after '()) waits
  (chains '()) latest-loop looping
  tnode)                                ; its name in the tracker

(defstruct crun comp n mark chain given flag cut state reads promise)
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
(define-condition endless (error) () (:report "endless"))
(defvar +pending+ '+pending+)

(defun computation-p (o) (and o (member (owner-kind o) '(:compute :effect))))
(defun alive-p (o) (and o (not (owner-disposed o))))

(defun moment (m)
  (push m *moments*)
  (when *in-pulse*
    (when (> (incf *pulse-moments*) 10000) (error 'endless))))

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

(defun track-read (c k)
  (let ((before (key-tracked-p k)))
    (track (owner-tnode c) (key-node k))
    (when (and (not before) (key-tracked-p k)) (push k *started*))))

(defun end-tracking (c)
  (let ((before (reads-keys c)))
    (end-run (owner-tnode c))
    (dolist (k before) (unless (key-tracked-p k) (push k *forgotten*)))))
(defun untrack-all (c)
  (let ((before (reads-keys c)))
    (untrack (owner-tnode c))
    (dolist (k before) (unless (key-tracked-p k) (push k *forgotten*)))))

;;; ---------------------------------------------------------------- ranks

(defun waits-of (c) (let ((w (owner-waits c))) (and (alive-p w) w)))
(defun live-computations () (remove-if-not #'alive-p *all*))

(defun learn-edges (c)
  "c's afters, fixed as its run ends: the writers of what it read, and the one it waits after"
  (let ((new '()))
    (dolist (k (reads-keys c))
      (let ((w (gethash k *key-writer*)))
        (when (and (alive-p w) (not (eq w c))) (pushnew w new))))
    (let ((w (waits-of c))) (when (and w (not (eq w c))) (pushnew w new)))
    (when (set-difference (owner-after c) new)
      ;; an edge gone lowers nothing
      (setf (owner-floor c) (max (owner-floor c) (owner-rank c))))
    (setf (owner-after c) new)))

(defun rerank ()
  "ranks from the after graph: a component of more than one shares one rank, one past what it is
   after; each one past the most of its afters, never below its floor"
  (let* ((nodes (reverse (live-computations)))
         (index (make-hash-table)) (low (make-hash-table)) (on (make-hash-table))
         (stack '()) (i 0) (done (make-hash-table)))
    (labels ((afters (c) (remove-if-not #'alive-p (owner-after c)))
             (finish (scc)
               (let* ((base (loop for c in scc
                                  maximize (loop for a in (afters c)
                                                 unless (member a scc) maximize (1+ (owner-rank a)))))
                      (r (if (cdr scc)
                             (max base (loop for c in scc maximize (owner-floor c)))
                             (max base (owner-floor (first scc))))))
                 (dolist (c scc) (setf (owner-rank c) r (gethash c done) t))))
             (connect (v)
               (setf (gethash v index) i (gethash v low) i) (incf i)
               (push v stack) (setf (gethash v on) t)
               (dolist (w (afters v))
                 (cond ((not (gethash w index))
                        (connect w)
                        (setf (gethash v low) (min (gethash v low) (gethash w low))))
                       ((gethash w on)
                        (setf (gethash v low) (min (gethash v low) (gethash w index))))))
               (when (= (gethash v low) (gethash v index))
                 (let ((scc '()))
                   (loop (let ((w (pop stack)))
                           (setf (gethash w on) nil)
                           (push w scc)
                           (when (eq w v) (return))))
                   (finish scc)))))
      (dolist (v nodes) (unless (gethash v index) (connect v))))))

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

(defun change (keys named)
  "the keys changed (one mark, one tick), named by a run, a computation or nothing"
  (let* ((tick (incf *tick*))
         (run (named-run named))
         (comp (cond ((crun-p named) (crun-comp named))
                     ((and (computation-p named) run) named)
                     (t nil)))
         (chain (and run (eq run (owner-latest (crun-comp run))) (crun-chain run))))
    ;; a compute alive, named by a run of it or by it, becomes the keys' writer
    (when (and comp (eq (owner-kind comp) :compute) (alive-p comp))
      (dolist (k keys) (setf (gethash k *key-writer*) comp)))
    (dolist (k keys)
      (dolist (c (readers-of k))
        (mark-on c tick comp run chain)))
    tick))

(defun mark-on (c tick writer run chain)
  (when (alive-p c)
    (let* ((through (loop-through chain c))
           (cut (and through run (crun-flag run) (member (crun-state run) '(:running :pending)))))
      (when chain (push chain (owner-chains c)))
      (cond
        (cut (setf (crun-cut run) t))
        (t
         (setf (owner-latest-loop c) through)
         (cond ((and through (owner-looping c)))
               (t (setf (owner-looping c) nil)
                  (make-due c tick writer))))))))

(defun make-due (c tick writer)
  (unless (owner-due c)
    (setf (owner-due c) t (owner-due-tick c) tick)
    (moment (jmap "due" (owner-name c) "tick" tick "writer" (and writer (owner-name writer))))))

;;; ---------------------------------------------------------------- teardown and dispose

(defun run-cleanup (cl writer)
  "a cleanup's expression, its scope open; what it throws comes back"
  (let ((*ctx* (make-ctx :owner (cleanup-owner cl) :writer writer
                         :name (if (computation-p (cleanup-owner cl)) (cleanup-owner cl) writer)
                         :value (ctx-value (cleanup-env cl)) :previous (ctx-previous (cleanup-env cl)))))
    (handler-case (progn (evaluate (cleanup-expr cl)) nil)
      (error (e) e))))

(defun teardown (o &key (which :all) writer)
  "what is under o first, newest first, then its cleanups, newest first; the first error"
  (let ((first-error nil))
    (flet ((note (e) (when (and e (not first-error)) (setf first-error e))))
      (let ((kids (remove-if-not (lambda (k) (or (eq which :all) (eq (cdr k) which))) (owner-children o))))
        (setf (owner-children o) (set-difference (owner-children o) kids))
        (dolist (k (reverse kids)) (note (dispose (car k) :writer writer))))
      (let ((cls (remove-if-not (lambda (c) (or (eq which :all) (eq (cleanup-origin c) which))) (owner-cleanups o))))
        (setf (owner-cleanups o) (set-difference (owner-cleanups o) cls))
        (dolist (cl (reverse cls))
          (note (run-cleanup cl (if (computation-p o) (and (owner-latest o) o) writer))))))
    first-error))

(defun dispose (o &key writer)
  "o and all under it gone; the first error a cleanup threw, or nil"
  (if (owner-disposed o) nil
      (progn
        (setf (owner-disposed o) t)
        (let ((err (teardown o :writer (if (computation-p o) o writer))))
          (when (owner-name o)
            (when (eq (gethash (owner-name o) *owners*) o) (remhash (owner-name o) *owners*))
            (setf (gethash (owner-name o) *gone*) o))
          (when (owner-parent o)
            (setf (owner-children (owner-parent o)) (remove o (owner-children (owner-parent o)) :key #'car)))
          (when (computation-p o)
            (setf (owner-due o) nil)
            (setf *acts* (remove o *acts* :key #'car))
            (untrack-all o)
            (maphash (lambda (k w) (when (eq w o) (remhash k *key-writer*))) *key-writer*)
            ;; an edge to one gone is an edge gone: it lowers nothing
            (dolist (c *all*)
              (when (member o (owner-after c))
                (setf (owner-floor c) (max (owner-floor c) (owner-rank c))
                      (owner-after c) (remove o (owner-after c)))))
            (rerank))
          err))))

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
    (when run
      (let* ((c (crun-comp run)) (w (gethash k *key-writer*)))
        (push k (crun-reads run))
        (track-read c k)
        (when (and (alive-p w) (not (eq w c)) (owner-due w)
                   (not (waits-reach w c))
                   (not (some (lambda (ch) (and (eq (chain-comp ch) c) (= (chain-pulse ch) *pulse*)))
                              (owner-chains w))))
          (error 'stop-signal :waits w))))
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
          (let* ((o (lookup (evaluate body)))
                 (err (dispose o :writer (ctx-writer *ctx*))))
            (when err (error err))
            :null))
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
    ;; a flagged run that makes a computation cuts
    (let ((r (and *ctx* (ctx-run *ctx*)))) (when (and r (crun-flag r)) (setf (crun-cut r) t)))
    (let ((tick (incf *tick*)))
      (setf (owner-made-tick c) tick)
      (make-due c tick (and *ctx* (ctx-maker *ctx*))))
    (when early
      (let ((r (run-computation c)))
        (when (and r (assoc c *acts*) (not (owner-due c)))
          (setf *acts* (remove c *acts* :key #'car))
          (act c r))))
    c))

(defun equal-field (c result)
  (and (not (eq (owner-last c) +none+)) (results-equal c (owner-last c) result)))

(defun end-moment (r ended &key equal error waits through)
  (let ((c (crun-comp r)))
    (moment (jmap "ends" (owner-name c) "run" (crun-n r) "ended" ended
                "equal" (cond ((eq equal :none) nil) (equal :true) (t :false))
                "error" error "waits" (and waits (owner-name waits))
                "through" (and through (mklist (mapcar #'owner-name through)))
                "reads" (mklist (reverse (crun-reads r)))))))

(defun give-back (r)
  (let ((c (crun-comp r)))
    (setf (owner-chains c) (append (crun-given r) (owner-chains c)))
    (setf (crun-given r) '())))

(defun queue-act (c r)
  (setf *acts* (append (remove c *acts* :key #'car) (list (cons c r)))))

(defun finish (r outcome value)
  "a run ends: done (value), pending, failed (value an error), stopped (value the one it waits)"
  (let ((c (crun-comp r)))
    (setf (crun-state r) :ended)
    (when (eq (owner-kind c) :effect) (setf *acts* (remove c *acts* :key #'car)))
    (ecase outcome
      (:stopped
       (setf (owner-waits c) value (owner-due c) t (owner-due-tick c) (crun-mark r))
       (give-back r)
       (end-moment r "stopped" :equal :none :waits value))
      (:pending
       (setf (crun-state r) :pending)
       (give-back r)
       (end-moment r "pending" :equal :none))
      (:failed
       (give-back r)
       (if (and (crun-flag r) (crun-cut r))
           (progn (setf (owner-looping c) t)
                  (end-moment r "looping" :equal :none :error (princ-to-string value) :through (crun-flag r)))
           (end-moment r "failed" :equal :none :error (princ-to-string value))))
      (:done
       (let ((equal (equal-field c value)))
         (cond
           ((and (crun-flag r) (or (not equal) (crun-cut r)))
            (give-back r)
            (setf (owner-looping c) t)
            (end-moment r "looping" :equal equal :through (crun-flag r)))
           ((progn (setf (gethash r *results*) value) equal)
            (setf (crun-given r) '())
            (end-moment r "done" :equal t))
           ((eq (owner-kind c) :effect)
            (setf (crun-given r) '())
            (queue-act c r)
            (end-moment r "done" :equal nil))
           (t
            (let ((err (set-result c r value)))
              (setf (crun-given r) '())
              (if err
                  (end-moment r "failed" :equal nil :error (princ-to-string err))
                  (end-moment r "done" :equal nil))))))))))

(defun set-result (c r value)
  "a compute's result given to set: kept at its key and marked; then its set; what that throws"
  (declare (ignore r))
  (setf (owner-last c) value)
  (when (owner-to c)
    (setf (gethash (owner-to c) *values*) value)
    (change (list (owner-to c)) c))
  (when (owner-set-expr c)
    (let ((*ctx* (make-ctx :owner c :writer c :name c :value value :previous value :maker c)))
      (handler-case (progn (evaluate (owner-set-expr c)) nil)
        (pending-signal () (setf (owner-last c) +none+) "pending")
        (error (e) (setf (owner-last c) +none+) e)))))

(defun run-computation (c)
  "one run of c: its teardown, its f, its end. the run, or nil when it went"
  (let* ((n (1+ (owner-runs c)))
         (r (make-crun :comp c :n n :mark (owner-due-tick c) :state :running
                       :given (owner-chains c) :flag (owner-latest-loop c))))
    (setf (owner-chains c) '()
          (crun-chain r) (make-chain :comp c :pulse *pulse* :given (crun-given r))
          (owner-due c) nil (owner-waits c) nil
          (owner-runs c) n (owner-latest c) r)
    ;; torn down first: a compute's all, an effect's what its runs made
    (let ((*ctx* (make-ctx :owner c :writer c :name r :run nil :maker c)))
      (teardown c :which (if (eq (owner-kind c) :effect) :run :all) :writer c))
    (when (owner-disposed c) (return-from run-computation nil))
    (setf (owner-info-run c) r)
    (moment (jmap "starts" (owner-name c) "run" n "rank" (owner-rank c)))
    (let ((outcome nil) (value nil))
      (let ((*ctx* (make-ctx :owner c :writer c :name r :run r :maker c
                             :previous (owner-last c) :origin :run)))
        (begin-run (owner-tnode c))
        (handler-case
            (let ((v (evaluate (owner-f c))))
              (cond ((eq v +pending+) (setf outcome :pending))
                    ((promise-p v) (setf outcome :pending (crun-promise r) v))
                    (t (setf outcome :done value v))))
          (stop-signal (s) (setf outcome :stopped value (waits s)))
          (pending-signal () (setf outcome :pending))
          (endless (e) (error e))
          (error (e) (setf outcome :failed value e)))
        (end-tracking c))
      (when (owner-disposed c) (return-from run-computation nil))
      (learn-edges c)
      (rerank)
      (finish r outcome value)
      r)))

(defun act (c r)
  "an effect acts on its run's value"
  (let ((*ctx* (make-ctx :owner c :writer c :name c :maker c :origin :act)))
    (teardown c :which :all :writer c))
  (when (owner-disposed c) (return-from act nil))
  (let* ((value (crun-result-value r)) (previous (owner-last c)) (err nil))
    (setf (owner-last c) value)
    (let ((*ctx* (make-ctx :owner c :writer c :name c :maker c :origin :act :value value :previous previous)))
      (handler-case (evaluate (owner-act-expr c))
        (endless (e) (error e))
        (error (e) (setf err (princ-to-string e)))))
    (moment (jmap "acts" (owner-name c) "run" (crun-n r) "early" (and (owner-early c) :true) "error" err))))

;;; the value a run gave, kept on it for its act
(defun crun-result-value (r) (gethash r *results* :null))

;;; ---------------------------------------------------------------- landing and pulses

(defun land (pr)
  (let* ((r (promise-run pr)) (c (and r (crun-comp r))))
    (when (and r (alive-p c) (eq r (owner-latest c)) (not (owner-due c)) (eq (crun-state r) :pending))
      (destructuring-bind (kind . v) (promise-outcome pr)
        (ecase kind
          (:value (setf (gethash r *results*) v) (finish r :done v))
          (:pending (finish r :pending nil))
          (:error (finish r :failed v)))))))

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
                      (endless (e) (error e))
                      (error (e) (cons :error e))))
                  (cons :value value))))
    (when (promise-run pr) (setf *settled* (append *settled* (list pr))))))

(defun next-due ()
  (let ((best nil))
    (dolist (c (live-computations) best)
      (when (and (owner-due c)
                 (not (let ((w (waits-of c))) (and w (owner-due w)))))
        (when (or (null best)
                  (< (owner-rank c) (owner-rank best))
                  (and (= (owner-rank c) (owner-rank best))
                       (or (< (owner-due-tick c) (owner-due-tick best))
                           (and (= (owner-due-tick c) (owner-due-tick best))
                                (< (owner-id c) (owner-id best))))))
          (setf best c))))))

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
      (let ((c (car pick)))
        (when (and (alive-p c) (not (owner-due c)))
          (act c (cdr pick)))))))

(defun pulse ()
  (incf *pulse*)
  (setf *pulse-moments* 0)
  (let ((*in-pulse* t))
    (unwind-protect
         (loop
           (let ((settled *settled*))
             (setf *settled* '())
             (dolist (pr settled) (land pr)))
           (loop for c = (next-due) while c do (run-computation c))
           (act-queue t)
           (act-queue nil)
           (unless (or (next-due) *settled* *acts*) (return)))
      (dolist (c *all*) (setf (owner-chains c) '())))))

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
           (let* ((s (scope-arg req "scope")) (err (dispose s)))
             (if err (answer-error err) (jmap))))
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
      (endless () (jmap "error" "endless"))
      (error (e) (answer-error e)))))
