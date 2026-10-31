// Protect on the line protocol (protect/typescript/protect_harness.ts documents it).
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "protect.h"
#include "../../conformance/c/harness.h"

static char *own(const char *s) { return strcpy(malloc(strlen(s) + 1), s); }


typedef struct {
	char *part, *id;
	op_value *at; // NULL: every version
	op_value *value; // NULL: no value, which reads as not there
} cell;
static cell *world;
static size_t nworld, cworld;

static int is_cell(const cell *c, const char *p, const char *i, const op_value *at) {
	return strcmp(c->part, p) == 0 && strcmp(c->id, i) == 0 && pr_same(c->at, at);
}
static cell *find(const char *p, const char *i, const op_value *at) {
	for (size_t k = 0; k < nworld; k++) if (is_cell(&world[k], p, i, at)) return &world[k];
	return NULL;
}
static void drop(const char *p, const char *i, const op_value *at) {
	cell *c = find(p, i, at);
	if (c == NULL) return;
	free(c->part), free(c->id), op_free(c->at), op_free(c->value);
	*c = world[--nworld];
}


typedef struct {
	char *part, *id;
	op_value *path;
} told;
static told *log_;
static size_t nlog, clog;

static const op_value *reader(void *ctx, const char *part, tb_key id, const op_value *path,
	const op_value *at) {
	(void)ctx;
	if (nlog == clog) {
		clog = clog ? clog * 2 : 16;
		log_ = realloc(log_, clog * sizeof *log_);
		if (log_ == NULL) hh_fail("out of memory");
	}
	log_[nlog++] = (told){own(part), own(id.string), op_ref((op_value *)path)};
	const cell *any = NULL;
	for (size_t k = 0; k < nworld; k++) {
		const cell *c = &world[k];
		if (strcmp(c->part, part) || strcmp(c->id, id.string)) continue;
		if (c->at == NULL) any = c;
		else if (pr_same(c->at, at)) return c->value;
	}
	return any ? any->value : NULL;
}


static const char **strings(const op_value *list) {
	const char **xs = hh_take((list->count ? list->count : 1) * sizeof *xs);
	for (size_t i = 0; i < list->count; i++) {
		if (list->items[i]->type != OP_STR) hh_fail("not a string");
		xs[i] = list->items[i]->str;
	}
	return xs;
}
static const op_value *list_of(const op_value *x) {
	if (x == NULL || x->type != OP_LIST) hh_fail("not a list");
	return x;
}

static pr_answer deny_node(void *ctx, const pr_ask *ask, const pr_read *read) {
	(void)read;
	const char *id = ask->node.id.string;
	if (id != NULL && strcmp(id, ctx) == 0) return (pr_answer){.verdict = PR_NO, .reason = "denied node"};
	return (pr_answer){.verdict = PR_YES};
}

static pr_policy *policy_of(const op_value *p) {
	if (p->type == OP_STR) {
		if (strcmp(p->str, "yes") == 0) return pr_yes();
		if (strcmp(p->str, "pending") == 0) return pr_pending();
		hh_fail("unknown policy");
	}
	const op_value *f;
	if ((f = op_get(p, "no"))) return pr_no(f->str);
	if ((f = op_get(p, "denynode"))) return pr_call(deny_node, (void *)f->str);
	if ((f = op_get(p, "grants"))) {
		const char **xs = strings(list_of(f));
		if (f->count != 2) hh_fail("grants: [part, id]");
		return pr_grants((pr_where){xs[0], tb_string(xs[1])});
	}
	int is_all = (f = op_get(p, "all")) != NULL;
	if (is_all || (f = op_get(p, "any"))) {
		pr_policy **kids = hh_take((list_of(f)->count ? f->count : 1) * sizeof *kids);
		for (size_t i = 0; i < f->count; i++) kids[i] = policy_of(f->items[i]);
		return is_all ? pr_all(kids, f->count) : pr_any(kids, f->count);
	}
	if ((f = op_get(p, "only"))) {
		const op_value *then = op_get(p, "policy");
		if (then == NULL) hh_fail("only: no policy");
		return pr_only(strings(list_of(f)), f->count, policy_of(then));
	}
	hh_fail("unknown policy");
}


