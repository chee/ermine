// the host (ermine.ts, features.ts, registry.ts), in C: createErmine, features and hooks, slots, start,
// stop, close, getProcessContext, handleOf, dataOf, records, calling, the registry,
// nothing-open. D's job, function by function (ermine.h says each):
//   errors: es_fail, es_fail_refusal, es_fail_feature, es_fail_text, es_thrown, es_clear_thrown,
//     es_not_yet, es_code_name, es_out_code
//   lifecycle: es_create (the order ermine.ts makes things in), es_close, es_free, es_start, es_stop,
//     es_started_status, es_started_free, es_refused_free, es_pulse
//   the host: es_host_context, es_get_process_context, es_handle_of, es_data_of, es_records_run,
//     es_records_call, es_records_waits, es_calling, es_features
//   features: es_on_table … es_on_status, es_api_*, es_reserve_slot, es_slot_get, es_slot_set,
//     es_listened, es_next_*: installed in order (needs first), setup-only, the chains with next
//   what the others call: es_hook_write, es_hook_read, es_hook_teardown, es_hook_status,
//     es_hook_record, es_held_at, es_held_status, es_held_row, es_held_drop, es_header, es_enter,
//     es_alive, es_queue_pulse, es_new_id, es_uuidv7, es_drop, es_why_of
//   the registry: es_register_scope, es_context_at, es_found (nothing-open)
//
// what the chains hand around. a hook's own arguments are borrowed for its call. onRead: its out is a
// fresh array, the version's held and more its own (the chain passes them up); what next gives into the
// out a hook passed is that hook's to free or hand up. onStatus: its out is borrowed from the hook (held
// good till its next call, or es_close); the chain copies the last one whole into the caller's.
// onTable: next gives the layer the hooks after it made. a closed ermine: every function here that gives
// a pointer or a 1/0 gives NULL/0 with es_thrown() ES_CLOSED; none (nothing there) leaves nothing thrown.
//
// what is not here, and why: the scope nodes going is done by libraries with no
// write hook, so onWrite does not see them and cannot hold them back.
#include "ermine.h"

#include <stdio.h>

#include "../../processes/c/platform.h"

// errors -------------------------------------------------------------------------------------------

// what was thrown last: one slot, replaced by each failure
static es_error thrown;

static void forget(void) {
	free(thrown.message);
	free(thrown.op);
	free(thrown.reason);
	free(thrown.feature);
	free(thrown.hook);
	free(thrown.cause);
	thrown = (es_error){0};
}

static char *format(const char *format, va_list args) {
	va_list again;
	va_copy(again, args);
	int n = vsnprintf(NULL, 0, format, again);
	va_end(again);
	char *text = es_alloc((size_t)n + 1);
	vsnprintf(text, (size_t)n + 1, format, args);
	return text;
}

int es_fail(int code, const char *fmt, ...) {
	va_list args;
	va_start(args, fmt);
	char *message = format(fmt, args);
	va_end(args);
	forget();
	thrown.code = code;
	thrown.message = message;
	return code;
}

int es_fail_refusal(const gd_refusal *why, const char *feature, const char *hook) {
	es_fail(ES_REFUSED, "%s refused: %s", why->op, why->reason);
	thrown.op = es_dup(why->op);
	thrown.reason = es_dup(why->reason);
	if (feature != NULL) thrown.feature = es_dup(feature);
	if (hook != NULL) thrown.hook = es_dup(hook);
	return ES_REFUSED;
}

int es_fail_feature(const char *feature, const char *hook, const char *cause) {
	// the cause may be the message held in the slot
	char *said = es_dup(cause);
	es_fail(ES_FEATURE, "%s's %s threw: %s", feature, hook, said);
	thrown.feature = es_dup(feature);
	thrown.hook = es_dup(hook);
	thrown.cause = said;
	return ES_FEATURE;
}

int es_fail_text(const char *message) { return es_fail(ES_FAILED, "%s", message); }

const es_error *es_thrown(void) { return &thrown; }

void es_clear_thrown(void) { forget(); }

int es_not_yet(const char *what) { return es_fail(ES_NOT_YET, "%s is not written yet", what); }

const char *es_code_name(int code) {
	switch (code) {
	case ES_OK: return "";
	case ES_NOT_A_NAME: return "not-a-name";
	case ES_NOTHING_THERE: return "nothing-there";
	case ES_ALREADY_THERE: return "already-there";
	case ES_REFUSED: return "refused";
	case ES_PENDING: return "pending";
	case ES_STOP: return "stop";
	case ES_NOT_A_METHOD: return "not-a-method";
	case ES_FEATURE: return "feature";
	case ES_FAILED: return "failed";
	case ES_TAKEN: return "taken";
	case ES_MISSING_FEATURE: return "missing-feature";
	case ES_FEATURE_TWICE: return "feature-twice";
	case ES_NEEDS_LOOP: return "needs-loop";
	case ES_SETUP_ONLY: return "setup-only";
	case ES_NOT_YET: return "not-yet";
	case ES_NOTHING_OPEN: return "nothing-open";
	case ES_NOT_A_HANDLE: return "not-a-handle";
	case ES_NOT_A_VALUE: return "not-a-value";
	case ES_NOT_PATCHES: return "not-patches";
	case ES_NOT_A_FUNCTION: return "not-a-function";
	case ES_CLOSED: return "closed";
	case ES_IN_ACT: return "in-act";
	case ES_BAD_CLEANUP: return "bad-cleanup";
	case ES_NOT_HERE: return "not-here";
	case ES_GONE: return "gone";
	case ES_ALREADY_INSIDE: return "already-inside";
	default: return "failed";
	}
}

es_out es_out_code(int code) {
	if (code == ES_PENDING) return es_out_pending();
	if (code == ES_STOP) return es_out_of(NULL);
	return es_out_failed(es_dup(thrown.message != NULL ? thrown.message : es_code_name(code)));
}

// an ErmineError's message: "code: message"
int es_fail_ermine(int code, const char *fmt, ...) {
	va_list args;
	va_start(args, fmt);
	char *body = format(fmt, args);
	va_end(args);
	es_fail(code, "%s: %s", es_code_name(code), body);
	free(body);
	return code;
}

// small things -------------------------------------------------------------------------------------

#define TRY(call) \
	do { \
		int code_ = (call); \
		if (code_) return code_; \
	} while (0)

#define CP(x) ((const char *const *)(x))

static const char *const HOOK_NAMES[ES_HOOKS] = {
	"onTable", "onRead", "onWrite", "onTeardown", "onRecord", "onStatus",
};

static const char PART_PROCESS[] = PR_PART;
static const char PART_CHILDREN[] = "children";
static const char PART_ATTRIBUTES[] = "attributes";
static const char PART_VALUE[] = "value";

// steps of a path as text: a leading "/" is the root, empty pieces are skipped (path.ts' parse)
static char **parse_steps(const char *text, size_t *n) {
	char **v = NULL;
	size_t cap = 0;
	*n = 0;
	if (text[0] == '/') ES_PUSH(v, *n, cap, es_dup("/"));
	const char *p = text;
	while (*p) {
		const char *q = strchr(p, '/');
		size_t len = q != NULL ? (size_t)(q - p) : strlen(p);
		if (len > 0) {
			char *s = es_alloc(len + 1);
			memcpy(s, p, len);
			ES_PUSH(v, *n, cap, s);
		}
		if (q == NULL) break;
		p = q + 1;
	}
	return v;
}

static op_value *names_value(const char *const *names, size_t n) {
	op_value *list = op_list();
	for (size_t i = 0; i < n; i++) op_push(list, op_str(names[i]));
	return list;
}

// an Error as a status holds it (status.h's)
static op_value *error_value(const char *message) {
	op_value *m = op_map();
	op_set(m, "name", op_str("Error"));
	op_set(m, "message", op_str(message));
	return op_stand(m);
}

// the patches of one key of an attributes-like map
static op_patch patch_set(const op_key *key, const op_value *value) {
	op_patch p = {0};
	p.place.path = key;
	p.place.length = 1;
	p.has_value = 1;
	p.value = value;
	return p;
}
static op_patch patch_unset(const op_key *key) {
	op_patch p = {0};
	p.place.path = key;
	p.place.length = 1;
	return p;
}

// the host's state ------------------------------------------------------------------------------------

// one hook, and the feature it is of
typedef struct {
	const char *feature;
	union {
		es_on_table_fn table;
		es_on_read_fn read;
		es_on_write_fn write;
		es_on_teardown_fn teardown;
		es_on_record_fn record;
		es_on_status_fn status;
	} fn;
	void *ctx;
} hook_rec;
typedef struct {
	hook_rec *items;
	size_t n, cap;
} hook_list;

// what a feature acts with: its api, and the hooks it has added, in order
typedef struct {
	es_feature_api api;
	es_ermine *e;
	char *name;
	es_hook *used;
	size_t nused, cap;
} fapi;

// a layer onTable gave: where its events and commits go on to is the next one outward that has any
typedef struct layer_rec {
	es_ermine *e;
	const char *feature;
	es_layer out;
	int made;
	struct layer_rec *ahead;
} layer_rec;

// a write held back: the feature, and whether it touches a status
typedef struct {
	const char *feature;
	int touches;
} held_rec;
// a stopped process whose row's removal was held: the feature, the root and the path
typedef struct {
	const char *feature;
	char *root;
	char **at;
	size_t nat;
} row_rec;

// a slot: per context, one number
struct es_slot {
	pm held;
	struct es_slot *next;
};

// a process es_start made
typedef struct proc_rec {
	// first: an es_started is one of these
	es_started started;
	es_ermine *e;
	es_program fn;
	void *ctx;
	es_context *context;
	char *id;
	op_value *at_value;
	sc_pair info[1];
	int running;
	// its setup's promise not settled yet (it holds the record); let go of by the host
	// (es_started_free); where it is in procs
	int awaiting, dropped;
	// started by a program: it belongs to the scope that started it, and goes with its own scope.
	// starter: the context that started it (compared, never read): only it may stop it or ask its status
	int child;
	const es_context *starter;
	size_t at;
} proc_rec;

struct es_hosting {
	// the ermine made the scheduler, so frees it
	int owns;
	// hooks may still be added; getProcessContext and the others work; a pulse is asked and not yet run
	int adding, made, queued;
	void (*schedule)(void *ctx, void (*f)(void *data), void *data);
	void *schedule_ctx;
	hook_list hooks[ES_HOOKS];
	fapi **apis;
	size_t napis, capapis;
	es_shown *shown;
	size_t nshown, capshown;
	layer_rec **layers;
	size_t nlayers, caplayers;
	layer_rec *innermost;
	// settled promises, keys no one tracks, and a pulse's end (what the places let go of)
	sc_listener *settle, *tracking, *tracking_first, *pulsed;
	sc_listener **listened;
	size_t nlistened, caplistened;
	un_wiring *unread;
	int registered;
	// held writes: the hook that did not call next, innermost; the key readers of them track
	const char *deepest;
	char heldkey;
	// id → (part → held_rec), process id → row_rec
	es_map held, rows;
	// computer id → the feature that held back the status write of the run its record is of (static)
	es_map run_held;
	// running processes' contexts, by their node's id
	es_map contexts;
	proc_rec **procs;
	size_t nprocs, capprocs;
	es_context **all;
	size_t nall, capall;
	sc_scope **scopes;
	size_t nscopes, capscopes;
	// a scope freed: its context goes (a process's), and the values its info borrowed (with)
	sc_listener *freed;
	pm with;
	// a child process's record, by its scope: let go as the scope is freed
	pm children;
	// values the scheduler's scope infos refer to: let go after it
	op_value **keep;
	size_t nkeep, capkeep;
	// headers made with no one to take their block
	pl_made **blocks;
	size_t nblocks, capblocks;
	pr_processes rows_walk;
	const pl_contributor *contributors[2];
	es_slot *slots;
	// closed ermines stay reachable (their contexts and handles may still be asked)
	es_ermine *next_closed;
};
typedef struct es_hosting hosting;

