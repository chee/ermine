// common (common.h), in C.
#include "common.h"

void *sw_xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) {
		fputs("software: out of memory\n", stderr);
		abort();
	}
	return p;
}
char *sw_xdup(const char *s) { return strcpy(sw_xalloc(strlen(s) + 1), s); }

// a and b, a "/" between: a derived id
char *sw_joined(const char *a, const char *b) {
	size_t n = strlen(a), m = strlen(b);
	char *s = sw_xalloc(n + m + 2);
	memcpy(s, a, n);
	s[n] = '/';
	memcpy(s + n + 1, b, m + 1);
	return s;
}

int sw_is_str(const op_value *v) { return v != NULL && v->type == OP_STR; }
int sw_is_map(const op_value *v) { return v != NULL && v->type == OP_MAP; }
const op_value *sw_get(const op_value *map, const char *key) {
	return sw_is_map(map) ? op_get(map, key) : NULL;
}

char **sw_copy_names(const char *const *names, size_t n) {
	char **copy = sw_xalloc((n + 1) * sizeof *copy);
	for (size_t i = 0; i < n; i++) copy[i] = sw_xdup(names[i]);
	return copy;
}

// names, then two more (a kind and a name): a path into what an owner holds
char **sw_names_and(const char *const *names, size_t n, const char *a, const char *b, size_t *out) {
	char **copy = sw_xalloc((n + 3) * sizeof *copy);
	for (size_t i = 0; i < n; i++) copy[i] = sw_xdup(names[i]);
	copy[n] = sw_xdup(a);
	copy[n + 1] = sw_xdup(b);
	*out = n + 2;
	return copy;
}

op_value *sw_names_value(const char *const *names, size_t n) {
	op_value *list = op_list();
	for (size_t i = 0; i < n; i++) op_push(list, op_str(names[i]));
	return list;
}

// a refusal's strings, held until the next call
void sw_forget(sw *s) {
	for (size_t i = 0; i < s->nscraps; i++) {
		if (s->scraps[i].names != NULL) pr_names_free(s->scraps[i].names, s->scraps[i].n);
		free(s->scraps[i].text);
	}
	s->nscraps = 0;
}
const char *const *sw_keep_names(sw *s, char **names, size_t n) {
	PUSH(s->scraps, s->nscraps, s->capscraps, ((scrap){names, n, NULL}));
	return (const char *const *)names;
}
const char *sw_keep_text(sw *s, const char *text) {
	if (text == NULL) return NULL;
	char *copy = sw_xdup(text);
	PUSH(s->scraps, s->nscraps, s->capscraps, ((scrap){NULL, 0, copy}));
	return copy;
}

// a message taken (malloc'd), the software's until its next call
const char *sw_keep_owned(sw *s, char *text) {
	PUSH(s->scraps, s->nscraps, s->capscraps, ((scrap){NULL, 0, text}));
	return text;
}

static void pulse_now(void *data) {
	sw *s = data;
	s->queued = 0;
	sc_pulse(s->s.scheduler);
}
// one pulse asked for outside a run, however many ask (none to ask: the host pulses)
void sw_later(sw *s) {
	if (s->queued || s->s.schedule == NULL || sc_get_run(s->s.scheduler) != NULL) return;
	s->queued = 1;
	s->s.schedule(s->s.schedule_ctx, pulse_now, s);
}

// told by the tracked reads of sw_running and sw_offers that what they say changed
void sw_changed(sw *s) {
	if (s->freeing) return;
	const void *keys[1] = {&s->version};
	sc_mark(s->s.scheduler, keys, 1, NULL);
}

// f with the scope open; none, or torn down already (its own teardown): with what is open, as it is
static void within(sc_scope *o, void (*f)(void *data), void *data) {
	if (o != NULL && sc_scope_alive(o)) sc_run_with_scope(o, f, data);
	else f(data);
}

