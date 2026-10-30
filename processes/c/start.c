// Starting and stopping processes; see start.h.
#include "start.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "runs.h"
#include "status.h"
#include "../../changeable/c/ptrmap.h"
#include "processes.h"
#include "platform.h"


static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) {
		fputs("processes: out of memory\n", stderr);
		abort();
	}
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }

static char *proc_id(const unsigned char boot[8], unsigned long n) {
	char *id = xalloc(sizeof "proc:" + 16 + 1 + 20);
	int at = sprintf(id, "proc:");
	for (size_t i = 0; i < 8; i++) at += sprintf(id + at, "%02x", boot[i]);
	sprintf(id + at, "-%lu", n);
	return id;
}

struct pr_process {
	pr *owner;
	char *id;
	char **at;
	size_t nat;
	char **args;
	size_t nargs;
	op_value *at_value;
	char **folder;
	size_t nfolder;
	sc_pair info[3];
	op_value *id_value;
	sc_scope *scope;
	pl *places;
	char *root;
	void (*stop)(pr_process *p, void *data);
	void *data;
	int ended, rowed;
	int dropped;
	size_t slot;
	ch_location site, stop_site;
};

struct pr {
	pr_setup s;
	sc_scope *owner;
	sc_pair owner_info;
	int owned;
	cst *statuses;
	crn *runs;
	pr_process **all;
	size_t n, cap;
	int halted;
	sc_listener *freed;
	pm dropped;
	pr_process *refused;
	unsigned char boot[8];
	unsigned long made;
};

static void process_free(pr_process *p) {
	free(p->id);
	pr_names_free(p->at, p->nat);
	pr_names_free(p->folder, p->nfolder);
	pr_names_free(p->args, p->nargs);
	free(p->root);
	op_free(p->at_value);
	op_free(p->id_value);
	free(p);
}

static void process_gone(pr *s, pr_process *p) {
	pr_process *last = s->all[--s->n];
	s->all[p->slot] = last;
	last->slot = p->slot;
	process_free(p);
}

static void scope_freed(sc_scope *o, void *data) {
	pr *s = data;
	pr_process *p = pm_get(&s->dropped, o);
	if (p == NULL) return;
	pm_delete(&s->dropped, o);
	process_gone(s, p);
}

pr *pr_new_at(const pr_setup *setup, const char *file, int line, const char *func) {
	(void)file, (void)line, (void)func;
	pr *s = xalloc(sizeof *s);
	s->s = *setup;
	PF_RANDOM(s->boot, sizeof s->boot);
	if (setup->owner != NULL) s->owner = setup->owner;
	else {
		s->owned = 1;
		s->owner_info = (sc_pair){"processes", op_str("start")};
		s->owner = sc_create_scope(setup->scheduler, &s->owner_info, 1, NULL);
	}
	s->statuses = cst_new(&(cst_setup){.places = setup->places, .table = setup->table,
		.scheduler = setup->scheduler, .write = setup->write, .write_ctx = setup->write_ctx});
	if (setup->runs) {
		s->runs = crn_new(&(crn_setup){
			.places = setup->places, .table = setup->table, .scheduler = setup->scheduler});
	}
	s->freed = sc_on_free(setup->scheduler, scope_freed, s);
	return s;
}

sc_scope *pr_scope(const pr_process *p) { return p->scope; }
const char *pr_id(const pr_process *p) { return p->id; }
pl *pr_places(const pr_process *p) { return p->places; }
const char *pr_root(const pr_process *p) { return p->root; }
size_t pr_at(const pr_process *p, const char *const **out) {
	*out = (const char *const *)p->at;
	return p->nat;
}
size_t pr_folder(const pr_process *p, const char *const **out) {
	*out = (const char *const *)p->folder;
	return p->nfolder;
}
size_t pr_args(const pr_process *p, const char *const **out) {
	*out = (const char *const *)p->args;
	return p->nargs;
}

void pr_give(pr *s, pr_process *p, sc_computer *c, int run) {
	cst_give(s->statuses, c, tb_string(p->id));
	if (run && s->runs != NULL) crn_give(s->runs, c, tb_string(p->id));
}

