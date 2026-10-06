// ermine.h: the core's types, the interface every layer implements, the
// program seam between drive.c and program.c, the driver's extras, and the
// protocol's encodings. Owner: the skeleton (done). Do not change a type or
// a signature here on your own: three agents code against it in parallel.
// You may add static helpers in your own file.
//
// Spec: ../CORE.tex (the design) and ../PROTOCOL.tex (the harness contract).
// NOTES.md says who owns which file and repeats the conventions below.
//
// ===========================================================================
// CONVENTIONS EVERY FILE KEEPS
//
// MEMORY. Nothing is freed during a session, and nothing shared is changed.
//   Every Json, ErmChange, ErmRecord, id string and list that has been
//   returned, stored or handed on is immutable and lives as long as the
//   process. So a pointer, once you have it, stays valid: store it without
//   copying. To "change" a node's value the graph builds a new Json
//   (jsonClone, then patch the clone) and swaps its pointer. Main never
//   frees a parsed request (the graph may hold parts of it); it frees only
//   the printed answer string. jsonFree is for scratch that never escaped.
//
// ABSENT is NULL: a NULL `Json *` value, a NULL process, a NULL name. A time
//   of 0 means "none" (absent node, null saw): real times start at 1.
//
// IDS AND NAMES are `const char *` UTF-8 with U+0000 as C0 80 (jsonText). Test
//   equality with strcmp; order them with textCompare (code point order).
//
// ARGUMENTS ARE RAW JSON. An ErmOp carries `Json *` exactly as the caller had
//   it (a request field, or what a program expression evaluated to). The
//   GRAPH decodes them (jsonText, ermPathFrom, ermPatchesFrom, jsonIsWhole)
//   and answers invalid for a bad one, so a bad id from a program fails in
//   the graph and the error comes back up through every layer and the run's
//   recording. Main rejects only a request missing a required field.
//
// ERRORS. Every operation returns an ErmErr; kind ERM_OK (zero) is success,
//   and only then is the result filled in. ERM_INVALID: the graph rejected it
//   (also a closed interface, a mode violation, an ended run). ERM_REFUSED: a
//   wrapper said no; the wrapper does not call the layer below. An operation
//   that fails changes nothing. An error a LAYER returns has op == NULL; the
//   op name is added by whoever reports it: the recording logs
//   {kind, op: ermOpName(op), why}; program.c builds a caught/thrown value
//   the same way. ERM_THROWN is only made by program.c (a throw step, an
//   operator given the wrong value). `why` is a Json: a string for
//   invalid/refused, any value for a throw step's message.
//
// TIME. Below drive, main passes the request's "time" in ErmStamp.time (0
//   when not given); the graph rejects 0 or a time not greater than every
//   time already in the graph as invalid. With drive, drive.c overwrites
//   stamp.time with last+1 on every change op passing through it; a failed
//   op uses up no time. Sites and causes are stored as given; changes made
//   by processes carry no site (drive/program pass site NULL).
//
// MODES (ErmCtx.mode). Outside requests and driver housekeeping:
//   ERM_READ_WRITE. A compute: ERM_READ_ONLY (make/write/place/unplace are
//   invalid). An effect, the driver's value write, cleanups and handlers
//   (the lasting interface): ERM_WRITE_ONLY (read/data/directory/lookup are
//   invalid). The GRAPH enforces modes, so these errors land in records.
//
// REMEMBERED READS (marking). The graph remembers a read (of a value, a
//   slot, or a whole directory; lookups remember each slot they search) only
//   when ctx.mode == ERM_READ_ONLY, ctx.process != NULL and ctx.run is the
//   CURRENT run tag of ctx.process. Only a recording sets ctx.run. So below
//   drive nothing is remembered and "marked" is always []. Starting a
//   recording with a READ_ONLY api replaces that process's remembered reads
//   with an empty set under the new tag.
//
// WHAT MARKS WHAT (CORE Changes). A make or write of node n marks the
//   readers of n's value; a make of n also the readers of n's directory or
//   any slot of it (they read it absent). A place/unplace in parent p under
//   name s marks readers of slot (p, s) and of p's whole directory. A change
//   never marks ctx.process. Marked ids are in code point order. A data read is
//   not remembered (fixed data never changes).
//
// WRAPPERS STACK (graph <- protect <- drive). A layer is an ErmInterface: a
//   vtable over an opaque self. A wrapper keeps the ErmInterface below it and
//   implements every vtable entry; what it does not change it passes on by
//   calling the same entry of the inner interface with the same arguments.
//   Every layer passes setTop on to the layer below it.
//
// THE TOP OF THE STACK. Once main has built the stack it calls
//   top.vt->setTop(top.self, top) exactly once; each layer keeps it.
//   Operations a layer makes for others enter at the top so they pass every
//   wrapper: the graph's lookup reads each slot it searches with
//   top.vt->op(top.self, ctx, &noStamp, directory(node, name)) using the
//   lookup's own ctx (so protect can refuse one; the graph then ends the
//   search, does not remember that directory, and lists it as refused);
//   drive binds every run's interfaces, its value writes and its lasting
//   interfaces from the top. Drive is also given the BARE graph ("beneath"):
//   its tree walk, its data reads of process nodes, and reading a process's
//   value to compare go there with ermHostCtx(), beneath protect.
//
// RECORDING (CORE record/finish). top.vt->record(top.self, api, run, marked)
//   (wrappers pass it down; the graph implements it) returns an
//   ErmRecording whose `api` is api with ctx.run set to a fresh tag, behind
//   an interface that LOGS every operation into rec->record, in order:
//     read ok      -> reads       += {node, saw: result.time}
//     directory ok -> directories += {node, name or NULL, saw: result.time}
//     lookup ok    -> lookups     += {name, searched, found}
//     change ok    -> changes     += ermRefOf(change)
//     any error    -> errors      += {kind, op: ermOpName(op), why}
//   (data ok logs nothing.) rec->quiet acts the same (same ctx and tag, so
//   the graph remembers its reads for marking) but logs nothing: drive reads
//   the program slots and program nodes through it and reports them itself in
//   rec->record.compute / .effect. rec->with(rec, other) returns `other`
//   wrapped to log into this same run, with other.ctx.run = tag: drive uses it
//   for the effect's api and the value write, so their changes land in
//   rec->record.changes in order. Drive sets compute, effect, value and
//   cleanup in rec->record directly (it is a plain struct). finish(rec,
//   ending) sets the ending, ends the run (every api of the recording then
//   answers invalid "the run has ended"), sends {record} to the subscribers
//   of the process node, and returns &rec->record.
//
// DRIVE INTERCEPTS (drive.c). drive's op: a read-like op passes straight to
//   the inner interface. A change op gets stamp.time = last+1, goes to the
//   inner interface, and on success: last = change time; every id in
//   result.applied.marked becomes due (or adds the change to its due marks);
//   the tree is walked (starting/stopping processes). Then, unless drive is
//   already running rounds or inside a batch, it runs rounds until nothing
//   is due, and returns the original result. Finished records and stops are
//   collected for ermDriverTake, which main calls after every request.
//
// ===========================================================================

