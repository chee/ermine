// common (common.h), in C.
#include "common.h"

void *dn_xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) {
		fputs("dens: out of memory\n", stderr);
		abort();
	}
	return p;
}
char *dn_xdup(const char *s) { return strcpy(dn_xalloc(strlen(s) + 1), s); }

// a and b, a "/" between: a derived id
char *dn_joined(const char *a, const char *b) {
	size_t n = strlen(a), m = strlen(b);
	char *s = dn_xalloc(n + m + 2);
	memcpy(s, a, n);
	s[n] = '/';
	memcpy(s + n + 1, b, m + 1);
	return s;
}


int dn_is_str(const op_value *v) { return v != NULL && v->type == OP_STR; }
int dn_is_map(const op_value *v) { return v != NULL && v->type == OP_MAP; }
const op_value *dn_get(const op_value *map, const char *key) {
	return dn_is_map(map) ? op_get(map, key) : NULL;
}
const char *dn_str_at(const op_value *map, const char *key) {
	const op_value *v = dn_get(map, key);
	return dn_is_str(v) ? v->str : NULL;
}

char **dn_copy_names(const char *const *names, size_t n) {
	char **copy = dn_xalloc((n + 1) * sizeof *copy);
	for (size_t i = 0; i < n; i++) copy[i] = dn_xdup(names[i]);
	return copy;
}

// names, then two more (a kind and a name): a path into what an owner holds
char **dn_names_and(const char *const *names, size_t n, const char *a, const char *b, size_t *out) {
	char **copy = dn_xalloc((n + 3) * sizeof *copy);
	for (size_t i = 0; i < n; i++) copy[i] = dn_xdup(names[i]);
	copy[n] = dn_xdup(a);
	copy[n + 1] = dn_xdup(b);
	*out = n + 2;
	return copy;
}

op_value *dn_names_value(const char *const *names, size_t n) {
	op_value *list = op_list();
	for (size_t i = 0; i < n; i++) op_push(list, op_str(names[i]));
	return list;
}

// a refusal's strings, held until the next call
void dn_forget(dn *d) {
	for (size_t i = 0; i < d->nscraps; i++) {
		if (d->scraps[i].names != NULL) pr_names_free(d->scraps[i].names, d->scraps[i].n);
		free(d->scraps[i].text);
	}
	d->nscraps = 0;
}
const char *const *dn_keep_names(dn *d, char **names, size_t n) {
	PUSH(d->scraps, d->nscraps, d->capscraps, ((scrap){names, n, NULL}));
	return (const char *const *)names;
}
const char *dn_keep_text(dn *d, const char *s) {
	if (s == NULL) return NULL;
	char *copy = dn_xdup(s);
	PUSH(d->scraps, d->nscraps, d->capscraps, ((scrap){NULL, 0, copy}));
	return copy;
}

// a message taken (malloc'd), the den's until its next call
const char *dn_keep_owned(dn *d, char *s) {
	PUSH(d->scraps, d->nscraps, d->capscraps, ((scrap){NULL, 0, s}));
	return s;
}

static void pulse_now(void *data) {
	dn *d = data;
	d->queued = 0;
	sc_pulse(d->s.scheduler);
}
// one pulse asked for outside a run, however many ask (none to ask: the host pulses)
void dn_later(dn *d) {
	if (d->queued || d->s.schedule == NULL || sc_get_run(d->s.scheduler) != NULL) return;
	d->queued = 1;
	d->s.schedule(d->s.schedule_ctx, pulse_now, d);
}

// told by the tracked reads of dn_nodes that what it says changed
void dn_changed(dn *d) {
	if (d->freeing) return;
	const void *keys[1] = {&d->version};
	sc_mark(d->s.scheduler, keys, 1, NULL);
}

// f with the scope open; torn down already (its own teardown): with what is open, as it is
static void within(sc_scope *o, void (*f)(void *data), void *data) {
	if (o != NULL && sc_scope_alive(o)) sc_run_with_scope(o, f, data);
	else f(data);
}

static void commit(dn *d, const pl_changed *changed) {
	if (d->s.commit != NULL) d->s.commit(d->s.commit_ctx, changed);
	else pl_commit(d->s.places, changed);
}