static es_ermine *closed_ermines;

static hosting *host_of(es_ermine *e) { return e->hosting; }

// the registry --------------------------------------------------------------------------------------------

// each scheduler an ermine registered, and how many did; a scope found to its context. module state,
// as registry.ts is: only es_create registers
typedef struct {
	sc_scheduler *s;
	int count;
} sched_ref;
static sched_ref *scheds;
static size_t nscheds, capscheds;
static pm scope_context;

static void sched_add(sc_scheduler *s) {
	for (size_t i = 0; i < nscheds; i++) {
		if (scheds[i].s == s) {
			scheds[i].count++;
			return;
		}
	}
	ES_PUSH(scheds, nscheds, capscheds, ((sched_ref){s, 1}));
}
static void sched_drop(sc_scheduler *s) {
	for (size_t i = 0; i < nscheds; i++) {
		if (scheds[i].s != s) continue;
		if (--scheds[i].count <= 0) {
			memmove(&scheds[i], &scheds[i + 1], (nscheds - i - 1) * sizeof *scheds);
			nscheds--;
		}
		return;
	}
}

void es_register_scope(sc_scope *scope, es_context *c) {
	pm_set(&scope_context, scope, c);
	hosting *h = host_of(c->ermine);
	ES_PUSH(h->scopes, h->nscopes, h->capscopes, scope);
}

static void forget_context(es_ermine *e, es_context *c);
static void rec_free(proc_rec *rec);

// a scope freed (torn down, held by nothing), as the reference's WeakMaps by scope let go: found to
// a process's context no more, and that context goes with it; the values its info borrowed go
static void scope_freed(sc_scope *o, void *data) {
	es_ermine *e = data;
	hosting *h = host_of(e);
	op_value *v = pm_get(&h->with, o);
	if (v != NULL) {
		pm_delete(&h->with, o);
		op_free(v);
	}
	proc_rec *kid = pm_get(&h->children, o);
	if (kid != NULL) {
		pm_delete(&h->children, o);
		kid->dropped = 1;
		// its setup's promise still out: freed as it settles
		if (!kid->awaiting) rec_free(kid);
	}
	es_context *c = pm_get(&scope_context, o);
	if (c == NULL || c->ermine != e) return;
	pm_delete(&scope_context, o);
	for (size_t i = 0; i < h->nscopes; i++) {
		if (h->scopes[i] != o) continue;
		h->scopes[i] = h->scopes[--h->nscopes];
		break;
	}
	if (c != e->host_context) forget_context(e, c);
}

es_context *es_context_at(sc_scope *scope) {
	for (sc_scope *o = scope; o != NULL; o = sc_scope_parent(o)) {
		es_context *c = pm_get(&scope_context, o);
		if (c != NULL) return c;
	}
	return NULL;
}

es_context *es_found(const char *name) {
	for (size_t i = 0; i < nscheds; i++) {
		es_context *c = es_context_at(sc_get_current_scope(scheds[i].s));
		if (c != NULL) return c;
	}
	es_fail_ermine(ES_NOTHING_OPEN,
		"%s: nothing is open here (a module's top level, a timer, a listener, or after an await): "
		"call it from a setup, a memo, an effect or an action",
		name);
	return NULL;
}

// ids -----------------------------------------------------------------------------------------------------

// a uuidv7 (rfc 9562): 48 bits of ms, then a 12-bit count within the ms (started random), then
// random. later ones sort after: a clock going back, or 4096 in one ms, borrows the next ms
char *es_uuidv7(void) {
	static uint64_t last;
	static unsigned count;
	unsigned char b[16];
	PF_RANDOM(b, sizeof b);
	uint64_t now = (uint64_t)PF_NOW_MS();
	if (now > last) {
		last = now;
		count = ((unsigned)b[6] << 8 | b[7]) & 0x7ff;
	} else if (++count > 0xfff) {
		last++;
		count = 0;
	}
	for (int i = 0; i < 6; i++) b[i] = (unsigned char)(last >> (8 * (5 - i)));
	b[6] = (unsigned char)(0x70 | count >> 8);
	b[7] = (unsigned char)count;
	b[8] = (unsigned char)(0x80 | (b[8] & 0x3f));
	char *s = es_alloc(37), *o = s;
	for (size_t i = 0; i < sizeof b; i++) {
		if (i == 4 || i == 6 || i == 8 || i == 10) *o++ = '-';
		snprintf(o, 3, "%02x", b[i]);
		o += 2;
	}
	return s;
}

char *es_new_id(es_ermine *e) { return e->id != NULL ? e->id(e->id_ctx) : es_uuidv7(); }

void es_drop(void *value, void *data) {
	(void)data;
	op_free(value);
}

int es_alive(es_ermine *e) {
	return e->closed ? es_fail_ermine(ES_CLOSED, "ermine is closed") : 0;
}

const char *es_why_of(es_ermine *e, const char *process) { return es_map_get(&e->whys, process); }

// the site of the call in progress, set; the one before back
const ch_site *es_enter(es_ermine *e, const ch_site *site) {
	const ch_site *was = e->site;
	e->site = site;
	return was;
}

// a write's header now: the open scope's. outside a run its site the call's, in one the running
// computer's own
int es_header(es_ermine *e, ch_header *out, pl_made **made) {
	pl_made *block = NULL;
	ch_site buf;
	const ch_site *site = NULL;
	sc_run *run = sc_get_run(e->scheduler);
	if (run == NULL) {
		site = e->site;
	} else {
		const st_site *own = st_site_of(e->sites, sc_run_computer(run));
		if (own != NULL) {
			buf = (ch_site){own->file, own->line, 0, own->func, 0};
			site = &buf;
		}
	}
	char *bad = pl_header(e->places, NULL, 0, site, out, &block);
	if (bad != NULL) {
		int code = strcmp(bad, SC_UNSCOPED) == 0
			? es_fail_ermine(ES_NOTHING_OPEN, "a write needs a scope open")
			: es_fail_text(bad);
		free(bad);
		return code;
	}
	if (made != NULL) {
		*made = block;
	} else {
		// no one to take the block: it goes with the ermine
		hosting *h = host_of(e);
		ES_PUSH(h->blocks, h->nblocks, h->capblocks, block);
	}
	return 0;
}

// pulses ------------------------------------------------------------------------------------------------------

static void run_pulse(void *data) {
	es_ermine *e = data;
	hosting *h = host_of(e);
	h->queued = 0;
	if (e->closed) return;
	es_pipes_told(e);
	sc_pulse(e->scheduler);
	free(sc_escaped(e->scheduler));
}

void es_queue_pulse(es_ermine *e) {
	hosting *h = host_of(e);
	if (h->queued || e->closed) return;
	h->queued = 1;
	if (h->schedule != NULL) h->schedule(h->schedule_ctx, run_pulse, e);
	else run_pulse(e);
}

static void settled(void *data) { es_queue_pulse(data); }
// a pulse over: the entries taken out of the table in it are let go of (none is read past it)
static void pulse_ended(void *data) {
	es_ermine *e = data;
	if (e->places != NULL) pl_sweep(e->places);
}

int es_pulse(es_context *c) {
	es_ermine *e = c->ermine;
	TRY(es_alive(e));
	es_pipes_told(e);
	sc_pulse(e->scheduler);
	char *bad = sc_escaped(e->scheduler);
	if (bad != NULL) {
		int code = es_fail_text(bad);
		free(bad);
		return code;
	}
	return 0;
}

// held writes -----------------------------------------------------------------------------------------------------

static void mark_held(es_ermine *e) {
	const void *keys[1] = {&host_of(e)->heldkey};
	sc_mark(e->scheduler, keys, 1, NULL);
}
static void track_held(es_ermine *e) { (void)sc_track(e->scheduler, &host_of(e)->heldkey); }

static held_rec *held_of(hosting *h, const char *part, const char *id) {
	es_map *at = es_map_get(&h->held, id);
	return at == NULL ? NULL : es_map_get(at, part);
}

// the write held at (part, id) let go; whether there was one
static int unhold(hosting *h, const char *part, const char *id) {
	es_map *at = es_map_get(&h->held, id);
	if (at == NULL) return 0;
	held_rec *r = es_map_get(at, part);
	if (r == NULL) return 0;
	es_map_del(at, part);
	free(r);
	if (at->n == 0) {
		es_map_free(at);
		free(at);
		es_map_del(&h->held, id);
	}
	return 1;
}

static void hold(hosting *h, const char *part, const char *id, const char *feature, int touches) {
	es_map *at = es_map_get(&h->held, id);
	if (at == NULL) {
		at = es_alloc(sizeof *at);
		es_map_set(&h->held, id, at);
	}
	held_rec *r = es_map_get(at, part);
	if (r == NULL) {
		r = es_alloc(sizeof *r);
		es_map_set(at, part, r);
	}
	r->feature = feature;
	r->touches = touches;
}

// whether a held write to the status table touches a computer's status
static int touches_status(const es_write *w) {
	if (w->gone) return 1;
	for (size_t i = 0; i < w->npatches; i++) {
		const op_patch *p = &w->patches[i];
		if (p->place.length > 0) {
			if (p->place.path[0].type == OP_STR_KEY && strcmp(p->place.path[0].s, CST_ATTRIBUTE) == 0) {
				return 1;
			}
		} else if (p->has_value && p->value != NULL && p->value->type == OP_MAP &&
			op_get(p->value, CST_ATTRIBUTE) != NULL) {
			return 1;
		}
	}
	return 0;
}

// a node gone: what was held at a part of it holding nothing goes too. a part still there keeps its own
void es_held_drop(es_ermine *e, const char *id) {
	hosting *h = host_of(e);
	int told = 0;
	for (;;) {
		es_map *at = es_map_get(&h->held, id);
		if (at == NULL) break;
		const char *gone = NULL;
		for (size_t i = 0; i < at->n; i++) {
			if (tb_get(e->table, tb_string(at->keys[i]), tb_string(id)) == NULL) {
				gone = at->keys[i];
				break;
			}
		}
		if (gone == NULL) break;
		char *part = es_dup(gone);
		told = unhold(h, part, id) || told;
		free(part);
	}
	if (told) mark_held(e);
}

int es_held_at(es_ermine *e, const char *part, const char *id, es_held *out) {
	track_held(e);
	held_rec *r = held_of(host_of(e), part, id);
	if (r == NULL) return 0;
	*out = (es_held){r->feature, NULL};
	return 1;
}

