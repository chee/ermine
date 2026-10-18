// The C dens (dens.h) on the line protocol of typescript/dens_harness.ts, which documents it
// (conformance/c/harness.h has the loop). Two devices, "mac" and "card", each a table, paths,
// places (root "R" unless root said; contributors [processes(root), away(root), children]),
// scheduler, scope nodes, hf registry and host scope { actor: <dev> } of its own, made at their
// first line as presence_harness.c makes its two; one clock, which only the "now" request moves.
// Names are one map, filled as answers come back: a den's node "den:<den id>", a process
// "proc:<its name>", a derived id its owner's name and the rest. The runners: record (its run and
// its stop recorded; hf_run.stop_reason given the reason) and boom (hf_run.error "boom"). The
// policy "grants": a pr_call recording each ask, then protect's grants on (value, rules).
// Not here yet: the other dens (connect, announce, beat, disconnect, sweep, remote, answer,
// forge), which are away.h's.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../conformance/c/harness.h"
#include "../../../filesystem/places/c/status.h"
#include "../../boxes/c/boxes.h"
#include "../../processes/c/processes.h"
#include "dens.h"

#define PUSH(v, n, cap, x) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 16; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
		(v)[(n)++] = (x); \
	} while (0)

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) abort();
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }
static char *concat(const char *a, const char *b) {
	size_t n = strlen(a);
	char *s = xalloc(n + strlen(b) + 1);
	memcpy(s, a, n);
	strcpy(s + n, b);
	return s;
}

static const op_value *get(const op_value *map, const char *key) {
	return map != NULL && map->type == OP_MAP ? op_get(map, key) : NULL;
}
static const char *text(const op_value *v) { return v != NULL && v->type == OP_STR ? v->str : NULL; }

static op_value *error(const char *why) {
	op_value *o = op_map();
	op_set(o, "error", op_str(why));
	return o;
}
static op_value *with(const char *key, op_value *v) {
	op_value *o = op_map();
	op_set(o, key, v);
	return o;
}

// the devices ------------------------------------------------------------------------------------

typedef struct {
	char *name;
	bx *box;
} boxed;

typedef struct {
	const char *name;
	char *root;
	int made;
	sc_scheduler *s;
	tb_table *table;
	pt_paths *paths;
	pl *places;
	pr_processes rows, away;
	const pl_contributor *walk[3];
	sn *scopes;
	hf *functions;
	sc_scope *host;
	sc_pair info;
	boxed *boxes;
	size_t nboxes, capboxes;
	// its den; every den made on it
	dn *den;
	dn **dens;
	size_t ndens, capdens;
	// the policy "grants": the recorder around grants on (value, rules)
	pr_policy *grants, *policy;
	op_value **asks;
	size_t nasks, capasks;
} device;

static device devices[2] = {{.name = "mac"}, {.name = "card"}};
static int64_t clock_ms;

static void drop(void *value, void *data) {
	(void)data;
	op_free(value);
}

// names: an id as answers show it, and back -----------------------------------------------------------

typedef struct {
	char *id;
	char *name;
} naming;
static naming *names;
static size_t nnames, capnames;

static void name(const char *id, const char *as) {
	PUSH(names, nnames, capnames, ((naming){xdup(id), xdup(as)}));
}
static const char *shown_of(const char *id) {
	for (size_t i = nnames; i-- > 0;) {
		if (strcmp(names[i].id, id) == 0) return names[i].name;
	}
	return NULL;
}
static const char *known_of(const char *as) {
	for (size_t i = nnames; i-- > 0;) {
		if (strcmp(names[i].name, as) == 0) return names[i].id;
	}
	return NULL;
}

// a string as shown (named, or derived: its owner's name and the rest), or taken back: fresh
static char *mapped(const char *v, const char *(*of)(const char *)) {
	const char *named = of(v);
	if (named != NULL) return xdup(named);
	const char *slash = strchr(v, '/');
	if (slash != NULL && slash > v) {
		char *owner = xalloc((size_t)(slash - v) + 1);
		memcpy(owner, v, (size_t)(slash - v));
		const char *o = of(owner);
		free(owner);
		if (o != NULL) return concat(o, slash);
	}
	return xdup(v);
}
static char *show(const char *v) { return mapped(v, shown_of); }
static char *take(const char *v) { return mapped(v, known_of); }

