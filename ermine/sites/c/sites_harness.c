// The C sites (sites.h) on the line protocol of typescript/sites_harness.ts, which documents it
// (conformance/c/harness.h has the loop). One scheduler and its sites last for the process; scopes
// by name. Only whether a site is there and how long a chain is are told: where in the code is the
// language's own. a frame alone is named like a scope; its parent may be either.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../conformance/c/harness.h"
#include "sites.h"

static sc_scheduler *scheduler;
static st_sites *sites;
static struct {
	char *name;
	sc_scope *scope;
	// the frame: a scope's own, or one made alone
	sc_frame *frame;
} *named;
static size_t count, capacity;
static const sc_pair info[] = {{"owner", "test"}};

void hh_start(void) {
	scheduler = sc_new((sc_options){0});
	sites = st_new(scheduler);
}

void hh_finish(void) {
	// frames alone first: a scope's own goes with the scheduler
	for (size_t i = 0; i < count; i++) sc_free_frame(named[i].frame);
	st_free(sites);
	sc_free(scheduler);
	for (size_t i = 0; i < count; i++) free(named[i].name);
	free(named);
}

static sc_scope *find(const char *name) {
	for (size_t i = 0; name != NULL && i < count; i++)
		if (strcmp(named[i].name, name) == 0) return named[i].scope;
	return NULL;
}

// a scope's own frame or a frame alone
static sc_frame *find_frame(const char *name) {
	for (size_t i = 0; name != NULL && i < count; i++)
		if (strcmp(named[i].name, name) == 0) return named[i].frame;
	return NULL;
}

static void keep_frame(const char *name, sc_scope *scope, sc_frame *frame) {
	if (count == capacity) {
		capacity = capacity ? capacity * 2 : 16;
		named = realloc(named, capacity * sizeof *named);
		if (named == NULL) abort();
	}
	named[count].name = strdup(name);
	named[count].scope = scope;
	named[count++].frame = frame;
}

static void keep(const char *name, sc_scope *scope) { keep_frame(name, scope, sc_scope_frame(scope)); }

static char *nothing_set(void *value, void *data) {
	(void)value, (void)data;
	return NULL;
}
static char *nothing_effect(void *value, void *previous, void *data) {
	(void)value, (void)previous, (void)data;
	return NULL;
}
// what every computer and effect reads
static const char key = 0;
static sc_out one(void *previous, void *data) {
	(void)previous, (void)data;
	sc_track(scheduler, &key);
	return (sc_out){.kind = SC_VALUE};
}

typedef struct {
	const char *kind;
	int wrapped;
	sc_scope *made;
} make;

static void make_computer(void *data) {
	make *m = data;
	int effect = strcmp(m->kind, "effect") == 0;
	sc_def def = {.f = one, .set = effect ? NULL : nothing_set, .effect = effect ? nothing_effect : NULL};
	if (m->wrapped) m->made = effect ? st_create_effect(sites, def, NULL, 0) : st_create_computer(sites, def, NULL, 0);
	else m->made = effect ? sc_create_effect(scheduler, def, NULL, 0) : sc_create_computer(scheduler, def, NULL, 0);
}

void hh_answer(const op_value *r, FILE *out) {
	const char *op = hh_str(r, "op");
	const char *name = hh_str(r, "name");
	const op_value *w = op_get(r, "wrapped");
	int wrapped = w == NULL || w->type != OP_BOOL || w->bool_;
	if (op == NULL) {
		hh_unknown(out, r);
		return;
	}
	if (strcmp(op, "root") == 0 || strcmp(op, "scope") == 0 || strcmp(op, "computer") == 0 ||
	    strcmp(op, "effect") == 0) {
		if (name == NULL) {
		hh_error(out, "%s: no name", op);
		return;
	}
		sc_scope *parent = find(hh_str(r, "parent"));
		sc_scope *made;
		if (strcmp(op, "root") == 0) {
			made = wrapped ? st_create_root_scope(sites, info, 1)
			               : sc_create_root_scope(scheduler, info, 1);
		} else if (strcmp(op, "scope") == 0) {
			made = wrapped ? st_create_scope(sites, info, 1, parent)
			               : sc_create_scope(scheduler, info, 1, parent);
		} else {
			if (parent == NULL) {
		hh_error(out, "%s: no parent", op);
		return;
	}
			make m = {op, wrapped, NULL};
			sc_run_with_scope(parent, make_computer, &m);
			made = m.made;
		}
		if (made == NULL) {
		hh_error(out, "%s: not made", op);
		return;
	}
		keep(name, made);
		fputs("{}", out);
	} else if (strcmp(op, "frame") == 0) {
		if (name == NULL) {
			hh_error(out, "frame: no name");
			return;
		}
		sc_frame *up = find_frame(hh_str(r, "parent"));
		if (up == NULL) {
			hh_error(out, "frame: no parent");
			return;
		}
		sc_frame *made = wrapped ? st_create_frame(sites, info, 0, up) : sc_create_frame(scheduler, info, 0, up);
		keep_frame(name, NULL, made);
		fputs("{}", out);
	} else if (strcmp(op, "note") == 0) {
		sc_frame *f = find_frame(name);
		if (f == NULL) {
			hh_error(out, "note: no %s", name ? name : "");
			return;
		}
		st_note_frame(sites, f, __FILE__, __LINE__, __func__);
		fputs("{}", out);
	} else if (strcmp(op, "rerun") == 0) {
		sc_pulse(scheduler);
		const void *keys[] = {&key};
		sc_mark(scheduler, keys, 1, NULL);
		sc_pulse(scheduler);
		fputs("{}", out);
	} else if (strcmp(op, "site") == 0) {
		sc_frame *o = find_frame(name);
		if (o == NULL) {
			hh_error(out, "site: no %s", name ? name : "");
			return;
		}
		const st_site *site = st_site_of(sites, o);
		fprintf(out, "{\"site\":%s}", site != NULL && site->file != NULL && site->line > 0 ? "true" : "false");
	} else if (strcmp(op, "chain") == 0) {
		sc_frame *o = find_frame(name);
		if (o == NULL) {
			hh_error(out, "chain: no %s", name ? name : "");
			return;
		}
		fprintf(out, "{\"length\":%zu}", st_sites_of(sites, o, NULL, 0));
	} else {
		hh_unknown(out, r);
	}
}
