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
	size_t there = 0;
	tb_at(d->s.table, tb_string(id), &there);
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
		f->scope = dn_scope_of(d, f->info, f->values, "offers", dn_kinds[kind], fid, o->under);
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
	x->scope = dn_scope_of(d, x->info, x->values, "offer", name, id, f->scope);
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
	dn_write_in(d, x->scope, (writing){.what = W_ADD, .part = "attributes", .id = id, .value = attrs});
	op_free(attrs);
	if (live != NULL) {
		dn_write_in(d, x->scope, (writing){.what = W_ADD, .part = "value", .id = id, .value = live});
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

void dn_withdraw_at(dn *d, const char *id, const ch_site *site) {
	offer *o = dn_live_offer(d, id);
	if (o == NULL || o->gone) return;
	const ch_site *was = dn_enter(d, site);
	// its name out of its folder, then its scope torn down: its users stopped "withdrawn"
	o->why = d->reasons[R_WITHDRAWN];
	dn_write_in(d, o->scope, (writing){.what = W_UNPLACE, .id = o->folder->id, .name = o->name});
	free(sc_teardown(o->scope));
	dn_leave(d, was);
}