char **pr_names(const char *const *steps, size_t n, size_t *out) {
	const char **names = xalloc((n + 1) * sizeof *names);
	size_t k = 0;
	for (size_t i = 0; i < n; i++) {
		if (strcmp(steps[i], ".") == 0) continue;
		if (strcmp(steps[i], "/") == 0) k = 0;
		else if (strcmp(steps[i], "..") == 0) k -= k > 0;
		else names[k++] = steps[i];
	}
	*out = k;
	char **copy = xalloc((*out + 1) * sizeof *copy);
	for (size_t i = 0; i < *out; i++) copy[i] = xdup(names[i]);
	free(names);
	return copy;
}

char **pr_folder_of(const char *const *at, size_t nat, const char *const *folder, size_t nfolder,
	int has_folder, size_t *out) {
	if (has_folder) return pr_names(folder, nfolder, out);
	*out = nat > 0 ? nat - 1 : 0;
	char **copy = xalloc((*out + 1) * sizeof *copy);
	for (size_t i = 0; i < *out; i++) copy[i] = xdup(at[i]);
	return copy;
}

void pr_names_free(char **names, size_t n) {
	for (size_t i = 0; i < n; i++) free(names[i]);
	free(names);
}

static op_value *names_value(char *const *names, size_t n) {
	op_value *list = op_list();
	for (size_t i = 0; i < n; i++) op_push(list, op_str(names[i]));
	return list;
}

static void within(pr_process *p, void (*f)(void *data), void *data) {
	if (sc_scope_alive(p->scope)) sc_run_with_scope(p->scope, f, data);
	else f(data);
}

static void commit_changed(pr *s, const pl_changed *changed) {
	if (s->s.commit != NULL) s->s.commit(s->s.commit_ctx, changed);
	else pl_commit(s->s.places, changed);
}

static void handed(pr *s, pl *holder, const char *part, const char *id, const op_patch *patches,
	size_t n, const ch_header *h, pl_made *made) {
	s->s.write(s->s.write_ctx, part, tb_string(id), patches, n, h);
	const nd_entry *there = tb_get(s->s.table, tb_string(part), tb_string(id));
	if (there != NULL) pl_hold_also(holder, there, pl_made_ref(made), pl_made_free);
	pl_made_free(made);
}

typedef struct {
	pr_process *p;
	int code;
} rowing;

static op_value *nested(char *const *names, size_t from, size_t n, op_value *leaf) {
	for (size_t i = n; i-- > from;) {
		op_value *m = op_map();
		op_set(m, names[i], leaf);
		leaf = m;
	}
	return leaf;
}

static int level_under(const op_value *v, char *const *names, size_t n) {
	for (size_t i = 0; i < n && v != NULL; i++) v = v->type == OP_MAP ? op_get(v, names[i]) : NULL;
	return v != NULL && v->type == OP_MAP && v->count > 0;
}

static int hand_row(pr_process *p, const ch_header *h, pl_made *made) {
	pr *s = p->owner;
	if (p->nat == 0) return PL_NOT_A_NAME;
	for (size_t i = 0; i < p->nat; i++) {
		if (!pl_is_name(p->at[i])) return PL_NOT_A_NAME;
	}
	const nd_entry *there = tb_get(s->s.table, tb_string(PR_PART), tb_string(p->root));
	size_t at = 0;
	op_value *value = NULL;
	if (there != NULL) {
		at = p->nat;
		const op_value *v = there->value;
		for (size_t i = 0; i < p->nat; i++) {
			if (v->type == OP_STR) {
				value = op_map();
				op_set(value, "", op_str(v->str));
				op_set(value, p->at[i], nested(p->at, i + 1, p->nat, op_str(p->id)));
				at = i;
				break;
			}
			if (v->type != OP_MAP) {
				at = i;
				break;
			}
			v = op_get(v, p->at[i]);
			if (v == NULL) {
				at = i + 1;
				break;
			}
		}
		if (value == NULL && at == p->nat && v != NULL) {
			if (v->type == OP_STR || (v->type == OP_MAP && op_get(v, "") != NULL)) {
				return PL_ALREADY_THERE;
			}
		}
	}
	size_t length = at;
	int self = there != NULL && value == NULL && at == p->nat &&
		level_under(there->value, p->at, p->nat);
	if (self) length = p->nat + 1;
	op_key *keys = xalloc((length + 1) * sizeof *keys);
	for (size_t i = 0; i < length; i++) {
		keys[i] = (op_key){.type = OP_STR_KEY, .s = i < p->nat ? p->at[i] : ""};
	}
	if (value == NULL) value = self ? op_str(p->id) : nested(p->at, at, p->nat, op_str(p->id));
	op_patch patch = {.place = {.path = keys, .length = length}, .has_value = 1, .value = value};
	handed(s, p->places, PR_PART, p->root, &patch, 1, h, made);
	op_free(value);
	free(keys);
	return 0;
}

