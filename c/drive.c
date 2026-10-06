// drive.c: the reference driver. CORE.tex "Running and wrapping",
// "Processes and lookup", "The reference driver and its programs";
// PROTOCOL.tex "The reference driver" (the tree, marks, rounds, heights,
// answers) and Commands (runs, stopped, batch, fire). Owner: the
// Drive+Program agent.
//
// Housekeeping (the tree walk, data reads of process nodes, reading a
// process's value to compare) goes to `beneath` with ermHostCtx(). Runs are
// bound from `top`: the compute with ermBind(top, {agent, p, path,
// ERM_READ_ONLY, 0}) wrapped by top.vt->record; the program slots and nodes
// through rec->quiet; the value write and the effect through rec->with(rec,
// ermBind(top, {..., ERM_WRITE_ONLY})); cleanups and handlers with the
// lasting interface (a wrapper over top that collects the changes made
// through it and, but for the cleanup a stop runs, stops working once its
// process stops or restarts).
//
// Readings chosen where the spec is open (the same as ../haskell/Drive.hs):
// - A process whose compute runs twice in one round has two runs: the
//   earlier record is finished, with no effect, just before the later
//   compute starts. The effect runs once, at the end of the round, in the
//   last run's record, if that compute returned a value and either the
//   process has not returned one since it started or the driver wrote its
//   value in this round.
// - An effect's previous is the process node's value read (beneath protect)
//   just before the compute's value is written; absent on the first run
//   since the process started.
// - The previous effect's cleanup runs whenever the effect would run, even
//   when the effect slot is gone. If that cleanup stops the process, the
//   effect does not run. A cleanup's own errors are dropped.
// - Stops are listed in the order they were decided: within one walk, in
//   the order the previous walk reached them (then by id); a stop caused by
//   a stopped process's cleanup comes after it.
// - A refused read of a program slot leaves compute/effect out; a refused
//   read of the program node gives {"node", "refused": true, "slot"}. A gone
//   compute slot or a program the loader rejects fails the run with
//   {"kind": "invalid", "op": "compute"|"effect"}; an absent program node
//   leaves the run pending. A data.path that is not a path fails each run
//   with "op": "path" before the slots are read.
// - A run's ending: refused if any error in its record is a refusal, else
//   failed on any error or an uncaught throw, else pending or done.
// - fire on a process that is not running, or with no such handler, is an
//   invalid error.

#include "ermine.h"

#include <stdlib.h>
#include <string.h>

/** a node's fixed data, as far as the driver cares */
typedef struct PathInfo {
	bool process; // fixed data is an object with a "path"
	bool ok;      // the path decodes
	ErmPath path;
	Json *why; // when not ok
} PathInfo;

/** a running process */
typedef struct Proc {
	Json *agent;
	PathInfo *info;
	int64_t gen; // which start this is
	int64_t height;
	ErmIds reads; // nodes its last compute read
	ErmIds wrote; // nodes its last effect changed
	ERM_LIST(ErmNamedHandler) handlers;
	bool hasCleanup;
	ErmHandler cleanup;
	bool returned; // a run has returned a value since it started
	bool ran;      // it has run since it started
} Proc;

/** a due process: the changes that marked it, oldest first, and the time of the first */
typedef struct Due {
	const char *process;
	ErmChanges marks;
	ErmTime first;
} Due;

typedef enum { OUT_VALUE, OUT_PENDING, OUT_FAILED, OUT_THREW_REFUSED, OUT_THREW, OUT_NONE } Outcome;

/** a run whose compute ran in this round and whose record is not finished yet */
typedef struct RunState {
	const char *process;
	ErmRecording *rec;
	int64_t gen;
	ErmCtx ctx; // READ_ONLY
	Outcome outcome;
	Json *value;    // OUT_VALUE
	Json *effect;   // the effect program's value, read before the compute; NULL: none
	Json *previous; // NULL: absent
} RunState;

struct ErmDriver {
	ErmInterface inner;   // protect
	ErmInterface beneath; // the bare graph
	ErmInterface top;     // told by setTop
	const char *root;
	ErmLoader load;
	ErmTime last; // the time of the last change applied
	int holds;    // > 0: rounds are held (running them, inside a batch or a fire)
	ErmRan ran;   // collected for ermDriverTake

