// offers (offers.h), in C.
#include "offers.h"

const char *const dn_kinds[3] = {"runners", "compilers", "surfaces"};
static const char *const types[3] = {DN_TYPE_RUNNER, DN_TYPE_COMPILER, DN_TYPE_SURFACE};

offer *dn_live_offer(const dn *d, const char *id) {
	for (size_t i = 0; id != NULL && i < d->nlive; i++) {
		if (strcmp(d->live[i]->id, id) == 0) return d->live[i];
	}
	return NULL;
}

// an offer's node going (withdrawn, or torn down from above), what ran on it gone already: it out
// of the lists
static char *offer_gone(void *data) {
	offer *o = data;
	dn *d = o->den;
	if (o->gone) return NULL;
	o->gone = 1;
	DROP(d->live, d->nlive, o);
	DROP(o->owner->offers, o->owner->noffers, o);
	dn_changed(d);
	return NULL;
}

// offers --------------------------------------------------------------------------------------------

// the owner's folder of the kind; NULL: none made yet
static folder *folder_of(dn_process *o, dn_kind kind) {
	for (size_t i = 0; i < o->nfolders; i++) {
		if (o->folders[i].kind == kind) return &o->folders[i];
	}
	return NULL;
}

static const char *offer_now(dn *d, dn_process *by, dn_kind kind, const char *name,
	const op_value *attributes, const op_value *live, dn_refusal *refused) {
	dn_forget(d);
	*refused = (dn_refusal){0};
	if (d->closed) return refused->refused = "stopped", NULL;
	if ((unsigned)kind > DN_SURFACES || name == NULL || !pl_is_name(name)) {
		return refused->refused = pl_code_name(PL_NOT_A_NAME), NULL;
	}
	dn_process *o = by == NULL ? d->self : by;
	if (o->den != d || o->ended || o->life == NULL) {
		return refused->refused = pl_code_name(PL_NOTHING_THERE), NULL;
	}
	size_t nat;
	char **at = dn_names_and((const char *const *)o->at, o->nat, dn_kinds[kind], name, &nat);
	char *fid = dn_joined(o->id, dn_kinds[kind]);
	char *id = dn_joined(fid, name);
	// the den's own offers are stored: taken by a live value there; a process's by any entry
	int stored = o == d->self && d->stored;
	size_t there = 0;
	if (stored) there = tb_get(d->s.table, tb_string("value"), tb_string(id)) != NULL;
	else tb_at(d->s.table, tb_string(id), &there);
	if (dn_live_offer(d, id) != NULL || there > 0) {
		free(fid);
		free(id);
		refused->refused = "taken";
		refused->at = dn_keep_names(d, at, nat);
		refused->nat = nat;
		return NULL;
	}
	folder *f = folder_of(o, kind);
	if (f == NULL) {
		f = &o->folders[o->nfolders++];
		f->kind = kind;
		f->id = fid;
		f->scope = dn_scope_of(d, f->info, f->values, "offers", dn_kinds[kind], fid, o->under,
			!stored);
		const char *path[1] = {dn_kinds[kind]};
		op_value *v = op_str(fid);
		dn_write_in(d, f->scope, (writing){.what = W_UPSERT, .part = "children", .id = o->id, .path = path,
			.n = 1, .value = v});
		op_free(v);
	} else free(fid);
	offer *x = dn_xalloc(sizeof *x);
	x->den = d;
	x->id = id;
	x->at = at;
	x->nat = nat;
	x->kind = kind;
	x->name = dn_xdup(name);
	x->owner = o;
	x->folder = f;
	x->scope = dn_scope_of(d, x->info, x->values, "offer", name, id, f->scope, !stored);
	PUSH(d->offers, d->noffers, d->capoffers, x);
	PUSH(d->live, d->nlive, d->caplive, x);
	PUSH(o->offers, o->noffers, o->capoffers, x);
	if (x->scope != NULL) free(sc_register_teardown(d->s.scheduler, x->scope, offer_gone, x));
	// the attributes as given, the kind's type over them; the value; its name in the folder
	op_value *attrs = op_map();
	if (dn_is_map(attributes)) {
		for (size_t i = 0; i < attributes->count; i++) {
			op_set_name(attrs, attributes->keys[i], op_ref(attributes->items[i]));
		}
	}
	op_set(attrs, DN_ATTRIBUTE, op_str(types[kind]));
	dn_write_in(d, x->scope, (writing){.what = W_SUB, .part = "attributes", .id = id, .value = attrs});
	op_free(attrs);
	if (live != NULL) {
		dn_write_in(d, x->scope, (writing){.what = W_ADD, .part = "value", .id = id, .value = live});
		if (stored) dn_live_until(d, x->scope, id);
	}
	const char *path[1] = {name};
	op_value *v = op_str(id);
	dn_write_in(d, x->scope, (writing){.what = W_UPSERT, .part = "children", .id = f->id, .path = path,
		.n = 1, .value = v});
	op_free(v);
	dn_changed(d);
	return x->id;
}

const char *dn_offer_at(dn *d, dn_process *by, dn_kind kind, const char *name,
	const op_value *attributes, const op_value *live, dn_refusal *refused, const ch_site *site) {
	const ch_site *was = dn_enter(d, site);
	const char *id = offer_now(d, by, kind, name, attributes, live, refused);
	dn_leave(d, was);
	return id;
}

size_t dn_offered_at(dn *d, const char *id, const char *const **out) {
	offer *o = dn_live_offer(d, id);
	if (o == NULL) return 0;
	*out = (const char *const *)o->at;
	return o->nat;
}

// a name an earlier session of this install left in one of the den's folders, offered by none now:
// out of its folder, its attributes out
static void unlist(dn *d, const char *id) {
	if (!d->stored || d->closed || id == NULL) return;
	for (size_t k = 0; k < 3; k++) {
		char *fid = dn_joined(d->self->id, dn_kinds[k]);
		const nd_entry *there = tb_get(d->s.table, tb_string("children"), tb_string(fid));
		char *name = NULL;
		for (size_t i = 0; dn_is_map(there != NULL ? there->value : NULL) && i < there->value->count; i++) {
			const op_value *x = there->value->items[i];
			if (dn_is_str(x) && strcmp(x->str, id) == 0) { free(name); name = dn_xdup(there->value->keys[i]); }
		}
		if (name != NULL) {
			dn_write_in(d, d->self->scope, (writing){.what = W_UNPLACE, .id = fid, .name = name});
			if (tb_get(d->s.table, tb_string("attributes"), tb_string(id)) != NULL) {
				tb_del(d->s.table, tb_string("attributes"), tb_string(id));
			}
			dn_changed(d);
		}
		free(name);
		free(fid);
	}
}

void dn_withdraw_at(dn *d, const char *id, const ch_site *site) {
	offer *o = dn_live_offer(d, id);
	const ch_site *was = dn_enter(d, site);
	if (o == NULL || o->gone) {
		unlist(d, id);
		dn_leave(d, was);
		return;
	}
	// its name out of its folder and its attributes out, then its scope torn down: its users stopped
	// "withdrawn"
	o->why = d->reasons[R_WITHDRAWN];
	dn_write_in(d, o->scope, (writing){.what = W_UNPLACE, .id = o->folder->id, .name = o->name});
	if (tb_get(d->s.table, tb_string("attributes"), tb_string(o->id)) != NULL) {
		tb_del(d->s.table, tb_string("attributes"), tb_string(o->id));
	}
	free(sc_teardown(o->scope));
	dn_leave(d, was);
}
