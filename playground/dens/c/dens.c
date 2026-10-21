// dens (dens.h), in C. the parts made into one den: its setup, and its end. the rules are in the
// parts: offers.c, start.c, policy.c, handlers.c, here.c, over common.c
#include "dens.h"

#include "common.h"
#include "here.h"
#include "start.h"

dn *dn_new_at(const dn_setup *setup, const char **error, const ch_site *site) {
	if (setup->id == NULL || !pl_is_name(setup->id)) {
		*error = pl_code_name(PL_NOT_A_NAME);
		return NULL;
	}
	dn *d = dn_xalloc(sizeof *d);
	d->s = *setup;
	d->id = dn_xdup(setup->id);
	d->s.id = d->id;
	d->name = setup->name != NULL ? dn_xdup(setup->name) : NULL;
	d->s.name = d->name;
	d->device = setup->device != NULL ? op_ref((op_value *)setup->device) : NULL;
	d->s.device = d->device;
	d->reasons[R_WITHDRAWN] = op_str(DN_WITHDRAWN);
	d->reasons[R_RUNNER] = op_str(DN_RUNNER_STOPPED);
	d->reasons[R_DEN] = op_str(DN_DEN_STOPPED);
	d->pending = op_ref(d->reasons[R_DEN]);
	d->scratch = op_num(0);
	d->owner_value = op_str(d->id);
	d->owner_info = (sc_pair){"den", d->owner_value};
	d->self = dn_xalloc(sizeof *d->self);
	d->self->den = d;
	d->self->self = 1;
	PUSH(d->all, d->nall, d->capall, d->self);
	d->site = site;
	ch_site buf;
	const ch_site *here = dn_site(d, &buf);
	const char *file = here != NULL ? here->file : NULL, *func = here != NULL ? here->function : NULL;
	int line = here != NULL ? (int)here->line : 0;
	d->owner = sc_create_scope(setup->scheduler, &d->owner_info, 1, NULL);
	if (d->owner == NULL) {
		*error = SC_UNSCOPED;
		d->self->ended = 1;
		dn_free(d);
		return NULL;
	}
	if (setup->sites != NULL && file != NULL) st_note(setup->sites, d->owner, file, line, func);
	d->life = pr_new_at(&(pr_setup){.scheduler = setup->scheduler, .table = setup->table,
		.places = setup->places, .scopes = setup->scopes, .commit = setup->commit,
		.commit_ctx = setup->commit_ctx, .sites = setup->sites, .runs = setup->runs, .owner = d->owner,
		.site = dn_site_of, .site_ctx = d},
		file, line, func);
	op_value *attrs = op_map();
	op_set(attrs, DN_ATTRIBUTE, op_str(DN_TYPE_DEN));
	op_set(attrs, DN_ID, op_str(d->id));
	if (d->name != NULL) op_set(attrs, DN_NAME, op_str(d->name));
	if (d->device != NULL) op_set(attrs, DN_DEVICE, op_ref(d->device));
	const char *at[3] = {dn_dens[0], dn_dens[1], d->id};
	pr_refusal no;
	pr_process *life = pr_start_at(d->life, setup->places, at, 3,
		&(pr_options){.body = dn_den_body, .stop = dn_den_end, .data = d->self, .attributes = attrs}, &no,
		file, line, func);
	op_free(attrs);
	if (life == NULL || d->here_failed) {
		free(sc_teardown(d->owner));
		d->site = NULL;
		if (life != NULL) *error = pl_code_name(d->here_failed);
		else if (strcmp(no.refused, "taken") == 0) *error = pl_code_name(PL_ALREADY_THERE);
		else *error = no.refused;
		d->self->ended = 1;
		pr_halt(d->life);
		dn_free(d);
		return NULL;
	}
	d->site = NULL;
	return d;
}

// the den's stop: the den's own here's, any other start's
int dn_stop_at(dn *d, dn_process *p, const op_value *reason, dn_refusal *refused,
	const ch_site *site) {
	dn_forget(d);
	const ch_site *was = dn_enter(d, site);
	op_value *who = pl_change_base(d->s.places, NULL, 0);
	int r = p != NULL && p == d->self ? dn_stop_self(d, who, 0, reason, refused)
	                                  : dn_stop_as(d, who, 0, p, reason, refused);
	op_free(who);
	dn_leave(d, was);
	return r;
}

// the end ---------------------------------------------------------------------------------------------

void dn_halt(dn *d) {
	if (d != NULL) pr_halt(d->life);
}

// a scope's info values let go
static void free_values(op_value **values, size_t n) {
	for (size_t i = 0; i < n; i++) op_free(values[i]);
}

void dn_free(dn *d) {
	if (d == NULL) return;
	d->freeing = 1;
	// a process never stopped: its handle's stop (processes' pr_free calls its end)
	pr_free(d->life);
	// a load never let go: its close
	for (size_t i = 0; i < d->nloaded; i++) {
		dn_loaded *l = d->loaded[i];
		if (!l->released && l->live.close != NULL) l->live.close(l->live.data);
		free(l);
	}
	free(d->loaded);
	for (size_t i = 0; i < d->nall; i++) {
		dn_process *p = d->all[i];
		free(p->loads);
		for (size_t k = 0; k < p->nfolders; k++) {
			free(p->folders[k].id);
			free_values(p->folders[k].values, 2);
		}
		free(p->offers);
		free(p->id);
		if (p->at != NULL) pr_names_free(p->at, p->nat);
		op_free(p->code);
		op_free(p->reason);
		op_free(p->under_value);
		free(p->failure);
		free(p);
	}
	for (size_t i = 0; i < d->noffers; i++) {
		offer *o = d->offers[i];
		free(o->id);
		pr_names_free(o->at, o->nat);
		free(o->name);
		free_values(o->values, 2);
		free(o);
	}
	for (size_t k = 0; k < 3; k++) {
		free(d->on_ids[k]);
		free_values(d->on_values[k], 2);
	}
	dn_forget(d);
	free(d->scraps);
	free(d->all);
	free(d->running);
	free(d->offers);
	free(d->live);
	free_values(d->reasons, 3);
	op_free(d->pending);
	op_free(d->scratch);
	op_free(d->owner_value);
	op_free(d->device);
	free(d->name);
	free(d->id);
	free(d);
}