	ErmMap infos;     // id -> PathInfo *
	ErmMap procs;     // id -> Proc *, the running processes
	ErmMap runCounts; // id -> int64_t *
	int64_t gens;
	ERM_LIST(Due *) due;
	ErmIds lastOrder; // the last walk's process nodes, in walk order

	// the current round
	ERM_LIST(RunState *) roundRuns;
	ErmIds roundOrder; // the order computes last ran
	ErmIds roundWrote; // processes whose value the driver wrote
};

static const char *const NO_PROCESS_WHY = "not a process";

static ErmApi hostApi(ErmDriver *d) {
	return ermBind(d->beneath, ermHostCtx());
}

static Proc *procOf(ErmDriver *d, const char *id) {
	return ermMapGet(&d->procs, id);
}

static void removeId(ErmIds *ids, const char *id) {
	int to = 0;
	for (int i = 0; i < ids->count; i++) {
		if (strcmp(ids->items[i], id) != 0) ids->items[to++] = ids->items[i];
	}
	ids->count = to;
}

// ===========================================================================
// the lasting interface

typedef struct Lasting {
	ErmDriver *driver;
	const char *process;
	int64_t gen;
	bool guarded;
	ErmChanges changes; // made through it
} Lasting;

static ErmErr lastingAlive(Lasting *l) {
	if (!l->guarded) return ermOk();
	Proc *st = procOf(l->driver, l->process);
	if (st && st->gen == l->gen) return ermOk();
	return ermInvalid("process %s has stopped: its lasting interface no longer works", l->process);
}

static ErmErr lastingOp(void *self, const ErmCtx *ctx, const ErmStamp *stamp, const ErmOp *op, ErmResult *out) {
	Lasting *l = self;
	ErmErr err = lastingAlive(l);
	if (err.kind) return err;
	ErmInterface top = l->driver->top;
	err = top.vt->op(top.self, ctx, stamp, op, out);
	if (!err.kind && ermOpIsChange(op->kind)) ERM_PUSH(l->changes, out->applied.change);
	return err;
}

static ErmErr lastingSubscribe(void *self, const ErmCtx *ctx, Json *node, ErmEventFn fn, void *data, int64_t *sub) {
	Lasting *l = self;
	ErmErr err = lastingAlive(l);
	if (err.kind) return err;
	ErmInterface top = l->driver->top;
	return top.vt->subscribe(top.self, ctx, node, fn, data, sub);
}

static ErmErr lastingUnsubscribe(void *self, const ErmCtx *ctx, int64_t sub) {
	Lasting *l = self;
	ErmErr err = lastingAlive(l);
	if (err.kind) return err;
	ErmInterface top = l->driver->top;
	return top.vt->unsubscribe(top.self, ctx, sub);
}

static ErmRecording *lastingRecord(void *self, ErmApi api, int64_t run, const ErmRefs *marked) {
	Lasting *l = self;
	ErmInterface top = l->driver->top;
	return top.vt->record(top.self, api, run, marked);
}

static ErmRecord *lastingFinish(void *self, ErmRecording *recording, ErmEnding ending) {
	Lasting *l = self;
	ErmInterface top = l->driver->top;
	return top.vt->finish(top.self, recording, ending);
}

static void lastingSetTop(void *self, ErmInterface top) {
	(void)self, (void)top;
}

static const ErmVtable lastingVtable = {
	lastingOp, lastingSubscribe, lastingUnsubscribe, lastingRecord, lastingFinish, lastingSetTop,
};

static ErmCtx lastingCtx(const char *process, const Proc *st) {
	ErmCtx ctx = { 0 };
	ctx.agent = st->agent;
	ctx.process = process;
	if (st->info->ok) ctx.path = st->info->path;
	ctx.mode = ERM_WRITE_ONLY;
	return ctx;
}

/** runs a handler or cleanup with the process's lasting interface; *changes gets what it made */
static ErmErr runLasting(ErmDriver *d, bool guarded, const char *process, const Proc *st, ErmHandler handler, Json *input,
                         ErmChanges *changes) {
	Lasting *l = allocate(sizeof *l);
	l->driver = d;
	l->process = process;
	l->gen = st->gen;
	l->guarded = guarded;
	ErmApi api = ermBind((ErmInterface){ &lastingVtable, l }, lastingCtx(process, st));
	ErmErr err = handler.run(handler.self, api, process, input);
	if (changes) *changes = l->changes;
	return err;
}

