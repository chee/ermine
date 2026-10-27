// start's stop (start.h): what its scope's teardown throws is given back, as start.ts' stop
// rethrows it. make test-start-processes (and its -check, with the sanitizers)
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../core/places/c/places.h"
#include "../../../core/scheduler/c/paths.h"
#include "../../../core/scheduler/c/scheduler.h"
#include "../../../core/table/c/table.h"
#include "processes.h"
#include "scopes.h"
#include "start.h"

#define CHECK(x) \
	do { \
		if (!(x)) { \
			fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #x); \
			exit(1); \
		} \
	} while (0)

static sc_scheduler *s;

static char *boom(void *data) {
	(void)data;
	char *e = malloc(5);
	CHECK(e != NULL);
	strcpy(e, "boom");
	return e;
}

static void body(pr_process *p, void *data) {
	(void)data;
	sc_register_teardown(s, pr_scope(p), boom, NULL);
}

static pl *places;
static tb_table *table;
static sn *scopes;
static pr *life;

static void run(void *data) {
	(void)data;
	life = pr_new(&(pr_setup){.scheduler = s, .table = table, .places = places, .scopes = scopes});
	static const char *const at[1] = {"p"};
	pr_refusal no;
	pr_process *p = pr_start(life, places, at, 1, &(pr_options){.body = body}, &no);
	CHECK(p != NULL);
	// the teardown's error comes back, to be freed; the process is stopped all the same
	char *error = pr_stop(life, p);
	CHECK(error != NULL && strcmp(error, "boom") == 0);
	free(error);
	CHECK(!sc_scope_alive(pr_scope(p)));
	// twice: nothing
	CHECK(pr_stop(life, p) == NULL);
}

int main(void) {
	places = pl_new();
	s = sc_new((sc_options){0});
	sc_on_tracking_end(s, pl_forget, places);
	table = tb_make(pl_event, places);
	pt_paths *paths = pt_new();
	pr_processes rows;
	pr_processes_init(&rows, tb_string("R"));
	const pl_contributor *walk[2] = {&rows.contributor, &pl_children};
	pl_connect(places, &(pl_setup){.root = tb_string("R"), .table = table, .paths = paths,
		.scheduler = s, .contributors = walk, .ncontributors = 2});
	sc_pair info = {"actor", op_str("host")};
	sc_scope *host = sc_create_root_scope(s, &info, 1);
	scopes = sn_new(s, table);
	sc_run_with_scope(host, run, NULL);
	pr_halt(life);
	sc_free(s);
	tb_free(table);
	pt_free(paths);
	pl_free(places);
	pr_free(life);
	sn_free(scopes);
	op_free((op_value *)info.value);
	puts("ok");
	return 0;
}
