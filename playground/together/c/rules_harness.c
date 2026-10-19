// together's own merge rules for its harnesses (rules_harness.h): "serial", as typescript/
// rules_harness.ts has it (its header the rule). Pure; has no keeping state
#include "rules_harness.h"

#include <stdlib.h>

static bool unknown(void *context, const hy_kept *const *from, size_t n) {
	(void)context, (void)from, (void)n;
	return false;
}

static void serial(void *state, const hy_history *h, const hy_kept *const *heads, size_t n, rp_get get,
	void *context, rp_tables *out) {
	(void)state, (void)get, (void)context;
	const hy_kept **from, **commits;
	size_t nf, nc;
	hy_since(h, heads, n, unknown, NULL, &from, &nf, &commits, &nc);
	for (size_t i = 0; i < nc; i++) {
		cm_commit c;
		if (cm_decode(commits[i]->bytes, commits[i]->length, &c, NULL) != CM_OK) continue;
		if (rp_apply(out, &c, commits[i]->name) != RP_OK) cm_free(&c);
	}
	free(from), free(commits);
}

static const rp_rule serial_rule = {"serial", serial, NULL, NULL};
const rp_rule *const harness_rules[] = {&serial_rule};
const size_t harness_rules_length = 1;