// a value with every string mapped (map keys as they are): new
static op_value *walked(const op_value *v, char *(*f)(const char *)) {
	if (v == NULL) return op_null();
	if (v->type == OP_STR) {
		char *s = f(v->str);
		op_value *o = op_str(s);
		free(s);
		return o;
	}
	if (v->type == OP_LIST) {
		op_value *a = op_list();
		for (size_t i = 0; i < v->count; i++) op_push(a, walked(v->items[i], f));
		return a;
	}
	if (v->type == OP_MAP) {
		op_value *m = op_map();
		for (size_t i = 0; i < v->count; i++) op_set_name(m, v->keys[i], walked(v->items[i], f));
		return m;
	}
	return op_ref((op_value *)v);
}
// an answer: ids by name
static op_value *plain(const op_value *v) { return walked(v, show); }
static op_value *plain_take(op_value *v) {
	op_value *o = plain(v);
	op_free(v);
	return o;
}
// a request's value: names taken back
static op_value *back(const op_value *v) { return walked(v, take); }
static op_value *back_or_null(const op_value *v) { return v != NULL ? back(v) : NULL; }

// what the runners did, every device's, in order --------------------------------------------------------

typedef struct {
	const char *dev;
	char *process;
	op_value *code, *args;
} ran;
static ran *runs;
static size_t nruns, capruns;

typedef struct {
	const char *dev;
	char *process;
	op_value *reason;
} stopped;
static stopped *stops;
static size_t nstops, capstops;

// a record handle's: its device and process
typedef struct {
	device *d;
	char *process;
} handled;
static handled **handles;
static size_t nhandles, caphandles;

// what the program is given: { den, places, process }
typedef struct {
	const char *den;
	pl *places;
	char *id;
	op_value *args;
} api;

static void *create_api(const dn_context *c, void *data) {
	(void)data;
	api *a = xalloc(sizeof *a);
	a->den = dn_id(c->den);
	a->places = c->places;
	a->id = xdup(c->process.id);
	a->args = op_list();
	for (size_t i = 0; i < c->process.nargs; i++) op_push(a->args, op_str(c->process.args[i]));
	return a;
}
static void free_api(void *a_, void *data) {
	(void)data;
	api *a = a_;
	free(a->id);
	op_free(a->args);
	free(a);
}

static void record_stop(void *ctx, const op_value *reason) {
	handled *h = ctx;
	stopped s = {h->d->name, xdup(h->process), reason != NULL ? op_ref((op_value *)reason) : NULL};
	PUSH(stops, nstops, capstops, s);
}
static void record_stop_plain(void *ctx) { record_stop(ctx, NULL); }

// the record runner: its run recorded; its handle's stop records the reason
static hf_run record(const op_value *code, void *api_, void *data) {
	device *d = data;
	api *a = api_;
	ran r = {d->name, xdup(a->id), code != NULL ? op_ref((op_value *)code) : op_null(), op_ref(a->args)};
	PUSH(runs, nruns, capruns, r);
	handled *h = xalloc(sizeof *h);
	h->d = d;
	h->process = xdup(a->id);
	PUSH(handles, nhandles, caphandles, h);
	return (hf_run){.handle = {record_stop_plain, h}, .stop_reason = record_stop};
}

static hf_run boom(const op_value *code, void *api_, void *data) {
	(void)code, (void)api_, (void)data;
	return (hf_run){.error = xdup("boom")};
}

// grants, each ask recorded on the device
static pr_answer recording(void *ctx, const pr_ask *ask, const pr_read *read) {
	device *d = ctx;
	op_value *m = op_map();
	op_set(m, "op", op_str(ask->op));
	op_value *who = op_map();
	static const char *const keys[3] = {"actor", "reader", "device"};
	for (size_t i = 0; i < 3; i++) {
		const op_value *x = get(ask->who, keys[i]);
		if (x != NULL) op_set(who, keys[i], op_ref((op_value *)x));
	}
	op_set(m, "who", who);
	if (ask->target.part != NULL) op_set(m, "part", op_str(ask->target.part));
	op_set(m, "id", op_str(ask->target.id.string != NULL ? ask->target.id.string : ""));
	if (ask->target.path != NULL) {
		op_value *path = op_list();
		for (size_t i = 0; i < ask->target.npath; i++) op_push(path, op_str(ask->target.path[i]));
		op_set(m, "path", path);
	}
	PUSH(d->asks, d->nasks, d->capasks, m);
	return pr_ask_of(d->grants, ask, read->reader, read->ctx);
}

