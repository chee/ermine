// drivers.h: the drivers built into ermineOS, by name, and the runner that runs
// a driver program (/drivers/<name>, its value {name}).

#ifndef ERMOS_DRIVERS_H
#define ERMOS_DRIVERS_H

#include "host.h"

#include "../../../ermine/programs/c/host.h"

/** a driver's setup, NULL if ermineOS has none of that name */
ap_fn *driverSetup(Host *host, const char *name);
/** the driver runner (ermine/programs' hf_runner): code {name}, the process's api (api.h's ap_api); data the host */
hf_run driverRun(const op_value *code, void *api, void *data);

/** vram plane id's memory, held until vramDrop(*ref) (drv_vram.c); NULL when there is none */
uint32_t *vramHold(int64_t id, size_t *bytes, void **ref);
void vramDrop(void *ref);
/** at power off: every plane's shared memory unlinked (drv_vram.c), every VNC connection closed
 * (drv_vnc.c), the shell's socket closed (drv_sock.c) */
void vramStop(void);
void vncStop(void);
void sockStop(void);

#endif
