// The C dens (dens.h) and away (away.h) on the line protocol of typescript/dens_harness.ts, which
// documents it (conformance/c/harness.h has the loop). Two devices, "mac" and "card", each a table,
// paths, places (root "R" unless root said; contributors [processes(root), away(root), children]),
// scheduler, scope nodes, hf registry and host scope { actor: <dev> } of its own, made at their
// first line as presence_harness.c makes its two; one clock, which only the "now" request moves;
// one channel pair (chn_pair_new) named "mac" and "card", made at the first connect. Names are one
// map, filled as answers come back: a den's node "den:<den id>", a process "proc:<its name>", a
// derived id its longest named owner's name and the rest; a remote start's process named from its
// answer, at the remote line or the first answer line after it. The runners, each given the start's facts
// (dn_starting): record (its run and its stop recorded; hf_run.stop_reason given the reason; its
// load and its live form's close recorded, by the process the load request names, hf_loader being
// given no facts), boom (hf_run.error "boom", its load's error too) and teller (the C api over the
// device's api_context, api_new from the facts, its teardown recorded; its stop_reason api_stop's
// why). A den's pulses asked for (dn_setup.schedule) are held, run by later. The policy
// "grants": a pr_call recording each ask, then protect's grants on (value, rules). disconnect frees
// the link at once (dn_disconnect, then dn_link_free, its den running).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../conformance/c/harness.h"
#include "../../../filesystem/places/c/status.h"
#include "../../../ermine/api/c/api.h"
#include "../../../ermine/boxes/c/boxes.h"
#include "../../../ermine/encoding/c/cbor.h"
#include "../../../playground/encoding/c/pack.h"
#include "../../../ermine/processes/c/processes.h"
#include "away.h"
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

// a pulse a den asked for, held
typedef struct {
	void (*f)(void *data);
	void *data;
} asking;

// a load by its request's name
typedef struct {
	char *name;
	dn_loaded *l;
} named_load;

struct telling;

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
	// its link; every link made on it
	dn_link *link;
	dn_link **links;
	size_t nlinks, caplinks;
	// the pulses its den asked for; its loads; teller's context and the apis it made
	asking *asked;
	size_t nasked, capasked;
	named_load *loads;
	size_t nloads, caploads;
	api_context *context;
	struct telling **tellings;
	size_t ntellings, captellings;
} device;

static device devices[2] = {{.name = "mac"}, {.name = "card"}};
static int64_t clock_ms;
// the channel pair, made at the first connect: mac's a, card's b
static chn_pair *pair;

static int64_t read_clock(void *ctx) {
	(void)ctx;
	return clock_ms;
}

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

// a string as shown (named, or derived: its longest named owner's name and the rest), or taken back:
// fresh
static char *mapped(const char *v, const char *(*of)(const char *)) {
	const char *named = of(v);
	if (named != NULL) return xdup(named);
	for (size_t i = strlen(v); i-- > 1;) {
		if (v[i] != '/') continue;
		char *owner = xalloc(i + 1);
		memcpy(owner, v, i);
		const char *o = of(owner);
		free(owner);
		if (o != NULL) return concat(o, v + i);
	}
	return xdup(v);
}
static char *show(const char *v) { return mapped(v, shown_of); }
static char *take(const char *v) { return mapped(v, known_of); }