int es_held_status(es_ermine *e, const char *id, es_held *out) {
	track_held(e);
	held_rec *r = held_of(host_of(e), CST_TABLE, id);
	if (r == NULL || !r->touches) return 0;
	*out = (es_held){r->feature, "status"};
	return 1;
}

// the row of a stopped process, as it is now: its row gone (a later write took it out), the entry goes
static row_rec *row_held(es_ermine *e, const char *id);
static const char *row_at(es_ermine *e, const char *root, char *const *at, size_t nat) {
	nd_entry *entry = tb_get(e->table, tb_string(PART_PROCESS), tb_string(root));
	const op_value *v = entry != NULL ? entry->value : NULL;
	for (size_t i = 0; i < nat; i++) {
		v = v != NULL && v->type == OP_MAP ? op_get(v, at[i]) : NULL;
	}
	// a process with processes under it: its id is under "" in its level
	if (v != NULL && v->type == OP_MAP) v = op_get(v, "");
	return v != NULL && v->type == OP_STR ? v->str : NULL;
}
static void row_free(row_rec *r) {
	free(r->root);
	pr_names_free(r->at, r->nat);
	free(r);
}
static row_rec *row_held(es_ermine *e, const char *id) {
	hosting *h = host_of(e);
	row_rec *r = es_map_get(&h->rows, id);
	if (r == NULL) return NULL;
	const char *there = row_at(e, r->root, r->at, r->nat);
	if (there != NULL && strcmp(there, id) == 0) return r;
	es_map_del(&h->rows, id);
	row_free(r);
	return NULL;
}

int es_held_row(es_ermine *e, const char *id, es_held *out) {
	track_held(e);
	row_rec *r = row_held(e, id);
	if (r == NULL) return 0;
	*out = (es_held){r->feature, "row"};
	return 1;
}

// hooks and their chains -------------------------------------------------------------------------------------------

// what a hook's code is passed up as: PENDING, STOP, a FeatureError, and what its next gave pass as they
// are; a Refusal as it is, its feature and hook named on it (the first to throw it); else a FeatureError
static int own(const char *feature, const char *hook, int code, int passed) {
	if (code == 0) return 0;
	if (code == ES_PENDING || code == ES_STOP || code == ES_FEATURE) return code;
	if (passed != 0 && code == passed) return code;
	if (code == ES_REFUSED) {
		if (thrown.feature == NULL) {
			thrown.feature = es_dup(feature);
			thrown.hook = es_dup(hook);
		}
		return code;
	}
	return es_fail_feature(feature, hook,
		thrown.message != NULL ? thrown.message : es_code_name(code));
}

// onTable ---------------------------------------------------------------------------------------------------------------

struct es_table_next {
	es_ermine *e;
	size_t i;
	int passed;
};

static void dispatch_event(es_ermine *e, layer_rec *r, tb_key part, tb_key id) {
	for (; r != NULL; r = r->ahead) {
		if (r->out.event != NULL) {
			r->out.event(r->out.ctx, part, id);
			return;
		}
	}
	if (e->places != NULL) pl_event(e->places, part, id);
}
static void dispatch_commit(es_ermine *e, layer_rec *r, const pl_changed *changed) {
	for (; r != NULL; r = r->ahead) {
		if (r->out.commit != NULL) {
			r->out.commit(r->out.ctx, changed);
			return;
		}
	}
	if (e->places != NULL) pl_commit(e->places, changed);
}

// the raw table's events, and every commit, go first to the innermost layer
static void table_event(void *ctx, tb_key part, tb_key id) {
	es_ermine *e = ctx;
	dispatch_event(e, host_of(e)->innermost, part, id);
}
void es_commit_changed(es_ermine *e, const pl_changed *changed) {
	dispatch_commit(e, host_of(e)->innermost, changed);
}
static void commit_changed(void *ctx, const pl_changed *changed) { es_commit_changed(ctx, changed); }
// what is in front of a layer a hook gave, asked by the hook (places, until it has given one)
static void ahead_event(void *ctx, tb_key part, tb_key id) {
	layer_rec *r = ctx;
	if (!r->made) {
		if (r->e->places != NULL) pl_event(r->e->places, part, id);
	} else {
		dispatch_event(r->e, r->ahead, part, id);
	}
}
static void ahead_commit(void *ctx, const pl_changed *changed) {
	layer_rec *r = ctx;
	if (!r->made) {
		if (r->e->places != NULL) pl_commit(r->e->places, changed);
	} else {
		dispatch_commit(r->e, r->ahead, changed);
	}
}

static int table_at(es_ermine *e, size_t i, tb_table *t, es_layer *out) {
	hosting *h = host_of(e);
	hook_list *l = &h->hooks[ES_ON_TABLE];
	if (i == l->n) {
		*out = (es_layer){.front = t};
		return 0;
	}
	hook_rec *r = &l->items[i];
	layer_rec *rec = es_alloc(sizeof *rec);
	rec->e = e;
	rec->feature = r->feature;
	ES_PUSH(h->layers, h->nlayers, h->caplayers, rec);
	es_under under = {t, ahead_event, ahead_commit, rec};
	es_table_next next = {e, i, 0};
	*out = (es_layer){0};
	int code = r->fn.table(r->ctx, &under, &next, out);
	code = own(r->feature, "onTable", code, next.passed);
	if (code != 0) return code;
	rec->out = *out;
	rec->made = 1;
	return 0;
}

int es_next_table(es_table_next *next, const es_under *under, es_layer *out) {
	int code = table_at(next->e, next->i + 1, under->table, out);
	next->passed = code;
	return code;
}

// each layer's ahead: the next one outward with an event or a commit; the innermost to hear the table
static void link_layers(es_ermine *e) {
	hosting *h = host_of(e);
	h->innermost = NULL;
	for (size_t k = h->nlayers; k-- > 0;) {
		layer_rec *rec = h->layers[k];
		rec->ahead = NULL;
		for (size_t j = k; j-- > 0;) {
			if (h->layers[j]->out.event != NULL || h->layers[j]->out.commit != NULL) {
				rec->ahead = h->layers[j];
				break;
			}
		}
		if (h->innermost == NULL && (rec->out.event != NULL || rec->out.commit != NULL)) {
			h->innermost = rec;
		}
	}
}

// onWrite ---------------------------------------------------------------------------------------------------------------

typedef struct {
	es_ermine *e;
	int (*land)(void *ctx, const es_write *w);
	void *ctx;
	int landed;
} write_frame;

struct es_write_next {
	write_frame *f;
	size_t i;
	const es_write *given;
	int passed;
};

// the end of the chain: the write lands. what was held at it is let go, and told
static int write_land(write_frame *f, const es_write *x) {
	es_ermine *e = f->e;
	hosting *h = host_of(e);
	f->landed = 1;
	int told = unhold(h, x->part, x->id);
	// a write at a root a held row is under: whoever read that row's status is told
	if (!told && strcmp(x->part, PART_PROCESS) == 0) {
		for (size_t i = 0; i < h->rows.n; i++) {
			if (strcmp(((row_rec *)h->rows.vals[i])->root, x->id) == 0) {
				told = 1;
				break;
			}
		}
	}
	// marked before it lands: a mark only schedules the rerun, which reads after
	if (told) mark_held(e);
	return f->land(f->ctx, x);
}

static int write_at(write_frame *f, size_t i, es_context *o, const es_write *w) {
	hosting *h = host_of(f->e);
	hook_list *l = &h->hooks[ES_ON_WRITE];
	if (i == l->n) return write_land(f, w);
	hook_rec *r = &l->items[i];
	es_write_next next = {f, i, w, 0};
	h->deepest = r->feature;
	int code = r->fn.write(r->ctx, o, w, &next);
	return own(r->feature, "onWrite", code, next.passed);
}

int es_next_write(es_write_next *next, es_context *o, const es_write *w) {
	hosting *h = host_of(next->f->e);
	hook_rec *r = &h->hooks[ES_ON_WRITE].items[next->i];
	es_write tagged;
	const char **features = NULL;
	const es_write *pass = w;
	// a write a hook changed: the base's own fields from what that hook was given, its name added
	if (w != next->given) {
		size_t n = next->given->nfeatures;
		features = es_alloc((n + 1) * sizeof *features);
		for (size_t k = 0; k < n; k++) features[k] = next->given->features[k];
		features[n] = r->feature;
		tagged = *w;
		tagged.features = features;
		tagged.nfeatures = n + 1;
		pass = &tagged;
	}
	int code = write_at(next->f, next->i + 1, o, pass);
	free(features);
	next->passed = code;
	return code;
}

int es_hook_write(es_ermine *e, es_context *o, const es_write *w,
	int (*land)(void *ctx, const es_write *w), void *ctx) {
	hosting *h = host_of(e);
	const char *was = h->deepest;
	h->deepest = NULL;
	write_frame f = {e, land, ctx, 0};
	int code = write_at(&f, 0, o, w);
	const char *by = h->deepest;
	h->deepest = was;
	if (code != 0) return code;
	// not landed, the innermost hook called did not call next: held, shown at its node
	if (!f.landed && by != NULL) {
		hold(h, w->part, w->id, by, strcmp(w->part, CST_TABLE) == 0 && touches_status(w));
		mark_held(e);
	}
	return 0;
}

// onRead ---------------------------------------------------------------------------------------------------------------

struct es_read_next {
	es_ermine *e;
	size_t i;
	const es_versions *given;
	es_version *snapshot;
	size_t nsnapshot;
	int passed;
};

static int same_version(const es_version *a, const es_version *b) {
	return a->value == b->value && a->from.change == b->from.change && a->from.view == b->from.view &&
		a->from.kind == b->from.kind && a->from.feature == b->from.feature &&
		a->from.more == b->from.more && a->gone == b->gone && a->inside == b->inside &&
		a->held == b->held;
}
static int had_version(const es_version *items, size_t n, const es_version *x) {
	for (size_t k = 0; k < n; k++) {
		if (same_version(&items[k], x)) return 1;
	}
	return 0;
}
// the items of after that are not in before, and name no feature, name this one
static void tag_fresh(const char *feature, const es_version *before, size_t nbefore, es_version *after,
	size_t nafter) {
	for (size_t k = 0; k < nafter; k++) {
		if (had_version(before, nbefore, &after[k])) continue;
		if (after[k].from.feature == NULL) after[k].from.feature = feature;
	}
}

static int read_at(es_ermine *e, size_t i, const es_reading *x, const es_versions *items,
	es_versions *out) {
	hosting *h = host_of(e);
	hook_list *l = &h->hooks[ES_ON_READ];
	if (i == l->n) {
		// the base's: what reads showed, as it is
		out->n = out->cap = items->n;
		out->items = items->n ? es_alloc(items->n * sizeof *out->items) : NULL;
		if (items->n) memcpy(out->items, items->items, items->n * sizeof *out->items);
		return 0;
	}
	hook_rec *r = &l->items[i];
	es_read_next next = {e, i, items, NULL, 0, 0};
	*out = (es_versions){0};
	int code = r->fn.read(r->ctx, x, items, &next, out);
	code = own(r->feature, "onRead", code, next.passed);
	if (code == 0) {
		// what it added after next, or in place of it, is the feature's
		if (next.snapshot != NULL) tag_fresh(r->feature, next.snapshot, next.nsnapshot, out->items, out->n);
		else tag_fresh(r->feature, items->items, items->n, out->items, out->n);
	}
	free(next.snapshot);
	return code;
}