// the device's world, made at its first line
static void make(device *d) {
	d->made = 1;
	if (d->root == NULL) d->root = xdup("R");
	d->places = pl_new();
	d->s = sc_new((sc_options){.drop = drop});
	sc_on_tracking_end(d->s, pl_forget, d->places);
	d->table = tb_make(pl_event, d->places);
	d->paths = pt_new();
	pr_processes_init(&d->rows, tb_string(d->root));
	pr_trie_init(&d->away, "away", tb_string(d->root), "away");
	d->walk[0] = &d->rows.contributor;
	d->walk[1] = &d->away.contributor;
	d->walk[2] = &pl_children;
	pl_connect(d->places, &(pl_setup){.root = tb_string(d->root), .table = d->table, .paths = d->paths,
		.scheduler = d->s, .contributors = d->walk, .ncontributors = 3});
	d->info = (sc_pair){"actor", op_str(d->name)};
	d->host = sc_create_root_scope(d->s, &d->info, 1);
	d->scopes = sn_new(d->s, d->table);
	d->functions = hf_new();
	hf_add_runner(d->functions, "record", record, d);
	hf_add_runner(d->functions, "boom", boom, d);
}

static device *named_device(const char *n) {
	if (strcmp(n, "mac") == 0) return &devices[0];
	if (strcmp(n, "card") == 0) return &devices[1];
	return NULL;
}

// the device a request names, made at its first line; NULL: none such
static device *dev(const op_value *r) {
	const char *n = hh_str(r, "dev");
	device *d = named_device(n != NULL ? n : "mac");
	if (d != NULL && !d->made) make(d);
	return d;
}

// f with the host's scope open, or a scope { actor } under it
static void hosted(device *d, void (*f)(void *data), void *data, const char *actor) {
	if (actor == NULL) {
		sc_run_with_scope(d->host, f, data);
		return;
	}
	op_value *v = op_str(actor);
	sc_pair info = {"actor", v};
	sc_scope *o = sc_create_scope(d->s, &info, 1, d->host);
	sc_run_with_scope(o, f, data);
	free(sc_teardown(o));
	op_free(v);
}

static bx *box_of(device *d, const char *name) {
	for (size_t i = 0; name != NULL && i < d->nboxes; i++) {
		if (strcmp(d->boxes[i].name, name) == 0) return d->boxes[i].box;
	}
	return NULL;
}

// an address's steps, copied: a string split as path.ts' parse does, a list as it is
typedef struct {
	char **v;
	size_t n, cap;
} steps;

static steps steps_of(const op_value *a) {
	steps s = {0};
	if (a != NULL && a->type == OP_STR) {
		const char *p = a->str;
		if (*p == '/') PUSH(s.v, s.n, s.cap, xdup("/"));
		while (*p) {
			const char *end = strchr(p, '/');
			size_t len = end != NULL ? (size_t)(end - p) : strlen(p);
			if (len > 0) {
				char *piece = xalloc(len + 1);
				memcpy(piece, p, len);
				PUSH(s.v, s.n, s.cap, piece);
			}
			p += len;
			if (*p == '/') p++;
		}
	} else if (a != NULL && a->type == OP_LIST) {
		for (size_t i = 0; i < a->count; i++) {
			PUSH(s.v, s.n, s.cap, xdup(text(a->items[i]) != NULL ? a->items[i]->str : ""));
		}
	}
	return s;
}
static void steps_free(steps *s) {
	for (size_t i = 0; i < s->n; i++) free(s->v[i]);
	free(s->v);
	*s = (steps){0};
}
#define STEPS(s) ((const char *const *)(s).v), (s).n

static op_value *names_json(const char *const *names, size_t n) {
	op_value *list = op_list();
	for (size_t i = 0; i < n; i++) op_push(list, op_str(names[i]));
	return list;
}

// a refusal as answers show it: a places code, an error; else dens.ts' Refused
static op_value *refusal(const dn_refusal *r) {
	if (strcmp(r->refused, "not-a-name") == 0 || strcmp(r->refused, "nothing-there") == 0 ||
		strcmp(r->refused, "already-there") == 0)
		return error(r->refused);
	return plain_take(dn_refusal_value(r));
}

// a process by its name; "den": the den's own. *id: its id (none: NULL)
static const char *process_id(dn *den, const char *n) {
	if (n == NULL) return NULL;
	if (strcmp(n, "den") == 0) return dn_node(den);
	char *as = concat("proc:", n);
	const char *id = known_of(as);
	free(as);
	return id;
}

// a process by its name, else an id taken back: fresh
static char *process_at(const op_value *v) {
	const char *n = text(v);
	if (n == NULL) return xdup("");
	char *as = concat("proc:", n);
	const char *id = known_of(as);
	free(as);
	return id != NULL ? xdup(id) : take(n);
}

