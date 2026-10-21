// policy (policy.h), in C.
#include "policy.h"

// the policy -------------------------------------------------------------------------------------

// a read the policy makes: the table, untracked
static const op_value *quiet(void *ctx, const char *part, tb_key id, const op_value *path,
	const op_value *at) {
	(void)at;
	dn *d = ctx;
	size_t n = path != NULL && path->type == OP_LIST ? path->count : 0;
	op_key *keys = dn_xalloc((n + 1) * sizeof *keys);
	for (size_t i = 0; i < n; i++) {
		const op_value *step = path->items[i];
		if (step->type == OP_STR) keys[i] = (op_key){.type = OP_STR_KEY, .s = step->str};
		else keys[i] = (op_key){.type = OP_NUM_KEY, .n = (long)step->num};
	}
	const nd_entry *e = tb_get(d->s.table, tb_string(part), id);
	const op_value *v = e != NULL ? pl_at(e->value, keys, n, d->scratch) : NULL;
	free(keys);
	return v;
}

static const char *const no_names[1] = {""};

// the policy asked; none: yes here, no for another den's. path NULL: not given
pr_answer dn_permit(dn *d, const op_value *who, const char *op, const char *part, const char *id,
	char *const *path, size_t npath, int remote) {
	if (d->s.may == NULL) {
		return remote ? (pr_answer){PR_NO, "no policy", NULL} : (pr_answer){PR_YES, NULL, NULL};
	}
	pr_ask ask = {.who = who, .op = op};
	ask.target.part = part;
	ask.target.id = tb_string(id);
	ask.target.path = path != NULL ? (const char *const *)path : NULL;
	if (path != NULL && npath == 0) ask.target.path = no_names;
	ask.target.npath = npath;
	return pr_ask_of(d->s.may, &ask, quiet, d);
}

// refused no-permission: the op asked, the answer (a pending's need dropped)
void dn_no_permission(dn_refusal *r, const char *op, pr_answer a) {
	r->refused = "no-permission";
	r->op = op;
	r->answer = a.verdict == PR_NO ? a : (pr_answer){PR_PENDING, NULL, NULL};
}