// ===========================================================================
// the tree

/** what the driver knows of a node's fixed data; NULL when the node is absent */
static PathInfo *infoOf(ErmDriver *d, const char *id) {
	PathInfo *info = ermMapGet(&d->infos, id);
	if (info) return info;
	Json *data = NULL;
	ErmErr err = ermApiData(hostApi(d), jsonString(id), &data);
	if (err.kind || !data) return NULL;
	info = allocate(sizeof *info);
	Json *path = jsonGet(data, "path");
	if (jsonIsObject(data) && path) {
		info->process = true;
		ErmErr decoded = ermPathFrom(path, &info->path);
		info->ok = !decoded.kind;
		info->why = decoded.why;
	} else {
		info->why = jsonString(NO_PROCESS_WHY);
	}
	ermMapPut(&d->infos, id, info);
	return info;
}

static bool isProcessNode(ErmDriver *d, const char *id) {
	PathInfo *info = infoOf(d, id);
	return info && info->process;
}

/** one node the walk is inside: its directory and where in it the walk is */
typedef struct WalkFrame {
	ErmResult listing;
	int slot;
	int index;
} WalkFrame;

/** a node's frame; false when its directory cannot be read whole */
static bool walkEnter(ErmDriver *d, const char *node, WalkFrame *frame) {
	*frame = (WalkFrame){ 0 };
	ErmErr err = ermApiDirectory(hostApi(d), jsonString(node), NULL, &frame->listing);
	return !err.kind && frame->listing.listing == ERM_LIST_WHOLE;
}

/**
 * Depth first, names in code point order, ids in slot order, as a recursion
 * would go, but with its own stack: a process tree can be as deep as
 * placements make it.
 */
static void walkFrom(ErmDriver *d, const char *node, ErmMap *visited, ErmIds *out) {
	ERM_LIST(WalkFrame) stack = { 0 };
	WalkFrame first;
	if (!walkEnter(d, node, &first)) return;
	ERM_PUSH(stack, first);
	while (stack.count) {
		WalkFrame *top = &stack.items[stack.count - 1];
		if (top->slot >= top->listing.whole.count) {
			stack.count--;
			continue;
		}
		const ErmSlot *slot = &top->listing.whole.items[top->slot];
		if (top->index >= slot->ids.count || strcmp(slot->name, "compute") == 0 || strcmp(slot->name, "effect") == 0) {
			top->slot++;
			top->index = 0;
			continue;
		}
		const char *id = slot->ids.items[top->index++];
		if (ermMapHas(visited, id) || !isProcessNode(d, id)) continue;
		ermMapPut(visited, id, (void *)id);
		ERM_PUSH(*out, id);
		WalkFrame next;
		if (walkEnter(d, id, &next)) ERM_PUSH(stack, next); // may move stack.items: top is not used after
	}
	free(stack.items);
}

/** the process nodes reached beneath the root, in walk order */
static ErmIds walk(ErmDriver *d) {
	ErmMap visited = { 0 };
	ErmIds out = { 0 };
	ermMapPut(&visited, d->root, (void *)d->root);
	walkFrom(d, d->root, &visited, &out);
	return out;
}

static Due *dueOf(ErmDriver *d, const char *process, int *index) {
	for (int i = 0; i < d->due.count; i++) {
		if (strcmp(d->due.items[i]->process, process) == 0) {
			if (index) *index = i;
			return d->due.items[i];
		}
	}
	return NULL;
}

static void removeDue(ErmDriver *d, const char *process) {
	int index;
	if (!dueOf(d, process, &index)) return;
	for (int i = index + 1; i < d->due.count; i++) d->due.items[i - 1] = d->due.items[i];
	d->due.count--;
}

static void addDue(ErmDriver *d, const char *process, ErmChange *change) {
	Due *due = dueOf(d, process, NULL);
	if (due) {
		ERM_PUSH(due->marks, change);
		return;
	}
	due = allocate(sizeof *due);
	due->process = process;
	due->first = change->time;
	ERM_PUSH(due->marks, change);
	ERM_PUSH(d->due, due);
}

