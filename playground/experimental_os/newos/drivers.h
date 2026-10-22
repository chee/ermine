// drivers.h: the drivers built into ermineOS, by name (drivers.c's table), and the runner that
// runs a driver program (/drivers/<name>, its value {name}).

#ifndef ERMOS_DRIVERS_H
#define ERMOS_DRIVERS_H

#include "host.h"

#include "../../../experiments/software/c/functions.h"

/** a driver's setup, NULL if ermineOS has none of that name */
ap_fn *driverSetup(Host *host, const char *name);
/** the driver runner (ermine/programs' hf_runner): code {name}, the process's api (api.h's ap_api); data the host */
hf_run driverRun(const op_value *code, void *api, void *data);

/** at power off: each driver's stop, where it has one (its shared memory unlinked, its connections closed) */
void driversStop(void);

#endif
