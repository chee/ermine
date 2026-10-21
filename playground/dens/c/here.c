// here (here.h), in C.
#include "here.h"

#include "handlers.h"
#include "offers.h"
#include "policy.h"
#include "start.h"

const char *const dn_dens[2] = {"system", "dens"};
const char *const dn_here[2] = {"system", "den"};

// the den's status gone at the first pulse
static char *den_act(void *value, void *previous, void *data) {
	(void)value, (void)previous;
	dn_process *self = data;
	free(sc_teardown(self->first));
	return NULL;
}

// the den's own process going, what is under it gone already (its offers and what ran on them, its
// loads): /system/den out, if it was put there
void dn_den_end(pr_process *life, void *data) {
	(void)life;
	dn_process *self = data;
	dn *d = self->den;
	if (self->ended) return;
	self->ended = 1;
	d->closed = 1;
	if (d->freeing) return;
	if (d->here_placed) {
		d->here_placed = 0;
		writing w = {.d = d, .what = W_UNHERE};
		dn_write_now(&w);
	}
	dn_changed(d);
}

// in the den's scope, as processes' start gives it: its methods, /system/den, and the effect that
// takes its status away at the first pulse
void dn_den_body(pr_process *life, void *data) {
	dn_process *self = data;
	dn *d = self->den;
	self->life = life;
	self->id = dn_xdup(pr_id(life));
	const char *const *at;
	self->nat = pr_at(life, &at);
	self->at = dn_copy_names(at, self->nat);
	self->scope = pr_scope(life);
	self->under = self->scope;
	dn_holder(d, self);
	dn_methods(d);
	writing w = {.d = d, .what = W_HERE, .id = self->id};
	dn_write_now(&w);
	if (w.code != 0) {
		d->here_failed = w.code > 0 ? w.code : PL_ALREADY_THERE;
		return;
	}
	d->here_placed = 1;
	self->first = sc_create_effect(d->s.scheduler, (sc_def){.f = dn_once_f, .effect = den_act, .data = self},
		NULL, 0);
	if (self->first != NULL) pr_give(d->life, life, self->first, 0);
}

const char *dn_id(const dn *d) { return d->id; }
const char *dn_node(const dn *d) { return d->self->id; }
dn_process *dn_self(const dn *d) { return d->self; }
sc_scope *dn_scope(const dn *d) { return d->owner; }
pl *dn_places(const dn *d) { return d->s.places; }
sc_scheduler *dn_scheduler(const dn *d) { return d->s.scheduler; }
tb_table *dn_table(const dn *d) { return d->s.table; }

void dn_close_at(dn *d, const op_value *reason, const ch_site *site) {
	if (d->closed) return;
	d->closed = 1;
	const ch_site *outer = dn_enter(d, site);
	op_value *was = d->pending;
	d->pending = op_ref((op_value *)(reason != NULL ? reason : d->reasons[R_DEN]));
	op_free(was);
	// each process's scope torn down, newest first (what goes with it is its scope's, its reason the
	// den's: start.c's); then the owner (the den's own, here, its row)
	size_t n = d->nrunning;
	dn_process **copy = dn_xalloc((n + 1) * sizeof *copy);
	if (n > 0) memcpy(copy, d->running, n * sizeof *copy);
	for (size_t i = n; i-- > 0;) free(sc_teardown(copy[i]->under));
	free(copy);
	free(sc_teardown(d->owner));
	dn_leave(d, outer);
}

int dn_stop_self(dn *d, const op_value *who, int remote, const op_value *reason,
	dn_refusal *refused) {
	*refused = (dn_refusal){0};
	dn_process *p = d->self;
	if (d->closed || p->life == NULL) return 0;
	pr_answer a = dn_permit(d, who, "stop", NULL, p->id, p->at, p->nat, remote);
	if (a.verdict != PR_YES) return dn_no_permission(refused, "stop", a), 1;
	dn_close_at(d, reason, d->site);
	return 0;
}

// whether a value has an encoding (what travels)
static int encodes(const op_value *v) {
	if (v == NULL || hf_holds(v)) return 0;
	// counted, not written: no bytes made
	CborOut count = {NULL, 0, 0, false};
	return pk_put(&count, v);
}

// the attributes as they travel, the read told: the status as "pending" | { failed }, no other with
// no encoding. none: NULL
static op_value *shown(dn *d, const char *id) {
	const op_value *v = pl_read(d->s.places, tb_string("attributes"), tb_string(id), NULL, 0);
	if (!dn_is_map(v)) return NULL;
	op_value *out = op_map();
	for (size_t i = 0; i < v->count; i++) {
		const op_value *x = v->items[i];
		if (strcmp(v->keys[i], CST_ATTRIBUTE) == 0) {
			if (cst_is_pending(x)) op_set(out, CST_ATTRIBUTE, op_str("pending"));
			else if (cst_error(x) != NULL) {
				op_value *failed = op_map();
				op_set(failed, "failed", op_str(cst_error(x)));
				op_set(out, CST_ATTRIBUTE, failed);
			}
		} else if (encodes(x)) op_set_name(out, v->keys[i], op_ref((op_value *)x));
	}
	return out;
}

// a node as seen: its attributes (if any), its children (kids, if any; taken)
static void seen(dn *d, op_value *nodes, const char *id, op_value *kids) {
	op_value *n = op_map();
	op_value *attributes = shown(d, id);
	if (attributes != NULL) op_set(n, "attributes", attributes);
	if (kids->count > 0) op_set(n, "children", kids);
	else op_free(kids);
	op_set(nodes, id, n);
}

// an owner, its folders and its offers, as seen; kids: its children dens wrote besides (taken)
static void offered(dn *d, op_value *nodes, dn_process *o, op_value *kids) {
	for (size_t i = 0; i < o->nfolders; i++) {
		op_set(kids, dn_kinds[o->folders[i].kind], op_str(o->folders[i].id));
	}
	seen(d, nodes, o->id, kids);
	for (size_t i = 0; i < o->nfolders; i++) {
		op_value *names = op_map();
		for (size_t k = 0; k < o->noffers; k++) {
			if (o->offers[k]->kind == o->folders[i].kind) {
				op_set(names, o->offers[k]->name, op_str(o->offers[k]->id));
			}
		}
		op_value *n = op_map();
		op_set(n, "children", names);
		op_set(nodes, o->folders[i].id, n);
	}
	for (size_t k = 0; k < o->noffers; k++) seen(d, nodes, o->offers[k]->id, op_map());
}

op_value *dn_nodes(dn *d, int processes) {
	sc_track(d->s.scheduler, &d->version);
	op_value *nodes = op_map();
	op_value *kids = op_map();
	op_set(kids, DN_ON, op_str(d->on_ids[0]));
	offered(d, nodes, d->self, kids);
	op_value *on = op_map(), *methods = op_map();
	op_set(methods, "start", op_str(d->on_ids[1]));
	op_set(methods, "stop", op_str(d->on_ids[2]));
	op_set(on, "children", methods);
	op_set(nodes, d->on_ids[0], on);
	op_value *out = op_map();
	op_set(out, "den", op_str(d->self->id));
	op_set(out, "nodes", nodes);
	if (!processes) return out;
	op_value *list = op_list();
	const char *root = pl_root(d->s.places).string;
	for (size_t i = 0; i < d->nrunning; i++) {
		dn_process *p = d->running[i];
		if (root == NULL || strcmp(pr_root(p->life), root) != 0) continue;
		op_push(list, dn_id_at(p));
		offered(d, nodes, p, op_map());
	}
	op_set(out, "processes", list);
	return out;
}
