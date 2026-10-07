// ermine.h: the graph's types and its interface (../CORE.tex), and the
// protocol's encodings of them (../PROTOCOL.tex). NOTES.md has the readings
// the papers leave open.
//
// MEMORY. Nothing is freed during a session, and nothing shared is changed:
//   a Json, change, id, name or list, once stored or handed on, lives until
//   exit, so a pointer to it can be kept without copying. A write builds the
//   node's new value by copying only the containers along each patch's path,
//   and swaps the node's pointer.
//
// IDS AND NAMES are C text: UTF-8 with U+0000 held as C0 80 (json.h). Test
//   equality with strcmp; order them with textCompare (code point order).
//
// ERRORS. Every operation returns an ErmErr; kind ERM_OK (zero) is success,
//   and only then is its result filled in. An error's why is
//   {"code": c, ...details}, with PROTOCOL's codes. A layer leaves op NULL;
//   whoever reports the error names the operation. An operation that fails
//   changes nothing.
//
// NO RECURSION. Walks, patches and encodings loop, and json.c keeps its own
//   stacks, so nothing here grows the C stack with the data.

#ifndef ERMINE_H
#define ERMINE_H

#include "json.h"

#include <stdbool.h>
#include <stdint.h>

// lists: { T *items; int count; int capacity; }, zeroed empty, appended to with ERM_PUSH

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

// A change's time: a whole number from 1 to 2^53-1 (PROTOCOL Encodings),
// held exactly in a double; 0: none. A time alone names a change in a graph:
// it is the change's reference (CORE Changes).
typedef double ErmTime;

#define ERM_LAST_TIME 9007199254740991.0 // 2^53-1

/** ids or names */
typedef ERM_LIST(const char *) ErmIds;

// errors (PROTOCOL Errors) -----------------------------------------------------

typedef enum {
	ERM_OK = 0,
	ERM_INVALID, // the graph or an interface rejected it
	ERM_REFUSED, // a wrapper said no
} ErmErrKind;

typedef struct ErmErr {
	ErmErrKind kind;
	const char *op; // the operation, when there was one; NULL from a layer
	Json *why;      // {"code": c, ...details}
} ErmErr;

ErmErr ermOk(void);
/** invalid, with why {"code": code} */
ErmErr ermInvalid(const char *code);
/** the error with one more detail in its why */
ErmErr ermDetail(ErmErr err, const char *key, Json *value);
/** {"kind": k, "op": s?, "why": why} */
Json *ermErrToJson(ErmErr err);

// places and addresses (CORE Paths; PROTOCOL Encodings) -------------------------

/** a place: names from the graph's root; the first `chroot` are hidden, and the node they reach is its start, its "/" */
typedef struct ErmPlace {
	ErmIds names;
	int chroot;
} ErmPlace;

/** an address's parts: an optional first "/", then `ups` "..", then names */
typedef struct ErmAddress {
	bool fromStart;
	int ups;
	ErmIds names;
} ErmAddress;

/** whether the text may be a name: anything but ".", ".." and "/" */
bool ermIsName(const char *text);
/** false when the value is not a list of parts that make an address */
bool ermAddressFrom(Json *parts, ErmAddress *out);
/** false when the value is not a list of names */
bool ermNamesFrom(Json *list, ErmIds *out);

// items (CORE Reads are lists, From; PROTOCOL Encodings) ------------------------

/** one name walked: the slot (parent, name), the member taken and its place among the slot's ids */
typedef struct ErmStep {
	const char *parent;
	const char *name;
	const char *node;
	int position;
} ErmStep;

typedef ERM_LIST(ErmStep) ErmRoute;

typedef struct ErmChange ErmChange;

/** a value, or an id in a slot or found by a lookup, and why the reader got it; or a lookup's refused search */
typedef struct ErmItem {
	Json *value;             // a value's item; NULL for an id's
	const char *id;          // an id's item
	bool pending;            // the id's node is not here yet
	bool ephemeral;          // its node is here and ephemeral
	bool refused;            // last in a lookup a refused directory read ended: from.path is `ups` ".."
	ErmRoute route;          // from.route: the walk that reached it (not a lookup's)
	int ups;                 // a lookup's: from.path is `ups` "..", then `name`; -1 for any other
	const char *name;        // a lookup's: the name it looked up
	int position;            // from.position: its place in its slot; -1 for a value's
	const ErmChange *change; // the change that last set that value, or the last that was not ephemeral to that slot; NULL: none
} ErmItem;