// a value with every string mapped (map keys too when keys): new
static op_value *walked_keys(const op_value *v, char *(*f)(const char *), int keys) {
	if (v == NULL) return op_null();
	if (v->type == OP_STR) {
		char *s = f(v->str);
		op_value *o = op_str(s);
		free(s);
		return o;
	}
	if (v->type == OP_LIST) {
		op_value *a = op_list();
		for (size_t i = 0; i < v->count; i++) op_push(a, walked_keys(v->items[i], f, keys));
		return a;
	}
	if (v->type == OP_MAP) {
		op_value *m = op_map();
		for (size_t i = 0; i < v->count; i++) {
			op_value *x = walked_keys(v->items[i], f, keys);
			if (!keys) {
				op_set_name(m, v->keys[i], x);
				continue;
			}
			char *k = f(v->keys[i]);
			op_set(m, k, x);
			free(k);
		}
		return m;
	}
	return op_ref((op_value *)v);
}
static op_value *walked(const op_value *v, char *(*f)(const char *)) { return walked_keys(v, f, 0); }
// an answer: ids by name
static op_value *plain(const op_value *v) { return walked(v, show); }
static op_value *plain_take(op_value *v) {
	op_value *o = plain(v);
	op_free(v);
	return o;
}
// a request's value: names taken back; back_all: in keys too (a row's nodes are by id)
static op_value *back(const op_value *v) { return walked(v, take); }
static op_value *back_all(const op_value *v) { return walked_keys(v, take, 1); }
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

// record's loads and its live forms' closes: { dev, by, code }; teller's teardowns: { dev, process,
// why }
typedef struct {
	const char *dev;
	char *by;
	op_value *code;
} loaded;
static loaded *loads, *unloads;
static size_t nloads, caploads, nunloads, capunloads;
static stopped *told;
static size_t ntold, captold;
// the process a load request names, as record's load is given none
static const char *loading_by;

static void record_stop(void *ctx, const op_value *reason) {
	handled *h = ctx;
	stopped s = {h->d->name, xdup(h->process), reason != NULL ? op_ref((op_value *)reason) : NULL};
	PUSH(stops, nstops, capstops, s);
}
static void record_stop_plain(void *ctx) { record_stop(ctx, NULL); }

// the record runner: its run recorded, the api it would make the facts' { den, places, process };
// its handle's stop records the reason
static hf_run record(const op_value *code, void *api_, void *data) {
	device *d = data;
	const dn_starting *st = api_;
	op_value *args = op_list();
	for (size_t i = 0; i < st->process.nargs; i++) op_push(args, op_str(st->process.args[i]));
	ran r = {d->name, xdup(st->process.id), code != NULL ? op_ref((op_value *)code) : op_null(), args};
	PUSH(runs, nruns, capruns, r);
	handled *h = xalloc(sizeof *h);
	h->d = d;
	h->process = xdup(st->process.id);
	PUSH(handles, nhandles, caphandles, h);
	return (hf_run){.handle = {record_stop_plain, h}, .stop_reason = record_stop};
}

// record's live form closed: recorded, let go
static void record_close(void *data) {
	loaded *l = data;
	loaded u = {l->dev, l->by, l->code};
	PUSH(unloads, nunloads, capunloads, u);
	free(l);
}
static hf_loaded record_load(const op_value *code, void *data) {
	device *d = data;
	loaded l = {d->name, xdup(loading_by != NULL ? loading_by : ""),
		code != NULL ? op_ref((op_value *)code) : op_null()};
	PUSH(loads, nloads, caploads, l);
	loaded *live = xalloc(sizeof *live);
	*live = (loaded){d->name, xdup(l.by), op_ref(l.code)};
	return (hf_loaded){.live = {.close = record_close, .data = live}};
}

static hf_run boom(const op_value *code, void *api_, void *data) {
	(void)code, (void)api_, (void)data;
	return (hf_run){.error = xdup("boom")};
}
static hf_loaded boom_load(const op_value *code, void *data) {
	(void)code, (void)data;
	return (hf_loaded){.error = xdup("boom")};
}

