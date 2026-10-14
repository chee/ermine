#!/bin/sh
# runs places_test.ts and the conformance suite on each version given (paths from optim/)
#   sh core/places/typescript/optim/check.sh ./places-v1-entry.ts ./places-final.ts
cd "$(dirname "$0")/../../../.." || exit 1
for v in "$@"; do
	printf '%s: ' "$v"
	PLACES_MODULE="$v" deno test --quiet --allow-env --allow-read core/places/typescript/optim/places_test.ts >/tmp/places-check.log 2>&1 \
		&& printf 'tests ok, ' || { printf 'TESTS FAILED\n'; tail -30 /tmp/places-check.log; continue; }
	PLACES_MODULE="$v" HARNESS="deno run --quiet --allow-env --allow-read core/places/typescript/optim/harness.ts" \
		deno test --quiet -A conformance/run.ts core/places/typescript/places_harness_test.ts -- places >/tmp/places-check.log 2>&1 \
		&& printf 'conformance ok\n' || { printf 'CONFORMANCE FAILED\n'; tail -30 /tmp/places-check.log; }
done