#ifndef ERMINE_H
#define ERMINE_H

#include "json.h"

#include <stdbool.h>
#include <stdint.h>

// lists ------------------------------------------------------------------------
// Every list is { T *items; int count; int capacity; }, zero-initialised
// empty, appended to with ERM_PUSH. Lists that have been handed on are
// immutable like everything else: copy (push into a new list) to change.

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

typedef int64_t ErmTime; // a change's time, from 1; 0 is "none"
/** a stamp's time when the request gave none (below drive); the graph refuses it as "a change needs a time" */
#define ERM_NO_TIME INT64_MIN

/** ids, in slot order or code point order as the place says */
typedef ERM_LIST(const char *) ErmIds;

bool ermIdsHas(const ErmIds *ids, const char *id);
/** sorts in place, strcmp (code point) order */
void ermIdsSort(ErmIds *ids);
Json *ermIdsToJson(const ErmIds *ids);

// errors (PROTOCOL Lines; Records "errors") ------------------------------------

typedef enum {
	ERM_OK = 0,
	ERM_INVALID, // the graph rejected it
	ERM_REFUSED, // a wrapper said no
	ERM_THROWN,  // program.c only: a throw step, or an operator given the wrong value
} ErmErrKind;

typedef struct ErmErr {
	ErmErrKind kind;
	const char *op; // the operation's name, when there was one; NULL from a layer (see ERRORS)
	Json *why;      // a string for invalid/refused; any value for a throw step
} ErmErr;

typedef ERM_LIST(ErmErr) ErmErrs;

