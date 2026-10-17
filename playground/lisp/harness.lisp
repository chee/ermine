;;; harness.lisp — the line protocol: one JSON request per line in, one answer per line out
(in-package :ermine)

(defvar *harnesses* (make-hash-table :test 'equal) "suite name → (start . answer)")
(defmacro defharness (name (req) &body body)
  "an answer function for a suite; body gets the request (a jmap), returns the answer (raw JSON)"
  `(setf (gethash ,name *harnesses*) (lambda (,req) ,@body)))

(define-condition harness-error (error) ((why :initarg :why :reader why))
  (:report (lambda (c s) (format s "~a" (why c)))))
(defun fail (fmt &rest args) (error 'harness-error :why (apply #'format nil fmt args)))

(defun field (req name) (jget req name))
(defun op-of (req) (let ((op (jget req "op"))) (if (stringp op) op "")))

(defun answer-line (fn text)
  (handler-case
      (let ((req (parse-json text)))
        (unless (jmap-p req) (fail "not an object"))
        (json-text (funcall fn req)))
    (error (e)
      (json-text (jmap "error" (let ((s (princ-to-string e))) (if (string= s "") "error" s)))))))

(defun serve (name)
  (let ((fn (or (gethash name *harnesses*) (progn (format *error-output* "no harness ~a~%" name)
                                                   (sb-ext:exit :code 2)))))
    (sb-int:with-float-traps-masked (:overflow :invalid :divide-by-zero :inexact :underflow)
      (loop for line = (read-line-wtf8 *in*)
            while line
            unless (string= (string-trim " 	" line) "")
              do (write-line (answer-line fn line) *standard-output*)
                 (force-output *standard-output*)))))

(defvar *in*)
(defun read-line-wtf8 (in)
  "one line of stdin, its bytes decoded as UTF-8 that may hold surrogates (WTF-8); nil at the end"
  (let ((bytes (make-array 0 :element-type '(unsigned-byte 8) :adjustable t :fill-pointer 0)))
    (loop for b = (read-byte in nil)
          do (cond ((null b) (return (if (zerop (length bytes)) nil (decode-wtf8 bytes))))
                   ((= b 10) (return (decode-wtf8 bytes)))
                   (t (vector-push-extend b bytes))))))
(defun decode-wtf8 (bytes)
  (let ((o (make-string-output-stream)) (i 0) (n (length bytes)))
    (flet ((cont (k) (if (< (+ i k) n) (logand (aref bytes (+ i k)) #x3f) 0)))
      (loop while (< i n)
            do (let ((b (aref bytes i)))
                 (cond ((< b #x80) (write-char (code-char b) o) (incf i))
                       ((< b #xe0) (write-char (code-char (logior (ash (logand b #x1f) 6) (cont 1))) o) (incf i 2))
                       ((< b #xf0) (write-char (code-char (logior (ash (logand b #x0f) 12) (ash (cont 1) 6) (cont 2))) o)
                        (incf i 3))
                       (t (write-char (code-char (min #x10ffff (logior (ash (logand b #x07) 18) (ash (cont 1) 12)
                                                                        (ash (cont 2) 6) (cont 3))))
                                      o)
                          (incf i 4))))))
    (normalize (get-output-stream-string o))))

(defun main ()
  (let ((*in* (sb-sys:make-fd-stream 0 :input t :element-type '(unsigned-byte 8) :buffering :full))
        (*standard-output* (sb-sys:make-fd-stream 1 :output t :external-format :utf-8 :buffering :full))
        (args (cdr sb-ext:*posix-argv*)))
    (serve (or (first args) ""))
    (finish-output *standard-output*)
    (sb-ext:exit :code 0 :abort t)))
