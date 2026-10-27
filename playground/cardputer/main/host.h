// the host: one ermine (ermine/system: a scheduler, a table, places at the root "root") and the
// processes started in it, each at /programs/<name> with the process api (es_*). what it asks to run
// later (its pulse) is run by host_settle. the same on the Cardputer and on the Mac (sim.c).
#ifndef HOST_H
#define HOST_H

#include "ermine/system/c/ermine.h"

#include "ermine/processes/c/scopes.h"
#include "ermine/sites/c/sites.h"

#define HOST_ROOT "root"

// a program: the process's setup, run once with its scope open (es_program's shape)
typedef es_program host_program;

// the world, for what runs beside the processes (the den). places: the ermine's, seen with the
// den's trie of other dens ("away") beside the processes' rows
typedef struct {
	sc_scheduler *s;
	tb_table *table;
	pl *places;
	sn *scopes;
	st_sites *sites;
	sc_scope *host;
	void (*schedule)(void *ctx, void (*f)(void *), void *data);
	es_ermine *ermine;
	// the host's own (process 0)
	es_context *context;
} host_world;
host_world host_get(void);
// a pulse, at the next host_settle (one however many ask)
void host_pulse_soon(void);

void host_init(void);
// a process named name running program (ctx given to it); its context (never freed: processes
// don't stop). NULL: not started
es_context *host_start(const char *name, host_program program, void *ctx);
// the same at /<folder>/<name> (the menu's: /system/menu), its folder /<folder>
es_context *host_start_at(const char *name, const char *folder, host_program program, void *ctx);
// what was asked to run later, till none is asked for
void host_settle(void);

#endif