int es_next_read(es_read_next *next, const es_reading *x, const es_versions *items,
	es_versions *out) {
	hosting *h = host_of(next->e);
	hook_rec *r = &h->hooks[ES_ON_READ].items[next->i];
	// what it passes on: the items new to this hook are the feature's
	es_versions tagged = {0};
	if (items->n) {
		tagged.items = es_alloc(items->n * sizeof *tagged.items);
		memcpy(tagged.items, items->items, items->n * sizeof *tagged.items);
	}
	tagged.n = tagged.cap = items->n;
	tag_fresh(r->feature, next->given->items, next->given->n, tagged.items, tagged.n);
	int code = read_at(next->e, next->i + 1, x, &tagged, out);
	free(tagged.items);
	next->passed = code;
	free(next->snapshot);
	next->snapshot = NULL;
	next->nsnapshot = 0;
	if (code == 0 && out->n) {
		next->snapshot = es_alloc(out->n * sizeof *next->snapshot);
		memcpy(next->snapshot, out->items, out->n * sizeof *next->snapshot);
		next->nsnapshot = out->n;
	} else if (code == 0) {
		next->snapshot = es_alloc(sizeof *next->snapshot);
	}
	return code;
}

int es_hook_read(es_ermine *e, const es_reading *x, const es_versions *items, es_versions *out) {
	return read_at(e, 0, x, items, out);
}

// onTeardown --------------------------------------------------------------------------------------------------------------

typedef struct {
	es_ermine *e;
	void (*fn)(void *ctx, const char *why);
	void *ctx;
} teardown_frame;
struct es_teardown_next {
	teardown_frame *f;
	size_t i;
	int passed;
};

static int teardown_at(teardown_frame *f, size_t i, sc_scope *scope, const char *why) {
	hook_list *l = &host_of(f->e)->hooks[ES_ON_TEARDOWN];
	if (i == l->n) {
		f->fn(f->ctx, why);
		return 0;
	}
	hook_rec *r = &l->items[i];
	es_teardown_next next = {f, i, 0};
	int code = r->fn.teardown(r->ctx, scope, why, &next);
	return own(r->feature, "onTeardown", code, next.passed);
}

int es_next_teardown(es_teardown_next *next, sc_scope *scope, const char *why) {
	int code = teardown_at(next->f, next->i + 1, scope, why);
	next->passed = code;
	return code;
}

int es_hook_teardown(es_ermine *e, sc_scope *scope, const char *why,
	void (*fn)(void *ctx, const char *why), void *ctx) {
	teardown_frame f = {e, fn, ctx};
	return teardown_at(&f, 0, scope, why);
}

// onRecord ----------------------------------------------------------------------------------------------------------------

typedef struct {
	es_ermine *e;
	void (*keep)(void *ctx, const es_recorded *r);
	void *ctx;
} record_frame;
struct es_record_next {
	record_frame *f;
	size_t i;
	int passed;
};

static int record_at(record_frame *f, size_t i, const es_recorded *x) {
	hook_list *l = &host_of(f->e)->hooks[ES_ON_RECORD];
	if (i == l->n) {
		f->keep(f->ctx, x);
		return 0;
	}
	hook_rec *r = &l->items[i];
	es_record_next next = {f, i, 0};
	int code = r->fn.record(r->ctx, x, &next);
	return own(r->feature, "onRecord", code, next.passed);
}

int es_next_record(es_record_next *next, const es_recorded *r) {
	int code = record_at(next->f, next->i + 1, r);
	next->passed = code;
	return code;
}

int es_hook_record(es_ermine *e, const es_recorded *r,
	void (*keep)(void *ctx, const es_recorded *r), void *ctx) {
	record_frame f = {e, keep, ctx};
	return record_at(&f, 0, r);
}

// onStatus ----------------------------------------------------------------------------------------------------------------

struct es_status_next {
	es_ermine *e;
	size_t i;
	int passed;
};

static int status_at(es_ermine *e, size_t i, const es_asked *x, const es_status *st, es_status *out) {
	hook_list *l = &host_of(e)->hooks[ES_ON_STATUS];
	if (i == l->n) {
		*out = *st;
		return 0;
	}
	hook_rec *r = &l->items[i];
	es_status_next next = {e, i, 0};
	*out = *st;
	int code = r->fn.status(r->ctx, x, st, &next, out);
	return own(r->feature, "onStatus", code, next.passed);
}

int es_next_status(es_status_next *next, const es_asked *x, const es_status *st, es_status *out) {
	int code = status_at(next->e, next->i + 1, x, st, out);
	next->passed = code;
	return code;
}

// a status made whole again, none of it shared (state, phase and held_write are static strings)
static void status_copy(const es_status *s, es_status *out) {
	*out = *s;
	if (s->held_feature != NULL) out->held_feature = es_dup(s->held_feature);
	if (s->error != NULL) out->error = es_dup(s->error);
	out->waiting = NULL;
	if (s->nwaiting > 0) {
		out->waiting = es_alloc(s->nwaiting * sizeof *out->waiting);
		for (size_t i = 0; i < s->nwaiting; i++) {
			out->waiting[i] = s->waiting[i];
			if (s->waiting[i].has_path) {
				out->waiting[i].path = es_alloc((s->waiting[i].npath + 1) * sizeof(char *));
				for (size_t k = 0; k < s->waiting[i].npath; k++) {
					out->waiting[i].path[k] = es_dup(s->waiting[i].path[k]);
				}
			}
		}
	}
	out->more = op_ref(s->more);
}

int es_hook_status(es_ermine *e, const es_asked *x, const es_status *st, es_status *out) {
	es_status last;
	TRY(status_at(e, 0, x, st, &last));
	status_copy(&last, out);
	return 0;
}

// features ---------------------------------------------------------------------------------------------------------------

static int add_hook(es_feature_api *f, es_hook kind, hook_rec rec) {
	fapi *a = f->private_;
	hosting *h = host_of(a->e);
	if (!h->adding) {
		return es_fail_ermine(ES_SETUP_ONLY, "%s's %s: add the feature to createErmine", a->name,
			HOOK_NAMES[kind]);
	}
	rec.feature = a->name;
	hook_list *l = &h->hooks[kind];
	ES_PUSH(l->items, l->n, l->cap, rec);
	int used = 0;
	for (size_t i = 0; i < a->nused; i++) used = used || a->used[i] == kind;
	if (!used) ES_PUSH(a->used, a->nused, a->cap, kind);
	return 0;
}

int es_on_table(es_feature_api *f, es_on_table_fn fn, void *ctx) {
	hook_rec r = {.ctx = ctx};
	r.fn.table = fn;
	return add_hook(f, ES_ON_TABLE, r);
}
int es_on_read(es_feature_api *f, es_on_read_fn fn, void *ctx) {
	hook_rec r = {.ctx = ctx};
	r.fn.read = fn;
	return add_hook(f, ES_ON_READ, r);
}
int es_on_write(es_feature_api *f, es_on_write_fn fn, void *ctx) {
	hook_rec r = {.ctx = ctx};
	r.fn.write = fn;
	return add_hook(f, ES_ON_WRITE, r);
}
int es_on_teardown(es_feature_api *f, es_on_teardown_fn fn, void *ctx) {
	hook_rec r = {.ctx = ctx};
	r.fn.teardown = fn;
	return add_hook(f, ES_ON_TEARDOWN, r);
}
int es_on_record(es_feature_api *f, es_on_record_fn fn, void *ctx) {
	hook_rec r = {.ctx = ctx};
	r.fn.record = fn;
	return add_hook(f, ES_ON_RECORD, r);
}
int es_on_status(es_feature_api *f, es_on_status_fn fn, void *ctx) {
	hook_rec r = {.ctx = ctx};
	r.fn.status = fn;
	return add_hook(f, ES_ON_STATUS, r);
}

int es_listened(es_feature_api *f, sc_listener *l) {
	fapi *a = f->private_;
	hosting *h = host_of(a->e);
	ES_PUSH(h->listened, h->nlistened, h->caplistened, l);
	return 0;
}

// what is made after setup: a feature asking before gets not-yet
static int after_setup(const char *what, int ready) {
	if (ready) return 0;
	return es_fail_ermine(ES_NOT_YET, "%s is made after setup: use it in a hook", what);
}

int es_api_places(es_feature_api *f, pl **out) {
	fapi *a = f->private_;
	TRY(after_setup("places", a->e->places != NULL));
	*out = a->e->places;
	return 0;
}

int es_api_processes(es_feature_api *f, pr **out) {
	fapi *a = f->private_;
	TRY(after_setup("processes", a->e->processes != NULL));
	*out = a->e->processes;
	return 0;
}

int es_api_get_process_context(es_feature_api *f, pr_process *process, es_context **out) {
	fapi *a = f->private_;
	es_ermine *e = a->e;
	TRY(after_setup("getProcessContext", host_of(e)->made));
	*out = NULL;
	if (process == NULL) {
		*out = e->host_context;
		return 0;
	}
	*out = es_map_get(&host_of(e)->contexts, pr_id(process));
	return 0;
}

int es_api_handle_of(es_feature_api *f, const es_node_data *node, es_handle **out) {
	fapi *a = f->private_;
	es_ermine *e = a->e;
	TRY(after_setup("handleOf", host_of(e)->made));
	*out = es_mint(e, node);
	return 0;
}

int es_api_data_of(es_feature_api *f, const void *x, es_node_data *node) {
	fapi *a = f->private_;
	es_ermine *e = a->e;
	if (after_setup("dataOf", host_of(e)->made)) return 0;
	const es_handle_data *d = es_handle_lookup(e, x);
	if (d == NULL) return 0;
	*node = es_node_data_copy(&d->node);
	return 1;
}

int es_api_seen(es_feature_api *f, const char *id, es_context *context, es_names *out) {
	fapi *a = f->private_;
	es_ermine *e = a->e;
	TRY(after_setup("seen", host_of(e)->made));
	*out = (es_names){0};
	// another ermine's context sees nothing here (the TypeScript's: none), not the root
	if (context->ermine != e) return es_fail(ES_NOTHING_THERE, "nothing-there");
	if (es_seen_in(e, context, id, out)) return 0;
	return es_fail(ES_NOTHING_THERE, "nothing-there");
}

int es_reserve_slot(es_feature_api *f, es_slot **out) {
	fapi *a = f->private_;
	hosting *h = host_of(a->e);
	if (!h->adding) return es_fail_ermine(ES_SETUP_ONLY, "%s's reserveSlot", a->name);
	es_slot *s = es_alloc(sizeof *s);
	s->next = h->slots;
	h->slots = s;
	*out = s;
	return 0;
}

int es_slot_get(const es_slot *s, es_context *c, long *out) {
	long *v = pm_get(&s->held, c);
	if (v == NULL) return 0;
	*out = *v;
	return 1;
}

void es_slot_set(es_slot *s, es_context *c, long value) {
	long *v = pm_get(&s->held, c);
	if (v == NULL) {
		v = es_alloc(sizeof *v);
		pm_set(&s->held, c, v);
	}
	*v = value;
}

