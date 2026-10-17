// drv.h: what the drivers built into ermineOS share, over newOS's API (api.h).
// A driver is a program /drivers/<name>, its value {name}, run by the driver
// runner (drivers.c): a setup, called once with the process's api, as any
// program is; it holds the host for what is hardware. Its handlers are nodes
// inside its own node, `on/<name>`; it is started at /dev/<device>/driver, so
// /dev/<device>/driver/on/<name> reaches them.
//
// The drivers keep the shape they had on the old core (c/drv.h): a function
// is an ErmFn, given an ErmGiven whose values are Json, answering an ErmErr.
// This kit turns that into the API's ap_fn and ap_given at the edge (PORT.md,
// Drivers in C); addresses are Json lists of names, "/" first.
//
// Every Json the kit makes or hands out is the turn's: held by the kit and let
// go at the turn's end (drvSweep). A driver borrows it; to keep it past the
// turn, or to put it in a container of its own, it jsonRefs it. What a driver
// gives the kit (a map's values, a write's value, a function's output) the kit
// takes: a fresh value becomes the turn's; the turn's stays the turn's; a value
// borrowed from elsewhere (a part of a read, one the driver keeps) is jsonRef'd
// or jsonShallow'd first (drv.c, the top).

#ifndef ERMOS_DRV_H
#define ERMOS_DRV_H

#include "host.h"

// --- lists: { T *items; int count; int capacity; }, zeroed empty, appended to with ERM_PUSH
#define ERM_LIST(T) \
	struct { \
		T *items; \
		int count; \
		int capacity; \
	}
#define ERM_PUSH(list, item) \
	do { \
		(list).items = growArray((list).items, (list).count, &(list).capacity, sizeof *(list).items); \
		(list).items[(list).count++] = (item); \
	} while (0)

// --- errors: kind ERM_OK (zero) is none
typedef enum { ERM_OK = 0, ERM_INVALID, ERM_REFUSED, ERM_THROWN } ErmErrKind;
typedef struct ErmErr {
	ErmErrKind kind;
	const char *op;
	Json *why; // {"code": c, ...details}
} ErmErr;
ErmErr ermOk(void);
ErmErr ermInvalid(const char *code);
ErmErr ermDetail(ErmErr err, const char *key, Json *value);
ErmErr ermField(const char *code, const char *field);

// --- functions and what they are given
typedef ap_api ErmPartApi;
typedef struct ErmGiven ErmGiven;
/** a function: called with what it is given, *out what it returns (NULL: nothing) */
typedef struct ErmFn {
	ErmErr (*call)(void *data, const ErmGiven *given, Json **out);
	void *data;
} ErmFn;
struct ErmGiven {
	ap_given *sc;            // what the API gave
	ErmPartApi *api;         // the part's interface
	ErmPartApi *peep;        // a compute's: untracked
	Json *self, *name;       // the process
	Json *value, *previous;  // an effect part's: previous NULL at first
	Json *args;              // a handler call's: NULL when the call gave none
	Json *killed;            // a cleanup's
};
/** the API's function for fn: made once and kept */
ap_fn *drvFn(ErmFn fn);
/** fn as a live value, as a handler's node holds it: the part running now's (else the host's) */
op_value *ermFunction(ErmFn fn);

// --- a map by text, as the old core's
typedef struct ErmMapEntry {
	const char *key;
	void *value;
} ErmMapEntry;
typedef struct ErmMap {
	ErmMapEntry *entries;
	int count, capacity;
	int *index;
	int indexSize;
} ErmMap;
void *ermMapGet(const ErmMap *map, const char *key);
bool ermMapHas(const ErmMap *map, const char *key);
void ermMapPut(ErmMap *map, const char *key, void *value);

/** the kit's host: set once, before any driver runs (drivers.c) */
void drvUse(Host *host);
Host *drvHost(void);
/** the turn's end: every Json the kit made or handed out this turn let go (hostTurn) */
void drvSweep(void);

/** an address: its parts, then NULL */
Json *drvPath(const char *first, ...);
/** the address with more parts after it: a fresh list */
Json *drvUnder(const Json *address, const char *first, ...);
/**
 * An operation through a part's interface, in the old core's request shape:
 * "place" {address, name, id?, value?, ephemeral?} and "unplace" {address,
 * name, id?} are the kit's own; any other is a word of the API's (words.h),
 * its fields the word's arguments by name: "write" {address, patches} (the
 * old core's patch shapes too), "call" {address, args?}, "start" {address,
 * program (a path, or "programs/x"), name?, data?}. Its answer, or NULL,
 * the error said in the log.
 */
Json *drvOp(const ErmPartApi *api, const char *op, Json *fields);
/** the value the address reaches, or NULL */
Json *drvRead(const ErmPartApi *api, Json *address);
/** a node's value item: {value, change: {time}} */
Json *drvItem(const ErmPartApi *api, Json *address);
/** whether a node is there */
bool drvHas(const ErmPartApi *api, Json *address);
/** writes the value whole */
void drvSnap(const ErmPartApi *api, Json *address, Json *value);
/** sets one key of a map */
void drvSet(const ErmPartApi *api, Json *address, const char *key, Json *value);
/** places an ephemeral node holding value under at, unless one is there; an entry of its id the card kept is taken again, not placed twice */
void drvMake(const ErmPartApi *api, Json *at, const char *name, const char *id, Json *value);
/** the same, holding a live value (a handler's function) */
void drvMakeLive(const ErmPartApi *api, Json *at, const char *name, const char *id, op_value *value);
/** places an ephemeral node holding value under at, without looking first */
void drvPlace(const ErmPartApi *api, Json *at, const char *name, const char *id, Json *value);
/** the names in the node the address reaches whose lists hold something */
Json *drvNames(const ErmPartApi *api, Json *address);

/** the process's own node, ["/", ...its place, its name] */
Json *drvHere(const ErmGiven *given);
/** a handler: fn in on/<name> inside here */
void drvHandler(const ErmGiven *given, Json *here, const char *name, ErmFn fn);
/** claims an irq line: its records come to here's on/irq */
void drvClaim(const ErmGiven *given, Json *here, int irq);
/** a process stopped once the part asking returns (hostKill) */
void drvKill(const char *pid);
/** a child that runs compute, and effect with each new value (effect may have no call) */
void drvChild(const ErmGiven *given, Json *here, const char *name, ErmFn compute, ErmFn effect);

/** a map: key, value, key, value, ..., NULL */
Json *drvMap(const char *key, ...);

/** base64, standard alphabet, padded: fresh text */
char *drvBase64(const uint8_t *bytes, size_t n);
/** the bytes base64 text holds: fresh, their count in *n */
uint8_t *drvUnbase64(const char *text, size_t *n);

#endif
