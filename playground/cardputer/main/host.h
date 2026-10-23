// the host: one world (a scheduler, a table, places at the root "R") and the processes started in
// it, each at /programs/<name> with the process api. what the api asks to run later (its pulse)
// is run by host_settle. the same on the Cardputer and on the Mac (sim.c).
#ifndef HOST_H
#define HOST_H

#include "ermine/api/c/api.h"

#include "ermine/processes/c/scopes.h"
#include "ermine/sites/c/sites.h"

#define HOST_ROOT "root"

typedef int (*host_program)(api *a);

// the world, for what runs beside the processes (the den)
typedef struct {
	sc_scheduler *s;
	tb_table *table;
	pl *places;
	sn *scopes;
	st_sites *sites;
	sc_scope *host;
	void (*schedule)(void *ctx, void (*f)(void *), void *data);
} host_world;
host_world host_get(void);
// a pulse, at the next host_settle (one however many ask)
void host_pulse_soon(void);

void host_init(void);
// a process named name running program; its api, the host's (never freed: processes don't stop)
api *host_start(const char *name, host_program program);
// the same at /<folder>/<name> (the menu's: /system/menu), its working folder /<folder>
api *host_start_at(const char *name, const char *folder, host_program program);
// what the api asked to run later, till none is asked for
void host_settle(void);

#endif