ErmErr ermOk(void);
ErmErr ermInvalid(const char *format, ...) __attribute__((format(printf, 1, 2)));
ErmErr ermRefused(const char *format, ...) __attribute__((format(printf, 1, 2)));
/** takes the why */
ErmErr ermThrown(Json *why);
/** the same error with op set */
ErmErr ermWithOp(ErmErr err, const char *op);
/** "invalid", "refused", "thrown" ("ok" for ERM_OK) */
const char *ermErrKindText(ErmErrKind kind);
/** {"kind": k, "op": s?, "why": w}: an answer's "error", a record's error, a caught value, a fire's "error" */
Json *ermErrToJson(ErmErr err);

// paths (CORE Path; PROTOCOL Encodings) ----------------------------------------

typedef struct ErmStep {
	const char *parent;
	const char *name;
	const char *node;
} ErmStep;

typedef ERM_LIST(ErmStep) ErmPath;

/**
 * Decodes a path: a list of {"parent", "name", "node"}, all three text, each
 * step's parent the node of the step before; extra keys are ignored. Only
 * the shape is checked, not whether the steps exist. Invalid with a why.
 */
ErmErr ermPathFrom(Json *value, ErmPath *out);
Json *ermPathToJson(const ErmPath *path);

// patches (CORE Patches) -------------------------------------------------------

typedef enum { ERM_SNAPSHOT, ERM_SPLICE, ERM_SET } ErmPatchType;

typedef struct ErmPatch {
	ErmPatchType type;
	Json *path;       // splice, set: a list of keys, each a string or a whole number >= 0 (checked)
	int64_t from, to; // splice: whole numbers >= 0 (from <= to is NOT checked here: the graph's)
	Json *key;        // set: the key, a string (may hold NUL)
	Json *value;      // snapshot: the value; splice, set: the value or NULL (delete)
} ErmPatch;

typedef ERM_LIST(ErmPatch) ErmPatches;

/**
 * Decodes a write's patches: a list of patches, checking each one's SHAPE
 * (type, path of keys, range of two whole numbers >= 0, string key, value
 * present for a snapshot). Whether a patch applies to a value is the
 * graph's to check. A bad shape is invalid with a why.
 */
ErmErr ermPatchesFrom(Json *value, ErmPatches *out);
/** {"type":"snapshot","value"} | {"type":"splice","path","range":[from,to],"value"?} | {"type":"set","path","key","value"?} */
Json *ermPatchToJson(const ErmPatch *patch);

// changes (CORE Changes; PROTOCOL Encodings, Changes) --------------------------

typedef enum { ERM_MAKE, ERM_WRITE, ERM_PLACE, ERM_UNPLACE } ErmChangeKind;

typedef struct ErmChange {
	const char *node; // the node changed; for a placement, the parent
	ErmTime time;
	ErmChangeKind kind;
	Json *value;          // make: the value
	Json *data;           // make: the fixed data as the maker gave it, NULL when not given
	ErmPatches patches;   // write
	const char *name;     // place, unplace
	const char *id;       // place, unplace: the placed id
	bool hasPosition;     // place: whether a position was given
	int64_t position;     // place
	Json *agent;          // any value
	const char *process;  // NULL when made by no process
	Json *cause;          // NULL when none was given; a JSON null is a cause
	Json *site;           // NULL when none was given; stored as given
} ErmChange;

typedef ERM_LIST(ErmChange *) ErmChanges;

/** a node and a time name one change in this graph */
typedef struct ErmRef {
	const char *node;
	ErmTime time;
} ErmRef;

typedef ERM_LIST(ErmRef) ErmRefs;

ErmRef ermRefOf(const ErmChange *change);
/** {"node", "time"} */
Json *ermRefToJson(ErmRef ref);
Json *ermRefsToJson(const ErmRefs *refs);
/** {"node","time","kind",...kind's fields,"agent","process"?,"cause"?,"site"?} */
Json *ermChangeToJson(const ErmChange *change);
Json *ermChangesToJson(const ErmChanges *changes);

// acting (CORE Operations: "Every operation carries an agent, and may carry a
// process; writes also carry a time and a site, and may carry a cause.") ----

typedef enum {
	ERM_READ_WRITE, // outside requests, driver housekeeping
	ERM_READ_ONLY,  // a compute
	ERM_WRITE_ONLY, // an effect, the value write, cleanups, handlers
} ErmMode;