// what a start gave: its id named, shown as { id, at }; or the refusal
static op_value *started(op_value *got, const char *as) {
	if (got == NULL) return error("no answer");
	if (get(got, "refused") != NULL) return plain_take(got);
	const char *id = text(get(got, "id"));
	if (id != NULL && as != NULL) {
		char *n = concat("proc:", as);
		name(id, n);
		free(n);
	}
	return plain_take(got);
}

// a request's program as an ask carries it: an address as it is, else { id, hash?, type?, api?,
// code? }, its id taken back: new
static op_value *program_value(const op_value *p) {
	if (p == NULL || p->type != OP_MAP) return p != NULL ? op_ref((op_value *)p) : op_null();
	op_value *m = op_map();
	const char *id = text(get(p, "id"));
	char *taken = take(id != NULL ? id : "");
	op_set(m, "id", op_str(taken));
	free(taken);
	static const char *const keys[4] = {"hash", "type", "api", "code"};
	for (size_t i = 0; i < 4; i++) {
		const op_value *x = get(p, keys[i]);
		if (x != NULL) op_set(m, keys[i], op_ref((op_value *)x));
	}
	return m;
}

// the requests, each with the host's scope open --------------------------------------------------------

typedef struct {
	device *d;
	const op_value *r;
	op_value *out;
	const char *part;
} job;

// kids, attrs, value: the entry replaced, its value's names taken back; no value: taken out
static void put_entry(void *data) {
	job *j = data;
	device *d = j->d;
	char *id = take(text(get(j->r, "id")) ? text(get(j->r, "id")) : "");
	const op_value *v = get(j->r, "value");
	if (v == NULL) {
		if (tb_get(d->table, tb_string(j->part), tb_string(id)) != NULL) {
			tb_del(d->table, tb_string(j->part), tb_string(id));
		}
	} else {
		ch_header h;
		pl_made *made;
		char *bad = pl_header(d->places, NULL, 0, CH_HERE, &h, &made);
		if (bad != NULL) {
			j->out = error(bad);
			free(bad);
			free(id);
			return;
		}
		op_value *x = back(v);
		nd_entry *e = nd_make_entry(x, &h, NULL);
		op_free(x);
		pl_own(d->places, e);
		pl_hold(d->places, e, made, pl_made_free);
		tb_sub(d->table, tb_string(j->part), tb_string(id), e);
	}
	free(id);
	j->out = op_map();
}

// a box over the folder's id, by name
static void create_box(void *data) {
	job *j = data;
	device *d = j->d;
	const char *folder = text(get(j->r, "folder"));
	const char *n = text(get(j->r, "name"));
	if (folder == NULL || n == NULL) {
		j->out = error("no name or folder");
		return;
	}
	char *id = take(folder);
	bx *b;
	int code = bx_create_id(&(bx_host){d->places, d->table, NULL, NULL}, id, NULL, &b);
	free(id);
	if (code != 0) {
		j->out = error(pl_code_name(code));
		return;
	}
	PUSH(d->boxes, d->nboxes, d->capboxes, ((boxed){xdup(n), b}));
	j->out = op_map();
}

// the device's den; its node named den:<id>
static void make_den(void *data) {
	job *j = data;
	device *d = j->d;
	const op_value *r = j->r;
	const char *id = text(get(r, "id"));
	const char *policy = text(get(r, "policy"));
	if (policy != NULL && strcmp(policy, "grants") == 0 && d->policy == NULL) {
		d->grants = pr_grants((pr_where){"value", tb_string("rules")});
		d->policy = pr_call(recording, d);
	}
	op_value *device_v = back_or_null(get(r, "device"));
	const char *why = NULL;
	dn *den = dn_new(&(dn_setup){.scheduler = d->s, .table = d->table, .places = d->places,
		.scopes = d->scopes, .functions = d->functions, .id = id != NULL ? id : d->name,
		.name = text(get(r, "name")), .device = device_v,
		.may = policy != NULL && strcmp(policy, "grants") == 0 ? d->policy : NULL,
		.create_api = create_api, .free_api = free_api, .data = d}, &why);
	op_free(device_v);
	if (den == NULL) {
		j->out = error(why);
		return;
	}
	PUSH(d->dens, d->ndens, d->capdens, den);
	d->den = den;
	char *as = concat("den:", dn_id(den));
	name(dn_node(den), as);
	free(as);
	j->out = plain_take(with("id", op_str(dn_node(den))));
}