typedef struct StopOrder {
	const char *process;
	int index; // in the last walk; INT32_MAX when not there
} StopOrder;

static int compareStops(const void *a, const void *b) {
	const StopOrder *x = a, *y = b;
	if (x->index != y->index) return x->index < y->index ? -1 : 1;
	return textCompare(x->process, y->process);
}

/** PROTOCOL The tree: starts what the walk newly reached, stops what it no longer reaches */
static void reconcile(ErmDriver *d, ErmChange *change) {
	ErmIds reached = walk(d);
	ERM_LIST(StopOrder) toStop = { 0 };
	for (int e = 0; e < d->procs.count; e++) {
		if (!d->procs.entries[e].live) continue;
		const char *id = d->procs.entries[e].key;
		if (ermIdsHas(&reached, id)) continue;
		int index = INT32_MAX;
		for (int i = 0; i < d->lastOrder.count; i++) {
			if (strcmp(d->lastOrder.items[i], id) == 0) {
				index = i;
				break;
			}
		}
		ERM_PUSH(toStop, ((StopOrder){ id, index }));
	}
	if (toStop.count > 1) qsort(toStop.items, (size_t)toStop.count, sizeof *toStop.items, compareStops);
	d->lastOrder = reached;

	for (int i = 0; i < reached.count; i++) {
		const char *id = reached.items[i];
		if (procOf(d, id)) continue;
		Proc *st = allocate(sizeof *st);
		st->agent = change->agent;
		st->info = infoOf(d, id);
		st->gen = ++d->gens;
		ermMapPut(&d->procs, id, st);
		addDue(d, id, change);
	}

	// decide every stop first, so that stops their cleanups cause come after
	Proc **stopping = allocate(sizeof *stopping * (size_t)(toStop.count + 1));
	int *slots = allocate(sizeof *slots * (size_t)(toStop.count + 1));
	for (int i = 0; i < toStop.count; i++) {
		const char *id = toStop.items[i].process;
		// the map's key is freed by nothing, but keep an id that outlives the map entry
		const char *kept = copyString(id);
		toStop.items[i].process = kept;
		stopping[i] = procOf(d, kept);
		slots[i] = d->ran.stopped.count;
		ERM_PUSH(d->ran.stopped, ((ErmStopped){ kept, { 0 } }));
		ermMapRemove(&d->procs, kept);
		removeDue(d, kept);
	}
	for (int i = 0; i < toStop.count; i++) {
		Proc *st = stopping[i];
		if (!st->hasCleanup) continue;
		ErmChanges changes = { 0 };
		runLasting(d, false, toStop.items[i].process, st, st->cleanup, NULL, &changes);
		d->ran.stopped.items[slots[i]].changes = changes;
	}
	free(stopping);
	free(slots);
}

static void afterChange(ErmDriver *d, const ErmApplied *applied) {
	ErmChange *change = applied->change;
	d->last = change->time;
	for (int i = 0; i < applied->marked.count; i++) {
		const char *m = applied->marked.items[i];
		if (!procOf(d, m)) continue;
		if (change->process && strcmp(change->process, m) == 0) continue;
		addDue(d, m, change);
	}
	reconcile(d, change);
}

// ===========================================================================
// rounds

static void runRounds(ErmDriver *d);

static void hold(ErmDriver *d) {
	d->holds++;
}

/** the outermost release runs rounds until nothing is due */
static void release(ErmDriver *d) {
	if (d->holds == 1) runRounds(d);
	d->holds--;
}

static ErmEnding endingOf(const ErmRecording *rec, Outcome outcome) {
	const ErmErrs *errors = &rec->record.errors;
	for (int i = 0; i < errors->count; i++) {
		if (errors->items[i].kind == ERM_REFUSED) return ERM_REFUSED_ENDING;
	}
	if (errors->count > 0) return ERM_FAILED;
	switch (outcome) {
		case OUT_VALUE: return ERM_DONE;
		case OUT_PENDING: return ERM_PENDING;
		case OUT_THREW_REFUSED: return ERM_REFUSED_ENDING;
		case OUT_FAILED:
		case OUT_THREW:
		case OUT_NONE: return ERM_FAILED;
	}
	return ERM_FAILED;
}