static int hand_unrow(pr_process *p, const ch_header *h, pl_made *made) {
	pr *s = p->owner;
	const nd_entry *there = tb_get(s->s.table, tb_string(PR_PART), tb_string(p->root));
	if (there == NULL || p->nat == 0) return PL_NOTHING_THERE;
	size_t *counts = xalloc((p->nat + 1) * sizeof *counts);
	const op_value *v = there->value;
	size_t n = p->nat;
	for (size_t i = 0; i < p->nat; i++) {
		if (v == NULL || v->type != OP_MAP || op_get(v, p->at[i]) == NULL) {
			free(counts);
			return PL_NOTHING_THERE;
		}
		counts[i] = v->count;
		v = op_get(v, p->at[i]);
	}
	if (v != NULL && v->type == OP_MAP && op_get(v, "") != NULL) {
		counts[n++] = v->count;
		v = op_get(v, "");
	}
	if (v == NULL || v->type != OP_STR) {
		free(counts);
		return PL_NOTHING_THERE;
	}
	size_t d = n - 1;
	while (d > 0 && counts[d] == 1) d--;
	free(counts);
	op_key *keys = xalloc((d + 1) * sizeof *keys);
	for (size_t i = 0; i <= d; i++) {
		keys[i] = (op_key){.type = OP_STR_KEY, .s = i < p->nat ? p->at[i] : ""};
	}
	op_patch patch = {.place = {.path = keys, .length = d + 1}};
	handed(s, p->places, PR_PART, p->root, &patch, 1, h, made);
	free(keys);
	return 0;
}

static void add_row(void *data) {
	rowing *r = data;
	pr_process *p = r->p;
	pr *s = p->owner;
	ch_header h;
	pl_made *made;
	char *bad = pl_header(s->s.places, NULL, 0, p->site.file != NULL ? &p->site : NULL, &h, &made);
	if (bad != NULL) {
		free(bad);
		r->code = -1;
		return;
	}
	if (s->s.write != NULL) {
		r->code = hand_row(p, &h, made);
		if (r->code != 0) pl_made_free(made);
		return;
	}
	pl *holder = p->places;
	pl_changed changed;
	nd_entry *born;
	r->code = pr_add(holder, s->s.table, tb_string(p->root), (const char *const *)p->at, p->nat,
		tb_string(p->id), h, &changed, &born);
	commit_changed(s, &changed);
	for (size_t i = 0; i < changed.n; i++) pl_hold_also(holder, changed.entries[i], pl_made_ref(made), pl_made_free);
	if (born != NULL) pl_hold(holder, born, pl_made_ref(made), pl_made_free);
	pl_made_free(made);
}

static void remove_row(void *data) {
	rowing *r = data;
	pr_process *p = r->p;
	pr *s = p->owner;
	ch_header h;
	pl_made *made;
	ch_location buf;
	const ch_location *at = &p->stop_site;
	if (at->file == NULL) at = s->s.site != NULL ? s->s.site(s->s.site_ctx, &buf) : NULL;
	char *bad = pl_header(s->s.places, NULL, 0, at != NULL ? at : CH_HERE, &h, &made);
	if (bad != NULL) {
		free(bad);
		return;
	}
	if (s->s.write != NULL) {
		r->code = hand_unrow(p, &h, made);
		if (r->code != 0) pl_made_free(made);
		return;
	}
	pl *holder = p->places;
	pl_changed changed;
	r->code = pr_remove(holder, s->s.table, tb_string(p->root), (const char *const *)p->at, p->nat,
		h, &changed);
	commit_changed(s, &changed);
	for (size_t i = 0; i < changed.n; i++) pl_hold_also(holder, changed.entries[i], pl_made_ref(made), pl_made_free);
	pl_made_free(made);
}