void sw_write_now(void *data) {
	writing *w = data;
	sw *s = w->s;
	pl *p = s->s.places;
	ch_header h;
	pl_made *made;
	ch_site at;
	char *bad = pl_header(p, NULL, 0, sw_site(s, &at), &h, &made);
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
		w->code = tb_add(s->s.table, tb_string(w->part), tb_string(w->id), born);
		break;
	case W_SUB:
		born = nd_make_entry((op_value *)w->value, &h);
		pl_own(p, born);
		tb_sub(s->s.table, tb_string(w->part), tb_string(w->id), born);
		break;
	case W_UNPLACE: {
		nd_entry *there = tb_get(s->s.table, tb_string("children"), tb_string(w->id));
		if (there != NULL && sw_is_map(there->value) && op_get(there->value, w->name) != NULL) {
			w->code = pl_unplace(p, there, w->name, h, &changes);
		}
		break;
	}
	}
	if (changes.n > 0 && s->s.commit != NULL) s->s.commit(s->s.commit_ctx, &changes);
	else if (changes.n > 0) pl_commit(p, &changes);
	for (size_t i = 0; i < changes.n; i++) {
		pl_hold_also(p, changes.entries[i], pl_made_ref(made), pl_made_free);
	}
	if (born != NULL) pl_hold(p, born, pl_made_ref(made), pl_made_free);
	pl_made_free(made);
}

const ch_site *sw_enter(sw *s, const ch_site *site) {
	const ch_site *was = s->site;
	s->site = site;
	return was;
}
void sw_leave(sw *s, const ch_site *was) { s->site = was; }

const ch_site *sw_site(sw *s, ch_site *buf) {
	if (s->site != NULL) return s->site;
	if (s->s.sites == NULL) return NULL;
	sc_run *run = sc_get_run(s->s.scheduler);
	sc_scope *o = run != NULL ? sc_run_computer(run) : sc_get_current_scope(s->s.scheduler);
	const st_site *noted[1];
	if (o == NULL || st_sites_of(s->s.sites, o, noted, 1) == 0 || noted[0]->file == NULL) return NULL;
	*buf = (ch_site){noted[0]->file, noted[0]->line, 0, noted[0]->func, 0};
	return buf;
}

const ch_site *sw_site_of(void *software, ch_site *buf) { return sw_site(software, buf); }

// at sw_free the scheduler may be gone: the loads are closed there
void sw_drop(sw_loaded *l) {
	if (l->released) return;
	l->released = 1;
	DROP(l->by->loads, l->by->nloads, l);
	load *x = l->load;
	if (--x->holds == 0 && !l->sw->freeing) free(sc_teardown(x->scope));
}

static char *let_go(void *data) {
	owner *o = data;
	while (o->nloads > 0) sw_drop(o->loads[o->nloads - 1]);
	return NULL;
}

void sw_holder(sw *s, owner *o) {
	free(sc_register_teardown(s->s.scheduler, o->scope, let_go, o));
}

// the write with o open (none, or o torn down: with what is open)
int sw_write_in(sw *s, sc_scope *o, writing w) {
	w.s = s;
	within(o, sw_write_now, &w);
	return w.code;
}

sc_scope *sw_scope_of(sw *s, sc_pair *info, op_value **values, const char *key, const char *what,
	const char *id, sc_scope *parent, int give) {
	values[0] = op_str(what);
	values[1] = op_str(id);
	info[0] = (sc_pair){key, values[0]};
	info[1] = (sc_pair){PL_NODE, values[1]};
	sc_scope *o = sc_create_scope(s->s.scheduler, info, 2, parent);
	if (o != NULL && s->s.sites != NULL) {
		ch_site buf;
		const ch_site *here = sw_site(s, &buf);
		if (here != NULL && here->file != NULL) {
			st_note(s->s.sites, o, here->file, (int)here->line, here->function);
		}
	}
	if (o != NULL && give) sn_give(s->s.scopes, o, id);
	return o;
}

static char *live_gone(void *data) {
	living *l = data;
	sw *s = l->sw;
	if (s->freeing) return NULL;
	tb_key id = tb_string(l->id), value = tb_string("value");
	if (tb_get(s->s.table, value, id) == l->written) tb_del(s->s.table, value, id);
	return NULL;
}

void sw_live_until(sw *s, sc_scope *scope, const char *id) {
	const void *written = tb_get(s->s.table, tb_string("value"), tb_string(id));
	if (written == NULL || scope == NULL) return;
	living *l = sw_xalloc(sizeof *l);
	l->sw = s;
	l->id = sw_xdup(id);
	l->written = written;
	PUSH(s->lives, s->nlives, s->caplives, l);
	free(sc_register_teardown(s->s.scheduler, scope, live_gone, l));
}

// a one-shot effect's run: true, so it acts once
sc_out sw_once_f(void *previous, void *data) {
	(void)previous, (void)data;
	return (sc_out){.kind = SC_VALUE, .value = op_bool(1)};
}