static void finishWith(ErmDriver *d, ErmRecording *rec, ErmEnding ending) {
	ErmRecord *record = d->top.vt->finish(d->top.self, rec, ending);
	ERM_PUSH(d->ran.runs, record);
}

static void addError(ErmRecording *rec, ErmErrKind kind, const char *op, Json *why) {
	ERM_PUSH(rec->record.errors, ((ErmErr){ kind, op, why }));
}

static Outcome outcomeOfThrow(ErmErr err) {
	if (!err.kind) return OUT_NONE;
	return err.kind == ERM_REFUSED ? OUT_THREW_REFUSED : OUT_THREW;
}

/** every other process the predicate holds for goes above p */
static void raise(ErmDriver *d, const char *p, bool (*isReader)(const Proc *q, const void *arg), const void *arg) {
	Proc *st = procOf(d, p);
	if (!st) return;
	for (int e = 0; e < d->procs.count; e++) {
		if (!d->procs.entries[e].live) continue;
		if (strcmp(d->procs.entries[e].key, p) == 0) continue;
		Proc *q = d->procs.entries[e].value;
		if (isReader(q, arg) && q->height <= st->height) q->height = st->height + 1;
	}
}

static bool readsNode(const Proc *q, const void *arg) {
	return ermIdsHas(&q->reads, arg);
}

static bool readsAny(const Proc *q, const void *arg) {
	const ErmIds *nodes = arg;
	for (int i = 0; i < nodes->count; i++) {
		if (ermIdsHas(&q->reads, nodes->items[i])) return true;
	}
	return false;
}

typedef enum { READ_OK, READ_GONE, READ_ERR } ProgramRead;

/** reads a program slot quietly: the slot and its first program node */
static ProgramRead readProgram(ErmRecording *rec, const char *process, const char *slot, ErmProgramSeen *seen,
                               bool *hasSeen, Json **value, ErmErr *err, const char **errOp) {
	*hasSeen = false;
	*value = NULL;
	ErmResult listed = { 0 };
	*err = ermApiDirectory(rec->quiet, jsonString(process), jsonString(slot), &listed);
	if (err->kind) {
		*errOp = "directory";
		return READ_ERR;
	}
	if (listed.listing != ERM_LIST_SLOT || listed.slot.count == 0) return READ_GONE;
	const char *first = listed.slot.items[0];
	*seen = (ErmProgramSeen){ first, 0, listed.slot, false };
	*hasSeen = true;
	ErmTime time = 0;
	*err = ermApiRead(rec->quiet, jsonString(first), value, &time);
	if (err->kind) {
		seen->refused = true;
		*errOp = "read";
		return READ_ERR;
	}
	seen->saw = time;
	return READ_OK;
}

static RunState *roundRunOf(ErmDriver *d, const char *process, int *index) {
	for (int i = 0; i < d->roundRuns.count; i++) {
		if (strcmp(d->roundRuns.items[i]->process, process) == 0) {
			if (index) *index = i;
			return d->roundRuns.items[i];
		}
	}
	return NULL;
}

static void removeRoundRun(ErmDriver *d, const char *process) {
	int index;
	if (!roundRunOf(d, process, &index)) return;
	for (int i = index + 1; i < d->roundRuns.count; i++) d->roundRuns.items[i - 1] = d->roundRuns.items[i];
	d->roundRuns.count--;
}

static Json *snapshotOf(Json *value) {
	Json *patch = jsonObject();
	jsonAdd(patch, "type", jsonString("snapshot"));
	jsonAdd(patch, "value", value);
	Json *patches = jsonArray();
	jsonPush(patches, patch);
	return patches;
}

