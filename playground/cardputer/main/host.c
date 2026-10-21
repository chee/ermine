// the host (host.h), as ermine/api/c/api_harness.c's world: places at the root "root" asked
// [processes("root"), away("root"), children] (dens_test.ts' world: other dens' things mirrored in),
// a host scope, a "programs" scope under it, a scope a process. any mark that makes something due
// asks for a pulse, soon (the page's soon())
#include "host.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ermine/processes/c/processes.h"
#include "ermine/processes/c/scopes.h"
#include "ermine/sites/c/sites.h"
#include "playground/dens/c/away.h"

static struct {
	sc_scheduler *s;
	tb_table *table;
	pt_paths *paths;
	pl *places;
	sn *scopes;
	st_sites *sites;
	pr_processes rows, away;
	const pl_contributor *walk[3];
	int pulsing;
	sc_scope *host, *above;
	sc_pair host_info, above_info;
	api_context *apis;
	struct {
		void (*f)(void *);
		void *data;
	} *queue;
	size_t qn, qcap, qhead;
} w;

static void schedule(void *ctx, void (*f)(void *), void *data) {
	(void)ctx;
	if (w.qn == w.qcap) {
		w.qcap = w.qcap ? w.qcap * 2 : 16;
		w.queue = realloc(w.queue, w.qcap * sizeof *w.queue);
		if (w.queue == NULL) abort();
	}
	w.queue[w.qn].f = f, w.queue[w.qn].data = data, w.qn++;
}

void host_settle(void) {
	while (w.qhead < w.qn) {
		size_t i = w.qhead++;
		w.queue[i].f(w.queue[i].data);
	}
	w.qn = w.qhead = 0;
}

static void pulse_now(void *data) {
	(void)data;
	w.pulsing = 0;
	sc_pulse(w.s);
	free(sc_escaped(w.s));
}

void host_pulse_soon(void) {
	if (w.pulsing) return;
	w.pulsing = 1;
	schedule(NULL, pulse_now, NULL);
}

static void marked(const void *const *keys, size_t nkeys, sc_run *run, sc_computer *const *due, size_t ndue,
	uint64_t tick, void *data) {
	(void)keys, (void)nkeys, (void)run, (void)due, (void)tick, (void)data;
	if (ndue > 0) host_pulse_soon();
}

static void commit(void *ctx, const pl_changed *changed) {
	(void)ctx;
	pl_commit(w.places, changed);
}

host_world host_get(void) {
	return (host_world){w.s, w.table, w.places, w.scopes, w.sites, w.host, schedule};
}

void host_init(void) {
	w.s = sc_new((sc_options){.drop = api_drop});
	w.places = pl_new();
	w.table = tb_make(pl_event, w.places);
	w.paths = pt_new();
	pr_processes_init(&w.rows, tb_string(HOST_ROOT));
	dn_away_init(&w.away, tb_string(HOST_ROOT));
	w.walk[0] = &w.rows.contributor, w.walk[1] = &w.away.contributor, w.walk[2] = &pl_children;
	pl_connect(w.places, &(pl_setup){.root = tb_string(HOST_ROOT), .table = w.table, .paths = w.paths,
		.scheduler = w.s, .contributors = w.walk, .ncontributors = 3});
	sc_on_tracking_end(w.s, pl_forget, w.places);
	sc_on_mark(w.s, marked, NULL);
	w.scopes = sn_new(w.s, w.table);
	w.sites = st_new(w.s);
	w.host_info = (sc_pair){"actor", op_str("cardputer")};
	w.host = st_create_root_scope(w.sites, &w.host_info, 1);
	w.above_info = (sc_pair){"role", op_str("programs")};
	w.above = st_create_scope(w.sites, &w.above_info, 1, w.host);
	w.apis = api_context_new(&(api_setup){.scheduler = w.s,
		.table = w.table,
		.places = w.places,
		.commit = commit,
		.schedule = schedule,
		.sites = w.sites,
		// no run records: the heap is for the den, WiFi and TLS (none of this device reads them)
		.no_runs = 1});
}

typedef struct {
	const char *const *at;
	size_t nat;
	const char *id;
	int code;
} row;

// the process's row at its path, under the root
static void add_row(void *data) {
	row *r = data;
	ch_header h;
	pl_made *made;
	char *bad = pl_header(w.places, NULL, 0, NULL, &h, &made);
	if (bad) {
		fprintf(stderr, "host: %s\n", bad);
		free(bad);
		r->code = API_FAILED;
		return;
	}
	pl_changed changed = {0};
	nd_entry *node = NULL;
	r->code = pr_add(w.places, w.table, tb_string(HOST_ROOT), r->at, r->nat, tb_string(r->id), h, &changed, &node);
	if (r->code) {
		pl_made_free(made);
		return;
	}
	pl_commit(w.places, &changed);
	for (size_t i = 0; i < changed.n; i++) pl_hold_also(w.places, changed.entries[i], pl_made_ref(made), pl_made_free);
	if (node) pl_hold(w.places, node, made, pl_made_free);
	else pl_made_free(made);
}

typedef struct {
	api *a;
	host_program program;
	int code;
} running;
static void run(void *data) {
	running *r = data;
	r->code = r->program(r->a);
}

api *host_start(const char *name, host_program program) {
	// kept for the process's life, which is the device's
	char **at = calloc(2, sizeof *at);
	at[0] = strdup("programs"), at[1] = strdup(name);
	op_value *where = op_list();
	op_push(where, op_str(at[0]));
	op_push(where, op_str(at[1]));
	// its id first, then its scope {process: at, PL_NODE: id}: its writes' metadata stops there
	char want[64];
	snprintf(want, sizeof want, "proc:%s", name);
	const char *id = strdup(want);
	sc_pair *info = malloc(2 * sizeof *info);
	info[0] = (sc_pair){"process", where};
	info[1] = (sc_pair){PL_NODE, op_str(id)};
	sc_scope *scope = st_create_scope(w.sites, info, 2, w.above);
	sn_give(w.scopes, scope, id);
	api_process *p = malloc(sizeof *p);
	*p = (api_process){id, (const char *const *)at, 2, (const char *const *)at, 1, NULL, 0, scope};
	row r = {p->at, p->nat, id, 0};
	sc_run_with_scope(scope, add_row, &r);
	if (r.code) fprintf(stderr, "host: %s not placed: %s\n", name, pl_code_name(r.code));
	api *a = api_new(w.apis, &(api_starting){.process = *p});
	running x = {a, program, 0};
	sc_run_with_scope(scope, run, &x);
	if (x.code) fprintf(stderr, "host: %s: %s %s\n", name, api_code_name(x.code), api_why(a));
	host_settle();
	return a;
}
