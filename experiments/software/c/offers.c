// offers (typescript/offers.ts), in C: what can run here, as nodes. a runner, a compiler or a
// surface an owner puts under its node, its attributes what travels and its value (the live
// stand-in) this session's alone. sw_offer_at and sw_withdraw_at are software.h's. an offer is a
// scope under its folder's, under its owner's: what runs on it runs under it, so its node going
// takes them, newest first. which question: what is on offer here
#include "common.h"

const char *const sw_kinds[3] = {"runners", "compilers", "surfaces"};
static const char *const types[3] = {SW_TYPE_RUNNER, SW_TYPE_COMPILER, SW_TYPE_SURFACE};

offer *sw_live_offer(const sw *s, const char *id) {
	for (size_t i = 0; id != NULL && i < s->nlive; i++) {
		if (strcmp(s->live[i]->id, id) == 0) return s->live[i];
	}
	return NULL;
}

// an offer's node going (withdrawn, or torn down from above), what ran on it gone already: it out
// of the lists
static char *offer_gone(void *data) {
	offer *o = data;
	sw *s = o->sw;
	if (o->gone) return NULL;
	o->gone = 1;
	DROP(s->live, s->nlive, o);
	DROP(o->owner->offers, o->owner->noffers, o);
	sw_changed(s);
	return NULL;
}

// a place's folder going: its name out of the owner's children, setup.scope open (a process's whole
// node goes anyway; a place's stays). the name pointing elsewhere now, or setup.scope gone
// (everything goes, nothing to tidy): nothing
static char *folder_gone(void *data) {
	folder *f = data;
	owner *o = f->owner;
	sw *s = o->sw;
	if (s->freeing) return NULL;
	const nd_entry *there = tb_get(s->s.table, tb_string("children"), tb_string(o->id));
	const op_value *v = there != NULL ? sw_get(there->value, sw_kinds[f->kind]) : NULL;
	if (!sw_is_str(v) || strcmp(v->str, f->id) != 0) return NULL;
	if (!sc_scope_alive(s->s.scope)) return NULL;
	sw_write_in(s, s->s.scope, (writing){.what = W_UNPLACE, .id = o->id, .name = sw_kinds[f->kind]});
	return NULL;
}

// the owner's folder of the kind; NULL: none made yet
static folder *folder_of(owner *o, sw_kind kind) {
	for (size_t i = 0; i < o->nfolders; i++) {
		if (o->folders[i].kind == kind) return &o->folders[i];
	}
	return NULL;
}

static const sw_offered *offer_now(sw *s, const sw_place *by, sw_kind kind, const char *name,
	const op_value *attributes, const op_value *live, sw_refusal *refused) {
	sw_forget(s);
	*refused = (sw_refusal){0};
	if ((unsigned)kind > SW_SURFACES) return refused->refused = "not-a-kind", NULL;
	if (name == NULL || !pl_is_name(name)) return refused->refused = pl_code_name(PL_NOT_A_NAME), NULL;
	owner *o = by != NULL ? sw_owner_of(s, by) : NULL;
	if (o == NULL) return refused->refused = pl_code_name(PL_NOTHING_THERE), NULL;
	size_t nat;
	char **at = sw_names_and((const char *const *)o->at, o->nat, sw_kinds[kind], name, &nat);
	char *fid = sw_joined(o->id, sw_kinds[kind]);
	char *id = sw_joined(fid, name);
	// a stored owner's: taken by a live value there; any other's by any entry
	int stored = o->stored;
	size_t there = 0;
	if (stored) there = tb_get(s->s.table, tb_string("value"), tb_string(id)) != NULL;
	else tb_at(s->s.table, tb_string(id), &there);
	if (sw_live_offer(s, id) != NULL || there > 0) {
		free(fid);
		free(id);
		refused->refused = "taken";
		refused->at = sw_keep_names(s, at, nat);
		refused->nat = nat;
		return NULL;
	}
	folder *f = folder_of(o, kind);
	if (f == NULL) {
		f = &o->folders[o->nfolders++];
		f->kind = kind;
		f->id = fid;
		f->owner = o;
		f->scope = sw_scope_of(s, f->info, f->values, "offers", sw_kinds[kind], fid, o->under, !stored);
		if (!stored && f->scope != NULL) {
			free(sc_register_teardown(s->s.scheduler, f->scope, folder_gone, f));
		}
		const char *path[1] = {sw_kinds[kind]};
		op_value *v = op_str(fid);
		sw_write_in(s, f->scope, (writing){.what = W_UPSERT, .part = "children", .id = o->id, .path = path,
			.n = 1, .value = v});
		op_free(v);
	} else free(fid);
	offer *x = sw_xalloc(sizeof *x);
	x->sw = s;
	x->id = id;
	x->at = at;
	x->name = sw_xdup(name);
	x->facts = (sw_offered){x->id, (const char *const *)x->at, nat, kind, x->name, o->id};
	x->owner = o;
	x->folder = f;
	x->scope = sw_scope_of(s, x->info, x->values, "offer", name, id, f->scope, !stored);
	PUSH(s->offers, s->noffers, s->capoffers, x);
	PUSH(s->live, s->nlive, s->caplive, x);
	PUSH(o->offers, o->noffers, o->capoffers, x);
	if (x->scope != NULL) free(sc_register_teardown(s->s.scheduler, x->scope, offer_gone, x));
	// the attributes as given, the kind's type over them; the value; its name in the folder
	op_value *attrs = op_map();
	if (sw_is_map(attributes)) {
		for (size_t i = 0; i < attributes->count; i++) {
			op_set_name(attrs, attributes->keys[i], op_ref(attributes->items[i]));
		}
	}
	op_set(attrs, SW_ATTRIBUTE, op_str(types[kind]));
	sw_write_in(s, x->scope, (writing){.what = W_SUB, .part = "attributes", .id = id, .value = attrs});
	op_free(attrs);
	if (live != NULL) {
		sw_write_in(s, x->scope, (writing){.what = W_ADD, .part = "value", .id = id, .value = live});
		if (stored) sw_live_until(s, x->scope, id);
	}
	const char *path[1] = {name};
	op_value *v = op_str(id);
	sw_write_in(s, x->scope, (writing){.what = W_UPSERT, .part = "children", .id = f->id, .path = path,
		.n = 1, .value = v});
	op_free(v);
	sw_changed(s);
	return &x->facts;
}