/** PROTOCOL Rounds: one compute of p, as a new run */
static void runCompute(ErmDriver *d, const char *p, Due *due) {
	RunState *earlier = roundRunOf(d, p, NULL);
	if (earlier) {
		removeRoundRun(d, p);
		finishWith(d, earlier->rec, endingOf(earlier->rec, earlier->outcome));
	}
	removeId(&d->roundOrder, p);
	ERM_PUSH(d->roundOrder, p);

	Proc *st = procOf(d, p);
	bool ranBefore = st->ran;
	st->ran = true;
	int64_t *count = ermMapGet(&d->runCounts, p);
	if (!count) {
		count = allocate(sizeof *count);
		ermMapPut(&d->runCounts, p, count);
	}
	int64_t n = ++*count;

	ErmCtx ctx = { 0 };
	ctx.agent = st->agent;
	ctx.process = p;
	if (st->info->ok) ctx.path = st->info->path;
	ctx.mode = ERM_READ_ONLY;
	ErmRefs refs = { 0 };
	for (int i = 0; i < due->marks.count; i++) ERM_PUSH(refs, ermRefOf(due->marks.items[i]));
	ErmInterface top = d->top;
	ErmRecording *rec = top.vt->record(top.self, ermBind(top, ctx), n, &refs);

	RunState *rs = allocate(sizeof *rs);
	rs->process = p;
	rs->rec = rec;
	rs->gen = st->gen;
	rs->ctx = ctx;
	rs->outcome = OUT_FAILED;
	ERM_PUSH(d->roundRuns, rs);

	if (!st->info->ok) {
		addError(rec, ERM_INVALID, "path", st->info->why);
		return;
	}
	ErmProgramSeen seen;
	bool hasSeen;
	Json *code, *effectCode = NULL;
	ErmErr err;
	const char *errOp = NULL;
	switch (readProgram(rec, p, "compute", &seen, &hasSeen, &code, &err, &errOp)) {
		case READ_ERR:
			if (hasSeen) rec->record.hasCompute = true, rec->record.compute = seen;
			addError(rec, err.kind, errOp, err.why);
			return;
		case READ_GONE: addError(rec, ERM_INVALID, "compute", jsonString("the compute slot is gone")); return;
		case READ_OK: rec->record.hasCompute = true, rec->record.compute = seen; break;
	}
	bool hasEffect = false;
	switch (readProgram(rec, p, "effect", &seen, &hasSeen, &effectCode, &err, &errOp)) {
		case READ_ERR:
			if (hasSeen) rec->record.hasEffect = true, rec->record.effect = seen;
			addError(rec, err.kind, errOp, err.why);
			return;
		case READ_GONE: break;
		case READ_OK:
			hasEffect = true;
			rec->record.hasEffect = true, rec->record.effect = seen;
			break;
	}
	if (!code || (hasEffect && !effectCode)) {
		rs->outcome = OUT_PENDING;
		return;
	}
	ErmProgram program;
	err = d->load(code, &program);
	if (err.kind) {
		addError(rec, ERM_INVALID, "compute", err.why);
		return;
	}
	ErmComputeIn in = { rec->api, p, ctx.path, due->marks };
	ErmComputeOut out = program.compute(program.self, &in);
	int readsCount = rec->record.reads.count;
	Outcome outcome;
	if (rec->record.errors.count > 0) {
		outcome = OUT_FAILED;
	} else if (out.kind == ERM_WENT_PENDING) {
		outcome = OUT_PENDING;
	} else if (out.kind == ERM_THREW) {
		outcome = outcomeOfThrow(out.threw);
		if (outcome == OUT_NONE) outcome = OUT_THREW;
	} else {
		Json *v = out.value ? out.value : jsonNull();
		rec->record.value = v;
		Json *old = NULL;
		ermApiRead(hostApi(d), jsonString(p), &old, NULL);
		if (ranBefore) rs->previous = old;
		if (old && jsonEqual(old, v)) {
			outcome = OUT_VALUE;
		} else {
			ErmCtx writing = ctx;
			writing.mode = ERM_WRITE_ONLY;
			ErmApi w = rec->with(rec, ermBind(top, writing));
			ErmErr wrote = ermApiWrite(w, NULL, jsonString(p), snapshotOf(v), NULL);
			if (wrote.kind) {
				outcome = OUT_FAILED;
			} else {
				if (!ermIdsHas(&d->roundWrote, p)) ERM_PUSH(d->roundWrote, p);
				outcome = OUT_VALUE;
			}
		}
		rs->value = v;
	}
	rs->outcome = outcome;
	rs->effect = effectCode;

	// heights: readers of p's value go above p
	st = procOf(d, p);
	if (st) {
		ErmIds reads = { 0 };
		for (int i = 0; i < readsCount; i++) ERM_PUSH(reads, rec->record.reads.items[i].node);
		st->reads = reads;
		raise(d, p, readsNode, p);
	}
}

