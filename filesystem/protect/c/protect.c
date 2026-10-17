// Protect (protect.h), in C.
#include "protect.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef enum { K_YES, K_NO, K_PENDING, K_CALL, K_ALL, K_ANY, K_ONLY, K_GRANTS } kind;

struct pr_policy {
	kind kind;
	char *reason;
	pr_call_fn call;
	void *ctx;
	pr_policy **kids;
	size_t nkids;
	char **ops;
	size_t nops;
	pr_where where;
};

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) {
		fputs("protect: out of memory\n", stderr);
		abort();
	}
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }
static tb_key kdup(tb_key k) { return k.symbol ? k : tb_string(xdup(k.string)); }
static pr_policy *make(kind k) {
	pr_policy *p = xalloc(sizeof *p);
	p->kind = k;
	return p;
}

pr_policy *pr_yes(void) { return make(K_YES); }
pr_policy *pr_no(const char *reason) {
	pr_policy *p = make(K_NO);
	p->reason = xdup(reason);
	return p;
}
pr_policy *pr_pending(void) { return make(K_PENDING); }
pr_policy *pr_call(pr_call_fn fn, void *ctx) {
	pr_policy *p = make(K_CALL);
	p->call = fn;
	p->ctx = ctx;
	return p;
}
static pr_policy *many(kind k, pr_policy *const *policies, size_t n) {
	pr_policy *p = make(k);
	p->kids = xalloc(n * sizeof *p->kids);
	memcpy(p->kids, policies, n * sizeof *p->kids);
	p->nkids = n;
	return p;
}
pr_policy *pr_all(pr_policy *const *policies, size_t n) { return many(K_ALL, policies, n); }
pr_policy *pr_any(pr_policy *const *policies, size_t n) { return many(K_ANY, policies, n); }
pr_policy *pr_only(const char *const *ops, size_t n, pr_policy *policy) {
	pr_policy *p = many(K_ONLY, &policy, 1);
	p->ops = xalloc(n * sizeof *p->ops);
	for (size_t i = 0; i < n; i++) p->ops[i] = xdup(ops[i]);
	p->nops = n;
	return p;
}
pr_policy *pr_grants(pr_where where) {
	pr_policy *p = make(K_GRANTS);
	p->where = (pr_where){xdup(where.part), kdup(where.id)};
	return p;
}

static void free_key(tb_key k) {
	if (k.symbol == NULL) free((char *)k.string);
}
void pr_free(pr_policy *p) {
	if (p == NULL) return;
	for (size_t i = 0; i < p->nkids; i++) pr_free(p->kids[i]);
	if (p->kind == K_ONLY) {
		for (size_t i = 0; i < p->nops; i++) free(p->ops[i]);
	}
	if (p->kind == K_GRANTS) {
		free((char *)p->where.part);
		free_key(p->where.id);
	}
	free(p->kids);
	free(p->ops);
	free(p->reason);
	free(p);
}

const op_value *pr_read_at(const pr_read *read, const char *part, tb_key id, const op_value *path) {
	return read->reader(read->ctx, part, id, path, read->at);
}

static const pr_answer YES = {PR_YES, NULL, NULL};
static pr_answer no(const char *reason) { return (pr_answer){PR_NO, reason, NULL}; }

// values equal: scalars, lists in order, maps by keys (as protect.ts's same)
int pr_same(const op_value *a, const op_value *b) {
	if (a == NULL || b == NULL) return a == b;
	if (a->type != b->type) return 0;
	switch (a->type) {
	case OP_NULL: return 1;
	case OP_BOOL: return a->bool_ == b->bool_;
	case OP_NUM: return op_same_num(a, b);
	case OP_STR: return strcmp(a->str, b->str) == 0;
	case OP_LIST:
		if (a->count != b->count) return 0;
		for (size_t i = 0; i < a->count; i++) if (!pr_same(a->items[i], b->items[i])) return 0;
		return 1;
	case OP_MAP:
		if (a->count != b->count) return 0;
		for (size_t i = 0; i < a->count; i++) {
			const op_value *x = op_get(b, a->keys[i]);
			if (x == NULL || !pr_same(a->items[i], x)) return 0;
		}
		return 1;
	default: return 0;
	}
}

// whether list is a list that starts the names given (given: there are any)
static int starts_names(const op_value *list, const char *const *path, size_t n, int given) {
	if (list->type != OP_LIST || !given || list->count > n) return 0;
	for (size_t i = 0; i < list->count; i++) {
		if (list->items[i]->type != OP_STR || strcmp(list->items[i]->str, path[i]) != 0) return 0;
	}
	return 1;
}
static int starts_field(const op_value *list, const op_value *field) {
	if (list->type != OP_LIST || field == NULL || field->type != OP_LIST || list->count > field->count) return 0;
	for (size_t i = 0; i < list->count; i++) {
		const op_value *x = list->items[i], *y = field->items[i];
		if (x->type != y->type) return 0;
		if (x->type == OP_STR ? strcmp(x->str, y->str) != 0 : x->num != y->num) return 0;
	}
	return 1;
}