/** fixed by bind; passed unchanged down through every layer */
typedef struct ErmCtx {
	Json *agent;         // any value
	const char *process; // NULL: no process
	ErmPath path;        // what lookup searches; empty finds nothing
	ErmMode mode;        // whether writes (and reads) are allowed
	int64_t run;         // 0, or the run tag a recording set (never set by hand)
} ErmCtx;

/** per call, for a change; reads pass ermNoStamp() */
typedef struct ErmStamp {
	Json *cause;  // NULL: none
	Json *site;   // NULL: none
	ErmTime time; // 0: none (drive fills it in)
} ErmStamp;

ErmStamp ermNoStamp(void);
/** a request from outside: agent, process (NULL), path, READ_WRITE, run 0 */
ErmCtx ermOutsideCtx(Json *agent, const char *process, ErmPath path);
/** the driver's housekeeping: agent null, no process, no path, READ_WRITE, run 0 */
ErmCtx ermHostCtx(void);

// operations (CORE Operations) -------------------------------------------------

typedef enum {
	ERM_OP_MAKE,
	ERM_OP_READ,
	ERM_OP_DATA,
	ERM_OP_DIRECTORY,
	ERM_OP_LOOKUP,
	ERM_OP_WRITE,
	ERM_OP_PLACE,
	ERM_OP_UNPLACE,
} ErmOpKind;

/** one operation; fields not used by its kind are NULL. All raw JSON. */
typedef struct ErmOp {
	ErmOpKind kind;
	Json *id;       // make: the new id; place, unplace: the placed id
	Json *value;    // make
	Json *data;     // make: the fixed data, NULL when not given (the node's data is then null)
	Json *node;     // read, data, directory, write
	Json *name;     // directory (NULL: the whole directory), lookup, place, unplace
	Json *patches;  // write: the list of patches
	Json *parent;   // place, unplace
	Json *position; // place: NULL when not given
} ErmOp;

ErmOp ermOpMake(Json *id, Json *value, Json *data);
ErmOp ermOpRead(Json *node);
ErmOp ermOpData(Json *node);
ErmOp ermOpDirectory(Json *node, Json *name);
ErmOp ermOpLookup(Json *name);
ErmOp ermOpWrite(Json *node, Json *patches);
ErmOp ermOpPlace(Json *parent, Json *name, Json *id, Json *position);
ErmOp ermOpUnplace(Json *parent, Json *name, Json *id);

/** the command's name ("make", "read", "data", "directory", "lookup", "write", "place", "unplace"): protect's rule "op" and a record error's "op" */
const char *ermOpName(ErmOpKind kind);
/** the node an operation is on, for protect: the new id for a make, the parent for a placement, NULL for a lookup */
Json *ermOpNode(const ErmOp *op);
bool ermOpIsChange(ErmOpKind kind);

typedef enum { ERM_LIST_ABSENT, ERM_LIST_SLOT, ERM_LIST_WHOLE } ErmListing;

typedef struct ErmSlot {
	const char *name;
	ErmIds ids; // slot order, never empty
} ErmSlot;

typedef ERM_LIST(ErmSlot) ErmSlots;

/** one directory a lookup searched, nearest first */
typedef struct ErmSearched {
	const char *node;
	ErmTime saw;  // the node's latest change; 0: absent (null). Unused when refused.
	bool refused; // its read was refused: it is the last searched, and has no saw
} ErmSearched;

typedef ERM_LIST(ErmSearched) ErmSearchedList;

/** a change and the processes it marked: code point order, never the change's own process */
typedef struct ErmApplied {
	ErmChange *change;
	ErmIds marked;
} ErmApplied;

/**
 * What an operation answers. Zero-initialise it; the answering layer fills
 * only the fields of the op's kind, and only on ERM_OK:
 *   read:      value (NULL: absent), time (0: absent)
 *   data:      data (NULL: absent)
 *   directory: listing; slot (ERM_LIST_SLOT: the slot's ids, empty when the
 *              slot is gone); whole (ERM_LIST_WHOLE: names in code point order,
 *              slots non-empty); time (0: absent, listing ERM_LIST_ABSENT)
 *   lookup:    found (the nearest slot's ids, empty if none), searched
 *   make, write, place, unplace: applied
 */