// teller: an api made from the facts, its teardown recorded; its stop's reason api_stop's why
typedef struct telling {
	device *d;
	char *id;
	api_process process;
	api *a;
} telling;
static void told_f(const op_value *why, void *ctx) {
	telling *t = ctx;
	stopped s = {t->d->name, xdup(t->id), why != NULL ? op_ref((op_value *)why) : NULL};
	PUSH(told, ntold, captold, s);
}
static void teller_stop(void *ctx, const op_value *reason) {
	telling *t = ctx;
	api_stop(t->d->context, &t->process, reason);
}
static void teller_stop_plain(void *ctx) { teller_stop(ctx, NULL); }
// the api's own pulses: none asked (the harness pulses)
static void no_schedule(void *ctx, void (*f)(void *data), void *data) { (void)ctx, (void)f, (void)data; }
static hf_run teller(const op_value *code, void *api_, void *data) {
	(void)code;
	device *d = data;
	const dn_starting *st = api_;
	if (d->context == NULL) {
		d->context = api_context_new(&(api_setup){.scheduler = d->s, .table = d->table,
			.places = d->places, .schedule = no_schedule});
	}
	telling *t = xalloc(sizeof *t);
	t->d = d;
	t->id = xdup(st->process.id);
	t->process = (api_process){.id = t->id, .at = st->process.at, .nat = st->process.nat,
		.cwd = st->process.cwd, .ncwd = st->process.ncwd, .args = st->process.args,
		.nargs = st->process.nargs, .scope = st->scope};
	t->a = api_new(d->context, &(api_starting){.process = t->process, .places = st->places});
	api_teardown(t->a, told_f, t);
	PUSH(d->tellings, d->ntellings, d->captellings, t);
	return (hf_run){.handle = {teller_stop_plain, t}, .stop_reason = teller_stop};
}