void dn_write_now(void *data) {
	writing *w = data;
	dn *d = w->d;
	pl *p = d->s.places;
	ch_header h;
	pl_made *made;
	ch_site at;
	char *bad = pl_header(p, NULL, 0, dn_site(d, &at), &h, &made);
	if (bad != NULL) {
		free(bad);
		w->code = -1;
		return;
	}
	pl_changed changes = {0};
	nd_entry *born = NULL;
	switch (w->what) {
	case W_UPSERT:
		w->code = pl_upsert(p, tb_string(w->part), tb_string(w->id), w->path, w->n, w->value, h, &changes,
			&born);
		break;
	case W_ADD:
		born = nd_make_entry((op_value *)w->value, &h);
		pl_own(p, born);
		w->code = tb_add(d->s.table, tb_string(w->part), tb_string(w->id), born);
		break;
	case W_UNPLACE: {
		nd_entry *there = tb_get(d->s.table, tb_string("children"), tb_string(w->id));
		if (there != NULL && dn_is_map(there->value) && op_get(there->value, w->name) != NULL) {
			w->code = pl_unplace(p, there, w->name, h, &changes);
		}
		break;
	}
	case W_HERE:
		w->code = pr_add(p, d->s.table, pl_root(p), dn_here, 2, tb_string(w->id), h, &changes, &born);
		break;
	case W_UNHERE:
		w->code = pr_remove(p, d->s.table, pl_root(p), dn_here, 2, h, &changes);
		break;
	}
	if (changes.n > 0) commit(d, &changes);
	for (size_t i = 0; i < changes.n; i++) {
		pl_hold_also(p, changes.entries[i], pl_made_ref(made), pl_made_free);
	}
	if (born != NULL) pl_hold(p, born, pl_made_ref(made), pl_made_free);
	pl_made_free(made);
}

const ch_site *dn_enter(dn *d, const ch_site *site) {
	const ch_site *was = d->site;
	d->site = site;
	return was;
}
void dn_leave(dn *d, const ch_site *was) { d->site = was; }

const ch_site *dn_site(dn *d, ch_site *buf) {
	if (d->site != NULL) return d->site;
	if (d->s.sites == NULL) return NULL;
	sc_run *run = sc_get_run(d->s.scheduler);
	sc_scope *o = run != NULL ? sc_run_computer(run) : sc_get_current_scope(d->s.scheduler);
	const st_site *noted[1];
	if (o == NULL || st_sites_of(d->s.sites, o, noted, 1) == 0 || noted[0]->file == NULL) return NULL;
	*buf = (ch_site){noted[0]->file, noted[0]->line, 0, noted[0]->func, 0};
	return buf;
}

const ch_site *dn_site_of(void *den, ch_site *buf) { return dn_site(den, buf); }

void dn_drop(dn_loaded *l) {
	if (l->released) return;
	l->released = 1;
	DROP(l->by->loads, l->by->nloads, l);
	if (l->live.close != NULL) l->live.close(l->live.data);
}

static char *let_go(void *data) {
	dn_process *o = data;
	while (o->nloads > 0) dn_drop(o->loads[o->nloads - 1]);
	return NULL;
}

void dn_holder(dn *d, dn_process *o) {
	free(sc_register_teardown(d->s.scheduler, o->scope, let_go, o));
}

// the write with o open (o torn down: with what is open)
int dn_write_in(dn *d, sc_scope *o, writing w) {
	w.d = d;
	within(o, dn_write_now, &w);
	return w.code;
}

sc_scope *dn_scope_of(dn *d, sc_pair *info, op_value **values, const char *key, const char *what,
	const char *id, sc_scope *parent) {
	values[0] = op_str(what);
	values[1] = op_str(id);
	info[0] = (sc_pair){key, values[0]};
	info[1] = (sc_pair){PL_NODE, values[1]};
	sc_scope *o = sc_create_scope(d->s.scheduler, info, 2, parent);
	if (o != NULL) sn_give(d->s.scopes, o, id);
	return o;
}

// a one-shot effect's run: true, so it acts once
sc_out dn_once_f(void *previous, void *data) {
	(void)previous, (void)data;
	return (sc_out){.kind = SC_VALUE, .value = op_bool(1)};
}