// an offer: { id, at }, or the refusal (a places code: an error)
static void offer(void *data) {
	job *j = data;
	device *d = j->d;
	const op_value *r = j->r;
	static const char *const kinds[3] = {"runners", "compilers", "surfaces"};
	const char *kind = text(get(r, "kind"));
	int k = -1;
	for (int i = 0; kind != NULL && i < 3; i++) {
		if (strcmp(kind, kinds[i]) == 0) k = i;
	}
	if (k < 0) {
		j->out = error("not a kind of offer");
		return;
	}
	dn_process *by = NULL;
	const char *by_name = text(get(r, "by"));
	if (by_name != NULL) {
		const char *id = process_id(d->den, by_name);
		if (id == NULL) {
			j->out = error("no such process");
			return;
		}
		by = strcmp(id, dn_node(d->den)) == 0 ? dn_self(d->den) : dn_find(d->den, id);
		if (by == NULL) {
			j->out = error(pl_code_name(PL_NOTHING_THERE));
			return;
		}
	}
	const char *live = text(get(r, "live"));
	if (live != NULL && strcmp(live, "record") != 0 && strcmp(live, "boom") != 0) {
		j->out = error("no such runner");
		return;
	}
	op_value *fn = live != NULL ? hf_value(live) : NULL;
	op_value *attrs = back_or_null(get(r, "attrs"));
	const char *n = text(get(r, "name"));
	dn_refusal no;
	const char *made = dn_offer(d->den, by, (dn_kind)k, n != NULL ? n : "", attrs, fn, &no);
	op_free(fn);
	op_free(attrs);
	if (made == NULL) {
		j->out = refusal(&no);
		return;
	}
	const char *const *at;
	size_t nat = dn_offered_at(d->den, made, &at);
	op_value *o = op_map();
	op_set(o, "id", op_str(made));
	op_set(o, "at", names_json(at, nat));
	j->out = plain_take(o);
}

static void withdraw(void *data) {
	job *j = data;
	const char *id = text(get(j->r, "id"));
	char *taken = take(id != NULL ? id : "");
	dn_withdraw(j->d->den, taken);
	free(taken);
	j->out = op_map();
}

// a start: its process named from the answer, proc:<name>
static void start(void *data) {
	job *j = data;
	device *d = j->d;
	const op_value *r = j->r;
	steps runner = steps_of(get(r, "runner")), at = steps_of(get(r, "at"));
	steps cwd = steps_of(get(r, "cwd")), args = steps_of(get(r, "args")), path = {0};
	const op_value *pv = get(r, "program");
	dn_program program = {0};
	char *id = NULL;
	if (pv != NULL && pv->type == OP_MAP) {
		const char *given = text(get(pv, "id"));
		id = take(given != NULL ? given : "");
		program.id = id;
		program.hash = text(get(pv, "hash"));
		program.type = text(get(pv, "type"));
		program.api = text(get(pv, "api"));
		program.code = get(pv, "code");
	} else {
		path = steps_of(pv);
		program.at = (const char *const *)path.v;
		program.nat = path.n;
		program.has_at = 1;
	}
	bx *b = NULL;
	if (get(r, "box") != NULL && (b = box_of(d, text(get(r, "box")))) == NULL) {
		j->out = error("no such box");
	} else {
		op_value *pin = back_or_null(get(r, "pin"));
		dn_options o = {.args = (const char *const *)args.v, .nargs = args.n,
			.has_args = get(r, "args") != NULL, .cwd = (const char *const *)cwd.v, .ncwd = cwd.n,
			.has_cwd = get(r, "cwd") != NULL, .box = b != NULL ? bx_places(b) : NULL, .pin = pin};
		dn_refusal no;
		dn_process *p = dn_start(d->den, STEPS(runner), &program, STEPS(at), &o, &no);
		op_free(pin);
		if (p == NULL) j->out = refusal(&no);
		else {
			const char *const *where;
			size_t nwhere = dn_process_at(p, &where);
			op_value *got = op_map();
			op_set(got, "id", op_str(dn_process_id(p)));
			op_set(got, "at", names_json(where, nwhere));
			j->out = started(got, text(get(r, "name")));
		}
	}
	free(id);
	steps_free(&runner), steps_free(&at), steps_free(&cwd), steps_free(&args), steps_free(&path);
}