typedef ERM_LIST(ErmItem) ErmItems;

/** one name of a directory listing, and its slot's items: of every member, for a union */
typedef struct ErmEntry {
	const char *name;
	ErmItems items;
} ErmEntry;

typedef ERM_LIST(ErmEntry) ErmListing;

/** [item] */
Json *ermItemsToJson(const ErmItems *items);
/** [[name, [item]]] */
Json *ermListingToJson(const ErmListing *listing);

// changes (CORE Changes; PROTOCOL Changes) --------------------------------------

typedef enum { ERM_WRITE, ERM_PLACE, ERM_UNPLACE } ErmChangeKind;

struct ErmChange {
	const char *node; // the node it changed; for a placement, the parent
	ErmTime time;
	ErmChangeKind kind;
	Json *patches;       // write: the patches as given
	const char *name;    // place, unplace: the slot
	const char *id;      // place, unplace
	bool hasPosition;    // place: whether a position was given
	int64_t position;    // place
	Json *value;         // place: the new node's value, when the placement made it; NULL otherwise
	Json *agent;         // any value
	const char *process; // NULL: made from outside any process
	Json *cause;         // NULL: none (a JSON null is a cause)
	bool ephemeral;      // it changes an ephemeral node, or places or unplaces one
};

/** change references: their times */
typedef ERM_LIST(ErmTime) ErmTimes;

/**
 * {"node","time","kind",...the kind's fields,"agent","process"?,"cause"?,"ephemeral"?};
 * an item's header has no patches and no placement's value
 */
Json *ermChangeToJson(const ErmChange *change, bool header);

// acting (CORE Operations, bind) -----------------------------------------------

typedef enum {
	ERM_READ_WRITE, // requests from outside
	ERM_READ_ONLY,  // its reads are remembered for marking, inside a run
	ERM_WRITE_ONLY,
} ErmMode;

/** who acts, at which place and how: fixed for an interface */
typedef struct ErmCtx {
	Json *agent;         // any value
	const char *process; // NULL: no process
	ErmPlace place;      // where addresses and lookups start
	ErmMode mode;
	int64_t run; // 0, or the tag of the run a recording set
} ErmCtx;

/** what a change carries besides its ctx */
typedef struct ErmStamp {
	Json *cause;  // NULL: none
	ErmTime time; // from a clock outside the graph
} ErmStamp;

// operations (CORE Operations) -------------------------------------------------

typedef enum {
	ERM_OP_READ,
	ERM_OP_DIRECTORY,
	ERM_OP_LOOKUP,
	ERM_OP_WRITE,
	ERM_OP_PLACE,
	ERM_OP_UNPLACE,
} ErmOpKind;

/** one operation; fields its kind does not use are zero */
typedef struct ErmOp {
	ErmOpKind kind;
	ErmAddress address; // all but lookup
	const char *name;   // directory (NULL: every name), lookup, place, unplace
	const char *id;     // place, unplace
	bool hasPosition;   // place
	int64_t position;   // place: a gap in the slot, from 0
	Json *value;        // place: NULL when none was given
	bool ephemeral;     // place with a value: the node it makes is ephemeral
	Json *patches;      // write: a list
} ErmOp;

/** "read", "directory", "lookup", "write", "place", "unplace" */
const char *ermOpName(ErmOpKind kind);
bool ermOpIsChange(ErmOpKind kind);

/** a process a change marked, and the first change that marked it: the change's own, or one its letting go made */
typedef struct ErmMark {
	const char *process;
	ErmTime by;
} ErmMark;

typedef ERM_LIST(ErmMark) ErmMarks;

/** what an operation answers: zero it first; filled only on ERM_OK */
typedef struct ErmResult {
	ErmItems items;     // read, lookup, directory with a name
	ErmListing listing; // directory without a name
	ErmChange *change;  // write, place, unplace
	ErmMarks marked;    // write, place, unplace: the processes it marked, in code point order, each once
	ErmIds gone;        // write, place, unplace: the ephemeral nodes it let go, in the order they went
} ErmResult;

/** {"change": c, "marked": [{"process": id, "by": t}], "gone": [id]?} */
Json *ermChangeAnswer(const ErmResult *result);

// the interface (CORE Running and wrapping) --------------------------------------

