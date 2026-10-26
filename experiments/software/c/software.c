// software (software.h), in C. the parts made into one: its setup, its owners, what it lists, and
// its end. the rules are in the parts: offers.c, run.c, over common.c
#include "common.h"

sw *sw_new(const sw_setup *setup) {
	sw *s = sw_xalloc(sizeof *s);
	s->s = *setup;
	s->reasons[R_WITHDRAWN] = op_str(SW_WITHDRAWN);
	s->reasons[R_RUNNER] = op_str(SW_RUNNER_STOPPED);
	// its own processes, under setup.scope
	s->life = pr_new(&(pr_setup){.scheduler = setup->scheduler, .table = setup->table,
		.places = setup->places, .scopes = setup->scopes, .commit = setup->commit,
		.commit_ctx = setup->commit_ctx, .sites = setup->sites, .runs = setup->runs,
		.owner = setup->scope, .site = sw_site_of, .site_ctx = s, .id = setup->id, .id_ctx = setup->id_ctx});
	return s;
}

// owners ---------------------------------------------------------------------------------------------

// a place's scope going: its owner out of the standing ones (a later one of the id is new)
static char *place_gone(void *data) {
	owner *o = data;
	DROP(o->sw->places, o->sw->nplaces, o);
	return NULL;
}

// a process run here is its own owner; any other place, one made the first time, gone with its scope
owner *sw_owner_of(sw *s, const sw_place *by) {
	if (by->id == NULL) return NULL;
	owner *run = sw_find(s, by->id);
	if (run != NULL && !run->ended) return run;
	for (size_t i = 0; i < s->nplaces; i++) {
		owner *o = s->places[i];
		if (strcmp(o->id, by->id) == 0 && sc_scope_alive(o->scope)) return o;
	}
	if (by->scope == NULL || !sc_scope_alive(by->scope)) return NULL;
	owner *o = sw_xalloc(sizeof *o);
	o->sw = s;
	o->id = sw_xdup(by->id);
	o->nat = by->nat;
	o->at = sw_copy_names(by->at, by->nat);
	o->stored = by->stored != 0;
	o->scope = by->scope;
	o->under = by->scope;
	o->nfolder = by->nat > 0 ? by->nat - 1 : 0;
	o->folder = sw_copy_names(by->at, o->nfolder);
	PUSH(s->all, s->nall, s->capall, o);
	PUSH(s->places, s->nplaces, s->capplaces, o);
	sw_holder(s, o);
	free(sc_register_teardown(s->s.scheduler, by->scope, place_gone, o));
	return o;
}

// lists ----------------------------------------------------------------------------------------------

size_t sw_running(sw *s, sw_process *const **out) {
	sc_track(s->s.scheduler, &s->version);
	*out = s->running;
	return s->nrunning;
}

size_t sw_offers(sw *s, const sw_offered *const **out) {
	sc_track(s->s.scheduler, &s->version);
	if (s->nlive > s->caplisting) {
		s->caplisting = s->nlive;
		s->listing = realloc(s->listing, s->caplisting * sizeof *s->listing);
		if (s->listing == NULL) abort();
	}
	for (size_t i = 0; i < s->nlive; i++) s->listing[i] = &s->live[i]->facts;
	*out = (const sw_offered *const *)s->listing;
	return s->nlive;
}

static op_value *with_refused(const char *why) {
	op_value *m = op_map();
	op_set(m, "refused", op_str(why));
	return m;
}

op_value *sw_refusal_value(const sw_refusal *r) {
	op_value *m = with_refused(r->refused);
	const char *k = r->refused;
	if (strcmp(k, "not-a-runner") == 0) {
		op_set(m, "runner", r->runner_id != NULL ? op_str(r->runner_id)
		                                         : sw_names_value(r->runner, r->nrunner));
	}
	else if (strcmp(k, "not-there") == 0) {
		if (r->program_has_at) op_set(m, "program", sw_names_value(r->program_at, r->nprogram_at));
		else op_set(m, "program", op_str(r->program != NULL ? r->program : ""));
	} else if (strcmp(k, "wrong-form") == 0) {
		op_value *program = op_map(), *runner = op_map();
		if (r->type != NULL) op_set(program, "type", op_str(r->type));
		if (r->api != NULL) op_set(program, "api", op_str(r->api));
		if (r->ntakes > 0) op_set(runner, "takes", sw_names_value(r->takes, r->ntakes));
		if (r->runner_api != NULL) op_set(runner, "api", op_str(r->runner_api));
		op_set(m, "program", program);
		op_set(m, "runner", runner);
	} else if (strcmp(k, "taken") == 0) op_set(m, "at", sw_names_value(r->at, r->nat));
	else if (strcmp(k, "failed") == 0) op_set(m, "error", op_str(r->error != NULL ? r->error : ""));
	return m;
}

// the end ---------------------------------------------------------------------------------------------

void sw_halt(sw *s) {
	if (s == NULL) return;
	pr_halt(s->life);
	for (size_t i = 0; i < s->nlates; i++) {
		sc_promise_free(s->lates[i]->promise);
		s->lates[i]->promise = NULL;
	}
}

// a scope's info values let go
static void free_values(op_value **values, size_t n) {
	for (size_t i = 0; i < n; i++) op_free(values[i]);
}

void sw_free(sw *s) {
	if (s == NULL) return;
	s->freeing = 1;
	// a process never stopped: its handle's stop (processes' pr_free calls its end)
	pr_free(s->life);
	// a load never let go: its close
	for (size_t i = 0; i < s->nloads; i++) {
		load *l = s->loads[i];
		if (!l->gone && l->live.close != NULL) l->live.close(l->live.data);
		free(l->key);
		op_free(l->code);
		free_values(l->values, 2);
		free(l);
	}
	free(s->loads);
	free(s->standing);
	for (size_t i = 0; i < s->nloaded; i++) free(s->loaded[i]);
	free(s->loaded);
	for (size_t i = 0; i < s->nall; i++) {
		owner *p = s->all[i];
		free(p->loads);
		for (size_t k = 0; k < p->nfolders; k++) {
			free(p->folders[k].id);
			free_values(p->folders[k].values, 2);
		}
		free(p->offers);
		free(p->id);
		if (p->at != NULL) pr_names_free(p->at, p->nat);
		if (p->folder != NULL) pr_names_free(p->folder, p->nfolder);
		op_free(p->code);
		op_free(p->reason);
		op_free(p->under_value);
		free(p->failure);
		free(p);
	}
	for (size_t i = 0; i < s->noffers; i++) {
		offer *o = s->offers[i];
		free(o->id);
		pr_names_free(o->at, o->facts.nat);
		free(o->name);
		free_values(o->values, 2);
		free(o);
	}
	for (size_t i = 0; i < s->nlives; i++) free(s->lives[i]->id), free(s->lives[i]);
	free(s->lives);
	for (size_t i = 0; i < s->nlates; i++) free(s->lates[i]);
	free(s->lates);
	sw_forget(s);
	free(s->scraps);
	free(s->all);
	free(s->places);
	free(s->running);
	free(s->offers);
	free(s->live);
	free(s->listing);
	free_values(s->reasons, 2);
	free(s);
}