// the features in chain order: each one's needs first, else the order given
typedef struct {
	const es_feature *const *features;
	size_t n;
	es_map named;
	// by name: 1 doing, 2 done
	es_map state;
	const es_feature **order;
	size_t norder, caporder;
	const char **way;
	size_t nway, capway;
	int code;
} ordering;

static const es_feature *feature_named(ordering *o, const char *name) {
	size_t at = (size_t)(uintptr_t)es_map_get(&o->named, name);
	return at == 0 ? NULL : o->features[at - 1];
}

static int order_visit(ordering *o, const es_feature *f) {
	void *s = es_map_get(&o->state, f->name);
	if (s == (void *)2) return 0;
	if (s == (void *)1) {
		size_t len = strlen(f->name) + 1;
		for (size_t i = 0; i < o->nway; i++) len += strlen(o->way[i]) + 5;
		char *text = es_alloc(len + 1);
		for (size_t i = 0; i < o->nway; i++) {
			strcat(text, o->way[i]);
			strcat(text, " \xe2\x86\x92 ");
		}
		strcat(text, f->name);
		es_fail_ermine(ES_NEEDS_LOOP, "%s", text);
		free(text);
		return ES_NEEDS_LOOP;
	}
	es_map_set(&o->state, f->name, (void *)1);
	for (size_t i = 0; i < f->nneeds; i++) {
		const es_feature *g = feature_named(o, f->needs[i]);
		if (g == NULL) {
			return es_fail_ermine(ES_MISSING_FEATURE, "%s needs %s", f->name, f->needs[i]);
		}
		ES_PUSH(o->way, o->nway, o->capway, f->name);
		int code = order_visit(o, g);
		o->nway--;
		if (code != 0) return code;
	}
	es_map_set(&o->state, f->name, (void *)2);
	ES_PUSH(o->order, o->norder, o->caporder, f);
	return 0;
}

static void ordering_free(ordering *o) {
	es_map_free(&o->named);
	es_map_free(&o->state);
	free(o->order);
	free(o->way);
}

// each feature's setup run with its own api, in chain order
static int install(es_ermine *e, const es_options *options) {
	hosting *h = host_of(e);
	ordering o = {.features = options->features, .n = options->nfeatures};
	int code = 0;
	for (size_t i = 0; i < o.n && code == 0; i++) {
		if (es_map_has(&o.named, o.features[i]->name)) {
			code = es_fail_ermine(ES_FEATURE_TWICE, "%s", o.features[i]->name);
		} else {
			es_map_set(&o.named, o.features[i]->name, (void *)(uintptr_t)(i + 1));
		}
	}
	for (size_t i = 0; i < o.n && code == 0; i++) code = order_visit(&o, o.features[i]);
	for (size_t i = 0; i < o.norder && code == 0; i++) {
		const es_feature *f = o.order[i];
		fapi *a = es_alloc(sizeof *a);
		ES_PUSH(h->apis, h->napis, h->capapis, a);
		a->e = e;
		a->name = es_dup(f->name);
		a->api = (es_feature_api){e->scheduler, e->table, a};
		if (f->setup != NULL) code = f->setup(f->ctx, &a->api);
		if (code != 0) break;
		es_shown s = {0};
		s.name = es_dup(f->name);
		s.needs = es_alloc((f->nneeds + 1) * sizeof *s.needs);
		for (size_t k = 0; k < f->nneeds; k++) s.needs[k] = es_dup(f->needs[k]);
		s.nneeds = f->nneeds;
		s.hooks = es_alloc((a->nused + 1) * sizeof *s.hooks);
		memcpy(s.hooks, a->used, a->nused * sizeof *s.hooks);
		s.nhooks = a->nused;
		ES_PUSH(h->shown, h->nshown, h->capshown, s);
	}
	ordering_free(&o);
	return code;
}

// the features as the host's node shows them
static op_value *shown_value(es_ermine *e) {
	hosting *h = host_of(e);
	op_value *list = op_list();
	for (size_t i = 0; i < h->nshown; i++) {
		const es_shown *s = &h->shown[i];
		op_value *m = op_map();
		op_set(m, "name", op_str(s->name));
		op_set(m, "needs", names_value(CP(s->needs), s->nneeds));
		op_value *hooks = op_list();
		for (size_t k = 0; k < s->nhooks; k++) op_push(hooks, op_str(HOOK_NAMES[s->hooks[k]]));
		op_set(m, "hooks", hooks);
		op_push(list, m);
	}
	return list;
}

const es_shown *es_features(es_ermine *e, size_t *n) {
	if (es_alive(e)) {
		*n = 0;
		return NULL;
	}
	es_clear_thrown();
	*n = host_of(e)->nshown;
	return host_of(e)->shown;
}

// createErmine ---------------------------------------------------------------------------------------------------------------

static void keep_value(hosting *h, op_value *v) { ES_PUSH(h->keep, h->nkeep, h->capkeep, v); }

// the root node and the host's node, written as the host
typedef struct {
	es_ermine *e;
	const es_options *o;
} init_args;

static int init_nodes(void *data) {
	init_args *a = data;
	es_ermine *e = a->e;
	op_value *kids = op_map();
	op_patch whole = {.has_value = 1, .value = kids};
	es_write w = {.part = PART_CHILDREN, .id = e->root, .patches = &whole, .npatches = 1};
	int code = es_context_put(e->host_context, &w);
	op_free(kids);
	if (code != 0) return code;
	op_value *attrs = op_map();
	op_set(attrs, ES_ARGS, names_value(a->o->host.args, a->o->host.nargs));
	if (a->o->host.machine != NULL) op_set(attrs, ES_MACHINE, op_ref((op_value *)a->o->host.machine));
	op_set(attrs, ES_FEATURES_ATTRIBUTE, shown_value(e));
	whole.value = attrs;
	w = (es_write){.part = PART_ATTRIBUTES, .id = e->node, .patches = &whole, .npatches = 1};
	code = es_context_put(e->host_context, &w);
	op_free(attrs);
	return code;
}

static void remember_context(es_ermine *e, es_context *c) {
	hosting *h = host_of(e);
	ES_PUSH(h->all, h->nall, h->capall, c);
}

// a process's context, its scope freed: out of what the host and features keep by it, and freed
static void forget_context(es_ermine *e, es_context *c) {
	hosting *h = host_of(e);
	for (size_t i = 0; i < h->nall; i++) {
		if (h->all[i] != c) continue;
		h->all[i] = h->all[--h->nall];
		break;
	}
	for (es_slot *sl = h->slots; sl != NULL; sl = sl->next) {
		long *held = pm_get(&sl->held, c);
		if (held == NULL) continue;
		pm_delete(&sl->held, c);
		free(held);
	}
	for (size_t i = 0; i < h->nprocs; i++)
		if (h->procs[i]->context == c) h->procs[i]->context = NULL;
	es_context_free(c);
}

// everything the libraries made, let go in the order they need
static void release(es_ermine *e) {
	hosting *h = host_of(e);
	if (h->unread != NULL) un_unwire(h->unread);
	h->unread = NULL;
	if (e->calls != NULL) es_calls_free(e->calls);
	e->calls = NULL;
	if (e->actions != NULL) es_actions_free(e->actions);
	e->actions = NULL;
	// the contexts and handles stay (a closed ermine is still asked, and says closed): es_free
	for (size_t i = 0; i < h->nall; i++) es_computer_forget(h->all[i]);
	if (e->computers != NULL) es_computers_free(e->computers);
	e->computers = NULL;
	if (h->owns && e->scheduler != NULL) sc_free(e->scheduler);
	if (e->table != NULL) tb_free(e->table);
	if (e->paths != NULL) pt_free(e->paths);
	if (e->places != NULL) pl_free(e->places);
	if (e->processes != NULL) pr_free(e->processes);
	if (e->statuses != NULL) cst_free(e->statuses);
	if (e->runs != NULL) crn_free(e->runs);
	if (e->scopes != NULL) sn_free(e->scopes);
	if (e->sites != NULL) st_free(e->sites);
	e->table = e->front = NULL;
	e->paths = NULL;
	e->places = NULL;
	e->processes = NULL;
	e->statuses = NULL;
	e->runs = NULL;
	e->scopes = NULL;
	e->sites = NULL;
	if (h->owns) {
		for (size_t i = 0; i < h->nkeep; i++) op_free(h->keep[i]);
		h->nkeep = 0;
	}
	for (size_t i = 0; i < h->nblocks; i++) pl_made_free(h->blocks[i]);
	h->nblocks = 0;
	for (size_t i = 0; i < h->nlayers; i++) free(h->layers[i]);
	h->nlayers = 0;
	h->innermost = NULL;
	for (size_t k = 0; k < ES_HOOKS; k++) h->hooks[k].n = 0;
	for (size_t i = 0; i < h->nshown; i++) {
		free(h->shown[i].name);
		pr_names_free(h->shown[i].needs, h->shown[i].nneeds);
		free(h->shown[i].hooks);
	}
	h->nshown = 0;
	for (size_t i = 0; i < h->rows.n; i++) row_free(h->rows.vals[i]);
	es_map_free(&h->rows);
	for (size_t i = 0; i < h->held.n; i++) {
		es_map *at = h->held.vals[i];
		for (size_t k = 0; k < at->n; k++) free(at->vals[k]);
		es_map_free(at);
		free(at);
	}
	es_map_free(&h->held);
	es_map_free(&h->run_held);
}

// the listeners and registrations an ermine has made, taken away
static void unlisten(es_ermine *e) {
	hosting *h = host_of(e);
	if (h->settle != NULL) sc_remove_listener(h->settle);
	if (h->tracking != NULL) sc_remove_listener(h->tracking);
	if (h->pulsed != NULL) sc_remove_listener(h->pulsed);
	if (h->freed != NULL) sc_remove_listener(h->freed);
	if (h->tracking_first != NULL) sc_remove_listener(h->tracking_first);
	h->settle = h->tracking = h->tracking_first = h->pulsed = h->freed = NULL;
	for (size_t i = 0; i < h->nlistened; i++) sc_remove_listener(h->listened[i]);
	h->nlistened = 0;
	if (h->registered) sched_drop(e->scheduler);
	h->registered = 0;
	for (size_t i = 0; i < h->nscopes; i++) pm_delete(&scope_context, h->scopes[i]);
	h->nscopes = 0;
}

static void free_hosting(es_ermine *e);

// made so far, let go of: createErmine threw
static void abandon(es_ermine *e) {
	if (e->host_scope != NULL) free(sc_teardown(e->host_scope));
	if (e->statuses != NULL) cst_stop(e->statuses);
	if (e->runs != NULL) crn_stop(e->runs);
	es_calls_stop(e);
	if (e->processes != NULL) pr_halt(e->processes);
	unlisten(e);
	release(e);
	if (e->nodes != NULL) es_nodes_free(e->nodes);
	e->nodes = NULL;
	free_hosting(e);
}