const sw_offered *sw_offer_at(sw *s, const sw_place *by, sw_kind kind, const char *name,
	const op_value *attributes, const op_value *live, sw_refusal *refused, const ch_site *site) {
	const ch_site *was = sw_enter(s, site);
	const sw_offered *made = offer_now(s, by, kind, name, attributes, live, refused);
	sw_leave(s, was);
	return made;
}

// a name a stored owner's folder holds, offered by none now: every name pointing at it out of the
// folder, its attributes out. the folder is <owner>/<kind>, the id's own (its first kind, in
// sw_kinds' order)
static void unlist(sw *s, const char *id) {
	if (id == NULL) return;
	int kind = -1;
	for (int k = 0; k < 3 && kind < 0; k++) {
		char in[16];
		snprintf(in, sizeof in, "/%s/", sw_kinds[k]);
		if (strstr(id, in) != NULL) kind = k;
	}
	if (kind < 0) return;
	size_t cut = (size_t)(strrchr(id, '/') - id);
	char *fid = sw_xalloc(cut + 1);
	memcpy(fid, id, cut);
	const nd_entry *there = tb_get(s->s.table, tb_string("children"), tb_string(fid));
	// every name pointing at it, copied first: each removal changes the map they are in
	char **names = NULL;
	size_t n = 0;
	for (size_t i = 0; there != NULL && sw_is_map(there->value) && i < there->value->count; i++) {
		const op_value *x = there->value->items[i];
		if (sw_is_str(x) && strcmp(x->str, id) == 0) {
			names = realloc(names, (n + 1) * sizeof *names);
			if (names == NULL) abort();
			names[n++] = sw_xdup(there->value->keys[i]);
		}
	}
	for (size_t i = 0; i < n; i++) {
		sw_write_in(s, NULL, (writing){.what = W_UNPLACE, .id = fid, .name = names[i]});
		free(names[i]);
	}
	if (n > 0) {
		if (tb_get(s->s.table, tb_string("attributes"), tb_string(id)) != NULL) {
			tb_del(s->s.table, tb_string("attributes"), tb_string(id));
		}
		sw_changed(s);
	}
	free(names);
	free(fid);
}

void sw_withdraw_at(sw *s, const char *id, const ch_site *site) {
	offer *o = sw_live_offer(s, id);
	const ch_site *was = sw_enter(s, site);
	if (o == NULL || o->gone) {
		unlist(s, id);
		sw_leave(s, was);
		return;
	}
	// its name out of its folder and its attributes out, then its scope torn down: what runs on it
	// stopped "withdrawn"
	o->why = s->reasons[R_WITHDRAWN];
	sw_write_in(s, o->scope, (writing){.what = W_UNPLACE, .id = o->folder->id, .name = o->name});
	if (tb_get(s->s.table, tb_string("attributes"), tb_string(o->id)) != NULL) {
		tb_del(s->s.table, tb_string("attributes"), tb_string(o->id));
	}
	free(sc_teardown(o->scope));
	sw_leave(s, was);
}