typedef struct ErmResult {
	Json *value;
	ErmTime time;
	Json *data;
	ErmListing listing;
	ErmIds slot;
	ErmSlots whole;
	ErmIds found;
	ErmSearchedList searched;
	ErmApplied applied;
} ErmResult;

/** {"change": c, "marked": [{"process": id, "by": ref}]}: a change answer below drive (main adds runs/stopped with drive) */
Json *ermAppliedToJson(const ErmApplied *applied);

// records (CORE Records; PROTOCOL Encodings, Records) --------------------------

typedef enum { ERM_DONE, ERM_PENDING, ERM_FAILED, ERM_REFUSED_ENDING } ErmEnding;

const char *ermEndingText(ErmEnding ending); // "done" "pending" "failed" "refused"

/** a program slot of a run: the first id (used), its latest change, every id the slot held */
typedef struct ErmProgramSeen {
	const char *node;
	ErmTime saw;  // 0: absent -> {"absent": true}
	ErmIds slot;
	bool refused; // the program node's read was refused -> {"refused": true}, no saw
} ErmProgramSeen;

typedef struct ErmReadEntry {
	const char *node;
	ErmTime saw; // 0 -> null
} ErmReadEntry;

typedef struct ErmDirEntry {
	const char *node;
	const char *name; // NULL: the whole directory
	ErmTime saw;      // 0 -> null
} ErmDirEntry;

typedef struct ErmLookupEntry {
	const char *name;
	ErmSearchedList searched;
	ErmIds found;
} ErmLookupEntry;

/** every list oldest first */
typedef struct ErmRecord {
	const char *process;
	int64_t run;
	Json *agent;
	ErmRefs marked;
	bool hasCompute; // false when the compute slot is gone (or its read was refused)
	ErmProgramSeen compute;
	bool hasEffect; // false when the effect slot is gone
	ErmProgramSeen effect;
	ERM_LIST(ErmLookupEntry) lookups;
	ERM_LIST(ErmReadEntry) reads;
	ERM_LIST(ErmDirEntry) directories;
	Json *value; // what the compute returned; NULL when it returned nothing
	ErmRefs cleanup;
	ErmRefs changes; // the value write's change, if any, then the effect's
	ErmEnding ending;
	ErmErrs errors; // each with op set
} ErmRecord;

typedef ERM_LIST(ErmRecord *) ErmRecords;

Json *ermRecordToJson(const ErmRecord *record);

// events -------------------------------------------------------------------------

/** what a subscriber receives: exactly one of the two is set */
typedef struct ErmEvent {
	ErmChange *change;
	ErmRecord *record;
} ErmEvent;

/** called synchronously, as the change applies or the record finishes */
typedef void (*ErmEventFn)(void *data, const ErmEvent *event);

/** {"change": c} or {"record": r} */
Json *ermEventToJson(const ErmEvent *event);

// the interface ------------------------------------------------------------------

typedef struct ErmVtable ErmVtable;
typedef struct ErmRecording ErmRecording;

/** one layer of the stack: a vtable over an opaque self */
typedef struct ErmInterface {
	const ErmVtable *vt;
	void *self;
} ErmInterface;

/** CORE's bind(api, {agent, process, path, writes}): an interface and the ctx its holder acts as */
typedef struct ErmApi {
	ErmInterface iface;
	ErmCtx ctx;
} ErmApi;

struct ErmVtable {
	/** make, read, data, directory, lookup, write, place, unplace; fills *out on ERM_OK */
	ErmErr (*op)(void *self, const ErmCtx *ctx, const ErmStamp *stamp, const ErmOp *op, ErmResult *out);
	/**
	 * node (may be absent; one that is not text is invalid) and a callback,
	 * called with each change to the node and each record of the process
	 * that is that node. *sub is the subscription's number, from 1 in each
	 * graph.
	 */
	ErmErr (*subscribe)(void *self, const ErmCtx *ctx, Json *node, ErmEventFn fn, void *data, int64_t *sub);
	/** an unknown number is invalid */
	ErmErr (*unsubscribe)(void *self, const ErmCtx *ctx, int64_t sub);
	/** wraps a bound api (whose ctx has a process) for one run numbered `run`, marked by `marked` (copied); see RECORDING */
	ErmRecording *(*record)(void *self, ErmApi api, int64_t run, const ErmRefs *marked);
	/** sets the ending, ends the run, sends the record to the process node's subscribers, returns it */
	ErmRecord *(*finish)(void *self, ErmRecording *recording, ErmEnding ending);
	/** told the top of the stack once it is built; keep it, and pass it on below */
	void (*setTop)(void *self, ErmInterface top);
};