// what the host held, let go: the ermine is closed, or never made
static void free_hosting(es_ermine *e) {
	hosting *h = host_of(e);
	for (size_t i = 0; i < h->nprocs; i++) {
		free(h->procs[i]->id);
		op_free(h->procs[i]->at_value);
		free(h->procs[i]);
	}
	free(h->procs);
	// what scopes not freed borrow: the scheduler's, so kept when it is the host's
	for (size_t i = 0; i < h->with.cap; i++)
		if (h->with.keys[i] != NULL && h->owns) op_free(h->with.vals[i]);
	pm_clear(&h->with);
	pm_clear(&h->children);
	for (es_slot *sl = h->slots; sl != NULL;) {
		es_slot *next = sl->next;
		for (size_t i = 0; i < sl->held.cap; i++) {
			if (sl->held.keys[i] != NULL) free(sl->held.vals[i]);
		}
		pm_clear(&sl->held);
		free(sl);
		sl = next;
	}
	for (size_t i = 0; i < h->napis; i++) {
		free(h->apis[i]->name);
		free(h->apis[i]->used);
		free(h->apis[i]);
	}
	for (size_t k = 0; k < ES_HOOKS; k++) free(h->hooks[k].items);
	free(h->apis);
	free(h->shown);
	free(h->layers);
	free(h->listened);
	free(h->all);
	free(h->scopes);
	free(h->keep);
	free(h->blocks);
	es_map_free(&h->contexts);
	es_map_free(&e->whys);
	free(e->root);
	free(e->node);
	free(h);
	free(e);
}

void es_free(es_ermine *e) {
	if (e == NULL) return;
	es_close(e);
	es_clear_thrown();
	for (es_ermine **at = &closed_ermines; *at != NULL; at = &host_of(*at)->next_closed) {
		if (*at == e) {
			*at = host_of(e)->next_closed;
			break;
		}
	}
	if (e->nodes != NULL) es_nodes_free(e->nodes);
	e->nodes = NULL;
	free_hosting(e);
}

// the libraries' writes and records ---------------------------------------------------------------------------------------

// the processes' rows and start's attributes: written as the host, through onWrite
static void host_write(void *ctx, const char *part, tb_key id, const op_patch *patches, size_t n,
	const ch_header *header) {
	es_ermine *e = ctx;
	es_context_writer(e->host_context, part, id, patches, n, header);
}

// a computer's status: written as the context that made it, else as the host
static void status_write(void *ctx, const char *part, tb_key id, const op_patch *patches, size_t n,
	const ch_header *header) {
	es_ermine *e = ctx;
	es_context *c = es_computer_context(e, id.string);
	es_context_writer(c != NULL ? c : e->host_context, part, id, patches, n, header);
}

// a run's record, told to onRecord (naming the feature that held its status write back) and held when
// the hooks let it through. a hook's changed run is not held: the record is held as it was given
typedef struct {
	es_ermine *e;
	crn_take take;
	void *taking;
} run_holding;
static void run_keep(void *ctx, const es_recorded *r) {
	run_holding *k = ctx;
	if (r->run == NULL) return;
	es_map *m = &host_of(k->e)->run_held;
	if (r->held != NULL) es_map_set(m, r->id, (void *)r->held);
	else es_map_del(m, r->id);
	k->take(k->taking);
}
static void run_hold(void *ctx, tb_key id, crn_run *run, crn_take take, void *taking) {
	es_ermine *e = ctx;
	held_rec *h = held_of(host_of(e), CST_TABLE, id.string);
	es_recorded r = {.id = id.string, .run = run, .held = h != NULL && h->touches ? h->feature : NULL};
	run_holding k = {e, take, taking};
	es_hook_record(e, &r, run_keep, &k);
}

int es_create(const es_options *given, es_ermine **out) {
	es_options none = {0};
	const es_options *o = given != NULL ? given : &none;
	es_ermine *e = es_alloc(sizeof *e);
	hosting *h = es_alloc(sizeof *h);
	e->hosting = h;
	e->id = o->id;
	e->id_ctx = o->id_ctx;
	e->may = o->may;
	e->on_create_function = o->on_create_function;
	e->on_create_function_ctx = o->on_create_function_ctx;
	e->user_activated = o->user_activated;
	e->user_activated_ctx = o->user_activated_ctx;
	h->adding = 1;
	h->schedule = o->schedule;
	h->schedule_ctx = o->schedule_ctx;
	int code = 0;

	// 1. the scheduler
	h->owns = o->scheduler == NULL;
	e->scheduler = o->scheduler != NULL ? o->scheduler : sc_new((sc_options){.drop = es_drop, .data = e});

	// 2. sites. ours: explicit in C, so nothing to skip
	e->sites = st_new(e->scheduler);

	// 3. the table; each feature's setup; onTable's layers over it
	e->table = tb_make(table_event, e);
	e->front = e->table;
	if ((code = install(e, o)) != 0) goto fail;
	{
		es_layer top;
		if ((code = table_at(e, 0, e->table, &top)) != 0) goto fail;
		link_layers(e);
		e->front = top.front;
	}

	// 4. places over the front, with the processes' rows
	e->root = o->root != NULL ? es_dup(o->root) : es_new_id(e);
	e->places = pl_new();
	e->paths = pt_new();
	pr_processes_init(&h->rows_walk, tb_string(e->root));
	h->contributors[0] = &h->rows_walk.contributor;
	h->contributors[1] = &pl_children;
	pl_connect(e->places, &(pl_setup){.root = tb_string(e->root), .table = e->front, .paths = e->paths,
		.scheduler = e->scheduler, .contributors = h->contributors, .ncontributors = 2, .tracking = 1});
	h->tracking = sc_on_tracking_end(e->scheduler, pl_forget, e->places);
	h->tracking_first = sc_on_tracking_start(e->scheduler, pl_tracking, e->places);
	h->unread = un_keeping(e->scheduler, pl_unread(e->places), NULL, NULL);

	// 5. the host's node and scope; pulses; the states the files keep
	e->node = es_new_id(e);
	{
		sc_pair *info = es_alloc((o->ninfo + 1) * sizeof *info);
		for (size_t i = 0; i < o->ninfo; i++) info[i] = o->info[i];
		op_value *node = op_str(e->node);
		keep_value(h, node);
		info[o->ninfo] = (sc_pair){PL_NODE, node};
		e->host_scope = sc_create_root_scope(e->scheduler, info, o->ninfo + 1);
		free(info);
	}
	h->settle = sc_on_settle(e->scheduler, settled, e);
	h->pulsed = sc_on_after_pulse(e->scheduler, pulse_ended, e);
	h->freed = sc_on_free(e->scheduler, scope_freed, e);
	e->nodes = es_nodes_new(e);
	e->computers = es_computers_new(e);
	e->actions = es_actions_new(e);
	{
		es_context_options co = {.scope = e->host_scope, .places = e->places, .args = o->host.args,
			.nargs = o->host.nargs, .node = e->node};
		e->host_context = es_context_new(e, &co);
		remember_context(e, e->host_context);
	}
	{
		init_args args = {e, o};
		if ((code = es_within(e->host_context, init_nodes, &args)) != 0) goto fail;
	}

	// 6. scope nodes, processes, statuses, records
	e->scopes = sn_new(e->scheduler, e->table);
	{
		op_value *start = op_str("start");
		keep_value(h, start);
		sc_pair info = {"processes", start};
		sc_scope *owner = sc_create_scope(e->scheduler, &info, 1, e->host_scope);
		e->processes = pr_new(&(pr_setup){.scheduler = e->scheduler, .table = e->table,
			.places = e->places, .scopes = e->scopes, .commit = commit_changed, .commit_ctx = e,
			.sites = e->sites, .owner = owner, .id = o->id, .id_ctx = o->id_ctx,
			.write = host_write, .write_ctx = e});
	}
	e->statuses = cst_new(&(cst_setup){.places = e->places, .table = e->table, .scheduler = e->scheduler,
		.write = status_write, .write_ctx = e});
	e->runs = crn_new(&(crn_setup){.places = e->places, .table = e->table, .scheduler = e->scheduler,
		.hold = run_hold, .hold_ctx = e});
	e->calls = es_calls_new(e, !o->calls_never);

	// the registry; hooks are setup-only from here
	sched_add(e->scheduler);
	h->registered = 1;
	es_register_scope(e->host_scope, e->host_context);
	h->adding = 0;

	// the host's node placed where the host says
	if (o->host.at != NULL) {
		es_node_data node = {.id = e->node, .part = (char *)PART_VALUE};
		es_handle *handle = es_mint(e, &node);
		if ((code = es_place(e->host_context, es_text(o->host.at), es_on_node(handle))) != 0) goto fail;
	}
	h->made = 1;
	*out = e;
	return 0;

fail:
	abandon(e);
	*out = NULL;
	return code;
}

// start, stop, close ---------------------------------------------------------------------------------------------------------------

// the folder a process is at and where it runs are the places': the registry and the contexts forget
// it as its scope goes
static char *process_gone(void *data) {
	proc_rec *rec = data;
	hosting *h = host_of(rec->e);
	// a child ended by its starter's ending: nothing stops it again (its scope may outlive this, held)
	if (rec->child) rec->running = 0;
	es_map_del(&h->contexts, rec->id);
	es_running_clear(rec->e, rec->id);
	return NULL;
}

// what a process says it waits on: its sends to nothing, else "PENDING"
static op_value *waits_value(es_ermine *e, const char *pid) {
	size_t n;
	es_wait *waits = es_calls_waits(e, pid, &n);
	op_value *list = op_list();
	for (size_t i = 0; i < n; i++) {
		op_value *m = op_map();
		if (waits[i].has_path) op_set(m, "send", names_value(CP(waits[i].path), waits[i].npath));
		else op_set(m, "send", op_str(waits[i].id));
		op_set(m, "since", op_num(waits[i].since));
		op_push(list, m);
	}
	es_waits_free(waits, n);
	// the nodes it read that weren't there (paths from the root)
	const es_missing *missing = es_missing_of(e, pid);
	for (size_t i = 0; missing != NULL && i < missing->npaths; i++) {
		op_value *m = op_map();
		op_set(m, "missing", names_value(CP(missing->paths[i].names), missing->paths[i].n));
		op_push(list, m);
	}
	if (list->count == 0) op_push(list, op_str("PENDING"));
	return list;
}

// the process's status table entry changed: its own context writes it
static int status_put(proc_rec *rec, const op_patch *patches, size_t n) {
	es_write w = {.part = CST_TABLE, .id = rec->id, .patches = patches, .npatches = n};
	return es_context_put(rec->context, &w);
}

static const op_key KEY_STATUS = {.type = OP_STR_KEY, .s = CST_ATTRIBUTE};
static const op_key KEY_WAITING = {.type = OP_STR_KEY, .s = ES_WAITING};

typedef struct {
	proc_rec *rec;
	// done: the value, or none; failed: the message; waiting: the list
	const op_value *value;
	const char *error;
	int kind;
} settle_call;

enum { SETTLE_DONE, SETTLE_FAILED, SETTLE_WAITING };

// the process's value and status, written with its scope open
static int settle_thunk(void *data) {
	settle_call *s = data;
	proc_rec *rec = s->rec;
	if (s->kind == SETTLE_DONE) {
		if (s->value != NULL) {
			op_patch whole = {.has_value = 1, .value = s->value};
			es_write w = {.part = PART_VALUE, .id = rec->id, .patches = &whole, .npatches = 1};
			TRY(es_context_put(rec->context, &w));
		}
		op_patch unset[2] = {patch_unset(&KEY_STATUS), patch_unset(&KEY_WAITING)};
		return status_put(rec, unset, 2);
	}
	if (s->kind == SETTLE_FAILED) {
		op_value *error = error_value(s->error);
		op_patch p[2] = {patch_set(&KEY_STATUS, error), patch_unset(&KEY_WAITING)};
		int code = status_put(rec, p, 2);
		op_free(error);
		return code;
	}
	op_patch p = patch_set(&KEY_WAITING, s->value);
	return status_put(rec, &p, 1);
}

