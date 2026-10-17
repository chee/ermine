#include "programs_json.h"

#include <string.h>

static op_value *pg_path_json(char *const *at, size_t n) {
	op_value *a = op_list();
	for (size_t i = 0; i < n; i++) op_push(a, op_str(at[i]));
	return a;
}

op_value *pg_place_json(const pg_place *p) {
	op_value *m = op_map();
	op_set(m, "id", op_str(p->id));
	op_set(m, "at", pg_path_json(p->at, p->n));
	return m;
}

static op_value *pg_step_json(const pg_step *s);

static op_value *pg_chain_json(const pg_chain *c) {
	op_value *a = op_list();
	for (size_t i = 0; i < c->n; i++) op_push(a, pg_step_json(&c->steps[i]));
	return a;
}

static op_value *pg_step_json(const pg_step *s) {
	op_value *m = pg_place_json(&s->place);
	op_set(m, "by", pg_chain_json(&s->by));
	return m;
}

static op_value *whys_json(const pg_whys *w) {
	op_value *a = op_list();
	for (size_t i = 0; i < w->n; i++) {
		const pg_why *x = &w->items[i];
		op_value *m = pg_place_json(&x->place);
		op_set(m, "for", op_str(x->for_));
		op_set(m, "type", op_str(x->type));
		op_set(m, "why", op_str(pg_reason_name(x->why)));
		if (x->why == PG_NEEDS_UNMET) op_set(m, "missing", pg_path_json(x->missing, x->nmissing));
		op_push(a, m);
	}
	return a;
}

op_value *pg_found_json(const pg_found *f) {
	op_value *m = op_map();
	if (f->refused != NULL) {
		op_set(m, "refused", op_str(f->refused));
		if (f->path != NULL) {
			op_set(m, "path", op_str(f->path));
			op_set(m, "at", pg_path_json(f->at, f->nat));
		} else {
			op_set(m, "program", pg_place_json(&f->program));
			if (strcmp(f->refused, "no-chain") == 0) op_set(m, "why", whys_json(&f->why));
		}
		return m;
	}
	op_set(m, "program", pg_place_json(&f->program));
	op_value *chains = op_list();
	for (size_t i = 0; i < f->chains.n; i++) op_push(chains, pg_chain_json(&f->chains.items[i]));
	op_set(m, "chains", chains);
	op_set(m, "why", whys_json(&f->why));
	return m;
}

op_value *pg_opened_json(const pg_opened *o) {
	op_value *m = op_map();
	if (o->refused != NULL) {
		op_set(m, "refused", op_str(o->refused));
		op_set(m, "id", op_str(o->id));
		return m;
	}
	op_value *ways = op_list();
	for (size_t i = 0; i < o->ways.n; i++) {
		op_value *w = op_map();
		op_set(w, "program", pg_place_json(&o->ways.items[i].program));
		op_set(w, "chain", pg_chain_json(&o->ways.items[i].chain));
		op_push(ways, w);
	}
	op_set(m, "ways", ways);
	op_set(m, "why", whys_json(&o->why));
	return m;
}