/** one run being recorded; made by the graph's record, ended by finish. See RECORDING. */
struct ErmRecording {
	int64_t tag;
	ErmApi api;       // logged; ctx.run = tag
	ErmApi quiet;     // same ctx; remembered for marking, not logged
	ErmRecord record; // being built; drive sets compute, effect, value, cleanup directly
	bool ended;       // set by finish
	/** `other` logged into this run, with other.ctx.run = tag */
	ErmApi (*with)(ErmRecording *recording, ErmApi other);
	void *graph; // the graph's own
};

ErmApi ermBind(ErmInterface iface, ErmCtx ctx);

// calling through an api (all wrap api.iface.vt->op with api.ctx)
ErmErr ermApiOp(ErmApi api, const ErmStamp *stamp, const ErmOp *op, ErmResult *out);
ErmErr ermApiMake(ErmApi api, const ErmStamp *stamp, Json *id, Json *value, Json *data, ErmApplied *out);
/** *value NULL: absent; *time 0: absent (either out may be NULL) */
ErmErr ermApiRead(ErmApi api, Json *node, Json **value, ErmTime *time);
/** *data NULL: absent */
ErmErr ermApiData(ErmApi api, Json *node, Json **data);
ErmErr ermApiDirectory(ErmApi api, Json *node, Json *name, ErmResult *out);
ErmErr ermApiLookup(ErmApi api, Json *name, ErmResult *out);
ErmErr ermApiWrite(ErmApi api, const ErmStamp *stamp, Json *node, Json *patches, ErmApplied *out);
ErmErr ermApiPlace(ErmApi api, const ErmStamp *stamp, Json *parent, Json *name, Json *id, Json *position, ErmApplied *out);
ErmErr ermApiUnplace(ErmApi api, const ErmStamp *stamp, Json *parent, Json *name, Json *id, ErmApplied *out);

// the layers' constructors -------------------------------------------------------

/** graph.c: CORE The core. A fresh, empty bare graph. */
ErmInterface ermGraph(void);

/** protect.c: may(agent, process, op, node): yes or no. `node` is ermOpNode (NULL for a lookup), or the subscription's node. */
typedef bool (*ErmMay)(void *data, Json *agent, const char *process, const char *op, Json *node);

/** one of protect's rules: {"agent"?, "process"?, "op"?, "node"?, "allow"} (PROTOCOL The reference protect) */
typedef struct ErmRule {
	Json *agent, *process, *op, *node; // NULL: not given (matches anything)
	bool allow;
} ErmRule;

typedef ERM_LIST(ErmRule) ErmRules;

/** protect.c: the reset's "rules" (NULL: none, allow everything); invalid when not a list of objects with a boolean allow */
ErmErr ermRulesFrom(Json *rules, ErmRules *out);
/** protect.c: an ErmMay whose data is an ErmRules *: the first rule whose given fields all equal (jsonEqual) the operation's wins; none: allowed */
bool ermMayFromRules(void *rules, Json *agent, const char *process, const char *op, Json *node);
/** protect.c: CORE protect. Asks may before every op (each lookup's directory read arrives as its own op through the top), subscribe and unsubscribe; refuses without passing on. */
ErmInterface ermProtect(ErmInterface inner, ErmMay may, void *mayData);

// programs: the loader seam between drive.c and program.c ------------------------

/** what a compute is given (PROTOCOL Variables: self, path, changes) */
typedef struct ErmComputeIn {
	ErmApi api; // read-only, recorded (rec->api)
	const char *self;
	ErmPath path;
	ErmChanges changes; // the changes that marked the run, oldest first; the variable holds ermChangesToJson
} ErmComputeIn;

typedef enum { ERM_RETURNED, ERM_WENT_PENDING, ERM_THREW } ErmComputeKind;

typedef struct ErmComputeOut {
	ErmComputeKind kind;
	Json *value;  // ERM_RETURNED: the value (a compute that ends without return returns null)
	ErmErr threw; // ERM_THREW: the uncaught error (kind REFUSED: the run ends refused; else failed)
} ErmComputeOut;

