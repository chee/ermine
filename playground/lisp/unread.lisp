;;; unread.lisp — an entry written in place where it owns what it changes: the first write after a
;;; read copies what it walks through, the writes after change those copies; a read, a keep or a
;;; take lets go
(in-package :ermine)

(defvar *u-root* +none+)
(defvar *u-owned* (make-hash-table :test 'eq))
(defvar *u-undo* nil "the last landed write's undo patches, nil before any")
(defvar *u-held* (make-hash-table :test 'equal))
(defvar *u-marks* (make-hash-table :test 'equal))

(defun at-path (root path)
  "what is at path (keys from the root), or +none+: a string into a map, a whole number into a list"
  (let ((v root))
    (loop for k across (or path (mklist))
          do (setf v (cond ((eq v +none+) +none+)
                           ((and (jmap-p v) (stringp k)) (multiple-value-bind (x there) (jget v k) (if there x +none+)))
                           ((and (jlistp v) (realp k) (whole-number-p k) (>= k 0) (< (index-of k) (length v)))
                            (aref v (index-of k)))
                           (t +none+))))
    v))

(defun js-same (a b)
  "=== : containers by identity, the rest by content"
  (cond ((and (eq a +none+) (eq b +none+)) t)
        ((or (eq a +none+) (eq b +none+)) nil)
        ((and (realp a) (realp b)) (and (not (nanp a)) (not (nanp b)) (= a b)))
        ((and (stringp a) (stringp b)) (string= a b))
        (t (eq a b))))

(defun marked (patches names)
  "patch i given what was marked under names[i], as it is (nothing there: a removal)"
  (if (not (jlistp names)) patches
      (map 'vector
           (lambda (p i)
             (let ((name (and (< i (length names)) (aref names i))))
               (if (not (stringp name)) p
                   (let ((v (gethash name *u-marks* +none+)) (q (jmap)))
                     (loop for k in (jkeys p) unless (string= k "value") do (jput q k (jget p k)))
                     (unless (eq v +none+) (jput q "value" v))
                     q))))
           patches (loop for i below (length patches) collect i))))

(defun hold (req value)
  (multiple-value-bind (name there) (jget req "hold")
    (when there (setf (gethash name *u-held*) value))))

(defun u-write (patches)
  "patches written: the undo, or the refusal's answer. what a patch puts is owned no more"
  (handler-case
      (progn
        (let ((*owned* *u-owned*))
          (loop for p across patches when (and (jmap-p p) (jhas p "value")) do (disown (jget p "value"))))
        ;; tried first on a copy: a refused write changes nothing
        (let ((*owned* nil)) (apply-patches (deep-copy *u-root*) patches))
        (let ((*owned* *u-owned*) (*copy-values* nil))
          (multiple-value-bind (undo after) (invert-patches *u-root* patches)
            (setf *u-root* after *u-undo* undo)
            (jmap "undo" (form undo)))))
    (apply-error (e) (jmap "error" (code e) "patch" (index e)))))

(defharness "unread" (req)
  (let ((op (op-of req)))
    (cond
      ((string= op "start")
       (setf *u-root* (value-of req) *u-undo* nil)
       (clrhash *u-owned*) (clrhash *u-held*) (clrhash *u-marks*)
       (jmap))
      ((string= op "write")
       (let ((ps (marked (patches-of req) (jget req "marked"))))
         (hold req (mklist (loop for p across ps
                                 when (and (jmap-p p) (jhas p "value")) collect (jget p "value"))))
         (u-write ps)))
      ((string= op "unwrite")
       (if (null *u-undo*) (jmap "error" "nothing-written")
           (let ((ps *u-undo*))
             (hold req (mklist (loop for p across ps when (jhas p "value") collect (jget p "value"))))
             (u-write ps))))
      ((string= op "read")
       (clrhash *u-owned*)
       (hold req *u-root*)
       (value-answer *u-root*))
      ((string= op "keep")
       (let* ((v (at-path *u-root* (jget req "path")))
              (kept (if (eq (jget req "wrap") :true) (mklist (list (if (eq v +none+) :null v))) v)))
         (let ((*owned* *u-owned*)) (disown kept))
         ;; writes: by its set or its run, after what it keeps is let go (refused: nothing)
         (multiple-value-bind (ws there) (jget req "writes")
           (when (and there (jlistp ws)) (u-write (patches-of (jmap "patches" ws)))))
         (hold req kept)
         (jmap)))
      ((string= op "held") (value-answer (gethash (jget req "name") *u-held* +none+)))
      ((string= op "value") (value-answer *u-root*))
      ((string= op "mark")
       (setf (gethash (jget req "name") *u-marks*) (at-path *u-root* (jget req "path")))
       (jmap))
      ((string= op "same")
       (jmap "same" (if (js-same (gethash (jget req "name") *u-marks* +none+) (at-path *u-root* (jget req "path")))
                        :true :false)))
      (t (fail "unknown op ~a" op)))))
