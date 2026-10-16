// libermine.h: ermineOS's ABI for C
// programs, on core (../exec.c says the ABI). A program the exec loader
// starts has the OS at the other end of fd 3. It asks for core's
// operations, what a JavaScript program's part is given (PROGRAMS.md), as its
// process, with ermDo:
//
//   Erm *erm = ermOpen();
//   Json *v = ermGet(erm, ermPath("/", "dev", "clock", "wall", NULL));
//
// Values are core's (ermine/encoding/c/json.h). What a call is given
// (an address, a value, fields) is taken: let go of by the call. What it
// gives back is the caller's, to jsonFree or free when done. The
// conveniences are kit.ts's (val, idAt, make, drop, whole), each a call or
// two over ermDo.

#ifndef LIBERMINE_H
#define LIBERMINE_H

#include "../../../../ermine/encoding/c/json.h"

#include <stdbool.h>
#include <stdint.h>

typedef struct Erm Erm;

/** the program's end of the OS: fd ERMINE_FD, or 3, a socket; or "in,out", two pipes; NULL when there is none */
Erm *ermOpen(void);

/**
 * An operation, as the program's process: look, lookup, lookups, content,
 * children, info, node, write, set, insert, remove, pop, rename, move,
 * create, start, call, handler, here, kill (../exec.c), with its fields (a
 * map, taken; cause in it: the op's changes carry it). The answer's value,
 * or NULL with *error the OS's {code, message}. Events that come meanwhile
 * wait for ermWait.
 */
Json *ermDo(Erm *erm, const char *op, Json *fields, Json **error);

/** a handler's function: what its caller gave (a list), called from ermWait, as the program's process */
typedef void (*ErmEvent)(Erm *erm, const Json *args, void *data);
/** f as <process>/on/<name>, a handler anyone may call: its address, or NULL with *error */
Json *ermHandler(Erm *erm, const char *name, ErmEvent f, void *data, Json **error);
/** waits up to ms (-1: as long as it takes) for an event, calling each that came; false once the OS is gone */
bool ermWait(Erm *erm, int ms);

// conveniences

/** an address: its names, then NULL */
Json *ermPath(const char *first, ...);
/** the value at the address: the first item with versions, its first not a status; NULL if none */
Json *ermGet(Erm *erm, Json *address);
/** the id of the first loaded node at the address: fresh, or NULL */
char *ermIdAt(Erm *erm, Json *address);
/** the value at the address written whole; false with *error */
bool ermPut(Erm *erm, Json *address, Json *value, Json **error);
/** the node at address/name, made holding value (ephemeral: going with this process) if none is there: its id, fresh, or NULL with *error */
char *ermMake(Erm *erm, Json *address, const char *name, Json *value, bool ephemeral, Json **error);
/** the node id (NULL: the first) in the list name of the node at address let go; false with *error */
bool ermDrop(Erm *erm, Json *address, const char *name, const char *id, Json **error);
/** the process's node, ["/", ...] */
Json *ermHere(Erm *erm);

// video memory (/dev/vram: ../drv_vram.c)

/** a plane: pixels the compositor shows, mapped here; bits w × h, 0x00RRGGBB, rows stride pixels apart */
typedef struct ErmPlane {
	uint32_t *bits;
	int w, h, stride;
	int64_t id, serial;
} ErmPlane;

/** a plane w × h, /dev/vram/planes/<name>, this process's while it runs, once the driver has made it (it waits up to 2 s); NULL with *error */
ErmPlane *ermPlane(Erm *erm, const char *name, int w, int h, Json **error);
/** what a layer holds as its "plane" to show it: {source: "vram", id, serial} */
Json *ermPlaneValue(const ErmPlane *plane);
/** x, y, w × h of the plane was drawn: the layer at the address (taken) shows it (its plane's serial one more, and dirty); false with *error */
bool ermDrawn(Erm *erm, ErmPlane *plane, Json *layer, int x, int y, int w, int h, Json **error);

#endif