// a stop by name ("den": the den's own); one not running: {}
static void stop(void *data) {
	job *j = data;
	device *d = j->d;
	const char *id = process_id(d->den, text(get(j->r, "name")));
	if (id == NULL) {
		j->out = error("no such process");
		return;
	}
	dn_process *p = strcmp(id, dn_node(d->den)) == 0 ? dn_self(d->den) : dn_find(d->den, id);
	op_value *reason = back_or_null(get(j->r, "reason"));
	dn_refusal no;
	j->out = p != NULL && dn_stop(d->den, p, reason, &no) ? refusal(&no) : op_map();
	op_free(reason);
}

// another den's ask, its who taken back as given
static void ask(void *data) {
	job *j = data;
	device *d = j->d;
	const op_value *r = j->r;
	const char *which = text(get(r, "ask"));
	op_value *a = op_map(), *who = back_or_null(get(r, "who"));
	int starting = which != NULL && strcmp(which, "start") == 0;
	if (starting) {
		op_set(a, "op", op_str("start"));
		static const char *const keys[4] = {"runner", "at", "args", "cwd"};
		for (size_t i = 0; i < 4; i++) {
			const op_value *x = get(r, keys[i]);
			if (x != NULL) op_set(a, keys[i], op_ref((op_value *)x));
		}
		op_set(a, "program", program_value(get(r, "program")));
	} else if (which != NULL && strcmp(which, "stop") == 0) {
		op_set(a, "op", op_str("stop"));
		char *id = process_at(get(r, "process"));
		op_set(a, "process", op_str(id));
		free(id);
		if (get(r, "reason") != NULL) op_set(a, "reason", back(get(r, "reason")));
	} else {
		op_free(a), op_free(who);
		j->out = error("no such ask");
		return;
	}
	op_value *got = dn_ask(d->den, who, a);
	op_free(a), op_free(who);
	if (starting) j->out = started(got, text(get(r, "name")));
	else j->out = got != NULL ? plain_take(got) : error("no answer");
}

// a method called (part: start | stop), the body's names taken back, its process by name
static void sending(void *data) {
	job *j = data;
	device *d = j->d;
	const op_value *given = get(j->r, "body");
	op_value *body = given != NULL && given->type == OP_MAP ? back(given) : op_map();
	const op_value *process = get(given, "process");
	if (text(process) != NULL) {
		long i = op_find(body, "process");
		char *id = process_at(process);
		if (i >= 0) {
			op_free(body->items[i]);
			body->items[i] = op_str(id);
		}
		free(id);
	}
	j->out = started(dn_on(d->den, j->part, body), text(get(body, "name")));
	op_free(body);
}

static void closing(void *data) {
	job *j = data;
	op_value *reason = back_or_null(get(j->r, "reason"));
	dn_close(j->d->den, reason);
	op_free(reason);
	j->out = op_map();
}

// reads, untracked --------------------------------------------------------------------------------------

typedef struct {
	pl *places;
	const char *const *path;
	size_t n;
	op_value *out;
} reading;

static void get_id(void *data) {
	reading *g = data;
	tb_key id;
	g->out = pl_get(g->places, g->path, g->n, &id) && id.symbol == NULL ? op_str(id.string) : op_null();
}
static void list_names(void *data) {
	reading *g = data;
	pl_members list = pl_list(g->places, g->path, g->n);
	g->out = op_list();
	for (size_t i = 0; i < list.n; i++) op_push(g->out, op_str(list.items[i].name));
	pl_members_free(&list);
}

static op_value *read_at(pl *places, const op_value *at, void (*f)(void *data)) {
	steps path = steps_of(at);
	reading g = {places, STEPS(path), NULL};
	pl_peep(places, f, &g);
	pl_status(places);
	steps_free(&path);
	return g.out;
}

// the method at a path: its id's last two steps, on/start or on/stop of the device's den; NULL: none
static const char *method_at(device *d, const op_value *path) {
	op_value *id = read_at(d->places, path, get_id);
	const char *op = NULL;
	if (id->type == OP_STR && d->den != NULL) {
		const nd_entry *e = tb_get(d->table, tb_string("value"), tb_string(id->str));
		char *on = concat(dn_node(d->den), "/" DN_ON "/");
		size_t n = strlen(on);
		if (e != NULL && hf_name(e->value) != NULL && strncmp(id->str, on, n) == 0) {
			if (strcmp(id->str + n, "start") == 0) op = "start";
			else if (strcmp(id->str + n, "stop") == 0) op = "stop";
		}
		free(on);
	}
	op_free(id);
	return op;
}

static int by_name(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }

// a status as answers show it: "pending" | { failed } | null
static op_value *status_json(const op_value *v) {
	if (v == NULL) return op_null();
	if (cst_is_pending(v)) return op_str("pending");
	if (cst_error(v) != NULL) return with("failed", op_str(cst_error(v)));
	return plain(v);
}

static op_value *node_json(device *d, const op_value *r) {
	const char *given = text(get(r, "id"));
	char *id = take(given != NULL ? given : "");
	size_t n;
	const tb_entry *at = tb_at(d->table, tb_string(id), &n);
	char **parts = xalloc((n + 1) * sizeof *parts);
	for (size_t i = 0; i < n; i++) parts[i] = xdup(at[i].part.string);
	qsort(parts, n, sizeof *parts, by_name);
	op_value *list = op_list();
	for (size_t i = 0; i < n; i++) op_push(list, op_str(parts[i])), free(parts[i]);
	free(parts);
	op_value *o = op_map();
	op_set(o, "parts", list);
	const nd_entry *a = tb_get(d->table, tb_string("attributes"), tb_string(id));
	op_value *attributes = op_null(), *state = op_null();
	if (a != NULL) {
		op_free(attributes), op_free(state);
		attributes = op_map();
		const op_value *v = a->value != NULL && a->value->type == OP_MAP ? a->value : NULL;
		const op_value *was = v != NULL ? op_get(v, CST_ATTRIBUTE) : NULL;
		for (size_t i = 0; v != NULL && i < v->count; i++) {
			if (strcmp(v->keys[i], CST_ATTRIBUTE) == 0) continue;
			op_set_name(attributes, v->keys[i], plain(v->items[i]));
		}
		state = status_json(was);
	}
	op_set(o, "attributes", attributes);
	op_set(o, "status", state);
	const nd_entry *c = tb_get(d->table, tb_string("children"), tb_string(id));
	op_set(o, "children", c != NULL ? plain(c->value) : op_null());
	const nd_entry *v = tb_get(d->table, tb_string("value"), tb_string(id));
	op_set(o, "live", op_bool(v != NULL && hf_name(v->value) != NULL));
	free(id);
	return o;
}

static op_value *runs_json(void) {
	op_value *list = op_list();
	for (size_t i = 0; i < nruns; i++) {
		op_value *m = op_map();
		op_set(m, "dev", op_str(runs[i].dev));
		op_set(m, "process", op_str(runs[i].process));
		op_set(m, "code", op_ref(runs[i].code));
		op_set(m, "args", op_ref(runs[i].args));
		op_value *keys = op_list();
		op_push(keys, op_str("den"));
		op_push(keys, op_str("places"));
		op_push(keys, op_str("process"));
		op_set(m, "keys", keys);
		op_push(list, m);
	}
	op_value *s = op_list();
	for (size_t i = 0; i < nstops; i++) {
		op_value *m = op_map();
		op_set(m, "dev", op_str(stops[i].dev));
		op_set(m, "process", op_str(stops[i].process));
		op_set(m, "reason", stops[i].reason != NULL ? op_ref(stops[i].reason) : op_null());
		op_push(s, m);
	}
	op_value *o = op_map();
	op_set(o, "runs", plain_take(list));
	op_set(o, "stops", plain_take(s));
	return o;
}

// requests ---------------------------------------------------------------------------------------