/** the effect of a run whose compute returned v; returns how it ended */
static Outcome runEffect(ErmDriver *d, RunState *rs) {
	ErmRecording *rec = rs->rec;
	const char *p = rs->process;
	ErmProgram program;
	ErmErr err = d->load(rs->effect, &program);
	if (err.kind) {
		addError(rec, ERM_INVALID, "effect", err.why);
		return OUT_THREW;
	}
	ErmCtx writing = rs->ctx;
	writing.mode = ERM_WRITE_ONLY;
	ErmApi api = rec->with(rec, ermBind(d->top, writing));
	int before = rec->record.changes.count;
	ErmEffectIn in = { api, p, rs->value, rs->previous };
	ErmEffectOut out = program.effect(program.self, &in);
	ErmIds wrote = { 0 };
	for (int i = before; i < rec->record.changes.count; i++) {
		const char *node = rec->record.changes.items[i].node;
		if (!ermIdsHas(&wrote, node)) ERM_PUSH(wrote, node);
	}
	Proc *st = procOf(d, p);
	if (st && st->gen == rs->gen) {
		for (int i = 0; i < out.handlers.count; i++) {
			ErmNamedHandler named = out.handlers.items[i];
			bool replaced = false;
			for (int j = 0; j < st->handlers.count; j++) {
				if (strcmp(st->handlers.items[j].name, named.name) == 0) {
					st->handlers.items[j].handler = named.handler;
					replaced = true;
				}
			}
			if (!replaced) ERM_PUSH(st->handlers, named);
		}
		st->hasCleanup = out.hasCleanup;
		st->cleanup = out.cleanup;
		st->wrote = wrote;
		raise(d, p, readsAny, &wrote);
	}
	return outcomeOfThrow(out.threw);
}

/** PROTOCOL Rounds: finishes a run of the round, running its effect if it calls for one */
static void finishRun(ErmDriver *d, RunState *rs) {
	ErmRecording *rec = rs->rec;
	const char *p = rs->process;
	Proc *st = procOf(d, p);
	Outcome effectOutcome = OUT_NONE;
	if (rs->outcome == OUT_VALUE && st && st->gen == rs->gen) {
		bool effectDue = !st->returned || ermIdsHas(&d->roundWrote, p);
		st->returned = true;
		if (effectDue) {
			if (st->hasCleanup) {
				ErmHandler cleanup = st->cleanup;
				st->hasCleanup = false;
				ErmChanges changes = { 0 };
				runLasting(d, true, p, st, cleanup, NULL, &changes);
				ErmRefs refs = { 0 };
				for (int i = 0; i < changes.count; i++) ERM_PUSH(refs, ermRefOf(changes.items[i]));
				rec->record.cleanup = refs;
			}
			Proc *still = procOf(d, p);
			if (rs->effect && still && still->gen == rs->gen) effectOutcome = runEffect(d, rs);
		}
	}
	finishWith(d, rec, endingOf(rec, effectOutcome != OUT_NONE ? effectOutcome : rs->outcome));
}

/** computes, lowest height first, then oldest first mark, then lowest id */
static void computes(ErmDriver *d) {
	for (;;) {
		Due *best = NULL;
		Proc *bestProc = NULL;
		for (int i = 0; i < d->due.count; i++) {
			Due *due = d->due.items[i];
			Proc *st = procOf(d, due->process);
			if (!st) continue;
			if (!best || st->height < bestProc->height ||
			    (st->height == bestProc->height &&
			     (due->first < best->first || (due->first == best->first && textCompare(due->process, best->process) < 0)))) {
				best = due;
				bestProc = st;
			}
		}
		if (!best) {
			d->due.count = 0;
			return;
		}
		removeDue(d, best->process);
		runCompute(d, best->process, best);
	}
}

static void runRound(ErmDriver *d) {
	d->roundRuns.count = 0;
	d->roundOrder = (ErmIds){ 0 };
	d->roundWrote = (ErmIds){ 0 };
	computes(d);
	ErmIds order = d->roundOrder;
	for (int i = 0; i < order.count; i++) {
		RunState *rs = roundRunOf(d, order.items[i], NULL);
		if (!rs) continue;
		removeRoundRun(d, order.items[i]);
		finishRun(d, rs);
	}
}