static void call_stop(void *data) {
	pr_process *p = data;
	void (*stop)(pr_process *, void *) = p->stop;
	p->stop = NULL;
	stop(p, p->data);
}

static void end(pr_process *p) {
	if (!p->ended) {
		p->ended = 1;
		if (p->stop != NULL) within(p, call_stop, p);
	}
	if (p->rowed) {
		p->rowed = 0;
		rowing r = {p, 0};
		within(p, remove_row, &r);
	}
}

static char *end_teardown(void *data) {
	end(data);
	return NULL;
}

static char *drop_teardown(void *data) {
	pr_process *p = data;
	if (p->owner->runs != NULL) crn_drop(p->owner->runs, tb_string(p->id));
	return NULL;
}

typedef struct {
	pr_process *p;
	const pr_options *o;
} starting;

static void make_attributes(void *data) {
	starting *c = data;
	pr_process *p = c->p;
	pr *s = p->owner;
	ch_header h;
	pl_made *made;
	char *bad = pl_header(s->s.places, NULL, 0, p->site.file != NULL ? &p->site : NULL, &h, &made);
	if (bad != NULL) {
		free(bad);
		return;
	}
	op_value *attrs = op_map();
	const op_value *given = c->o->attributes;
	if (given != NULL && given->type == OP_MAP) {
		for (size_t i = 0; i < given->count; i++) {
			op_set_name(attrs, given->keys[i], op_ref(given->items[i]));
		}
	}
	if (c->o->has_args) op_set(attrs, PR_ARGS, names_value(p->args, p->nargs));
	op_set(attrs, PR_FOLDER, names_value(p->folder, p->nfolder));
	if (c->o->pin != NULL) op_set(attrs, PR_PIN, op_ref((op_value *)c->o->pin));
	if (s->s.write != NULL) {
		op_patch whole = {.has_value = 1, .value = attrs};
		handed(s, s->s.places, "attributes", p->id, &whole, 1, &h, made);
		op_free(attrs);
	} else {
		nd_entry *node = nd_make_entry(attrs, &h);
		op_free(attrs);
		pl_own(s->s.places, node);
		pl_hold(s->s.places, node, made, pl_made_free);
		tb_add(s->s.table, tb_string("attributes"), tb_string(p->id), node);
	}
	ch_header sh;
	pl_made *smade;
	bad = pl_header(s->s.places, NULL, 0, p->site.file != NULL ? &p->site : NULL, &sh, &smade);
	if (bad != NULL) {
		free(bad);
		return;
	}
	op_value *st = op_map();
	op_set(st, CST_ATTRIBUTE, cst_pending_value());
	if (s->s.write != NULL) {
		op_patch whole = {.has_value = 1, .value = st};
		handed(s, s->s.places, CST_TABLE, p->id, &whole, 1, &sh, smade);
		op_free(st);
		return;
	}
	nd_entry *status = nd_make_entry(st, &sh);
	op_free(st);
	pl_own(s->s.places, status);
	pl_hold(s->s.places, status, smade, pl_made_free);
	tb_add(s->s.table, tb_string(CST_TABLE), tb_string(p->id), status);
}

static void call_body(void *data) {
	starting *c = data;
	c->o->body(c->p, c->o->data);
}