static void settle_call_run(void *data) {
	int code = settle_thunk(data);
	if (code != 0) es_clear_thrown();
}

// done or failed from a promise or a setup: with its scope open (a promise settles with nothing open)
static void settle_with_scope(proc_rec *rec, int kind, const op_value *value, const char *error) {
	settle_call s = {rec, value, error, kind};
	sc_scope *scope = pr_scope(rec->started.process);
	sc_run_with_scope(scope, settle_call_run, &s);
}

static void process_done(proc_rec *rec, const op_value *value) {
	if (!sc_scope_alive(pr_scope(rec->started.process))) return;
	settle_with_scope(rec, SETTLE_DONE, value, NULL);
	es_queue_pulse(rec->e);
}

static void process_failed(proc_rec *rec, const char *message) {
	if (!sc_scope_alive(pr_scope(rec->started.process))) return;
	settle_with_scope(rec, SETTLE_FAILED, NULL, message);
	es_queue_pulse(rec->e);
}

static void rec_free(proc_rec *rec);

// setup's promise settled
static void process_settled(void *ctx, int ok, const op_value *value, const char *error) {
	proc_rec *rec = ctx;
	rec->awaiting = 0;
	if (rec->e->closed) return;
	if (rec->dropped) {
		rec_free(rec);
		return;
	}
	if (ok) process_done(rec, value);
	else process_failed(rec, error != NULL ? error : "undefined");
}

typedef struct {
	proc_rec *rec;
	es_out out;
} setup_call;

static void setup_thunk(void *data) {
	setup_call *c = data;
	c->out = c->rec->fn(c->rec->context, c->rec->ctx);
}

// the program, run once with the process's scope open, untracked, in a scope of its own under the
// process's; its result is the process's value, or its status
static void run_setup(proc_rec *rec) {
	es_ermine *e = rec->e;
	sc_scope *at = sc_create_scope(e->scheduler, rec->info, 1, pr_scope(rec->started.process));
	// its info's value held as long as it is (scope_freed); the maker's hold let go once setup has
	// run: what it made under it holds it
	if (at != NULL) pm_set(&host_of(e)->with, at, op_ref(rec->at_value));
	setup_call c = {rec, es_out_of(NULL)};
	// the nodes it reads that are not there are held while it runs, then said in its status
	es_setting(e, rec->id, 1);
	int stopped = at == NULL || sc_run_with_scope(at, setup_thunk, &c) != NULL;
	if (at != NULL) sc_release(at);
	op_value *waits = NULL;
	if (!stopped && c.out.kind == ES_OUT_PENDING) waits = waits_value(e, rec->id);
	es_setting(e, rec->id, 0);
	if (stopped) return;
	es_out out = c.out;
	if (out.kind == ES_OUT_FAILED) {
		process_failed(rec, out.error != NULL ? out.error : "undefined");
		free(out.error);
		return;
	}
	if (out.kind == ES_OUT_PENDING) {
		// a send to nothing, or a node not there: what it waits on is in its status; setup is not run again
		settle_with_scope(rec, SETTLE_WAITING, waits, NULL);
		op_free(waits);
		return;
	}
	es_promise *p = es_promise_of(e, out.value);
	if (p != NULL) {
		op_value *promised = op_list();
		op_push(promised, op_str("a promise"));
		settle_with_scope(rec, SETTLE_WAITING, promised, NULL);
		op_free(promised);
		rec->awaiting = 1;
		es_promise_then(p, process_settled, rec);
		op_free(out.value);
		return;
	}
	process_done(rec, out.value);
	op_free(out.value);
}

// the process is made: its node and row are there. its context, found by its scope; then setup
static void start_body(pr_process *p, void *data) {
	proc_rec *rec = data;
	es_ermine *e = rec->e;
	hosting *h = host_of(e);
	rec->started.process = p;
	rec->id = es_dup(pr_id(p));
	const char *const *at, *const *folder, *const *args;
	size_t nat = pr_at(p, &at), nfolder = pr_folder(p, &folder), nargs = pr_args(p, &args);
	es_context_options co = {.scope = pr_scope(p), .places = pr_places(p), .folder = folder, .nfolder = nfolder,
		.at = at, .nat = nat, .args = args, .nargs = nargs, .process = p, .node = rec->id};
	rec->context = es_context_new(e, &co);
	remember_context(e, rec->context);
	es_map_set(&h->contexts, rec->id, rec->context);
	es_running_set(e, rec->id, at, nat);
	es_register_scope(pr_scope(p), rec->context);
	sc_register_teardown(e->scheduler, pr_scope(p), process_gone, rec);
	rec->at_value = names_value(at, nat);
	rec->info[0] = (sc_pair){"process", rec->at_value};
	run_setup(rec);
}

static char **dup_steps(char *const *src, size_t n) {
	char **out = es_alloc((n + 1) * sizeof *out);
	for (size_t i = 0; i < n; i++) out[i] = es_dup(src[i]);
	return out;
}

// path text or steps, as the steps pr_start takes (owned: free them)
static const char *const *steps_of(es_at at, size_t *n, char ***owned) {
	*owned = NULL;
	if (at.text == NULL) {
		*n = at.nsteps;
		return at.steps;
	}
	*owned = parse_steps(at.text, n);
	return CP(*owned);
}

// a process made at steps, under a scope (NULL: the owner's, the host's); a child belongs to that scope
// and is freed with its own. taken (or a name code): ES_TAKEN, and *refused says which
static int start_under(es_ermine *e, es_program fn, void *ctx, const char *const *steps, size_t nsteps,
	const es_start_options *o, sc_scope *under, const es_context *starter, es_child *kid,
	es_started **out, es_refused *refused) {
	int child = starter != NULL;
	hosting *h = host_of(e);
	proc_rec *rec = es_alloc(sizeof *rec);
	rec->e = e;
	rec->fn = fn;
	rec->ctx = ctx;
	rec->started.ermine = e;
	rec->running = 1;
	rec->child = child;
	rec->starter = starter;
	rec->at = h->nprocs;
	ES_PUSH(h->procs, h->nprocs, h->capprocs, rec);

	pr_options po = {.body = start_body, .data = rec, .under = under};
	if (o != NULL && o->has_args) {
		po.args = o->args;
		po.nargs = o->nargs;
		po.has_args = 1;
	}
	pr_refusal no;
	// a child lives where its starter does; the host's start may name the places
	pl *where = starter != NULL ? starter->places : o != NULL && o->places != NULL ? o->places : e->places;
	pr_process *made = pr_start(e->processes, where, steps, nsteps, &po, &no);
	if (made == NULL) {
		// refused: no process, its record out of procs
		rec_free(rec);
		if (refused != NULL) {
			refused->refused = no.refused;
			refused->nat = no.nat;
			refused->at = es_alloc((no.nat + 1) * sizeof *refused->at);
			for (size_t i = 0; i < no.nat; i++) refused->at[i] = es_dup(no.at[i]);
			// taken by a stopped process whose row a feature held: said, naming both (to the host's start only:
			// a program is told where, never whose it is)
			for (size_t k = 0; !child && k < h->rows.n;) {
				size_t before = h->rows.n;
				char *pid = es_dup(h->rows.keys[k]);
				row_rec *r = row_held(e, pid);
				if (h->rows.n != before) {
					free(pid);
					continue;
				}
				k++;
				if (r == NULL) {
					free(pid);
					continue;
				}
				size_t common = r->nat < no.nat ? r->nat : no.nat;
				size_t i = 0;
				while (i < common && strcmp(r->at[i], no.at[i]) == 0) i++;
				if (i != common) {
					free(pid);
					continue;
				}
				refused->has_held = 1;
				refused->held_process = pid;
				refused->held_feature = es_dup(r->feature);
				break;
			}
		}
		return es_fail_ermine(ES_TAKEN, "taken");
	}
	if (child) {
		// the starter's: nobody holds it, it is freed as its scope is. what the starter is told is read
		// first: letting go may free it (its setup unplaced its own node)
		const char *const *names;
		size_t n = pr_at(made, &names);
		kid->id = es_dup(pr_id(made));
		kid->at = (es_names){dup_steps((char *const *)names, n), n};
		n = pr_folder(made, &names);
		kid->folder = (es_names){dup_steps((char *const *)names, n), n};
		pm_set(&h->children, pr_scope(made), rec);
		pr_let_go(e->processes, made);
	} else {
		*out = &rec->started;
	}
	return 0;
}

int es_start(es_ermine *e, es_program fn, void *ctx, es_at at, const es_start_options *o,
	es_started **out, es_refused *refused) {
	TRY(es_alive(e));
	if (refused != NULL) *refused = (es_refused){0};
	if (fn == NULL) {
		return es_fail_ermine(ES_NOT_A_FUNCTION, "start takes the program: its function");
	}
	char **owned;
	size_t nsteps;
	const char *const *steps = steps_of(at, &nsteps, &owned);
	int code = start_under(e, fn, ctx, steps, nsteps, o, NULL, NULL, NULL, out, refused);
	pr_names_free(owned, owned != NULL ? nsteps : 0);
	return code;
}

// the scope a process starts under asked as its starter: the folder it is placed in, or the nearest one
// above that is there (the rest are made), "place" on the slot
static int ask_starting(es_context *c, const char *const *path, size_t n) {
	for (size_t k = n; k-- > 0;) {
		tb_key folder;
		if (k == 0) folder = pl_root(c->places);
		else if (!pl_get(c->places, path, k, &folder)) continue;
		return es_ask_slot(c, folder.string, path, k + 1);
	}
	return 0;
}

static const op_value *pair_in(const sc_scope *o, const char *key) {
	const sc_info *info = sc_scope_info(o);
	for (size_t i = 0; info != NULL && i < info->n; i++) {
		if (strcmp(info->pairs[i].key, key) == 0) return info->pairs[i].value;
	}
	return NULL;
}

int es_start_in(es_context *c, es_program fn, void *ctx, es_at at, const es_start_options *o,
	es_child *out, es_refused *refused) {
	es_ermine *e = c->ermine;
	*out = (es_child){0};
	if (refused != NULL) *refused = (es_refused){0};
	TRY(es_alive(e));
	sc_scope *own = es_owner(c);
	if (own == NULL || !sc_scope_alive(own)) {
		return es_fail_ermine(ES_GONE, "gone: what this was started in has ended");
	}
	const op_value *node = pair_in(own, PL_NODE);
	if ((node != NULL && node->type == OP_STR && es_is_computer(e, node->str)) ||
		pair_in(own, "pipe") != NULL) {
		return es_fail_ermine(ES_NOT_HERE,
			"start in a memo, effect or pipe: start a process in setup or an action");
	}
	if (fn == NULL) return es_fail_ermine(ES_NOT_A_FUNCTION, "start takes the program: its function");
	es_names path;
	TRY(es_resolve(c, at, &path));
	int code = ask_starting(c, CP(path.names), path.n);
	if (!code) {
		code = start_under(e, fn, ctx, CP(path.names), path.n, o, own, c, out, NULL, refused);
		es_queue_pulse(e);
	}
	es_names_free(&path);
	// taken is said, not thrown: the starter is told
	if (code == ES_TAKEN && refused != NULL && refused->refused != NULL) {
		es_clear_thrown();
		return 0;
	}
	return code;
}

