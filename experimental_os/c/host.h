// host.h: the host (host.c), as the OS's thread (os.c) runs it: a turn for
// the records that came, and how long it may sleep when none come; and what
// it gives the drivers and loaders built into ermineOS.

#ifndef ERMOS_HOST_H
#define ERMOS_HOST_H

#include "os.h"

#include "../../core/graph/c/ermine.h"
#include "../../core/scheduler/c/schedule.h"

typedef struct Host Host;

/** the card, the stack, /hw from the device tree, what boots; NULL if it cannot */
Host *hostBoot(const ErmosConfig *config);
/** one turn: these records (JSON text, oldest first), then what is due */
void hostTurn(Host *host, const char *const *records, int count);
/** µs until the host wants a turn though no record comes; -1: not until one does */
int64_t hostWait(Host *host);
/** whether it is still running: false once it has powered off */
bool hostRunning(Host *host);
/** closes the connection and lets everything go */
void hostOff(Host *host);

// for drivers and loaders

/** the config the OS was started with: the frame buffers, the planes, the folders */
const ErmosConfig *hostConfig(Host *host);
/** the device tree */
Json *hostTree(Host *host);
/** a command to the metal, METAL.md's */
void hostCommand(Host *host, const Json *command);
/** µs on the metal's clock, the clock records' "at" counts */
int64_t hostNow(Host *host);
/** asks for a turn at that µs on hostNow's clock, as a driver's timer does; the earliest asked wins */
void hostWake(Host *host, int64_t at);
/** a line to the OS's log */
void hostSay(Host *host, const char *format, ...) __attribute__((format(printf, 2, 3)));
/** an operation as host code, with that agent (NULL: the machine's), through the scheduler; *out what its ok holds */
ErmErr hostDo(Host *host, Json *agent, const char *op, Json *fields, Json **out);
/** an operation as the machine on the keeper, beneath protect, the wrapper and the scheduler: the host's own bookkeeping, never committed */
ErmErr hostBare(Host *host, const char *op, Json *fields, Json **out);

/**
 * a plane: pixels a driver keeps in its own memory, w × h, rows stride
 * pixels apart, for a layer {"plane": {"source", "id", "serial"}} to show
 * without them going through the graph (drv_display.c's render)
 */
typedef struct HostPlane {
	const uint32_t *bits;
	int w, h, stride;
} HostPlane;
typedef bool (*HostPlaneFn)(void *data, int64_t id, HostPlane *out);
/** a source of planes, by name: fn gives plane id, false when there is none; called on the OS's thread only */
void hostPlanes(Host *host, const char *source, HostPlaneFn fn, void *data);
/** plane id of that source: false when there is none */
bool hostPlane(Host *host, const char *source, int64_t id, HostPlane *out);

#endif
