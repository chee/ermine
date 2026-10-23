// host.h: ermineOS's host on today's core (host.c; PORT.md), as the OS's
// thread (os.c) runs it, and what it gives the drivers and runners built in.

#ifndef ERMOS_HOST_H
#define ERMOS_HOST_H

#include "api.h"
#include "os.h"
#include "val.h"

typedef struct Host Host;

/** the graph, the card, the image, /hw from the device tree, what boots; NULL if it cannot */
Host *hostBoot(const ErmosConfig *config);
/** one turn: these records (JSON text, oldest first), then what is due */
void hostTurn(Host *host, const char *const *records, int count);
/** µs until the host wants a turn though no record comes; -1: not until one does */
int64_t hostWait(Host *host);
/** whether it is still running: false once it has powered off */
bool hostRunning(Host *host);
/** lets everything go */
void hostOff(Host *host);

// for drivers and runners

/** the graph newOS's API is over (api.h) */
ap_os *hostOs(Host *host);
/** the card */
Card *hostCard(Host *host);
/** the connection to /etc/sync's server (net.c) */
struct Net *hostNet(Host *h);
/** the config the OS was started with: the frame buffers, the planes, the folders */
const ErmosConfig *hostConfig(Host *host);
/** the device tree */
Json *hostTree(Host *host);
/** a command to the metal, METAL.md's */
void hostCommand(Host *host, const Json *command);
/** µs on the metal's clock, the clock records' "at" counts */
int64_t hostNow(Host *host);
/** asks for a turn at that µs on hostNow's clock; the earliest asked wins */
void hostWake(Host *host, int64_t at);
/** stops a process (start.h's ps_stop), once the part asking has returned */
void hostKill(Host *host, const char *pid);
/** the process at an address stopped and started again at its path, as its program's node holds it now */
const ap_error *hostRestart(Host *host, const char *const *address, size_t n);
/** a fresh id for a process, or an ephemeral node: "@" and a number, local */
const char *hostPid(Host *host);
/** calls the handler at address (from the root) at that µs on hostNow's clock, as the machine, with no args */
void hostAfter(Host *host, int64_t at, Json *address);
/** a line to the OS's log */
void hostSay(Host *host, const char *format, ...) __attribute__((format(printf, 2, 3)));
/** an error said in the log, with what was being done: true if there was one */
bool hostFailed(Host *host, const ap_error *error, const char *doing);

/** memory for this turn: let go of at its end */
void *hostTemp(Host *host, size_t n);
char *hostTempDup(Host *host, const char *text);
/** an address: names from the root, then NULL; *n its length. For this turn (hostTemp) */
const char *const *hostPath(Host *host, size_t *n, const char *first, ...);
/** a Json list of names as an address, for this turn (hostTemp); NULL if it is not one */
const char *const *hostPathOf(Host *host, const Json *names, size_t *n);
/** the first loaded item at an address through api: NULL if none */
const ap_item *hostLook(ap_api *api, const char *const *address, size_t n);
/** the value at an address through api: its first version not a status; NULL if none */
const op_value *hostRead(ap_api *api, const char *const *address, size_t n);
/** what a program is given: newOS's API, for its process, made by its runner from software's start facts (sw_starting) */
ap_api *hostApi(Host *host, const void *start);
/** a node holding value made and placed at parent (an id) as name; its id, NULL on an error said */
const char *hostPut(Host *host, ap_api *api, const char *parent, const char *name, const op_value *value, bool ephemeral);
/** the value at an address written whole; an error if nothing is there */
const ap_error *hostSnap(ap_api *api, const char *const *address, size_t n, const op_value *value);

/** a process's own node as an address, ["/", ...its place, its name]; NULL if not known */
Json *hostHere(Host *host, const char *pid);

/** a plane: pixels in shared memory, w × h, rows stride pixels apart */
typedef struct HostPlane {
	const uint32_t *bits;
	int w, h, stride;
} HostPlane;
/**
 * what a plane's node says. A source's planes are the nodes under /dev/<source>/planes, each
 * valued {id, w, h, stride?, shm | file, offset?}: shm the POSIX shared memory's name, or file a
 * file's path, the pixels offset bytes into it. A reader finds a plane there, by its id, and maps it.
 */
typedef struct HostPlaneSaid {
	char name[256];
	bool file;
	size_t offset;
	int w, h, stride;
} HostPlaneSaid;
/** the plane with that id among /dev/<source>/planes, as its node says it; false when none says it */
bool hostPlaneSaid(Host *host, const char *source, int64_t id, HostPlaneSaid *out);
/** its memory mapped, read and write, the whole object (*bytes its size); NULL when it cannot be */
void *hostPlaneMap(const HostPlaneSaid *plane, size_t *bytes);
void hostPlaneUnmap(void *mapping, size_t bytes);
/** the compositor's: plane id of that source, read from its node, mapped while the node says the same memory; false when there is none. On the OS's thread only */
bool hostPlane(Host *host, const char *source, int64_t id, HostPlane *out);

#endif