// a pulse a den asked for: held
static void asking_f(void *ctx, void (*f)(void *data), void *data) {
	device *d = ctx;
	PUSH(d->asked, d->nasked, d->capasked, ((asking){f, data}));
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
	dn_away_init(&d->away, tb_string(d->root));
	d->walk[0] = &d->rows.contributor;
	d->walk[1] = &d->away.contributor;
	d->walk[2] = &pl_children;
	pl_connect(d->places, &(pl_setup){.root = tb_string(d->root), .table = d->table, .paths = d->paths,
		.scheduler = d->s, .contributors = d->walk, .ncontributors = 3});
	d->info = (sc_pair){"actor", op_str(d->name)};
	d->host = sc_create_root_scope(d->s, &d->info, 1);
	d->scopes = sn_new(d->s, d->table);
	d->functions = hf_new();
	hf_add_loader(d->functions, "record", record, record_load, d);
	hf_add_loader(d->functions, "boom", boom, boom_load, d);
	hf_add_runner(d->functions, "teller", teller, d);
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

// what a start gave: its id named, shown as { id, at }; or the refusal (a places code: an error,
// as refusal's)
static op_value *started(op_value *got, const char *as) {
	if (got == NULL) return error("no answer");
	const char *no = text(get(got, "refused"));
	if (no != NULL && (strcmp(no, "not-a-name") == 0 || strcmp(no, "nothing-there") == 0 ||
		strcmp(no, "already-there") == 0)) {
		op_value *e = error(no);
		op_free(got);
		return e;
	}
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
		nd_entry *e = nd_make_entry(x, &h);
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
		.install = text(get(r, "install")), .name = text(get(r, "name")), .device = device_v,
		.may = policy != NULL && strcmp(policy, "grants") == 0 ? d->policy : NULL,
		.schedule = asking_f, .schedule_ctx = d}, &why);
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
	as = concat("session:", dn_id(den));
	name(dn_session_id(den), as);
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
	if (live != NULL && strcmp(live, "record") != 0 && strcmp(live, "boom") != 0 &&
		strcmp(live, "teller") != 0) {
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

// a request's program: an address (its steps in path), or { id, hash?, type?, api?, code? } (its id
// taken back, in *id)
static dn_program program_of(const op_value *pv, steps *path, char **id) {
	dn_program program = {0};
	if (pv != NULL && pv->type == OP_MAP) {
		const char *given = text(get(pv, "id"));
		*id = take(given != NULL ? given : "");
		program.id = *id;
		program.hash = text(get(pv, "hash"));
		// a hash that is no string: none's, as an ask's
		if (program.hash == NULL && get(pv, "hash") != NULL) program.hash = "";
		program.type = text(get(pv, "type"));
		program.api = text(get(pv, "api"));
		program.code = get(pv, "code");
	} else {
		*path = steps_of(pv);
		program.at = (const char *const *)path->v;
		program.nat = path->n;
		program.has_at = 1;
	}
	return program;
}

// a start: its process named from the answer, proc:<name>
static void start(void *data) {
	job *j = data;
	device *d = j->d;
	const op_value *r = j->r;
	steps runner = steps_of(get(r, "runner")), at = steps_of(get(r, "at"));
	steps cwd = steps_of(get(r, "cwd")), args = steps_of(get(r, "args")), path = {0};
	char *id = NULL;
	dn_program program = program_of(get(r, "program"), &path, &id);
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

// a load, named; by a process's name ("den": the den's own; none: the den)
static void load(void *data) {
	job *j = data;
	device *d = j->d;
	const op_value *r = j->r;
	dn_process *by = NULL;
	const char *by_name = text(get(r, "by"));
	if (by_name != NULL) {
		const char *pid = process_id(d->den, by_name);
		if (pid == NULL) {
			j->out = error("no such process");
			return;
		}
		by = strcmp(pid, dn_node(d->den)) == 0 ? dn_self(d->den) : dn_find(d->den, pid);
		if (by == NULL) {
			j->out = error(pl_code_name(PL_NOTHING_THERE));
			return;
		}
	}
	bx *b = NULL;
	if (get(r, "box") != NULL && (b = box_of(d, text(get(r, "box")))) == NULL) {
		j->out = error("no such box");
		return;
	}
	steps runner = steps_of(get(r, "runner")), path = {0};
	char *id = NULL;
	dn_program program = program_of(get(r, "program"), &path, &id);
	dn_options o = {.box = b != NULL ? bx_places(b) : NULL};
	loading_by = by != NULL ? dn_process_id(by) : dn_node(d->den);
	dn_refusal no;
	dn_loaded *l = dn_load(d->den, by, STEPS(runner), &program, &o, &no);
	loading_by = NULL;
	if (l == NULL && strcmp(no.refused, "failed") == 0) j->out = with("failed", op_str(no.error));
	else if (l == NULL) j->out = refusal(&no);
	else {
		const char *n = text(get(r, "name"));
		PUSH(d->loads, d->nloads, d->caploads, ((named_load){xdup(n != NULL ? n : ""), l}));
		j->out = op_map();
	}
	free(id);
	steps_free(&runner), steps_free(&path);
}

static void release_named(void *data) {
	job *j = data;
	device *d = j->d;
	const char *n = text(get(j->r, "name"));
	for (size_t i = d->nloads; n != NULL && i-- > 0;) {
		if (strcmp(d->loads[i].name, n) != 0) continue;
		dn_release(d->den, d->loads[i].l);
		j->out = op_map();
		return;
	}
	j->out = error("no such load");
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

// an ask written in the graph, named ask:<as>; the den's node by name (none: the device's den's)
static op_value *write_ask(device *d, const op_value *r) {
	const char *which = text(get(r, "ask")), *as = text(get(r, "as")), *given = text(get(r, "den"));
	if (given == NULL && d->den == NULL) return error("no den");
	op_value *a = op_map(), *who = back_or_null(get(r, "who"));
	if (who != NULL) op_set(a, "who", who);
	if (which != NULL && strcmp(which, "start") == 0) {
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
		op_free(a);
		return error("no such ask");
	}
	char *den = given != NULL ? take(given) : xdup(dn_node(d->den));
	dn_world w = {d->table, d->places, d->host};
	char *id = dn_ask_write(&w, den, a);
	free(den);
	op_free(a);
	if (id == NULL) return error("an ask that does not encode");
	char *n = concat("ask:", as != NULL ? as : "");
	name(id, n);
	free(n);
	op_value *out = plain_take(with("id", op_str(id)));
	free(id);
	return out;
}

// the answer of an ask, read untracked: a copy
typedef struct {
	const dn_world *w;
	const char *id;
	op_value *out;
} answering;
static void answer_of(void *data) {
	answering *g = data;
	const op_value *got = dn_ask_answer(g->w, g->id);
	g->out = got != NULL ? op_ref((op_value *)got) : NULL;
}

// the answer to the ask named as (or at id); null: none yet. name: what a process it started is named
static op_value *answered(device *d, const op_value *r) {
	const char *as = text(get(r, "as")), *id = text(get(r, "id"));
	char *named = as != NULL ? concat("ask:", as) : NULL;
	char *n = take(named != NULL ? named : id != NULL ? id : "");
	free(named);
	dn_world w = {d->table, d->places, d->host};
	answering g = {&w, n, NULL};
	pl_peep(d->places, answer_of, &g);
	free(n);
	return with("answer", g.out != NULL ? started(g.out, text(get(r, "name"))) : op_null());
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

// other dens --------------------------------------------------------------------------------------

static chn_channel *channel_of(device *d) {
	if (pair == NULL) pair = chn_pair_new("mac", "card");
	return d == &devices[0] ? chn_pair_a(pair) : chn_pair_b(pair);
}

// the names remote starts are to give their processes, by device and n, until their answer lands
typedef struct {
	device *d;
	unsigned n;
	char *name;
} to_name;
static to_name *to_names;
static size_t nto_names, capto_names;

// a remote start's process named from its answer, once it has one
static void named(device *d, unsigned n) {
	for (size_t i = 0; i < nto_names; i++) {
		if (to_names[i].d != d || to_names[i].n != n) continue;
		const char *id = text(get(dn_answer(d->link, n), "id"));
		if (id == NULL) return;
		char *as = concat("proc:", to_names[i].name);
		name(id, as);
		free(as);
		free(to_names[i].name);
		to_names[i] = to_names[--nto_names];
		return;
	}
}

// a link, on the device's channel
static void connecting(void *data) {
	job *j = data;
	device *d = j->d;
	const op_value *r = j->r;
	const op_value *publish = get(r, "publish"), *processes = get(r, "processes"), *ttl = get(r, "ttl");
	steps under = steps_of(get(r, "under"));
	char *topic = text(get(r, "topic")) != NULL ? take(text(get(r, "topic"))) : NULL;
	dn_link_setup o = {.topic = topic, .under = (const char *const *)under.v, .nunder = under.n,
		.publish = publish != NULL && publish->type == OP_BOOL
			? (publish->bool_ ? DN_PUBLISH_YES : DN_PUBLISH_NO)
			: DN_PUBLISH_DEFAULT,
		.hide_processes = processes != NULL && processes->type == OP_BOOL && !processes->bool_,
		.ttl = ttl != NULL && ttl->type == OP_NUM ? (int64_t)ttl->num : 10000, .now = read_clock};
	dn_link *l = dn_connect(d->den, channel_of(d), &o);
	free(topic);
	steps_free(&under);
	if (l == NULL) {
		j->out = error("a den's channel is named its id");
		return;
	}
	PUSH(d->links, d->nlinks, d->caplinks, l);
	d->link = l;
	j->out = op_map();
}

// an ask to another den: { n }. a program at an address: carried, with its code when code is true
static void remote(void *data) {
	job *j = data;
	device *d = j->d;
	const op_value *r = j->r;
	const char *which = text(get(r, "ask"));
	int starting = which != NULL && strcmp(which, "start") == 0;
	op_value *a = op_map();
	if (starting) {
		op_set(a, "op", op_str("start"));
		const op_value *pv = get(r, "program"), *code = get(r, "code");
		op_value *program;
		if (pv != NULL && (pv->type == OP_STR || pv->type == OP_LIST)) {
			steps at = steps_of(pv);
			program = dn_carry(d->link, STEPS(at), code != NULL && code->type == OP_BOOL && code->bool_);
			steps_free(&at);
			if (program == NULL) {
				op_free(a);
				j->out = error(pl_code_name(PL_NOTHING_THERE));
				return;
			}
		} else program = program_value(pv);
		static const char *const keys[4] = {"runner", "at", "args", "cwd"};
		for (size_t i = 0; i < 4; i++) {
			const op_value *x = get(r, keys[i]);
			if (x != NULL) op_set(a, keys[i], op_ref((op_value *)x));
		}
		op_set(a, "program", program);
	} else if (which != NULL && strcmp(which, "stop") == 0) {
		op_set(a, "op", op_str("stop"));
		char *id = process_at(get(r, "process"));
		op_set(a, "process", op_str(id));
		free(id);
		if (get(r, "reason") != NULL) op_set(a, "reason", back(get(r, "reason")));
	} else {
		op_free(a);
		j->out = error("no such ask");
		return;
	}
	const char *to = text(get(r, "to"));
	unsigned n = dn_remote(d->link, to != NULL ? to : "", a);
	op_free(a);
	if (n == 0) {
		j->out = error("the link is stopped");
		return;
	}
	const char *as = text(get(r, "name"));
	if (starting && as != NULL) PUSH(to_names, nto_names, capto_names, ((to_name){d, n, xdup(as)}));
	named(d, n);
	j->out = with("n", op_num((double)n));
}

// the request's value set as the device's row at its link's anchor, its den bypassed
static op_value *forge(device *d, const op_value *r) {
	pres_world *w = dn_link_world(d->link);
	if (!sc_scope_alive(w->scope)) return error(SC_DISPOSED);
	const op_value *ttl = get(r, "ttl");
	op_value *v = back_all(get(r, "value"));
	pres_set(w, dn_link_anchor(d->link), channel_of(d)->name, v,
		ttl != NULL && ttl->type == OP_NUM ? (int64_t)ttl->num : 10000);
	op_free(v);
	return op_map();
}

// the request's message (names taken back) as CBOR on the device's channel at
// "<its link's anchor>/ask/<to>", its link bypassed
static op_value *say(device *d, const op_value *r) {
	const char *to = text(get(r, "to"));
	op_value *m = back(get(r, "message"));
	Json *j = pk_to_json(m);
	op_free(m);
	size_t length = 0;
	const char *why = NULL;
	if (to == NULL || j == NULL || !cborEncode(j, NULL, 0, &length, &why)) {
		if (j != NULL) jsonFree(j);
		return error("no message");
	}
	unsigned char *bytes = xalloc(length);
	cborEncode(j, bytes, length, &length, &why);
	jsonFree(j);
	char *topic = concat(dn_link_anchor(d->link), "/ask/");
	char *at = concat(topic, to);
	chn_channel *ch = channel_of(d);
	ch->send(ch, at, bytes, length);
	free(at);
	free(topic);
	free(bytes);
	return op_map();
}

// the link stopped, and freed at once (dn_link_free after dn_disconnect, the den running): gone
static void disconnect(device *d) {
	dn_link *l = d->link;
	dn_disconnect(l);
	for (size_t i = 0; i < d->nlinks; i++) {
		if (d->links[i] != l) continue;
		d->links[i] = d->links[--d->nlinks];
		break;
	}
	dn_link_free(l);
	d->link = NULL;
}

static op_value *swept_json(pres_swept *swept) {
	op_value *list = op_list();
	for (size_t i = 0; i < swept->n; i++) {
		op_value *m = op_map();
		op_set(m, "anchor", op_str(swept->items[i].anchor));
		op_set(m, "who", op_str(swept->items[i].who));
		op_push(list, m);
	}
	pres_swept_free(swept);
	return with("swept", plain_take(list));
}

// the away ops; NULL: none of them
static op_value *away_answer(device *d, const char *op, job *j, const char *actor) {
	if (strcmp(op, "connect") == 0) {
		if (d->den == NULL) return error("no den");
		hosted(d, connecting, j, NULL);
		return j->out;
	}
	if (strcmp(op, "announce") != 0 && strcmp(op, "beat") != 0 && strcmp(op, "disconnect") != 0 &&
		strcmp(op, "sweep") != 0 && strcmp(op, "remote") != 0 && strcmp(op, "answer") != 0 &&
		strcmp(op, "forge") != 0 && strcmp(op, "say") != 0)
		return NULL;
	if (d->link == NULL) return error("no link");
	if (strcmp(op, "announce") == 0) dn_announce(d->link);
	else if (strcmp(op, "beat") == 0) dn_beat(d->link);
	else if (strcmp(op, "disconnect") == 0) disconnect(d);
	else if (strcmp(op, "sweep") == 0) {
		pres_swept swept = dn_sweep(d->link);
		return swept_json(&swept);
	} else if (strcmp(op, "remote") == 0) {
		hosted(d, remote, j, actor);
		return j->out;
	} else if (strcmp(op, "answer") == 0) {
		unsigned n = 0;
		const op_value *v = get(j->r, "n");
		if (v != NULL && v->type == OP_NUM && v->num >= 1) n = (unsigned)v->num;
		named(d, n);
		const op_value *got = dn_answer(d->link, n);
		return with("answer", got != NULL ? plain(got) : op_null());
	} else if (strcmp(op, "say") == 0) return say(d, j->r);
	else return forge(d, j->r);
	return op_map();
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

// a status as answers show it: "pending" | { failed } | null; any other value: { raw: it }
static op_value *status_json(const op_value *v) {
	if (v == NULL) return op_null();
	if (cst_is_pending(v)) return op_str("pending");
	if (cst_error(v) != NULL) return with("failed", op_str(cst_error(v)));
	return with("raw", plain(v));
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

// whether the entry at (part, id) (part NULL: attributes) was last written with this file as its
// site: the files differ by harness, so only yes or no
static op_value *site_json(device *d, const op_value *r) {
	const char *given = text(get(r, "id")), *part = text(get(r, "part"));
	char *id = take(given != NULL ? given : "");
	const nd_entry *e = tb_get(d->table, tb_string(part != NULL ? part : "attributes"), tb_string(id));
	free(id);
	int ours = e != NULL && e->change.external_length > 0 && e->change.external[0].file != NULL &&
		strcmp(e->change.external[0].file, __FILE__) == 0;
	return with("harness", op_bool(ours));
}

static op_value *loaded_json(const loaded *ls, size_t n) {
	op_value *list = op_list();
	for (size_t i = 0; i < n; i++) {
		op_value *m = op_map();
		op_set(m, "dev", op_str(ls[i].dev));
		op_set(m, "by", op_str(ls[i].by));
		op_set(m, "code", op_ref(ls[i].code));
		op_push(list, m);
	}
	return plain_take(list);
}

static op_value *told_json(void) {
	op_value *list = op_list();
	for (size_t i = 0; i < ntold; i++) {
		op_value *m = op_map();
		op_set(m, "dev", op_str(told[i].dev));
		op_set(m, "process", op_str(told[i].process));
		op_set(m, "why", told[i].reason != NULL ? op_ref(told[i].reason) : op_null());
		op_push(list, m);
	}
	return with("told", plain_take(list));
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
	if (strcmp(op, "loads") == 0) {
		op_value *o = op_map();
		op_set(o, "loads", loaded_json(loads, nloads));
		op_set(o, "unloads", loaded_json(unloads, nunloads));
		return o;
	}
	if (strcmp(op, "told") == 0) return told_json();
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
	if (strcmp(op, "later") == 0) {
		size_t n = d->nasked;
		asking *held = d->asked;
		d->asked = NULL, d->nasked = d->capasked = 0;
		for (size_t i = 0; i < n; i++) held[i].f(held[i].data), free(sc_escaped(d->s));
		free(held);
		return with("pulses", op_num((double)n));
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
	if (strcmp(op, "write-ask") == 0) return write_ask(d, r);
	if (strcmp(op, "answered") == 0) return answered(d, r);
	if (strcmp(op, "raw") == 0) {
		const char *given = text(get(r, "name"));
		char *id = take(given != NULL ? given : "");
		op_value *out = with("id", op_str(id));
		free(id);
		return out;
	}
	if (strcmp(op, "site") == 0) return site_json(d, r);
	if (strcmp(op, "asked") == 0) {
		op_value *list = op_list();
		for (size_t i = 0; i < d->nasks; i++) op_push(list, d->asks[i]);
		d->nasks = 0;
		return with("asks", plain_take(list));
	}
	op_value *other = away_answer(d, op, &j, actor);
	if (other != NULL) return other;
	// the rest are the den's
	if (strcmp(op, "offer") != 0 && strcmp(op, "withdraw") != 0 && strcmp(op, "start") != 0 &&
		strcmp(op, "stop") != 0 && strcmp(op, "ask") != 0 && strcmp(op, "send") != 0 &&
		strcmp(op, "close") != 0 && strcmp(op, "load") != 0 && strcmp(op, "release") != 0)
		return NULL;
	if (d->den == NULL) return error("no den");
	if (strcmp(op, "offer") == 0) hosted(d, offer, &j, NULL);
	else if (strcmp(op, "withdraw") == 0) hosted(d, withdraw, &j, NULL);
	else if (strcmp(op, "start") == 0) hosted(d, start, &j, actor);
	else if (strcmp(op, "stop") == 0) hosted(d, stop, &j, actor);
	else if (strcmp(op, "ask") == 0) hosted(d, ask, &j, NULL);
	else if (strcmp(op, "close") == 0) hosted(d, closing, &j, NULL);
	else if (strcmp(op, "load") == 0) hosted(d, load, &j, actor);
	else if (strcmp(op, "release") == 0) hosted(d, release_named, &j, NULL);
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
		// teller's apis after their processes' scopes, then their context
		for (size_t i = 0; i < d->ntellings; i++) {
			api_free(d->tellings[i]->a);
			free(d->tellings[i]->id);
			free(d->tellings[i]);
		}
		free(d->tellings);
		api_context_free(d->context);
	}
	for (size_t k = 0; k < 2; k++) {
		device *d = &devices[k];
		if (d->made) {
			sc_free(d->s);
			tb_free(d->table);
			pt_free(d->paths);
			pl_free(d->places);
			for (size_t i = 0; i < d->nlinks; i++) dn_link_free(d->links[i]);
			for (size_t i = 0; i < d->ndens; i++) dn_free(d->dens[i]);
			for (size_t i = 0; i < d->nboxes; i++) bx_free(d->boxes[i].box), free(d->boxes[i].name);
			sn_free(d->scopes);
			hf_free(d->functions);
			pr_policy_free(d->policy);
			pr_policy_free(d->grants);
			op_free((op_value *)d->info.value);
			for (size_t i = 0; i < d->nasks; i++) op_free(d->asks[i]);
		}
		for (size_t i = 0; i < d->nloads; i++) free(d->loads[i].name);
		free(d->loads);
		free(d->asked);
		free(d->links);
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
	for (size_t i = 0; i < nloads; i++) free(loads[i].by), op_free(loads[i].code);
	free(loads);
	for (size_t i = 0; i < nunloads; i++) free(unloads[i].by), op_free(unloads[i].code);
	free(unloads);
	for (size_t i = 0; i < ntold; i++) free(told[i].process), op_free(told[i].reason);
	free(told);
	for (size_t i = 0; i < nto_names; i++) free(to_names[i].name);
	free(to_names);
	chn_pair_free(pair);
}
