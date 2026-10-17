;;; invert.lisp — the undo of patches: in the order to apply them, applied to the value after
;;; it gives the value before
(in-package :ermine)

(defvar *disown-undo* t "an undo's values let go as they are made (a move's take: only when used)")
(defun undo-patch (path &key range (value +none+) (move-path nil move-p) move-range)
  (let ((m (jmap "path" (mklist path))))
    (when range (jput m "range" (jlist (first range) (second range))))
    (unless (eq value +none+)
      ;; copied (invert), or the very value, let go so nothing changes it after (unread)
      (jput m "value" (if *owned* (progn (when *disown-undo* (disown value)) value) (deep-copy value))))
    (when move-p
      (jput m "move" (if move-range
                         (jmap "path" (mklist move-path) "range" (jlist (first move-range) (second move-range)))
                         (jmap "path" (mklist move-path)))))
    m))

;;; strings as UTF-16 units, for spans whose edges join lone surrogates
(defun units (s)
  (let ((u (make-array 0 :adjustable t :fill-pointer 0)))
    (loop for c across s
          for code = (char-code c)
          do (if (> code #xFFFF)
                 (let ((v (- code #x10000)))
                   (vector-push-extend (+ #xD800 (ash v -10)) u)
                   (vector-push-extend (+ #xDC00 (logand v #x3FF)) u))
                 (vector-push-extend code u)))
    u))
(defun units-string (u &optional (start 0) (end (length u)))
  (normalize (map 'string #'code-char (subseq u start end))))
(defun unit-of-cp (s i) (utf16-length (subseq s 0 i)))
(defun cp-of-unit (u k)
  "how many code points the units [0, k) hold (k at a code point's edge)"
  (let ((n 0) (j 0))
    (loop while (< j k)
          do (if (and (< (1+ j) (length u)) (<= #xD800 (aref u j) #xDBFF) (<= #xDC00 (aref u (1+ j)) #xDFFF))
                 (incf j 2) (incf j))
             (incf n))
    n))
(defun pair-at-p (u k)
  "units k-1 and k are a high then a low: k inside a pair"
  (and (> k 0) (< k (length u)) (<= #xD800 (aref u (1- k)) #xDBFF) (<= #xDC00 (aref u k) #xDFFF)))

(defun string-span-undo (path before a b ins)
  "the undo of before's [a, b) replaced by ins, widened over a pair its edges made"
  (let* ((after (seq-splice before a b ins))
         (ub (units before)) (ua (units after))
         (s (unit-of-cp before a)) (e-before (unit-of-cp before b))
         (e (+ s (utf16-length ins)))
         (s2 (if (pair-at-p ua s) (1- s) s))
         (e2 (if (pair-at-p ua e) (1+ e) e))
         (old (units-string ub s2 (+ e-before (- e2 e))))
         (ra (cp-of-unit ua s2)) (rb (cp-of-unit ua e2)))
    (cond ((and (= ra rb) (string= old "")) '())
          ((string= old "") (list (undo-patch path :range (list ra rb))))
          (t (list (undo-patch path :range (list ra rb) :value old))))))

(defun span-undo (path target a b ins)
  "the undo of target's [a, b) replaced by ins (a sequence of its kind)"
  (if (stringp target)
      (string-span-undo path target a b ins)
      (let ((n (seq-length ins)) (old (seq-sub target a b)))
        (cond ((and (zerop n) (zerop (seq-length old))) '())
              ((zerop (seq-length old)) (list (undo-patch path :range (list a (+ a n)))))
              (t (list (undo-patch path :range (list a (+ a n)) :value old)))))))

(defun put-undo (box path)
  "the undo of an unranged put at path, before it"
  (if (null path)
      (if (eq (box-root box) +none+) (list (undo-patch '()))
          (list (undo-patch '() :value (box-root box))))
      (let ((parent (walk box (butlast path))) (k (car (last path))))
        (if (jlistp parent)
            (list (undo-patch path :value (aref parent k)))
            (multiple-value-bind (old there) (jget parent k)
              (if there (list (undo-patch path :value old)) (list (undo-patch path))))))))

(defun remove-undo (box path)
  "the undo of an unranged removal at path, before it"
  (if (null path)
      (list (undo-patch '() :value (box-root box)))
      (let ((parent (walk box (butlast path))) (k (car (last path))))
        (if (jlistp parent)
            (list (undo-patch (butlast path) :range (list k k) :value (mklist (list (aref parent k)))))
            (multiple-value-bind (old there) (jget parent k)
              (if there (list (undo-patch path :value old)) '()))))))

(defun joins-p (before a b ins)
  "a string's [a, b) replaced by ins makes a pair at an edge"
  (and (stringp before)
       (/= (length (seq-splice before a b ins)) (+ (- (length before) (- b a)) (length ins)))))

(defun raise (path back amount)
  "path with its index through back's list, at or past the gap, plus amount"
  (destructuring-bind (bpath brange) back
    (let ((n (length bpath)))
      (if (and brange (> (length path) n) (prefix-p bpath path)
               (integerp (nth n path)) (>= (nth n path) (first brange)))
          (append (subseq path 0 n) (list (+ (nth n path) amount)) (nthcdr (1+ n) path))
          path))))

(defun move-undo (box p)
  "a move's undo, and the move done on box"
  (let* ((from (patch-move-path p)) (fr (patch-move-range p))
         (to (patch-path p)) (tr (patch-range p))
         (take-undo (let ((*disown-undo* nil))
                      (if fr
                        (let ((target (walk box from)))
                          (span-undo from target (first fr) (second fr) (seq-sub target 0 0)))
                        (remove-undo box from))))
         (take-joins (and fr (let ((target (walk box from)))
                               (joins-p target (first fr) (second fr) (seq-sub target 0 0)))))
         (taken (if fr (take-span box from fr) (remove-at box from :strict t)))
         (back (cond (fr (list from (list (first fr) (first fr))))
                     ((and from (integerp (car (last from))))
                      (let ((i (car (last from)))) (list (butlast from) (list i i))))
                     (t (list from nil))))
         (back-path (first back)) (back-range (second back))
         (n (if fr (- (second fr) (first fr)) 1)))
    (flet ((fallen (land-undo)
             ;; in place, what the undo holds of what moved is a copy: the tree goes on changing
             (when *owned*
               (dolist (u take-undo)
                 (multiple-value-bind (v there) (jget u "value")
                   (when there (jput u "value" (deep-copy v))))))
             (append land-undo take-undo))
           (moved-back (move-path move-range)
             (undo-patch back-path :range back-range :move-path move-path :move-range move-range)))
      (if (not tr)
          ;; landing unranged at to
          (let* ((land-undo (put-undo box to))
                 (old (and to (let ((parent (walk box (butlast to))) (k (car (last to))))
                                (if (jlistp parent) (aref parent k)
                                    (multiple-value-bind (v there) (jget parent k) (if there v +none+))))))
                 (undo
                   (cond ((null to) (fallen land-undo))
                         (fr (if (or take-joins (prefix-p to from))
                                 (fallen land-undo)
                                 (append (if (zerop n) '() (list (moved-back to (list 0 n))))
                                         (let ((at (raise to back n)))
                                           (if (eq old +none+) (list (undo-patch at))
                                               (list (undo-patch at :value old)))))))
                         ((integerp (car (last to)))
                          (if (and (prefix-p to back-path) (not (equal to back-path)))
                              (fallen land-undo)
                              (let ((k (car (last to))))
                                (list (undo-patch (butlast to) :range (list (1+ k) (1+ k))
                                                               :value (mklist (list old)))
                                      (moved-back to nil)))))
                         (t (if (prefix-p to back-path)
                                (fallen land-undo)
                                (cons (moved-back to nil)
                                      (if (eq old +none+) '()
                                          (list (undo-patch (raise to back 1) :value old)))))))))
            (put-at box to taken)
            undo)
          ;; landing in a span [a, b) at to
          (let* ((target (span-target box to tr))
                 (a (first tr)) (b (second tr))
                 (one (and (jlistp target) (not fr)))
                 (ins (if one (mklist (list taken)) taken))
                 (land-undo (and (same-kind-p target ins) (span-undo to target a b ins)))
                 (size (seq-length ins))
                 (held (seq-sub target a b))
                 (move-path (if one (append to (list a)) to))
                 (move-range (if one nil (list a (+ a size)))))
            (let* ((element-in-seq (and (not fr) (integerp (car (last from)))
                                        (or (stringp target) (typed-p target))))
                   (inside (if move-range
                               (and (> (length back-path) (length move-path)) (prefix-p move-path back-path)
                                    (let ((k (nth (length move-path) back-path)))
                                      (and (integerp k) (<= (first move-range) k) (< k (second move-range)))))
                               (and (> (length back-path) (length move-path)) (prefix-p move-path back-path))))
                   (lone-edge (and (stringp ins) (stringp held) (plusp (length ins)) (plusp (length held))
                                   (high-p (char ins (1- (length ins)))) (low-p (char held 0))))
                   (result
                     (cond ((not (same-kind-p target ins)) nil)
                           ((or inside element-in-seq take-joins (joins-p target a b ins) lone-edge)
                            (fallen land-undo))
                           (t (append (if (zerop (seq-length held)) '()
                                          (list (undo-patch to :range (list (+ a size) (+ a size)) :value held)))
                                      (if (and fr (zerop n)) '()
                                          (list (moved-back move-path move-range))))))))
              (splice-at box to tr ins)
              result))))))

(defun try-on-copy (box p)
  (let ((*owned* nil) (*copy-values* t)) (apply-one (make-box :root (deep-copy (box-root box))) p)))

(defun patch-undo (box p)
  "the undo of one patch on what box holds, and the patch done on box"
  (let ((path (patch-path p)) (range (patch-range p)))
    (cond
      ((patch-has-move p)
       ;; refused or not: tried on a copy first, so the undo reads only what is there
       (try-on-copy box p)
       (if (and (not (patch-move-range p)) (not range) (equal (patch-move-path p) path))
           '()
           (move-undo box p)))
      (t
       (try-on-copy box p)
       (prog1 (cond (range (let ((target (walk box path)))
                             (span-undo path target (first range) (second range)
                                        (if (patch-has-value p) (patch-value p) (seq-sub target 0 0)))))
                    ((patch-has-value p) (put-undo box path))
                    (t (remove-undo box path)))
         (apply-one box p))))))

(defun invert-patches (root patches)
  "the undo of patches on root: each patch's undo, the last patch's first; and root after them.
   copying on write (*owned*), root is changed where owned and copied where not"
  (let ((box (make-box :root (if *owned* root (deep-copy root)))) (undos '()))
    (loop for x across patches
          for i from 0
          do (handler-bind ((apply-error (lambda (e) (unless (index e) (setf (index e) i)))))
               (push (patch-undo box (read-patch x)) undos)))
    (values (mklist (apply #'append undos)) (box-root box))))