/**
 * called with each change a subscription receives, as it applies: `reaches`
 * is what reading its address gives just after a change to its route, and
 * NULL for a change to the node it reaches
 */
typedef void (*ErmEventFn)(void *data, const ErmChange *change, const ErmItems *reaches);

typedef struct ErmVtable ErmVtable;

/** one layer of a stack: a vtable over an opaque self; a wrapper keeps the layer below and passes on what it does not change */
typedef struct ErmInterface {
	const ErmVtable *vt;
	void *self;
} ErmInterface;

/** an interface bound to a ctx */
typedef struct ErmApi {
	ErmInterface iface;
	ErmCtx ctx;
} ErmApi;

typedef struct ErmRecording ErmRecording;
typedef struct ErmRecord ErmRecord;

typedef enum { ERM_DONE, ERM_PENDING, ERM_FAILED, ERM_REFUSED_ENDING } ErmEnding;

struct ErmVtable {
	/** fills *out on ERM_OK */
	ErmErr (*op)(void *self, const ErmCtx *ctx, const ErmStamp *stamp, const ErmOp *op, ErmResult *out);
	/** follows the address from the ctx's place; *sub numbers the subscription, from 1 */
	ErmErr (*subscribe)(void *self, const ErmCtx *ctx, const ErmAddress *address, ErmEventFn fn, void *data, int64_t *sub);
	ErmErr (*unsubscribe)(void *self, const ErmCtx *ctx, int64_t sub);
	/** CORE forget(id): drops the reads kept for that process, so nothing marks it any more */
	void (*forget)(void *self, const char *process);
	/** the graph as storing it and loading it again would leave it (PROTOCOL reload): ephemeral nodes and changes, subscriptions and kept reads dropped */
	void (*reload)(void *self);
	/** CORE record(api, changes): an api that passes everything to `api` and logs it, for one run marked by `marked` */
	ErmRecording *(*record)(void *self, ErmApi api, const ErmTimes *marked);
	/** CORE finish: ends the run; its reads replace the process's last run's */
	ErmRecord *(*finish)(void *self, ErmRecording *recording, ErmEnding ending);
	/** told the top of the stack once it is built; keep it, and pass it on below */
	void (*setTop)(void *self, ErmInterface top);
};

/** one operation a run made, and what it was answered */
typedef struct ErmLogged {
	ErmOp op;
	ErmErr err;
	ErmResult result; // when err is ERM_OK
} ErmLogged;

/** CORE Record, as the graph keeps it: what marked the run, what it did in order, how it ended */
struct ErmRecord {
	const char *process;
	Json *agent;
	ErmTimes marked;
	ERM_LIST(ErmLogged) log;
	ErmEnding ending;
};

struct ErmRecording {
	ErmApi api; // logs into record; answers invalid (code stopped) once ended
	ErmRecord record;
	int64_t tag;
	bool ended;
};

ErmApi ermBind(ErmInterface iface, ErmCtx ctx);
ErmErr ermApiOp(ErmApi api, const ErmStamp *stamp, const ErmOp *op, ErmResult *out);

/** graph.c: a graph made with its root, whose value is null */
ErmInterface ermGraph(const char *root);
/** graph.c, for a host holding the bare graph ermGraph made: the latest time in it, 0 for none (CORE What the graph holds) */
ErmTime ermGraphLast(ErmInterface graph);
/**
 * graph.c, for a scheduler's bookkeeping beneath the wrappers (SCHEDULER
 * Ephemeral nodes): unplaces the ephemeral node `id` from its one slot,
 * needing no address, as an unplace op at its parent would, letting it go;
 * nothing-there when no ephemeral node of that id is here
 */
ErmErr ermGraphLetGo(ErmInterface graph, const ErmCtx *ctx, const ErmStamp *stamp, const char *id, ErmResult *out);

// a string map ---------------------------------------------------------------------
// Keys are copied; values are yours. Entries 0..count-1 are in insertion
// order. Nothing is ever removed.

typedef struct ErmMapEntry {
	const char *key;
	void *value;
} ErmMapEntry;

typedef struct ErmMap {
	ErmMapEntry *entries;
	int count;
	int capacity;
	int *index; // open addressing over entries, -1 empty
	int indexSize;
} ErmMap;

void *ermMapGet(const ErmMap *map, const char *key);
bool ermMapHas(const ErmMap *map, const char *key);
void ermMapPut(ErmMap *map, const char *key, void *value);

#endif