static void print_key(FILE *out, const char *s) { op_json_string(out, s); }

static void target_of(const op_value *t, pr_target *target) {
	const op_value *f;
	const char *s;
	target->part = hh_str(t, "part");
	if ((s = hh_str(t, "id"))) target->id = tb_string(s);
	target->field = op_get(t, "field");
	if ((f = op_get(t, "path"))) {
		target->npath = list_of(f)->count;
		target->path = strings(f);
	}
	if ((f = op_get(t, "route"))) {
		target->nroute = list_of(f)->count;
		tb_key *route = hh_take((f->count ? f->count : 1) * sizeof *route);
		const char **ids = strings(f);
		for (size_t i = 0; i < f->count; i++) route[i] = tb_string(ids[i]);
		target->route = route;
	}
}

static void ask(const op_value *r, FILE *out) {
	pr_policy *policy = policy_of(op_get(r, "policy"));
	pr_ask ask = {0};
	ask.who = op_get(r, "who");
	ask.at = op_get(r, "at");
	ask.op = hh_str(r, "what");
	if (ask.op == NULL) hh_fail("no what");
	const op_value *t = op_get(r, "target"), *f;
	if (t != NULL) target_of(t, &ask.target);
	if ((f = op_get(r, "node"))) target_of(f, &ask.node);
	if ((t = op_get(r, "from")) && (f = op_get(t, "path"))) {
		ask.from.npath = list_of(f)->count;
		ask.from.path = strings(f);
	}
	nlog = 0;
	pr_answer a = pr_ask_of(policy, &ask, reader, NULL);
	static const char *const names[] = {"yes", "no", "pending"};
	fprintf(out, "{\"answer\":\"%s\"", names[a.verdict]);
	if (a.verdict == PR_NO) {
		fputs(",\"reason\":", out);
		op_json_string(out, a.reason);
	}
	if (a.grant.where != NULL) {
		fputs(",\"grant\":{\"part\":", out);
		print_key(out, a.grant.where->part);
		fputs(",\"id\":", out);
		print_key(out, a.grant.where->id.string);
		fprintf(out, ",\"index\":%zu}", a.grant.index);
	}
	if (a.verdict == PR_PENDING && a.need != NULL) {
		const pr_where *w = a.need;
		fputs(",\"need\":[", out);
		print_key(out, w->part), putc(',', out), print_key(out, w->id.string);
		putc(']', out);
	}
	fputs(",\"reads\":[", out);
	for (size_t i = 0; i < nlog; i++) {
		if (i) putc(',', out);
		putc('[', out);
		print_key(out, log_[i].part), putc(',', out), print_key(out, log_[i].id);
		if (log_[i].path) putc(',', out), op_json_write(out, log_[i].path);
		putc(']', out);
		free(log_[i].part), free(log_[i].id);
		op_free(log_[i].path);
	}
	fputs("]}", out);
	pr_policy_free(policy);
}

void hh_answer(const op_value *r, FILE *out) {
	const char *what = hh_str(r, "op");
	if (what != NULL && strcmp(what, "ask") == 0) {
		ask(r, out);
		return;
	}
	int load = what && strcmp(what, "load") == 0, drops = what && strcmp(what, "drop") == 0;
	if (!load && !drops) {
		hh_unknown(out, r);
		return;
	}
	const char *p = hh_str(r, "part"), *i = hh_str(r, "id");
	if (p == NULL || i == NULL) hh_fail("no part, id");
	const op_value *at = op_get(r, "at");
	if (load) {
		drop(p, i, at);
		if (nworld == cworld) {
			cworld = cworld ? cworld * 2 : 16;
			world = realloc(world, cworld * sizeof *world);
			if (world == NULL) hh_fail("out of memory");
		}
		world[nworld++] = (cell){own(p), own(i), op_ref((op_value *)at), op_ref(op_get(r, "value"))};
	} else {
		drop(p, i, at);
	}
	fputs("{}", out);
}

void hh_finish(void) {
	for (size_t k = 0; k < nworld; k++) {
		free(world[k].part), free(world[k].id);
		op_free(world[k].at), op_free(world[k].value);
	}
	free(world);
	free(log_);
}