static void runRounds(ErmDriver *d) {
	while (d->due.count > 0) runRound(d);
}

// ===========================================================================
// the drive layer

/** PROTOCOL The reference driver: stamps change ops, applies, queues marks, walks, runs rounds */
static ErmErr driveOp(void *self, const ErmCtx *ctx, const ErmStamp *stamp, const ErmOp *op, ErmResult *out) {
	ErmDriver *d = self;
	if (!ermOpIsChange(op->kind)) return d->inner.vt->op(d->inner.self, ctx, stamp, op, out);
	hold(d);
	ErmStamp stamped = *stamp;
	stamped.time = d->last + 1;
	ErmErr err = d->inner.vt->op(d->inner.self, ctx, &stamped, op, out);
	if (!err.kind) afterChange(d, &out->applied);
	release(d);
	return err;
}

static ErmErr driveSubscribe(void *self, const ErmCtx *ctx, Json *node, ErmEventFn fn, void *data, int64_t *sub) {
	ErmDriver *driver = self;
	return driver->inner.vt->subscribe(driver->inner.self, ctx, node, fn, data, sub);
}

static ErmErr driveUnsubscribe(void *self, const ErmCtx *ctx, int64_t sub) {
	ErmDriver *driver = self;
	return driver->inner.vt->unsubscribe(driver->inner.self, ctx, sub);
}

static ErmRecording *driveRecord(void *self, ErmApi api, int64_t run, const ErmRefs *marked) {
	ErmDriver *driver = self;
	return driver->inner.vt->record(driver->inner.self, api, run, marked);
}

static ErmRecord *driveFinish(void *self, ErmRecording *recording, ErmEnding ending) {
	ErmDriver *driver = self;
	return driver->inner.vt->finish(driver->inner.self, recording, ending);
}

static void driveSetTop(void *self, ErmInterface top) {
	ErmDriver *driver = self;
	driver->top = top;
	driver->inner.vt->setTop(driver->inner.self, top);
}

static const ErmVtable driveVtable = {
	driveOp, driveSubscribe, driveUnsubscribe, driveRecord, driveFinish, driveSetTop,
};

ErmDriver *ermDrive(ErmInterface inner, ErmInterface beneath, const char *root, ErmLoader load) {
	ErmDriver *driver = allocate(sizeof *driver);
	driver->inner = inner;
	driver->beneath = beneath;
	driver->top = (ErmInterface){ &driveVtable, driver };
	driver->root = root;
	driver->load = load;
	return driver;
}

ErmInterface ermDriverInterface(ErmDriver *driver) {
	return (ErmInterface){ &driveVtable, driver };
}

/** CORE Running and wrapping: batch */
void ermDriverBatchBegin(ErmDriver *driver) {
	hold(driver);
}

void ermDriverBatchEnd(ErmDriver *driver) {
	release(driver);
}

/** PROTOCOL Commands: fire */
ErmErr ermDriverFire(ErmDriver *driver, const ErmCtx *ctx, const char *process, const char *handler, Json *input, ErmFired *out) {
	(void)ctx;
	*out = (ErmFired){ 0 };
	Proc *st = procOf(driver, process);
	if (!st) return ermInvalid("no process %s is running", process);
	ErmHandler *found = NULL;
	for (int i = 0; i < st->handlers.count; i++) {
		if (strcmp(st->handlers.items[i].name, handler) == 0) found = &st->handlers.items[i].handler;
	}
	if (!found) return ermInvalid("process %s has no handler %s", process, handler);
	ErmHandler h = *found;
	const char *kept = copyString(process);
	hold(driver);
	ErmChanges changes = { 0 };
	ErmErr err = runLasting(driver, true, kept, st, h, input, &changes);
	release(driver);
	out->changes = changes;
	out->error = err;
	return ermOk();
}

/** PROTOCOL Commands: runs and stopped */
ErmRan ermDriverTake(ErmDriver *driver) {
	ErmRan ran = driver->ran;
	driver->ran = (ErmRan){ 0 };
	return ran;
}