/** what an effect is given (PROTOCOL Variables: self, value, previous) */
typedef struct ErmEffectIn {
	ErmApi api; // write-only, recorded into the same run (rec->with)
	const char *self;
	Json *value;
	Json *previous; // NULL: absent (the first run since the process started)
} ErmEffectIn;

/** handler or cleanup steps; run with the process's lasting interface */
typedef struct ErmHandler {
	void *self;
	/** lasting: bound from the top, agent = the process's agent, process = it, its path, WRITE_ONLY, run 0. input NULL: absent (always for a cleanup). Returns the uncaught error, or ERM_OK. */
	ErmErr (*run)(void *self, ErmApi lasting, const char *process, Json *input);
} ErmHandler;

typedef struct ErmNamedHandler {
	const char *name;
	ErmHandler handler;
} ErmNamedHandler;

typedef struct ErmEffectOut {
	ErmErr threw; // ERM_OK, or the uncaught error
	/** registered during the effect, in order (a later one of a name replaces an earlier and the process's existing one); those before an uncaught throw still count */
	ERM_LIST(ErmNamedHandler) handlers;
	bool hasCleanup;
	ErmHandler cleanup; // the last cleanup step run
} ErmEffectOut;

/** a loaded program: the same steps, run as a compute or as an effect according to the slot */
typedef struct ErmProgram {
	void *self;
	ErmComputeOut (*compute)(void *self, const ErmComputeIn *in);
	ErmEffectOut (*effect)(void *self, const ErmEffectIn *in);
} ErmProgram;

/** a program node's value to a program; invalid (with a why) when the value is not a list of steps */
typedef ErmErr (*ErmLoader)(Json *value, ErmProgram *out);

/** program.c: the test program language (PROTOCOL Programs as data) */
ErmErr ermLoadProgram(Json *value, ErmProgram *out);

// the driver (drive.c; PROTOCOL The reference driver, Commands) ------------------

typedef struct ErmDriver ErmDriver;

/** a process the walk no longer reached, and the changes its cleanup made */
typedef struct ErmStopped {
	const char *process;
	ErmChanges changes;
} ErmStopped;

/** what finished since the last take: records in the order finished; stops in the order decided */
typedef struct ErmRan {
	ErmRecords runs;
	ERM_LIST(ErmStopped) stopped;
} ErmRan;

/** a fire's handler: the changes it made, in order, and its uncaught error (ERM_OK: none) */
typedef struct ErmFired {
	ErmChanges changes;
	ErmErr error;
} ErmFired;

/**
 * drive(inner, root, load). `inner` is the stack below (protect);
 * `beneath` is the bare graph under it, for the driver's own bookkeeping.
 * `root` names the root node (it may be absent).
 */
ErmDriver *ermDrive(ErmInterface inner, ErmInterface beneath, const char *root, ErmLoader load);
/** the drive layer: the top of the stack */
ErmInterface ermDriverInterface(ErmDriver *driver);
/** holds rounds: change ops only queue what they marked (nests) */
void ermDriverBatchBegin(ErmDriver *driver);
/** ends a batch; at the outermost end, runs rounds until nothing is due */
void ermDriverBatchEnd(ErmDriver *driver);
/**
 * Runs `process`'s handler `handler` with its lasting interface, outside any
 * run, then runs what it marked. `ctx` is the requester's (fire acts as no
 * process). Invalid when the process is not running or has no such handler.
 */
ErmErr ermDriverFire(ErmDriver *driver, const ErmCtx *ctx, const char *process, const char *handler, Json *input, ErmFired *out);
/** takes and clears what finished since the last take */
ErmRan ermDriverTake(ErmDriver *driver);

// a string map ---------------------------------------------------------------------
// Keys are copied; values are yours. Iterate entries 0..count-1 in insertion
// order, skipping dead ones. Removing marks an entry dead; putting the key
// again appends a new entry.

typedef struct ErmMapEntry {
	const char *key;
	void *value;
	bool live;
} ErmMapEntry;

typedef struct ErmMap {
	ErmMapEntry *entries;
	int count;
	int capacity;
	int *index; // open addressing over entries, -1 empty
	int indexSize;
	int live;
} ErmMap;

void *ermMapGet(const ErmMap *map, const char *key);
bool ermMapHas(const ErmMap *map, const char *key);
void ermMapPut(ErmMap *map, const char *key, void *value);
bool ermMapRemove(ErmMap *map, const char *key);

#endif
