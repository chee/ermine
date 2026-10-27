// Start (start.h), in C.
#include "start.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "runs.h"
#include "../../../core/places/c/status.h"
#include "../../../core/scheduler/c/ptrmap.h"
#include "processes.h"
#include "platform.h"

#define PENDING_NAME "ermine.pending"

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) {
		fputs("processes: out of memory\n", stderr);
		abort();
	}
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }

// "proc:<boot>-<n>": boot 16 hex, from the system's random bytes once per pr, n from 1
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
	// its scope's: ["process", at], [PL_NODE, id]
	sc_pair info[2];
	op_value *id_value;
	sc_scope *scope;
	// the places it runs in, and their root (copied)
	pl *places;
	char *root;
	// stop and its data, until called; its row still at its root
	void (*stop)(pr_process *p, void *data);
	void *data;
	int ended, rowed;
	// let go of by its holder (pr_drop): freed as its scope is. slot: where it is in all
	int dropped;
	size_t slot;
	// the sites of its writes: its start's caller's (file NULL: none); its stop's caller's (file
	// NULL: torn down from above, processes' own)
	ch_site site, stop_site;
};

struct pr {
	pr_setup s;
	// the processes' owner: setup.owner, or its own (owned 1), its info [["processes", "start"]]
	sc_scope *owner;
	sc_pair owner_info;
	int owned;
	cst *statuses;
	// setup.runs: give's runs, on the runs' table (runs.h); else NULL
	crn *runs;
	pr_process **all;
	size_t n, cap;
	int halted;
	// a dropped process's scope freed: the process goes. the dropped, by their scope
	sc_listener *freed;
	pm dropped;
	// the last start refused: its path is the refusal's, till the next start (or pr_free)
	pr_process *refused;
	// the default ids: this pr's boot, and how many made
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

// out of all, and freed
static void process_gone(pr *s, pr_process *p) {
	pr_process *last = s->all[--s->n];
	s->all[p->slot] = last;
	last->slot = p->slot;
	process_free(p);
}

// a scope freed: a dropped process whose it was goes (its info borrowed its at and id till now)
static void scope_freed(sc_scope *o, void *data) {
	pr *s = data;
	pr_process *p = pm_get(&s->dropped, o);
	if (p == NULL) return;
	pm_delete(&s->dropped, o);
	process_gone(s, p);
}

pr *pr_new_at(const pr_setup *setup, const char *file, int line, const char *func) {
	pr *s = xalloc(sizeof *s);
	s->s = *setup;
	PF_RANDOM(s->boot, sizeof s->boot);
	if (setup->owner != NULL) s->owner = setup->owner;
	else {
		s->owned = 1;
		s->owner_info = (sc_pair){"processes", op_str("start")};
		s->owner = sc_create_scope(setup->scheduler, &s->owner_info, 1, NULL);
		if (setup->sites != NULL) st_note(setup->sites, s->owner, file, line, func);
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

// names steps come to from the root: "." here, ".." back one (at the root: stays), "/" the root; copied
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

// f with the process's scope open; torn down already (its own teardown): open, as it is
static void within(pr_process *p, void (*f)(void *data), void *data) {
	if (sc_scope_alive(p->scope)) sc_run_with_scope(p->scope, f, data);
	else f(data);
}

static void commit_changed(pr *s, const pl_changed *changed) {
	if (s->s.commit != NULL) s->s.commit(s->s.commit_ctx, changed);
	else pl_commit(s->s.places, changed);
}

// one write handed to setup.write; its header's block held on the node it landed on (none there: a
// writer that held it back), holder's, as the writes made here hold theirs
static void handed(pr *s, pl *holder, const char *part, const char *id, const op_patch *patches,
	size_t n, const ch_header *h, pl_made *made) {
	s->s.write(s->s.write_ctx, part, tb_string(id), patches, n, h);
	const nd_entry *there = tb_get(s->s.table, tb_string(part), tb_string(id));
	if (there != NULL) pl_hold_also(holder, there, pl_made_ref(made), pl_made_free);
	pl_made_free(made);
}

// the row ----------------------------------------------------------------------------------------------

typedef struct {
	pr_process *p;
	int code;
} rowing;

// names[from..n) nested round leaf: {a: {b: leaf}}
static op_value *nested(char *const *names, size_t from, size_t n, op_value *leaf) {
	for (size_t i = n; i-- > from;) {
		op_value *m = op_map();
		op_set(m, names[i], leaf);
		leaf = m;
	}
	return leaf;
}

// whether the node at names under v is a map with a name in it
static int level_under(const op_value *v, char *const *names, size_t n) {
	for (size_t i = 0; i < n && v != NULL; i++) v = v->type == OP_MAP ? op_get(v, names[i]) : NULL;
	return v != NULL && v->type == OP_MAP && v->count > 0;
}

// add_row as the writer has it: the patch pr_add makes (processes.c), refused the same way, handed
// over instead of made. 0, or the code
static int hand_row(pr_process *p, const ch_header *h, pl_made *made) {
	pr *s = p->owner;
	if (p->nat == 0) return PL_NOT_A_NAME;
	for (size_t i = 0; i < p->nat; i++) {
		if (!pl_is_name(p->at[i])) return PL_NOT_A_NAME;
	}
	const nd_entry *there = tb_get(s->s.table, tb_string(PR_PART), tb_string(p->root));
	// the first level the part has no map for or no key at: the rest goes there. a leaf above the
	// path becomes a level (its id under "", the rest beside it); a level of processes under the path
	// takes this one under "" (processes.c)
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

// remove_row as the writer has it: pr_remove's patch (the highest level left empty), handed over
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
	// a process with processes under it: its id is under "" in its level
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
	ch_site buf;
	const ch_site *at = &p->stop_site;
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

// stop, once; the row taken out, once
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

// its run record out, last
static char *drop_teardown(void *data) {
	pr_process *p = data;
	if (p->owner->runs != NULL) crn_drop(p->owner->runs, tb_string(p->id));
	return NULL;
}

// start ------------------------------------------------------------------------------------------------

typedef struct {
	pr_process *p;
	const pr_options *o;
} starting;

// the node's one attributes entry: options.attributes' pairs, then processes' own over them; its
// status its status table entry
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
	// its status PENDING, in the status table, not its attributes (places' status.h): a header of
	// its own, as the entry borrows it
	ch_header sh;
	pl_made *smade;
	bad = pl_header(s->s.places, NULL, 0, p->site.file != NULL ? &p->site : NULL, &sh, &smade);
	if (bad != NULL) {
		free(bad);
		return;
	}
	op_value *st = op_map();
	op_set(st, CST_ATTRIBUTE, op_stand(op_str(PENDING_NAME)));
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
	p->site = (ch_site){file, line, 0, func, 0};
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
	p->info[1] = (sc_pair){PL_NODE, p->id_value};
	p->scope = sc_create_scope(s->s.scheduler, p->info, 2, o->under != NULL ? o->under : s->owner);
	if (s->s.sites != NULL && file != NULL) st_note(s->s.sites, p->scope, file, line, func);
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
		// refused: the scope torn down and the maker's hold let go (the scope freed), the process
		// made no more (its pieces, which the scope's info and the refusal borrow, freed at the next start)
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

void pr_stop_at(pr *s, pr_process *p, const char *file, int line, const char *func) {
	p->stop_site = (ch_site){file, line, 0, func, 0};
	(void)s;
	end(p);
	free(sc_teardown(p->scope));
}

void pr_let_go(pr *s, pr_process *p) {
	if (p->dropped) return;
	p->dropped = 1;
	pm_set(&s->dropped, p->scope, p);
	// the maker's hold: the scope freed once nothing else holds it, and p with it
	sc_release(p->scope);
}

void pr_drop(pr *s, pr_process *p) {
	if (p->dropped) return;
	if (!p->ended || sc_scope_alive(p->scope)) pr_stop(s, p);
	pr_let_go(s, p);
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
	// a process never stopped: its stop (no scope open: the scheduler is gone)
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
