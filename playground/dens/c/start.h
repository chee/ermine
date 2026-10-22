// start (start.c): run a program on a runner. what a start asks of the program and the runner, then
// the process: started at a path, loaded live with no process, stopped, and the reasons. dn_start_at,
// dn_load_at, dn_release_at, dn_stop_at, dn_find and dn_hash_hex are dens.h's. inside the den's files
#ifndef DN_START_H
#define DN_START_H
#include "common.h"

// a process stopped with a reason: told, then where it runs torn down (its offers and what runs on
// them, its handle's stop, its scope: what its program made, its loads, the row out)
void dn_halt_process(dn *d, dn_process *p, const op_value *why);
// start's checks, then processes' start (its writes at dn_site). who: the policy's; remote: another
// den's ask
dn_process *dn_begin(dn *d, const op_value *who, int remote, const char *const *runner,
	size_t nrunner, const dn_program *program, const char *const *steps, size_t nsteps,
	const dn_options *options, dn_refusal *refused);
// asked stop on its node, a process this den started (the den's own: dn_stop_self). 1: refused
int dn_stop_as(dn *d, const op_value *who, int remote, dn_process *p, const op_value *reason,
	dn_refusal *refused);
// a start's answer: { id, at }
op_value *dn_id_at(const dn_process *p);
// the id at a path from the places' root, untracked, copied; NULL: nothing there
char *dn_resolve(pl *p, const char *const *path, size_t n);

#endif