void es_child_free(es_child *k) {
	if (k == NULL) return;
	free(k->id);
	es_names_free(&k->at);
	es_names_free(&k->folder);
	*k = (es_child){0};
}

void es_refused_free(es_refused *r) {
	if (r == NULL) return;
	pr_names_free(r->at, r->nat);
	free(r->held_process);
	free(r->held_feature);
	*r = (es_refused){0};
}

// stop why (NULL: "ended"): its teardowns are told it, its row goes. what its teardown threw:
// malloc'd for the caller (NULL: none)
static char *stop_process(proc_rec *rec, const char *why) {
	es_ermine *e = rec->e;
	hosting *h = host_of(e);
	// a child is freed as its scope is: held till this is done with it
	sc_scope *hold = rec->child ? pr_scope(rec->started.process) : NULL;
	if (hold != NULL) sc_retain(hold);
	// the root its row is on: the process's own places' (a box's), known till it is torn down
	es_context *own = es_map_get(&h->contexts, rec->id);
	char *world = es_dup(own != NULL ? pl_root(own->places).string : e->root);
	char *why_ = es_dup(why != NULL ? why : "ended");
	es_map_set(&e->whys, rec->id, why_);
	char *bad = pr_stop(e->processes, rec->started.process);
	es_map_del(&e->whys, rec->id);
	free(why_);
	es_held_drop(e, rec->id);
	rec->running = 0;
	// its row still there: its removal was held back, and the path says so
	held_rec *held = held_of(h, PART_PROCESS, world);
	const char *at;
	const char *const *names;
	size_t n = pr_at(rec->started.process, &names);
	at = row_at(e, world, (char *const *)names, n);
	if (at != NULL && strcmp(at, rec->id) == 0 && held != NULL) {
		row_rec *r = es_alloc(sizeof *r);
		r->feature = held->feature;
		r->root = world;
		world = NULL;
		r->nat = n;
		r->at = es_alloc((n + 1) * sizeof *r->at);
		for (size_t i = 0; i < n; i++) r->at[i] = es_dup(names[i]);
		row_rec *was = es_map_get(&h->rows, rec->id);
		if (was != NULL) row_free(was);
		es_map_set(&h->rows, rec->id, r);
		mark_held(e);
	}
	free(world);
	if (hold != NULL) sc_release(hold);
	return bad;
}

static int failed_with(char *bad) {
	if (bad == NULL) return 0;
	int code = es_fail_text(bad);
	free(bad);
	return code;
}

// a running process stopped by its node, told why (NULL: "ended"); none running there: nothing
int es_stop_id(es_ermine *e, const char *id, const char *why) {
	hosting *h = host_of(e);
	if (e->closed) return 0;
	for (size_t i = 0; i < h->nprocs; i++) {
		proc_rec *rec = h->procs[i];
		if (rec->running && strcmp(rec->id, id) == 0) {
			return failed_with(stop_process(rec, why));
		}
	}
	return 0;
}
// (unplace, remove: nodes.c)
int es_stop_node(es_ermine *e, const char *id) { return es_stop_id(e, id, NULL); }

// the process running at id, if it runs (its context is still known)
static proc_rec *running_rec(es_ermine *e, const char *id) {
	hosting *h = host_of(e);
	if (es_map_get(&h->contexts, id) == NULL) return NULL;
	for (size_t i = 0; i < h->nprocs; i++) {
		if (h->procs[i]->running && strcmp(h->procs[i]->id, id) == 0) return h->procs[i];
	}
	return NULL;
}

// the child c started, by id (running or not, till its record goes); a process anyone else started,
// or none by that id: NULL. only the starter has the stop and the status (the TypeScript gives them to
// the one that started it, and no one else)
static proc_rec *child_of(es_context *c, const char *id) {
	hosting *h = host_of(c->ermine);
	for (size_t i = 0; i < h->nprocs; i++) {
		proc_rec *rec = h->procs[i];
		if (rec->child && rec->starter == c && rec->id != NULL && strcmp(rec->id, id) == 0) return rec;
	}
	return NULL;
}

static proc_rec *process_rec(es_ermine *e, const char *id) {
	hosting *h = host_of(e);
	for (size_t i = 0; i < h->nprocs; i++) {
		if (h->procs[i]->id != NULL && strcmp(h->procs[i]->id, id) == 0) return h->procs[i];
	}
	return NULL;
}

// a process this did not start: ES_NOT_HERE, as a compute is refused start (the closest the TypeScript
// has: it has no such call, a process's stop and status are held by the one that started it)
static int not_started_here(void) {
	return es_fail_ermine(ES_NOT_HERE, "stop and status are for a process this started");
}

// the stop's ask, run in the starter's scope: the policy sees the starter, whoever calls the stop
typedef struct {
	es_context *c;
	const char *const *path;
	size_t n;
	int code;
} stop_ask;
static void stop_ask_run(void *data) {
	stop_ask *a = data;
	a->code = ask_starting(a->c, a->path, a->n);
}

int es_child_stop(es_context *c, const char *id, const char *why) {
	es_ermine *e = c->ermine;
	TRY(es_alive(e));
	// one that ended and is gone has nothing to stop (the TypeScript's stop is then a no-op)
	if (child_of(c, id) == NULL && process_rec(e, id) != NULL) return not_started_here();
	proc_rec *rec = running_rec(e, id);
	if (rec == NULL || !rec->child || rec->starter != c) return 0;
	const char *const *names;
	size_t n = pr_at(rec->started.process, &names);
	stop_ask a = {c, names, n, 0};
	if (!sc_scope_alive(c->scope)) return es_fail_ermine(ES_GONE, "gone: what this was started in has ended");
	const char *bad = sc_run_with_scope(c->scope, stop_ask_run, &a);
	if (bad != NULL) return es_fail_text(bad);
	TRY(a.code);
	return failed_with(stop_process(rec, why));
}

int es_child_status(es_context *c, const char *id, es_status *out) {
	es_ermine *e = c->ermine;
	*out = (es_status){0};
	TRY(es_alive(e));
	if (child_of(c, id) == NULL) return not_started_here();
	es_node_data node = {.id = (char *)id, .part = (char *)PART_VALUE};
	return es_get_status(c, es_on_node(es_mint(e, &node)), out);
}

int es_stop(es_started *s, const char *why) {
	es_ermine *e = s->ermine;
	if (e->closed) return 0;
	proc_rec *rec = (proc_rec *)s;
	return failed_with(stop_process(rec, why));
}

// a record let go of: out of procs, its process dropped (freed with its scope)
static void rec_free(proc_rec *rec) {
	es_ermine *e = rec->e;
	hosting *h = host_of(e);
	proc_rec *last = h->procs[--h->nprocs];
	h->procs[rec->at] = last;
	last->at = rec->at;
	if (!rec->child && !e->closed && e->processes != NULL && rec->started.process != NULL) {
		free(pr_drop(e->processes, rec->started.process));
	}
	free(rec->id);
	op_free(rec->at_value);
	free(rec);
}

void es_started_free(es_started *s) {
	if (s == NULL) return;
	proc_rec *rec = (proc_rec *)s;
	if (rec->dropped) return;
	if (!rec->e->closed && rec->running) free(stop_process(rec, NULL));
	rec->dropped = 1;
	// its setup's promise still out: freed as it settles
	if (rec->awaiting && !rec->e->closed) return;
	rec_free(rec);
}

int es_started_status(es_started *s, es_status *out) {
	es_ermine *e = s->ermine;
	TRY(es_alive(e));
	es_node_data node = {.id = (char *)pr_id(s->process), .part = (char *)PART_VALUE};
	es_handle *handle = es_mint(e, &node);
	return es_get_status(e->host_context, es_on_node(handle), out);
}

int es_close(es_ermine *e) {
	hosting *h = host_of(e);
	if (e->closed) return 0;
	char *first = NULL;
	// stopping a parent ends its children and frees their records (out of procs): scan again each time
	for (;;) {
		proc_rec *rec = NULL;
		for (size_t i = h->nprocs; i-- > 0;) {
			if (h->procs[i]->running) {
				rec = h->procs[i];
				break;
			}
		}
		if (rec == NULL) break;
		char *stopped = stop_process(rec, "ended");
		if (first == NULL) first = stopped;
		else free(stopped);
	}
	char *bad = sc_teardown(e->host_scope);
	if (first != NULL) {
		free(bad);
		bad = first;
	}
	if (e->statuses != NULL) cst_stop(e->statuses);
	if (e->runs != NULL) crn_stop(e->runs);
	es_calls_stop(e);
	if (e->processes != NULL) pr_halt(e->processes);
	unlisten(e);
	e->closed = 1;
	release(e);
	h->next_closed = closed_ermines;
	closed_ermines = e;
	if (bad != NULL) {
		int code = es_fail_text(bad);
		free(bad);
		return code;
	}
	return 0;
}

// the host's side ----------------------------------------------------------------------------------------------------------------------

es_context *es_host_context(es_ermine *e) { return e->host_context; }

es_context *es_process_context_of(es_ermine *e, const char *id) {
	return es_map_get(&host_of(e)->contexts, id);
}

es_context *es_get_process_context(es_ermine *e, pr_process *process) {
	if (es_alive(e)) return NULL;
	es_clear_thrown();
	if (process == NULL) return e->host_context;
	return es_map_get(&host_of(e)->contexts, pr_id(process));
}

es_handle *es_handle_of(es_ermine *e, const es_node_data *node) {
	if (es_alive(e)) return NULL;
	es_clear_thrown();
	return es_mint(e, node);
}

int es_data_of(es_ermine *e, const void *x, es_node_data *node) {
	if (es_alive(e)) return 0;
	es_clear_thrown();
	const es_handle_data *d = es_handle_lookup(e, x);
	if (d == NULL) return 0;
	*node = es_node_data_copy(&d->node);
	return 1;
}

const crn_run *es_records_run(es_ermine *e, const char *id) {
	if (es_alive(e)) return NULL;
	es_clear_thrown();
	const crn_run *run = NULL;
	if (crn_read(e->runs, NULL, NULL, tb_string(id), CRN_ALL, &run, NULL, NULL) != 0) return NULL;
	return run;
}

const char *es_records_run_held(es_ermine *e, const char *id) {
	if (es_alive(e)) return NULL;
	es_clear_thrown();
	return es_map_get(&host_of(e)->run_held, id);
}

const es_call *es_records_call(es_ermine *e, const char *id) {
	if (es_alive(e)) return NULL;
	es_clear_thrown();
	return es_calls_latest(e, id);
}

es_wait *es_records_waits(es_ermine *e, size_t *n) {
	if (es_alive(e)) {
		*n = 0;
		return NULL;
	}
	es_clear_thrown();
	return es_calls_waits(e, NULL, n);
}

int es_calling(es_ermine *e, es_calling_view *out) {
	if (es_alive(e)) return 0;
	es_clear_thrown();
	return es_calls_calling(e, sc_get_current_scope(e->scheduler), out);
}
