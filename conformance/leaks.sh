#!/bin/sh
# a C harness run under macOS's leaks, for its suite: the harness's answers on stdout as it writes
# them, leaks' report cut off after them. anything leaked: the report added to $LEAKS_LOG
# (default: stderr), and the exit 1. usage: leaks.sh harness [args]
# (the sanitizer builds find bad reads and writes; on macOS they find no leaks, so this does)
err=$(mktemp) || exit 2
leaks --atExit -- "$@" 2>"$err" | awk -v file="${LEAKS_LOG:-/dev/stderr}" -v name="$1" '
	# the report starts at its first "Process:" line, after everything the harness wrote
	!report && /^Process: / { report = 1 }
	!report { print; fflush(); next }
	{ lines = lines $0 "\n" }
	/^Process [0-9]+: [0-9]+ leaks? for/ { n = $3 + 0 }
	END {
		if (n > 0) { printf "== %s\n%s", name, lines >> file; exit 1 }
		if (!report) { printf "== %s: no report from leaks\n", name >> file; exit 2 }
	}'
code=$?
# the harness's own errors pass through; leaks' and malloc's notes do not
grep -v -e "is not debuggable" -e "MallocStackLogging:" -e "^$" "$err" >&2
rm -f "$err"
exit $code