static int matches(const op_value *g, const pr_ask *ask) {
	const pr_target *t = &ask->target;
	const op_value *x;
	const op_value *who = ask->who != NULL && ask->who->type == OP_MAP ? ask->who : NULL;
	if ((x = op_get(g, "actor")) && !pr_same(x, who ? op_get(who, "actor") : NULL)) return 0;
	if ((x = op_get(g, "reader")) && !pr_same(x, who ? op_get(who, "reader") : NULL)) return 0;
	if ((x = op_get(g, "op")) && !(x->type == OP_STR && strcmp(x->str, ask->op) == 0)) return 0;
	if ((x = op_get(g, "id"))) {
		if (x->type != OP_STR || t->id.symbol != NULL || t->id.string == NULL) return 0;
		if (strcmp(x->str, t->id.string) != 0) return 0;
	}
	if ((x = op_get(g, "path")) && !starts_names(x, t->path, t->npath, t->path != NULL)) return 0;
	if ((x = op_get(g, "from")) && !starts_names(x, ask->from.path, ask->from.npath, ask->from.path != NULL)) return 0;
	if ((x = op_get(g, "field")) && !starts_field(x, t->field)) return 0;
	return 1;
}

// the first field of a grant that is not known, or of the wrong kind (as protect.ts's malformed)
static const char *malformed(const op_value *g) {
	for (size_t i = 0; i < g->count; i++) {
		const char *k = g->keys[i];
		int t = g->items[i]->type;
		if (!strcmp(k, "actor") || !strcmp(k, "reader")) continue;
		if (!strcmp(k, "op") || !strcmp(k, "id")) { if (t != OP_STR) return k; }
		else if (!strcmp(k, "path") || !strcmp(k, "from") || !strcmp(k, "field")) { if (t != OP_LIST) return k; }
		else if (!strcmp(k, "deny")) { if (t != OP_BOOL) return k; }
		else return k;
	}
	return NULL;
}

static pr_answer grants(const pr_policy *p, const pr_ask *ask, const pr_read *read) {
	const op_value *rules = pr_read_at(read, p->where.part, p->where.id, NULL);
	if (rules == NULL) return (pr_answer){PR_PENDING, NULL, &p->where};
	if (rules->type != OP_LIST) return no("rules are not a list");
	for (size_t i = 0; i < rules->count; i++) {
		const op_value *g = rules->items[i];
		const char *bad = g->type == OP_MAP ? malformed(g) : NULL;
		if (bad != NULL) {
			// the reason lives in a buffer kept until the next such answer on this thread
			static _Thread_local char why[160];
			snprintf(why, sizeof why, "bad grant %zu: %s", i, bad);
			return no(why);
		}
	}
	int allowed = 0;
	for (size_t i = 0; i < rules->count; i++) {
		const op_value *g = rules->items[i];
		if (g->type != OP_MAP || !matches(g, ask)) continue;
		const op_value *deny = op_get(g, "deny");
		if (deny != NULL && deny->type == OP_BOOL && deny->bool_) return no("denied");
		allowed = 1;
	}
	return allowed ? YES : no("no grant");
}

static pr_answer run(const pr_policy *p, const pr_ask *ask, const pr_read *read) {
	switch (p->kind) {
	case K_YES: return YES;
	case K_NO: return no(p->reason);
	case K_PENDING: return (pr_answer){PR_PENDING, NULL, NULL};
	case K_CALL: return p->call(p->ctx, ask, read);
	case K_GRANTS: return grants(p, ask, read);
	case K_ONLY:
		for (size_t i = 0; i < p->nops; i++) {
			if (strcmp(p->ops[i], ask->op) == 0) return run(p->kids[0], ask, read);
		}
		return YES;
	case K_ALL: {
		pr_answer waiting = YES;
		for (size_t i = 0; i < p->nkids; i++) {
			pr_answer a = run(p->kids[i], ask, read);
			if (a.verdict == PR_NO) return a;
			if (a.verdict == PR_PENDING && waiting.verdict == PR_YES) waiting = a;
		}
		return waiting;
	}
	case K_ANY: {
		pr_answer refused = no("no policy"), waiting = YES;
		int refusal = 0;
		for (size_t i = 0; i < p->nkids; i++) {
			pr_answer a = run(p->kids[i], ask, read);
			if (a.verdict == PR_YES) return a;
			if (a.verdict == PR_NO && !refusal) refused = a, refusal = 1;
			if (a.verdict == PR_PENDING && waiting.verdict == PR_YES) waiting = a;
		}
		return waiting.verdict == PR_PENDING ? waiting : refused;
	}
	}
	return no("bad policy");
}

pr_answer pr_ask_of(const pr_policy *policy, const pr_ask *ask, pr_reader reader, void *ctx) {
	pr_read read = {reader, ctx, ask->at};
	return run(policy, ask, &read);
}