pr_process *pr_start_at(pr *s, pl *where, const char *const *steps, size_t nsteps,
	const pr_options *options, pr_refusal *refused, const char *file, int line, const char *func) {
	*refused = (pr_refusal){0};
	if (s->refused != NULL) process_gone(s, s->refused);
	s->refused = NULL;
	pr_options none = {0};
	const pr_options *o = options != NULL ? options : &none;
	pr_process *p = xalloc(sizeof *p);
	p->owner = s;
	p->site = (ch_location){file, line, 0, func, 0};
	p->places = where;
	p->root = xdup(pl_root(where).string);
	p->at = pr_names(steps, nsteps, &p->nat);
	p->at_value = names_value(p->at, p->nat);
	p->folder = pr_folder_of((const char *const *)p->at, p->nat, o->folder, o->nfolder, o->has_folder,
		&p->nfolder);
	p->nargs = o->nargs;
	p->args = xalloc((o->nargs + 1) * sizeof *p->args);
	for (size_t i = 0; i < o->nargs; i++) p->args[i] = xdup(o->args[i]);
	p->id = s->s.id != NULL ? s->s.id(s->s.id_ctx) : proc_id(s->boot, ++s->made);
	p->id_value = op_str(p->id);
	p->info[0] = (sc_pair){"process", p->at_value};
	p->info[1] = (sc_pair){CH_NODE, p->id_value};
	size_t ninfo = 2;
	op_value *locations = NULL;
	if (file != NULL && sc_get_run(s->s.scheduler) == NULL &&
		!ch_frame_located(sc_get_current_frame(s->s.scheduler))) {
		locations = ch_locations(&p->site);
		p->info[ninfo++] = (sc_pair){CH_LOCATIONS, locations};
	}
	p->scope = sc_create_scope(s->s.scheduler, p->info, ninfo, o->under != NULL ? o->under : s->owner);
	op_free(locations);
	sn_give(s->s.scopes, p->scope, p->id);
	if (s->n == s->cap) {
		s->cap = s->cap ? s->cap * 2 : 8;
		s->all = realloc(s->all, s->cap * sizeof *s->all);
		if (s->all == NULL) abort();
	}
	p->slot = s->n;
	s->all[s->n++] = p;
	rowing row = {p, 0};
	sc_run_with_scope(p->scope, add_row, &row);
	if (row.code != 0) {
		// Refused: the pieces the scope's info and the refusal borrow are freed at the next start.
		free(sc_teardown(p->scope));
		sc_release(p->scope);
		p->ended = 1;
		refused->refused = row.code == PL_ALREADY_THERE ? "taken" : pl_code_name(row.code);
		refused->at = (const char *const *)p->at, refused->nat = p->nat;
		s->refused = p;
		return NULL;
	}
	p->rowed = 1;
	p->stop = o->stop;
	p->data = o->data;
	sc_register_teardown(s->s.scheduler, p->scope, drop_teardown, p);
	sc_register_teardown(s->s.scheduler, p->scope, end_teardown, p);
	starting c = {p, o};
	sc_run_with_scope(p->scope, make_attributes, &c);
	if (o->body != NULL) sc_run_with_scope(p->scope, call_body, &c);
	return p;
}

char *pr_stop_at(pr *s, pr_process *p, const char *file, int line, const char *func) {
	p->stop_site = (ch_location){file, line, 0, func, 0};
	(void)s;
	end(p);
	return sc_teardown(p->scope);
}

void pr_let_go(pr *s, pr_process *p) {
	if (p->dropped) return;
	p->dropped = 1;
	pm_set(&s->dropped, p->scope, p);
	sc_release(p->scope);
}

char *pr_drop(pr *s, pr_process *p) {
	if (p->dropped) return NULL;
	char *error = !p->ended || sc_scope_alive(p->scope) ? pr_stop(s, p) : NULL;
	pr_let_go(s, p);
	return error;
}

void pr_halt(pr *s) {
	if (s == NULL || s->halted) return;
	s->halted = 1;
	if (s->freed != NULL) sc_remove_listener(s->freed);
	s->freed = NULL;
	cst_stop(s->statuses);
	crn_stop(s->runs);
}

void pr_free(pr *s) {
	if (s == NULL) return;
	cst_free(s->statuses);
	crn_free(s->runs);
	for (size_t i = 0; i < s->n; i++) {
		pr_process *p = s->all[i];
		if (p->ended) continue;
		p->ended = 1;
		if (p->stop != NULL) call_stop(p);
	}
	for (size_t i = 0; i < s->n; i++) process_free(s->all[i]);
	pm_clear(&s->dropped);
	free(s->all);
	if (s->owned) op_free((op_value *)s->owner_info.value);
	free(s);
}
