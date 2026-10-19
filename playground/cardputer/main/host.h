// the host: one world (a scheduler, a table, places at the root "R") and the processes started in
// it, each at /programs/<name> with the process api. what the api asks to run later (its pulse)
// is run by host_settle. the same on the Cardputer and on the Mac (sim.c).
#ifndef HOST_H
#define HOST_H

#include "ermine/api/c/api.h"

typedef int (*host_program)(api *a);

void host_init(void);
// a process named name running program; its api, the host's (never freed: processes don't stop)
api *host_start(const char *name, host_program program);
// what the api asked to run later, till none is asked for
void host_settle(void);

#endif
