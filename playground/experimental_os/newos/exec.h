// exec.h: the exec runner: programs of type party.chee.ermine.exec, their
// value {argv}, each a Mac process of its own that speaks the ABI on its fd 3,
// as libermine does (exec.c).

#ifndef ERMOS_EXEC_H
#define ERMOS_EXEC_H

#include "host.h"

#include "../../../playground/build/c/host.h"

/** the exec programs' irq line: a program's frames or lines came, or it exited */
#define EXEC_IRQ 60

/** the exec runner (ermine/programs' hf_runner): code {argv}, the process's api (api.h's ap_api); data the host */
hf_run execRun(const op_value *program, void *api, void *data);
/** the records of EXEC_IRQ, oldest first, on the host's turn */
void execRecords(Host *host, const Json *records);
/** power off: every program ended, and reaped */
void execStop(Host *host);

#endif
