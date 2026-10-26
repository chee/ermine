// clingy (clingy.h)
#include "clingy.h"

#include <stdlib.h>

#include "../../../core/scheduler/c/ptrmap.h"

struct cl_clingy {
	sc_listener *on_start, *on_end;
	void (*go)(const void *key, void *data);
	void *data;
	// each key added: its value tracked (a run tracks it now), or NULL
	pm keys;
};

static char tracked;

static void started(const void *key, sc_run *run, void *data) {
	(void)run;
	cl_clingy *c = data;
	if (pm_has(&c->keys, key)) pm_set(&c->keys, key, &tracked);
}

static void ended(const void *key, void *data) {
	cl_clingy *c = data;
	if (!pm_has(&c->keys, key)) return;
	pm_set(&c->keys, key, NULL);
	c->go(key, c->data);
}

cl_clingy *cl_new(sc_scheduler *s, void (*go)(const void *key, void *data), void *data) {
	cl_clingy *c = calloc(1, sizeof *c);
	if (c == NULL) abort();
	c->go = go;
	c->data = data;
	c->on_start = sc_on_tracking_start(s, started, c);
	c->on_end = sc_on_tracking_end(s, ended, c);
	return c;
}

void cl_free(cl_clingy *c) {
	if (c == NULL) return;
	sc_remove_listener(c->on_start);
	sc_remove_listener(c->on_end);
	pm_clear(&c->keys);
	free(c);
}

void cl_add(cl_clingy *c, const void *key) {
	if (!pm_has(&c->keys, key)) pm_set(&c->keys, key, NULL);
}
bool cl_has(const cl_clingy *c, const void *key) { return pm_has(&c->keys, key); }
bool cl_tracked(const cl_clingy *c, const void *key) { return pm_get(&c->keys, key) == &tracked; }
void cl_drop(cl_clingy *c, const void *key) { pm_delete(&c->keys, key); }