static op_value *answer(const op_value *r) {
	const char *op = hh_str(r, "op");
	if (op == NULL) return error("no op");
	if (strcmp(op, "root") == 0) {
		const char *n = hh_str(r, "dev");
		device *d = named_device(n != NULL ? n : "mac");
		if (d == NULL) return error("no such device");
		if (d->made) return error("began already");
		const char *root = hh_str(r, "root");
		if (root == NULL) return error("no root");
		free(d->root);
		d->root = xdup(root);
		return op_map();
	}
	if (strcmp(op, "now") == 0) {
		const op_value *t = op_get(r, "t");
		if (t == NULL || t->type != OP_NUM) return error("no t");
		clock_ms = (int64_t)t->num;
		return op_map();
	}
	if (strcmp(op, "runs") == 0) return runs_json();
	if (strcmp(op, "settle") == 0) {
		for (int i = 0; i < 3; i++) {
			for (int k = 0; k < 2; k++) {
				if (devices[k].made) sc_pulse(devices[k].s), free(sc_escaped(devices[k].s));
			}
		}
		return op_map();
	}
	device *d = dev(r);
	if (d == NULL) return error("no such device");
	job j = {.d = d, .r = r};
	const char *actor = hh_str(r, "actor");
	if (strcmp(op, "kids") == 0 || strcmp(op, "attrs") == 0 || strcmp(op, "value") == 0) {
		j.part = op[0] == 'k' ? "children" : op[0] == 'a' ? "attributes" : "value";
		hosted(d, put_entry, &j, NULL);
		return j.out;
	}
	if (strcmp(op, "create") == 0) return hosted(d, create_box, &j, NULL), j.out;
	if (strcmp(op, "den") == 0) return hosted(d, make_den, &j, NULL), j.out;
	if (strcmp(op, "pulse") == 0) {
		sc_pulse(d->s);
		free(sc_escaped(d->s));
		return op_map();
	}
	if (strcmp(op, "here") == 0 || strcmp(op, "list") == 0) {
		bx *b = NULL;
		if (op_get(r, "box") != NULL && (b = box_of(d, hh_str(r, "box"))) == NULL) {
			return error("no such box");
		}
		pl *places = b != NULL ? bx_places(b) : d->places;
		if (op[0] == 'h') return with("id", plain_take(read_at(places, op_get(r, "path"), get_id)));
		return with("names", read_at(places, op_get(r, "path"), list_names));
	}
	if (strcmp(op, "node") == 0) return node_json(d, r);
	if (strcmp(op, "asked") == 0) {
		op_value *list = op_list();
		for (size_t i = 0; i < d->nasks; i++) op_push(list, d->asks[i]);
		d->nasks = 0;
		return with("asks", plain_take(list));
	}
	// the rest are the den's
	if (strcmp(op, "offer") != 0 && strcmp(op, "withdraw") != 0 && strcmp(op, "start") != 0 &&
		strcmp(op, "stop") != 0 && strcmp(op, "ask") != 0 && strcmp(op, "send") != 0 &&
		strcmp(op, "close") != 0)
		return NULL;
	if (d->den == NULL) return error("no den");
	if (strcmp(op, "offer") == 0) hosted(d, offer, &j, NULL);
	else if (strcmp(op, "withdraw") == 0) hosted(d, withdraw, &j, NULL);
	else if (strcmp(op, "start") == 0) hosted(d, start, &j, actor);
	else if (strcmp(op, "stop") == 0) hosted(d, stop, &j, actor);
	else if (strcmp(op, "ask") == 0) hosted(d, ask, &j, NULL);
	else if (strcmp(op, "close") == 0) hosted(d, closing, &j, NULL);
	else {
		j.part = method_at(d, op_get(r, "path"));
		if (j.part == NULL) return error("no method there");
		hosted(d, sending, &j, actor);
	}
	return j.out != NULL ? j.out : error("no answer");
}

void hh_answer(const op_value *request, FILE *out) {
	op_value *a = answer(request);
	if (a == NULL) {
		hh_unknown(out, request);
		return;
	}
	op_json_write(out, a);
	op_free(a);
}

static void close_all(void *data) {
	device *d = data;
	for (size_t i = 0; i < d->ndens; i++) dn_close(d->dens[i], NULL);
}

void hh_finish(void) {
	for (size_t k = 0; k < 2; k++) {
		device *d = &devices[k];
		if (!d->made) continue;
		sc_run_with_scope(d->host, close_all, d);
		for (size_t i = 0; i < d->ndens; i++) dn_halt(d->dens[i]);
	}
	for (size_t k = 0; k < 2; k++) {
		device *d = &devices[k];
		if (d->made) {
			sc_free(d->s);
			tb_free(d->table);
			pt_free(d->paths);
			pl_free(d->places);
			for (size_t i = 0; i < d->ndens; i++) dn_free(d->dens[i]);
			for (size_t i = 0; i < d->nboxes; i++) bx_free(d->boxes[i].box), free(d->boxes[i].name);
			sn_free(d->scopes);
			hf_free(d->functions);
			pr_policy_free(d->policy);
			pr_policy_free(d->grants);
			op_free((op_value *)d->info.value);
			for (size_t i = 0; i < d->nasks; i++) op_free(d->asks[i]);
		}
		free(d->dens);
		free(d->boxes);
		free(d->asks);
		free(d->root);
	}
	for (size_t i = 0; i < nnames; i++) free(names[i].id), free(names[i].name);
	free(names);
	for (size_t i = 0; i < nruns; i++) free(runs[i].process), op_free(runs[i].code), op_free(runs[i].args);
	free(runs);
	for (size_t i = 0; i < nstops; i++) free(stops[i].process), op_free(stops[i].reason);
	free(stops);
	for (size_t i = 0; i < nhandles; i++) free(handles[i]->process), free(handles[i]);
	free(handles);
}
