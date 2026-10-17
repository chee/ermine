// api.c: newOS's API over today's core (api.h).

#include "api.h"


#include <math.h>
#include <stdarg.h>
#include <time.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void *grab(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (!p) {
		fputs("api: out of memory\n", stderr);
		abort();
	}
	return p;
}

static char *copied(const char *s) {
	size_t n = strlen(s) + 1;
	return memcpy(grab(n), s, n);
}

#define GROW(items, n, room) \
	do { \
		if ((n) == (room)) { \
			(room) = (room) ? (room) * 2 : 16; \
			(items) = realloc((items), sizeof *(items) * (room)); \
		} \
	} while (0)

// the turn's memory: blocks, newest first
typedef struct Temp {
	struct Temp *next;
	size_t used, room;
	_Alignas(16) char data[];
} Temp;

// a live function, and the process that made it
typedef struct {
	ap_fn *fn;
	ap_api *owner;
} Live;

// where a process or computed node is
typedef struct {
	char *id;
	const char **at;
	size_t n;
} Here;

// an ephemeral node in front of a name: taken out of it when its node goes
typedef struct {
	char *id, *parent, *name;
} Front;

struct ap_os {
	ap_setup setup;
	sc_scheduler *s;
	tb_table *table;
	pl *places;
	pt_paths *paths;
	sn *scopes;
	st_sites *sites;
	cst *status;
	pr_processes rows;
	fr_fronts fronts;
	const pl_contributor *order[3];
	sc_scope *machine;
	sc_pair info;
	ap_api *host;
	Temp *temp;
	// values made for the turn (sites, statuses): op_free'd at ap_sweep
	op_value **held;
	size_t nheld, heldroom;
	Live *lives;
	size_t nlives, lives_room;
	Here *here;
	size_t nhere, here_room;
	Front *in_front;
	size_t nfront, front_room;
	// effects' acts waiting for the pulse's end (ap_pulse)
	struct Act *acts;
	size_t nacts, acts_room;
	// everything kept until ap_free
	void **kept;
	size_t nkept, kept_room;
	int64_t clock, pids;
};

static void *keep(ap_os *os, size_t n) {
	void *p = grab(n);
	GROW(os->kept, os->nkept, os->kept_room);
	os->kept[os->nkept++] = p;
	return p;
}

static char *keepdup(ap_os *os, const char *s) {
	size_t n = strlen(s) + 1;
	return memcpy(keep(os, n), s, n);
}

static void say(ap_os *os, const char *format, ...) {
	char line[1024];
	va_list a;
	va_start(a, format);
	vsnprintf(line, sizeof line, format, a);
	va_end(a);
	if (os->setup.say) os->setup.say(os->setup.ctx, line);
	else fprintf(stderr, "[os] %s\n", line);
}

void *ap_temp(ap_os *os, size_t n) {
	n = (n + 15) & ~(size_t)15;
	if (!os->temp || os->temp->used + n > os->temp->room) {
		size_t room = n > 65536 ? n : 65536;
		Temp *t = grab(sizeof *t + room);
		t->next = os->temp, t->room = room;
		os->temp = t;
	}
	void *p = os->temp->data + os->temp->used;
	os->temp->used += n;
	memset(p, 0, n);
	return p;
}

char *ap_dup(ap_os *os, const char *text) {
	size_t n = strlen(text) + 1;
	return memcpy(ap_temp(os, n), text, n);
}

/** a value the turn made for an answer: let go at ap_sweep */
static void hold_for_turn(ap_os *os, op_value *v) {
	if (os->nheld == os->heldroom) {
		os->heldroom = os->heldroom ? os->heldroom * 2 : 256;
		os->held = realloc(os->held, sizeof *os->held * os->heldroom);
		if (!os->held) abort();
	}
	os->held[os->nheld++] = v;
}

void ap_sweep(ap_os *os) {
	for (size_t i = 0; i < os->nheld; i++) op_free(os->held[i]);
	os->nheld = 0;
	while (os->temp) {
		Temp *t = os->temp;
		os->temp = t->next;
		free(t);
	}
}

const ap_error *ap_error_new(ap_os *os, const char *code, const char *message) {
	ap_error *e = ap_temp(os, sizeof *e);
	e->code = code ? ap_dup(os, code) : NULL;
	e->message = message ? ap_dup(os, message) : NULL;
	return e;
}

static const ap_error *fail(ap_os *os, const char *code, const char *format, ...) {
	char text[512];
	va_list a;
	va_start(a, format);
	vsnprintf(text, sizeof text, format, a);
	va_end(a);
	return ap_error_new(os, code, text);
}

// --- the os

static void drop(void *value, void *data) {
	(void)data;
	op_free(value);
}

// a run that failed, said in the log: whose (the nearest scope node), and where it was made
static void ended(sc_computer *c, unsigned n, sc_ended how, const void *const *reads, size_t nreads, const sc_more *more, void *data) {
	(void)n, (void)reads, (void)nreads;
	ap_os *os = data;
	if (how != SC_FAIL && how != SC_LOOPING) return;
	const char *node = sn_nearest(os->scopes, c);
	size_t k;
	const char *const *at = node ? ap_here(os, node, &k) : NULL;
	char where[512] = "";
	for (size_t i = 1; at && i < k; i++) snprintf(where + strlen(where), sizeof where - strlen(where), "/%s", at[i]);
	const st_site *site = st_site_of(os->sites, c);
	say(os, "run of %s %s failed%s%s:%d: %s", node ? node : "?", where, site ? " (made at " : "", site ? site->file : "", site ? site->line : 0,
		how == SC_LOOPING ? "looping" : more && more->error ? more->error : "thrown");
}

ap_os *ap_new(const ap_setup *setup) {
	ap_os *os = grab(sizeof *os);
	os->setup = *setup;
	os->places = pl_new();
	os->s = sc_new((sc_options){.drop = drop});
	sc_on_tracking_end(os->s, pl_forget, os->places);
	os->table = tb_make(pl_event, os->places);
	os->paths = pt_new();
	tb_key root = tb_string(keepdup(os, setup->root));
	pr_processes_init(&os->rows, root);
	fr_init(&os->fronts, FR_PART);
	os->order[0] = &os->rows.contributor, os->order[1] = &os->fronts.contributor, os->order[2] = &pl_children;
	pl_connect(os->places, &(pl_setup){.root = root, .table = os->table, .paths = os->paths, .scheduler = os->s,
		.contributors = os->order, .ncontributors = 3});
	os->scopes = sn_new(os->s, os->table);
	sc_on_run_end(os->s, ended, os);
	os->status = cst_new(&(cst_setup){os->places, os->table, os->s});
	os->sites = st_new(os->s);
	os->info = (sc_pair){"actor", op_str("machine")};
	os->machine = st_create_root_scope(os->sites, &os->info, 1);
	os->host = keep(os, sizeof *os->host);
	*os->host = (ap_api){.os = os, .scope = os->machine};
	struct timespec ts;
	clock_gettime(CLOCK_REALTIME, &ts);
	os->clock = (int64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
	return os;
}

void ap_free(ap_os *os) {
	if (!os) return;
	ap_sweep(os);
	for (size_t i = 0; i < os->nkept; i++) free(os->kept[i]);
	free(os->kept);
	for (size_t i = 0; i < os->nlives; i++)
		if (os->lives[i].fn && os->lives[i].fn->free) os->lives[i].fn->free(os->lives[i].fn);
	free(os->lives), free(os->here), free(os->in_front);
	free(os->held);
	free(os);
}

sc_scheduler *ap_scheduler(ap_os *os) { return os->s; }
tb_table *ap_table(ap_os *os) { return os->table; }
pl *ap_places(ap_os *os) { return os->places; }
sn *ap_scopes(ap_os *os) { return os->scopes; }
sc_scope *ap_machine(ap_os *os) { return os->machine; }
st_sites *ap_sites(ap_os *os) { return os->sites; }

const char *ap_pid(ap_os *os) {
	char id[32];
	snprintf(id, sizeof id, "@%lld", (long long)++os->pids);
	return keepdup(os, id);
}

void ap_commit(void *ctx, const pl_changed *changed) {
	ap_os *os = ctx;
	if (!changed || !changed->n) return;
	pl_commit(os->places, changed);
	if (os->setup.card) cardWrote(os->setup.card, changed, NULL, 0);
}

// --- interfaces

ap_api *ap_host(ap_os *os) { return os->host; }

void ap_here_is(ap_os *os, const char *id, const char *const *at, size_t n) {
	for (size_t i = 0; i < os->nhere; i++)
		if (!strcmp(os->here[i].id, id)) {
			const char **path = keep(os, sizeof *path * (n + 2));
			path[0] = "/";
			for (size_t k = 0; k < n; k++) path[k + 1] = keepdup(os, at[k]);
			os->here[i].at = path, os->here[i].n = n + 1;
			return;
		}
	GROW(os->here, os->nhere, os->here_room);
	const char **path = keep(os, sizeof *path * (n + 2));
	path[0] = "/";
	for (size_t i = 0; i < n; i++) path[i + 1] = keepdup(os, at[i]);
	os->here[os->nhere++] = (Here){keepdup(os, id), path, n + 1};
}

const char *const *ap_here(ap_os *os, const char *id, size_t *n) {
	for (size_t i = 0; id && i < os->nhere; i++)
		if (!strcmp(os->here[i].id, id)) {
			*n = os->here[i].n;
			return os->here[i].at;
		}
	return NULL;
}

ap_api *ap_process(ap_os *os, sc_scope *scope, const char *self, const char *const *at, size_t nat) {
	ap_api *a = keep(os, sizeof *a);
	const char **place = keep(os, sizeof *place * (nat ? nat : 1));
	for (size_t i = 0; i + 1 < nat; i++) place[i] = keepdup(os, at[i]);
	*a = (ap_api){.os = os, .scope = scope, .self = self ? keepdup(os, self) : NULL,
		.name = nat ? keepdup(os, at[nat - 1]) : NULL, .place = place, .nplace = nat ? nat - 1 : 0};
	if (self) ap_here_is(os, self, at, nat);
	return a;
}

ap_api *ap_peep(ap_api *api) {
	ap_api *a = keep(api->os, sizeof *a);
	*a = *api;
	a->peep = 1;
	return a;
}

ap_api *ap_as(ap_api *api, const op_value *cause) {
	ap_api *a = ap_temp(api->os, sizeof *a);
	*a = *api;
	a->cause = cause;
	return a;
}

// --- addresses

// names from the root an address comes to: "/" first from the root, else from the api's place;
// "." here, ".." up one (at the root staying there). The turn's
static const char **resolve(ap_api *a, const char *const *address, size_t n, size_t *out) {
	const char **names = ap_temp(a->os, sizeof *names * (a->nplace + n + 1));
	size_t k = 0;
	size_t i = 0;
	if (n && !strcmp(address[0], "/")) i = 1;
	else
		for (; k < a->nplace; k++) names[k] = a->place[k];
	for (; i < n; i++) {
		if (!strcmp(address[i], "/")) k = 0;
		else if (!strcmp(address[i], ".")) continue;
		else if (!strcmp(address[i], "..")) k = k ? k - 1 : 0;
		else names[k++] = address[i];
	}
	*out = k;
	return names;
}

// --- reads

// f's reads, told to no one when the api peeps
typedef struct {
	void (*f)(void *ctx);
	void *ctx;
} Peeping;

static void peeping(void *ctx) {
	Peeping *p = ctx;
	p->f(p->ctx);
}

static void reading(ap_api *a, void (*f)(void *ctx), void *ctx) {
	if (!a->peep) {
		f(ctx);
		return;
	}
	pl_set reads = {0}, fresh = {0};
	Peeping p = {f, ctx};
	pl_record(a->os->places, peeping, &p, &reads, &fresh);
	for (size_t i = 0; i < fresh.n; i++) pl_forget(fresh.items[i], a->os->places);
	pl_set_free(&reads);
	pl_set_free(&fresh);
}

static const char *const ID_TEXT[] = {"value", "attributes", "children"};

static int loaded(ap_os *os, const char *id) {
	for (size_t i = 0; i < 3; i++)
		if (tb_get(os->table, tb_string(ID_TEXT[i]), tb_string(id))) return 1;
	size_t n = 0;
	tb_at(os->table, tb_string(id), &n);
	return n > 0;
}

// a site as 10-12 gave one: {file, line, column?, function?}
static op_value *site_value(const ch_site *s) {
	op_value *m = op_map();
	op_set(m, "file", op_str(s->file ? s->file : ""));
	op_set(m, "line", op_num((double)s->line));
	if (s->has_column) op_set(m, "column", op_num((double)s->column));
	if (s->function) op_set(m, "function", op_str(s->function));
	return m;
}

static ap_change change_of(ap_os *os, const ch_header *h) {
	ap_change c = {0};
	if (!h) return c;
	c.time = h->has_time ? h->time : 0;
	c.actor = h->actor;
	c.reader = h->reader;
	if (h->external_length) {
		op_value *site = site_value(&h->external[0]);
		hold_for_turn(os, site); // the turn's: let go at the sweep
		c.site = site;
	}
	for (size_t i = 0; i < h->metadata_length; i++)
		if (!strcmp(h->metadata[i].key, "cause")) c.cause = h->metadata[i].value;
	return c;
}

// a status as 10-12's programs read one: {pending: true}, or {error: {name, message}}
static const op_value *status_value(ap_os *os, const op_value *st) {
	if (!st) return NULL;
	op_value *m = op_map();
	const char *error = cst_error(st);
	if (cst_is_pending(st)) op_set(m, "pending", op_bool(1));
	else {
		op_value *e = op_map();
		op_set(e, "name", op_str("Error"));
		op_set(e, "message", op_str(error ? error : "failed"));
		op_set(e, "code", op_str("thrown"));
		op_set(m, "error", e);
	}
	hold_for_turn(os, m); // the turn's: a value the table does not hold
	return m;
}

// an answer as an item, its versions read (told) when content
static void item_of(ap_api *a, const char *id, const char *from, const char *const *route, size_t nroute, int content,
	ap_item *out) {
	ap_os *os = a->os;
	*out = (ap_item){.id = ap_dup(os, id), .from = from, .route = route, .nroute = nroute};
	out->node = loaded(os, id);
	out->ephemeral = !id_is(id);
	if (!out->node || !content) return;
	out->has_versions = 1;
	const op_value *st = cst_status(os->places, tb_string(out->id));
	const op_value *v = pl_read(os->places, tb_string("value"), tb_string(out->id), NULL, 0);
	const ch_header *h = pl_change(os->places, tb_string("value"), tb_string(out->id));
	out->versions = ap_temp(os, sizeof *out->versions * 2);
	if (st) out->versions[out->nversions++] = (ap_version){status_value(os, st), {0}, 1};
	if (v) out->versions[out->nversions++] = (ap_version){v, change_of(os, h), 0};
}

typedef struct {
	ap_api *a;
	const char **names;
	size_t n;
	int content;
	ap_items *out;
} Gets;

static void getting(void *ctx) {
	Gets *g = ctx;
	ap_os *os = g->a->os;
	pl_answers all = pl_gets(os->places, g->names, g->n);
	g->out->items = ap_temp(os, sizeof *g->out->items * (all.n ? all.n : 1));
	g->out->n = 0;
	for (size_t i = 0; i < all.n; i++) {
		if (!all.items[i].id.string) continue;
		item_of(g->a, all.items[i].id.string, all.items[i].from, g->names, g->n, g->content, &g->out->items[g->out->n++]);
	}
	pl_answers_free(&all);
}

// an address by id (AP_ID): the id its names come to, read as a walk from the id; 0: none there
static int by_id(ap_api *a, const char *const *address, size_t n, size_t upto, tb_key *out) {
	ap_os *os = a->os;
	tb_key at = tb_string(address[1]);
	if (upto > 2) {
		pl_member *steps = ap_temp(os, sizeof *steps * upto);
		size_t walked = pl_walk(os->places, at, address + 2, upto - 2, steps);
		if (walked < upto - 2) return 0;
		at = steps[upto - 3].id;
	}
	(void)n;
	*out = at;
	return 1;
}

static int is_id(const char *const *address, size_t n) {
	return n >= 2 && !strcmp(address[0], AP_ID);
}

typedef struct {
	ap_api *a;
	const char *const *address;
	size_t n;
	int content;
	ap_items *out;
} ById;

static void getting_by_id(void *ctx) {
	ById *b = ctx;
	ap_os *os = b->a->os;
	tb_key id;
	if (b->n == 2) {
		b->out->items = ap_temp(os, sizeof *b->out->items);
		b->out->n = 1;
		item_of(b->a, b->address[1], "id", b->address + 2, 0, b->content, &b->out->items[0]);
		return;
	}
	if (!by_id(b->a, b->address, b->n, b->n - 1, &id) || !id.string) return;
	pl_here here = {.id = id};
	pl_answers all = pl_answers_at(os->places, &here, b->address[b->n - 1]);
	b->out->items = ap_temp(os, sizeof *b->out->items * (all.n ? all.n : 1));
	for (size_t i = 0; i < all.n; i++)
		if (all.items[i].id.string)
			item_of(b->a, all.items[i].id.string, all.items[i].from, b->address + 2, b->n - 2, b->content, &b->out->items[b->out->n++]);
	pl_answers_free(&all);
}

static const ap_error *items_at(ap_api *a, const char *const *address, size_t n, int content, ap_items *out) {
	*out = (ap_items){0};
	if (is_id(address, n)) {
		ById b = {a, address, n, content, out};
		reading(a, getting_by_id, &b);
		return NULL;
	}
	size_t k;
	const char **names = resolve(a, address, n, &k);
	// the root: itself
	if (!k) {
		const char *root = pl_root(a->os->places).string;
		out->items = ap_temp(a->os, sizeof *out->items);
		out->n = 1;
		item_of(a, root, "root", names, 0, content, &out->items[0]);
		return NULL;
	}
	Gets g = {a, names, k, content, out};
	reading(a, getting, &g);
	return NULL;
}

// what is at an address: items without their values (no versions read or tracked), so a look is told
// of placements, not of every change of what is placed; content reads the values too
const ap_error *ap_look(ap_api *a, const char *const *address, size_t n, ap_items *out) {
	return items_at(a, address, n, 0, out);
}

const ap_error *ap_content(ap_api *a, const char *const *address, size_t n, ap_items *out) {
	return items_at(a, address, n, 1, out);
}

const ap_item *ap_first(ap_api *a, const char *const *address, size_t n) {
	ap_items items;
	if (items_at(a, address, n, 0, &items)) return NULL;
	for (size_t i = 0; i < items.n; i++)
		if (items.items[i].node) return &items.items[i];
	return NULL;
}

const op_value *ap_read(ap_api *a, const char *const *address, size_t n) {
	ap_items items;
	if (items_at(a, address, n, 1, &items)) return NULL;
	for (size_t i = 0; i < items.n; i++) {
		if (!items.items[i].node) continue;
		for (size_t k = 0; k < items.items[i].nversions; k++)
			if (!items.items[i].versions[k].status) return items.items[i].versions[k].content;
		return NULL;
	}
	return NULL;
}

typedef struct {
	ap_api *a;
	const char **names;
	size_t n;
	int all;
	ap_items *out;
} Looking;

static void looking(void *ctx) {
	Looking *l = ctx;
	ap_os *os = l->a->os;
	size_t nfrom = l->a->nplace;
	size_t *depths = ap_temp(os, sizeof *depths * (nfrom + 1));
	size_t found = pl_lookup(os->places, l->names, l->n, l->a->place, nfrom, l->all, depths);
	l->out->items = ap_temp(os, sizeof *l->out->items * (found ? found * 4 : 1));
	l->out->n = 0;
	for (size_t f = 0; f < found; f++) {
		size_t k = depths[f];
		const char **path = ap_temp(os, sizeof *path * (k + l->n + 1));
		for (size_t i = 0; i < k; i++) path[i] = l->a->place[i];
		for (size_t i = 0; i < l->n; i++) path[k + i] = l->names[i];
		pl_answers all = pl_gets(os->places, path, k + l->n);
		for (size_t i = 0; i < all.n && i < 4; i++)
			if (all.items[i].id.string)
				item_of(l->a, all.items[i].id.string, all.items[i].from, path, k + l->n, 1, &l->out->items[l->out->n++]);
		pl_answers_free(&all);
	}
}

static const ap_error *lookup(ap_api *a, const char *const *path, size_t n, int all, ap_items *out) {
	*out = (ap_items){0};
	Looking l = {a, (const char **)path, n, all, out};
	reading(a, looking, &l);
	return NULL;
}

const ap_error *ap_lookup(ap_api *a, const char *const *path, size_t n, ap_items *out) {
	return lookup(a, path, n, 0, out);
}

const ap_error *ap_lookups(ap_api *a, const char *const *path, size_t n, ap_items *out) {
	return lookup(a, path, n, 1, out);
}

typedef struct {
	ap_api *a;
	const char **names;
	size_t n;
	ap_namelist *out;
} Listing;

static void listing(void *ctx) {
	Listing *l = ctx;
	ap_os *os = l->a->os;
	pl_members all = pl_list(os->places, l->names, l->n);
	l->out->names = ap_temp(os, sizeof *l->out->names * (all.n ? all.n : 1));
	l->out->n = 0;
	for (size_t i = 0; i < all.n; i++) l->out->names[l->out->n++] = ap_dup(os, all.items[i].name);
	pl_members_free(&all);
}

typedef struct {
	ap_api *a;
	const char *const *address;
	size_t n;
	ap_namelist *out;
} NamingId;

static void naming_by_id(void *ctx) {
	NamingId *m = ctx;
	ap_os *os = m->a->os;
	tb_key id;
	if (!by_id(m->a, m->address, m->n, m->n, &id)) return;
	pl_here here = {.id = id};
	pl_nameds all = pl_names(os->places, &here);
	m->out->names = ap_temp(os, sizeof *m->out->names * (all.n ? all.n : 1));
	for (size_t i = 0; i < all.n; i++) m->out->names[m->out->n++] = ap_dup(os, all.items[i].name);
	pl_nameds_free(&all);
}

const ap_error *ap_names(ap_api *a, const char *const *address, size_t n, ap_namelist *out) {
	*out = (ap_namelist){0};
	if (is_id(address, n)) {
		NamingId m = {a, address, n, out};
		reading(a, naming_by_id, &m);
		return NULL;
	}
	size_t k;
	const char **names = resolve(a, address, n, &k);
	Listing l = {a, names, k, out};
	reading(a, listing, &l);
	return NULL;
}

typedef struct {
	ap_api *a;
	const char **names;
	size_t n;
	const char *part;
	ap_namelist *out;
} Naming;

static void naming(void *ctx) {
	Naming *m = ctx;
	ap_os *os = m->a->os;
	tb_key id;
	if (is_id(m->names, m->n)) {
		if (!by_id(m->a, m->names, m->n, m->n, &id)) return;
	} else if (m->n && !pl_get(os->places, m->names, m->n, &id)) return;
	else if (!m->n) id = pl_root(os->places);
	pl_namelist list = {0};
	pl_keys(os->places, tb_string(!strcmp(m->part, "info") ? "attributes" : "children"), id, NULL, 0, 0, &list);
	m->out->names = ap_temp(os, sizeof *m->out->names * (list.n ? list.n : 1));
	for (size_t i = 0; i < list.n; i++) m->out->names[m->out->n++] = ap_dup(os, list.items[i]);
	pl_namelist_free(&list);
}

const ap_error *ap_names_of(ap_api *a, const char *const *address, size_t n, const char *part, ap_namelist *out) {
	*out = (ap_namelist){0};
	size_t k = n;
	const char **names = is_id(address, n) ? (const char **)address : resolve(a, address, n, &k);
	Naming m = {a, names, k, part, out};
	reading(a, naming, &m);
	return NULL;
}

const ap_error *ap_children(ap_api *a, const char *const *address, size_t n, const char *name, ap_items *out) {
	const char **at = ap_temp(a->os, sizeof *at * (n + 1));
	for (size_t i = 0; i < n; i++) at[i] = address[i];
	at[n] = name;
	return items_at(a, at, n + 1, 1, out);
}

typedef struct {
	ap_api *a;
	const char **names;
	size_t n;
	const char *name;
	ap_items *out;
} Info;

static void info(void *ctx) {
	Info *f = ctx;
	ap_os *os = f->a->os;
	tb_key id;
	if (is_id(f->names, f->n)) {
		if (!by_id(f->a, f->names, f->n, f->n, &id)) return;
	} else if (f->n ? !pl_get(os->places, f->names, f->n, &id) : 0) return;
	else if (!f->n) id = pl_root(os->places);
	op_key key = {.type = OP_STR_KEY, .s = f->name};
	const op_value *v = pl_read(os->places, tb_string("attributes"), id, &key, 1);
	f->out->items = ap_temp(os, sizeof *f->out->items);
	f->out->n = 1;
	ap_item *it = &f->out->items[0];
	*it = (ap_item){.id = ap_dup(os, id.string), .from = "attributes", .route = f->names, .nroute = f->n, .node = 1,
		.ephemeral = !id_is(id.string), .has_versions = 1};
	it->versions = ap_temp(os, sizeof *it->versions);
	if (v) it->versions[it->nversions++] = (ap_version){v, change_of(os, pl_change(os->places, tb_string("attributes"), id)), 0};
}

const ap_error *ap_info(ap_api *a, const char *const *address, size_t n, const char *name, ap_items *out) {
	*out = (ap_items){0};
	size_t k = n;
	const char **names = is_id(address, n) ? (const char **)address : resolve(a, address, n, &k);
	Info f = {a, names, k, name, out};
	reading(a, info, &f);
	return NULL;
}

static op_value *versions_of(const op_value *v) {
	op_value *list = op_list();
	if (v) {
		op_value *ver = op_map();
		op_set(ver, "content", op_ref((op_value *)v));
		op_push(list, ver);
	}
	return list;
}

const ap_error *ap_node(ap_api *a, const char *id, op_value **out) {
	ap_os *os = a->os;
	*out = NULL;
	if (!loaded(os, id)) return NULL;
	op_value *n = op_map();
	op_set(n, "id", op_str(id));
	op_set(n, "value", versions_of(pl_read(os->places, tb_string("value"), tb_string(id), NULL, 0)));
	op_value *infos = op_map(), *children = op_map();
	const op_value *attrs = pl_read(os->places, tb_string("attributes"), tb_string(id), NULL, 0);
	for (size_t i = 0; attrs && attrs->type == OP_MAP && i < attrs->count; i++)
		op_set(infos, attrs->keys[i], versions_of(attrs->items[i]));
	pl_here here = {.id = tb_string(id)};
	pl_nameds names = pl_names(os->places, &here);
	for (size_t i = 0; i < names.n; i++) {
		tb_key ids[16];
		size_t k = fr_members(os->places, FR_PART, tb_string(id), names.items[i].name, ids, 16);
		op_value *list = op_list();
		for (size_t j = 0; j < k && j < 16; j++) op_push(list, op_str(ids[j].string));
		op_value *ver = op_map();
		op_set(ver, "content", list);
		op_value *vs = op_list();
		op_push(vs, ver);
		op_set(children, names.items[i].name, vs);
	}
	pl_nameds_free(&names);
	op_set(n, "info", infos);
	op_set(n, "children", children);
	*out = n;
	op_value **slot = ap_temp(os, sizeof *slot);
	*slot = n;
	return NULL;
}

// --- writes

// what a write holds: the header's block, the entries it changed, and those it made
typedef struct {
	ap_api *a;
	const char *op;
	ch_header h;
	pl_made *made;
	pl_changed changed;
	struct {
		nd_entry *entry;
		const char *part, *id;
	} born[4];
	size_t nborn;
	const ap_error *e;
	void (*f)(void *w);
	void *ctx;
} Writing;

static void born(Writing *w, nd_entry *entry, const char *part, const char *id) {
	if (!entry || w->nborn >= 4) return;
	w->born[w->nborn].entry = entry, w->born[w->nborn].part = part, w->born[w->nborn].id = id;
	w->nborn++;
}

// the header made with a scope open, f, then each entry it changed or made holding the block, said written
static void writing_body(void *data) {
	Writing *w = data;
	ap_os *os = w->a->os;
	sc_pair extra[1];
	size_t n = 0;
	if (w->a->cause) extra[n++] = (sc_pair){"cause", w->a->cause};
	ch_site site = {.file = w->a->self ? w->a->self : "machine", .line = 0, .function = w->op};
	char *bad = pl_header(os->places, extra, n, &site, &w->h, &w->made);
	if (bad) {
		w->e = ap_error_new(os, "unscoped", bad);
		free(bad);
		return;
	}
	w->f(w);
	for (size_t i = 0; i < w->changed.n; i++) pl_hold_also(os->places, w->changed.entries[i], pl_made_ref(w->made), pl_made_free);
	for (size_t i = 0; i < w->nborn; i++) pl_hold_also(os->places, w->born[i].entry, pl_made_ref(w->made), pl_made_free);
	pl_made_free(w->made);
	pl_commit(os->places, &w->changed);
	// the card: each kept table changed one commit; an entry born in the write its value whole
	card_born born[4];
	for (size_t i = 0; i < w->nborn; i++) born[i] = (card_born){w->born[i].entry, w->born[i].part, w->born[i].id};
	if (os->setup.card) cardWrote(os->setup.card, &w->changed, born, w->nborn);
}

static const ap_error *write_with(ap_api *a, const char *op, void (*f)(void *w), void *ctx, int64_t *time) {
	ap_os *os = a->os;
	Writing w = {.a = a, .op = op, .f = f, .ctx = ctx};
	if (sc_get_current_scope(os->s)) writing_body(&w);
	else {
		const char *gone = sc_run_with_scope(a->scope ? a->scope : os->machine, writing_body, &w);
		if (gone) return ap_error_new(os, "stopped", "stopped: its process has ended");
	}
	if (time) *time = ++os->clock;
	return w.e;
}

// an entry at (part, id), made empty if none (a map for a map's part): the places' own
static nd_entry *entry_at(Writing *w, const char *part, const char *id, int map) {
	ap_os *os = w->a->os;
	nd_entry *e = tb_get(os->table, tb_string(part), tb_string(id));
	if (e) return e;
	op_value *v = map ? op_map() : NULL;
	// a node's value is copy-on-write: what a patch leaves is the same value as before (val.h's kept Json)
	e = nd_make_entry(v, &w->h, &(nd_entry_options){.in_place = strcmp(part, "value") != 0});
	op_free(v);
	pl_own(os->places, e);
	const char *kept = keepdup(os, id);
	tb_add(os->table, tb_string(part), tb_string(kept), e);
	born(w, e, part, kept);
	return e;
}

// patches copied, keys and all, held by the entry they went into
typedef struct {
	op_patch *patches;
	size_t n;
	op_key **keys;
	size_t nkeys;
	char **strings;
	size_t nstrings;
} Held;

static void held_free(void *block) {
	Held *h = block;
	for (size_t i = 0; i < h->n; i++) op_free((op_value *)h->patches[i].value);
	for (size_t i = 0; i < h->nkeys; i++) free(h->keys[i]);
	for (size_t i = 0; i < h->nstrings; i++) free(h->strings[i]);
	free(h->patches), free(h->keys), free(h->strings), free(h);
}

static op_target target_copy(Held *h, const op_target *t, const char *prefix) {
	op_target out = *t;
	size_t n = t->length + (prefix ? 1 : 0);
	op_key *keys = grab(sizeof *keys * (n ? n : 1));
	h->keys[h->nkeys++] = keys;
	size_t k = 0;
	if (prefix) {
		char *s = copied(prefix);
		h->strings[h->nstrings++] = s;
		keys[k++] = (op_key){.type = OP_STR_KEY, .s = s};
	}
	for (size_t i = 0; i < t->length; i++) {
		keys[k] = t->path[i];
		if (t->path[i].type == OP_STR_KEY && t->path[i].s) {
			char *s = copied(t->path[i].s);
			h->strings[h->nstrings++] = s;
			keys[k].s = s;
		}
		k++;
	}
	out.path = keys, out.length = n;
	return out;
}

static Held *held_of(const op_patch *patches, size_t n, const char *prefix) {
	Held *h = grab(sizeof *h);
	h->patches = grab(sizeof *h->patches * (n ? n : 1));
	h->keys = grab(sizeof *h->keys * (2 * n + 1));
	size_t strings = 1;
	for (size_t i = 0; i < n; i++) strings += patches[i].place.length + patches[i].move.length + 2;
	h->strings = grab(sizeof *h->strings * strings);
	h->n = n;
	for (size_t i = 0; i < n; i++) {
		h->patches[i] = patches[i];
		h->patches[i].place = target_copy(h, &patches[i].place, prefix);
		if (patches[i].has_move) h->patches[i].move = target_copy(h, &patches[i].move, prefix);
		h->patches[i].value = patches[i].value ? op_ref((op_value *)patches[i].value) : NULL;
	}
	return h;
}

// patches into the entry at (part, id), made if none: changed, or an error
static void apply(Writing *w, const char *part, const char *id, const op_patch *patches, size_t n, const char *prefix) {
	ap_os *os = w->a->os;
	nd_entry *e = entry_at(w, part, id, prefix != NULL);
	// a value is changed copy-on-write, whoever made its entry (places' are in place)
	if (!strcmp(part, "value")) e->in_place = 0;
	Held *h = held_of(patches, n, prefix);
	size_t failed = 0;
	int code = nd_update(e, h->patches, h->n, w->h, &failed);
	if (code != OP_OK) {
		held_free(h);
		w->e = fail(os, "wrong-field", "patch %zu: %s", failed, op_code_name(code));
		return;
	}
	pl_hold(os->places, e, h, held_free);
	w->changed.entries[w->changed.n++] = e;
}

// the index-th loaded item at an address (none: its first)
static const char *target(ap_api *a, const char *const *address, size_t n, const long *index) {
	ap_items items;
	items_at(a, address, n, 0, &items);
	long k = 0;
	for (size_t i = 0; i < items.n; i++) {
		if (!items.items[i].node) continue;
		if (!index || k == *index) return items.items[i].id;
		k++;
	}
	return NULL;
}

typedef struct {
	const char *id, *part, *prefix;
	const op_patch *patches;
	size_t n;
} Patching;

static void patching(void *data) {
	Writing *w = data;
	Patching *p = w->ctx;
	apply(w, p->part, p->id, p->patches, p->n, p->prefix);
}

const ap_error *ap_write(ap_api *a, const char *const *address, size_t n, const op_patch *patches, size_t np,
	const long *index, int64_t *time) {
	const char *id = target(a, address, n, index);
	if (!id) return ap_error_new(a->os, "nothing-there", "nothing there to write");
	Patching p = {id, "value", NULL, patches, np};
	return write_with(a, "write", patching, &p, time);
}

const ap_error *ap_set(ap_api *a, const char *const *address, size_t n, const char *name, const op_patch *patches,
	size_t np, const long *index, int64_t *time) {
	const char *id = target(a, address, n, index);
	if (!id) return ap_error_new(a->os, "nothing-there", "nothing there to set");
	Patching p = {id, "attributes", name, patches, np};
	return write_with(a, "set", patching, &p, time);
}

const ap_error *ap_snap(ap_api *a, const char *const *address, size_t n, const op_value *value) {
	op_patch p = {.has_value = 1, .value = value};
	op_value *none = NULL;
	if (!value) p.value = none = op_null();
	const ap_error *e = ap_write(a, address, n, &p, 1, NULL, NULL);
	op_free(none);
	return e;
}

// --- members: the fronts at a name, then its child

static void front_of(ap_os *os, const char *id, const char *parent, const char *name) {
	GROW(os->in_front, os->nfront, os->front_room);
	os->in_front[os->nfront++] = (Front){copied(id), copied(parent), copied(name)};
}

static void front_out(ap_os *os, const char *id, const char *parent, const char *name) {
	for (size_t i = 0; i < os->nfront; i++) {
		Front *f = &os->in_front[i];
		if (strcmp(f->id, id) || strcmp(f->parent, parent) || strcmp(f->name, name)) continue;
		free(f->id), free(f->parent), free(f->name);
		os->in_front[i] = os->in_front[--os->nfront];
		return;
	}
}

static const char *child_at(ap_os *os, const char *parent, const char *name) {
	const nd_entry *e = tb_get(os->table, tb_string("children"), tb_string(parent));
	const op_value *v = e && e->value && e->value->type == OP_MAP ? op_get(e->value, name) : NULL;
	return v && v->type == OP_STR ? v->str : NULL;
}

static size_t fronts_at(ap_os *os, const char *parent, const char *name, const char **out, size_t cap) {
	const nd_entry *e = tb_get(os->table, tb_string(FR_PART), tb_string(parent));
	const op_value *v = e && e->value && e->value->type == OP_MAP ? op_get(e->value, name) : NULL;
	size_t n = 0;
	for (size_t i = 0; v && v->type == OP_LIST && i < v->count; i++)
		if (v->items[i]->type == OP_STR) {
			if (n < cap) out[n] = v->items[i]->str;
			n++;
		}
	return n;
}

typedef struct {
	const char *parent, *name, *child, *to, *toparent;
	const long *index;
	long at;
} Membering;

static int code_of(Writing *w, int code, const char *what) {
	if (code) w->e = fail(w->a->os, pl_code_name(code), "%s: %s", what, pl_code_name(code));
	return code;
}

static void inserting(void *data) {
	Writing *w = data;
	Membering *m = w->ctx;
	ap_os *os = w->a->os;
	if (!id_is(m->child)) {
		// ephemeral: in front, at index (none: after the fronts there)
		nd_entry *made = NULL;
		long at = m->index ? *m->index : -1;
		if (!code_of(w, fr_add(os->places, os->table, FR_PART, tb_string(m->parent), m->name, tb_string(m->child), at, w->h,
			                  &w->changed, &made),
			    "insert")) {
			born(w, made, FR_PART, keepdup(os, m->parent));
			front_of(os, m->child, m->parent, m->name);
		}
		return;
	}
	nd_entry *children = entry_at(w, "children", m->parent, 1);
	code_of(w, pl_place(os->places, children, m->name, tb_string(m->child), w->h, &w->changed), "insert");
}

const ap_error *ap_insert(ap_api *a, const char *id, const char *name, const char *child, const long *index,
	int64_t *time) {
	if (!pl_is_name(name)) return ap_error_new(a->os, "wrong-field", "not a name");
	Membering m = {.parent = id, .name = name, .child = child, .index = index};
	return write_with(a, "insert", inserting, &m, time);
}

static void lives_out(ap_os *os, const char *id);
static bool fronted(ap_os *os, const char *id);

static void removing(void *data) {
	Writing *w = data;
	Membering *m = w->ctx;
	ap_os *os = w->a->os;
	const char *ids[64];
	size_t n = fronts_at(os, m->parent, m->name, ids, 64);
	if (m->at >= 0 && (size_t)m->at < n && m->at < 64) {
		const char *id = ids[m->at];
		char *kept = ap_dup(os, id);
		if (!code_of(w, fr_remove(os->places, os->table, FR_PART, tb_string(m->parent), m->name, tb_string(kept), w->h, &w->changed), "remove")) {
			front_out(os, kept, m->parent, m->name);
			// an ephemeral node out of its last front: its handler is called no more, its function let go
			if (!id_is(kept) && !fronted(os, kept)) lives_out(os, kept);
		}
		return;
	}
	const char *child = child_at(os, m->parent, m->name);
	if (!child || m->at != (long)n) {
		w->e = ap_error_new(os, "nothing-there", "no member there");
		return;
	}
	nd_entry *children = tb_get(os->table, tb_string("children"), tb_string(m->parent));
	code_of(w, pl_unplace(os->places, children, m->name, w->h, &w->changed), "remove");
}

const ap_error *ap_remove(ap_api *a, const char *id, const char *name, long index, int64_t *time) {
	Membering m = {.parent = id, .name = name, .at = index};
	return write_with(a, "remove", removing, &m, time);
}

static void renaming(void *data) {
	Writing *w = data;
	Membering *m = w->ctx;
	ap_os *os = w->a->os;
	const char *ids[64];
	size_t n = fronts_at(os, m->parent, m->name, ids, 64);
	char **kept = ap_temp(os, sizeof *kept * (n + 1));
	for (size_t i = 0; i < n && i < 64; i++) kept[i] = ap_dup(os, ids[i]);
	for (size_t i = 0; i < n && i < 64 && !w->e; i++) {
		pl_changed one = {0};
		if (code_of(w, fr_remove(os->places, os->table, FR_PART, tb_string(m->parent), m->name, tb_string(kept[i]), w->h, &one), "rename")) break;
		ap_commit(os, &one);
		for (size_t k = 0; k < one.n; k++) pl_hold_also(os->places, one.entries[k], pl_made_ref(w->made), pl_made_free);
		front_out(os, kept[i], m->parent, m->name);
		nd_entry *made = NULL;
		one = (pl_changed){0};
		if (code_of(w, fr_add(os->places, os->table, FR_PART, tb_string(m->parent), m->to, tb_string(kept[i]), -1, w->h, &one, &made), "rename")) break;
		ap_commit(os, &one);
		for (size_t k = 0; k < one.n; k++) pl_hold_also(os->places, one.entries[k], pl_made_ref(w->made), pl_made_free);
		born(w, made, FR_PART, keepdup(os, m->parent));
		front_of(os, kept[i], m->parent, m->to);
	}
	if (w->e || !child_at(os, m->parent, m->name)) return;
	nd_entry *children = tb_get(os->table, tb_string("children"), tb_string(m->parent));
	code_of(w, pl_rename(os->places, children, m->name, m->to, w->h, &w->changed), "rename");
}

const ap_error *ap_rename(ap_api *a, const char *id, const char *name, const char *to, int64_t *time) {
	if (!pl_is_name(to)) return ap_error_new(a->os, "wrong-field", "not a name");
	Membering m = {.parent = id, .name = name, .to = to};
	return write_with(a, "rename", renaming, &m, time);
}

static void moving(void *data) {
	Writing *w = data;
	Membering *m = w->ctx;
	ap_os *os = w->a->os;
	const char *ids[64];
	size_t n = fronts_at(os, m->parent, m->name, ids, 64);
	if (m->at >= 0 && (size_t)m->at < n && m->at < 64) {
		char *kept = ap_dup(os, ids[m->at]);
		pl_changed one = {0};
		if (code_of(w, fr_remove(os->places, os->table, FR_PART, tb_string(m->parent), m->name, tb_string(kept), w->h, &one), "move")) return;
		ap_commit(os, &one);
		for (size_t k = 0; k < one.n; k++) pl_hold_also(os->places, one.entries[k], pl_made_ref(w->made), pl_made_free);
		front_out(os, kept, m->parent, m->name);
		nd_entry *made = NULL;
		long at = m->index ? *m->index : -1;
		if (!code_of(w, fr_add(os->places, os->table, FR_PART, tb_string(m->toparent), m->to, tb_string(kept), at, w->h, &w->changed, &made), "move")) {
			born(w, made, FR_PART, keepdup(os, m->toparent));
			front_of(os, kept, m->toparent, m->to);
		}
		return;
	}
	if (m->at != (long)n || !child_at(os, m->parent, m->name)) {
		w->e = ap_error_new(os, "nothing-there", "no member there");
		return;
	}
	nd_entry *from = tb_get(os->table, tb_string("children"), tb_string(m->parent));
	nd_entry *into = entry_at(w, "children", m->toparent, 1);
	code_of(w, pl_move(os->places, from, m->name, into, m->to, w->h, &w->changed), "move");
}

const ap_error *ap_move(ap_api *a, const char *id, const char *name, long index, const char *toid,
	const char *toname, const long *toindex, int64_t *time) {
	if (!pl_is_name(toname)) return ap_error_new(a->os, "wrong-field", "not a name");
	Membering m = {.parent = id, .name = name, .at = index, .toparent = toid, .to = toname, .index = toindex};
	return write_with(a, "move", moving, &m, time);
}

// --- nodes

typedef struct {
	ap_os *os;
	char *id;
} Going;

// a live function let go: its function freed (ap_fn's free), its number answering no one (live_of)
static void live_out(ap_os *os, const op_value *v, int depth) {
	if (!v || depth > 64) return;
	if (v->type == OP_STAND) {
		const op_value *kind = v->count ? v->items[0] : NULL;
		const op_value *n = kind && kind->type == OP_MAP ? op_get(kind, "live") : NULL;
		if (!n || n->type != OP_NUM || n->num < 0 || (size_t)n->num >= os->nlives) return;
		Live *l = &os->lives[(size_t)n->num];
		if (l->fn && l->fn->free) l->fn->free(l->fn);
		l->fn = NULL, l->owner = NULL;
	} else if (v->type == OP_LIST || v->type == OP_MAP)
		for (size_t i = 0; i < v->count; i++) live_out(os, v->items[i], depth + 1);
}

/** the lives a node's value holds let go: the node is gone, or out of its last front (a handler no one reaches again) */
static void lives_out(ap_os *os, const char *id) {
	const nd_entry *e = tb_get(os->table, tb_string("value"), tb_string(id));
	if (e) live_out(os, e->value, 0);
}

static bool fronted(ap_os *os, const char *id) {
	for (size_t i = 0; i < os->nfront; i++)
		if (!strcmp(os->in_front[i].id, id)) return true;
	return false;
}

// an ephemeral node's teardown: out of every front it is in, its entries out of the table
static char *going(void *data) {
	Going *g = data;
	ap_os *os = g->os;
	for (size_t i = 0; i < os->nfront;) {
		Front *f = &os->in_front[i];
		if (strcmp(f->id, g->id)) {
			i++;
			continue;
		}
		Writing w = {.a = os->host, .op = "gone"};
		char *parent = ap_dup(os, f->parent), *name = ap_dup(os, f->name);
		ch_site site = {.file = "machine", .function = "gone"};
		char *bad = pl_header(os->places, NULL, 0, &site, &w.h, &w.made);
		if (bad) {
			free(bad);
			front_out(os, g->id, parent, name);
			continue;
		}
		fr_remove(os->places, os->table, FR_PART, tb_string(parent), name, tb_string(g->id), w.h, &w.changed);
		for (size_t k = 0; k < w.changed.n; k++) pl_hold_also(os->places, w.changed.entries[k], pl_made_ref(w.made), pl_made_free);
		pl_made_free(w.made);
		ap_commit(os, &w.changed);
		front_out(os, g->id, parent, name);
	}
	lives_out(os, g->id);
	const char *parts[] = {"value", "attributes", "children", FR_PART};
	for (size_t i = 0; i < 4; i++) tb_del(os->table, tb_string(parts[i]), tb_string(g->id));
	free(g->id);
	free(g);
	return NULL;
}

void ap_goes_with(ap_os *os, sc_scope *scope, const char *id) {
	Going *g = grab(sizeof *g);
	g->os = os, g->id = copied(id);
	free(sc_register_teardown(os->s, scope, going, g));
}

typedef struct {
	const op_value *value;
	const char *id;
	int ephemeral;
	const char *made;
} Creating;

static void creating(void *data) {
	Writing *w = data;
	Creating *c = w->ctx;
	ap_os *os = w->a->os;
	const char *id = c->id;
	if (!id) {
		if (c->ephemeral || !os->setup.card) id = ap_pid(os);
		else {
			char fresh[ID_LENGTH + 1];
			cardFresh(os->setup.card, fresh);
			id = keepdup(os, fresh);
		}
	} else id = keepdup(os, id);
	c->made = id;
	nd_entry *e = tb_get(os->table, tb_string("value"), tb_string(id));
	if (e) {
		// there already (an id given again): its value written
		op_patch p = {.has_value = 1, .value = c->value};
		op_value *none = NULL;
		if (!c->value) p.value = none = op_null();
		apply(w, "value", id, &p, 1, NULL);
		op_free(none);
		return;
	}
	e = nd_make_entry((op_value *)c->value, &w->h, &(nd_entry_options){.in_place = 0});
	pl_own(os->places, e);
	tb_add(os->table, tb_string("value"), tb_string(id), e);
	born(w, e, "value", id);
	// an ephemeral node goes with the scope that made it
	sc_scope *scope = sc_get_current_scope(os->s);
	if (!id_is(id) && scope && scope != os->machine) {
		Going *g = grab(sizeof *g);
		g->os = os, g->id = copied(id);
		free(sc_register_teardown(os->s, scope, going, g));
	}
}

const ap_error *ap_create(ap_api *a, const op_value *value, const char *id, int ephemeral, const char **out) {
	Creating c = {value, id, ephemeral, NULL};
	const ap_error *e = write_with(a, "create", creating, &c, NULL);
	*out = c.made;
	return e;
}

const char *ap_put(ap_api *a, const char *parent, const char *name, const op_value *value, int ephemeral) {
	const char *id = NULL;
	const ap_error *e = ap_create(a, value, NULL, ephemeral, &id);
	if (!e) e = ap_insert(a, parent, name, id, NULL, NULL);
	if (e) {
		say(a->os, "make %s: %s%s%s", name, e->code ? e->code : "thrown", e->message ? ": " : "", e->message ? e->message : "");
		return NULL;
	}
	return id;
}

// --- live functions

op_value *ap_live(ap_api *a, ap_fn *f) {
	ap_os *os = a->os;
	GROW(os->lives, os->nlives, os->lives_room);
	os->lives[os->nlives] = (Live){f, a};
	op_value *kind = op_map();
	op_set(kind, "live", op_num((double)os->nlives));
	os->nlives++;
	return op_stand(kind);
}

static const Live *live_of(ap_os *os, const op_value *v) {
	if (!v || v->type != OP_STAND || !v->count) return NULL;
	const op_value *kind = v->items[0];
	const op_value *n = kind && kind->type == OP_MAP ? op_get(kind, "live") : NULL;
	if (!n || n->type != OP_NUM || n->num < 0 || (size_t)n->num >= os->nlives) return NULL;
	const Live *l = &os->lives[(size_t)n->num];
	return l->fn ? l : NULL;
}

ap_fn *ap_live_fn(ap_os *os, const op_value *v) {
	const Live *l = live_of(os, v);
	return l ? l->fn : NULL;
}

bool ap_equal(const op_value *a, const op_value *b) {
	if (a == b) return true;
	if (!a || !b || a->type != b->type) return false;
	switch (a->type) {
	case OP_NULL: return true;
	case OP_BOOL: return a->bool_ == b->bool_;
	case OP_NUM: return a->num == b->num || (a->num != a->num && b->num != b->num);
	case OP_STR: return a->bytes == b->bytes && !memcmp(a->str, b->str, a->bytes);
	case OP_TYPED:
		if (a->kind != b->kind) return false;
		// fall through
	case OP_BYTES: return a->bytes == b->bytes && (!a->bytes || !memcmp(a->data, b->data, a->bytes));
	case OP_STAND:
	case OP_LIST:
		if (a->count != b->count) return false;
		for (size_t i = 0; i < a->count; i++)
			if (!ap_equal(a->items[i], b->items[i])) return false;
		return true;
	case OP_MAP:
		if (a->count != b->count) return false;
		for (size_t i = 0; i < a->count; i++)
			if (!ap_equal(a->items[i], op_get(b, a->keys[i]))) return false;
		return true;
	}
	return false;
}

// --- parts

typedef struct {
	ap_fn *fn;
	ap_given *g;
	op_value *out;
	int pending;
	const ap_error *e;
} Calling;

static void calling(void *data) {
	Calling *c = data;
	c->e = c->fn->call(c->fn, c->g, &c->out, &c->pending);
}

// a handler at an address called, with the scope of the process that placed it open
static const ap_error *call(ap_os *os, ap_api *from, const char *const *address, size_t n, const op_value *args,
	op_value **out) {
	*out = NULL;
	ap_items items;
	items_at(from, address, n, 1, &items);
	const op_value *v = NULL;
	for (size_t i = 0; i < items.n && !v; i++)
		if (items.items[i].node)
			for (size_t k = 0; k < items.items[i].nversions && !v; k++)
				if (!items.items[i].versions[k].status) v = items.items[i].versions[k].content;
	const Live *l = live_of(os, v);
	if (!l) {
		size_t k;
		const char **names = resolve(from, address, n, &k);
		char path[512] = "";
		for (size_t i = 0; i < k; i++) snprintf(path + strlen(path), sizeof path - strlen(path), "/%s", names[i]);
		return fail(os, items.n ? "not-a-handler" : "nothing-there", "%s: %s", path, items.n ? "not a handler" : "nothing there");
	}
	ap_api *owner = l->owner;
	if (owner->scope && !sc_scope_alive(owner->scope)) return ap_error_new(os, "stopped", "stopped: its process has ended");
	ap_given g = {.os = os, .part = AP_HANDLER, .api = owner, .self = owner->self, .name = owner->name, .args = args};
	Calling c = {l->fn, &g, NULL, 0, NULL};
	sc_scope *scope = owner->scope ? owner->scope : os->machine;
	if (sc_get_current_scope(os->s) == scope) calling(&c);
	else if (sc_run_with_scope(scope, calling, &c)) return ap_error_new(os, "stopped", "stopped: its process has ended");
	if (c.e) return c.e;
	*out = c.out;
	if (c.out) hold_for_turn(os, c.out); // the turn's: let go at the sweep
	return NULL;
}

const ap_error *ap_call(ap_given *g, const char *const *address, size_t n, const op_value *args, op_value **out) {
	return call(g->os, g->api, address, n, args, out);
}

const ap_error *ap_call_host(ap_os *os, const char *const *address, size_t n, const op_value *args, op_value **out) {
	return call(os, os->host, address, n, args, out);
}

typedef struct {
	ap_os *os;
	ap_fn *fn;
	ap_api *api;
} Cleanup;

static char *cleaning(void *data) {
	Cleanup *c = data;
	ap_given g = {.os = c->os, .part = AP_CLEANUP, .api = c->api, .self = c->api->self, .name = c->api->name, .killed = 1};
	op_value *out = NULL;
	int pending = 0;
	const ap_error *e = c->fn->call(c->fn, &g, &out, &pending);
	if (e) say(c->os, "cleanup of %s: %s%s%s", c->api->self ? c->api->self : "?", e->code ? e->code : "thrown", e->message ? ": " : "", e->message ? e->message : "");
	op_free(out);
	free(c);
	return NULL;
}

const ap_error *ap_cleanup(ap_given *g, ap_fn *f) {
	sc_scope *scope = g->api->scope;
	if (!scope || scope == g->os->machine) return ap_error_new(g->os, "wrong-field", "onCleanup in a process's part");
	Cleanup *c = grab(sizeof *c);
	*c = (Cleanup){g->os, f, g->api};
	free(sc_register_teardown(g->os->s, scope, cleaning, c));
	return NULL;
}

// a computed node: its compute (and effect), in a scope of its own
typedef struct {
	ap_os *os;
	ap_api *api;
	ap_fn *compute, *effect;
	int deep;
	sc_scope *scope;
	// its computer given to the statuses (ermine.computer.status on its node), at its first run
	int given;
} Computed;

static sc_out computing(void *previous, void *data) {
	(void)previous;
	Computed *c = data;
	if (!c->given) {
		// in its first run, so a first run pending or failed is said too
		c->given = 1;
		sc_run *run = sc_get_run(c->os->s);
		if (run && c->api->self) cst_give(c->os->status, sc_run_computer(run), tb_string(c->api->self));
	}
	ap_given g = {.os = c->os, .part = AP_COMPUTE, .api = c->api, .peep = ap_peep(c->api), .self = c->api->self, .name = c->api->name};
	op_value *out = NULL;
	int pending = 0;
	const ap_error *e = c->compute->call(c->compute, &g, &out, &pending);
	if (e) {
		char text[512];
		snprintf(text, sizeof text, "%s%s%s", e->code ? e->code : "thrown", e->message ? ": " : "", e->message ? e->message : "");
		return (sc_out){.kind = SC_FAILED, .error = copied(text)};
	}
	if (pending) return (sc_out){.kind = SC_PENDING};
	return (sc_out){.kind = SC_VALUE, .value = out ? out : op_null()};
}

static bool same_deep(const void *a, const void *b, void *data) {
	(void)data;
	return ap_equal(a, b);
}

// the same as JavaScript's Object.is (the TS scheduler's own default): null, a boolean, a number, a string
// or a stand-in (a live function's number) by what it is; a map, a list, bytes or a typed array by
// identity, each made anew the same as a new one
static bool same_is(const void *x, const void *y, void *data) {
	(void)data;
	const op_value *a = x, *b = y;
	if (a == b) return true;
	if (!a || !b || a->type != b->type) return false;
	switch (a->type) {
	case OP_NULL: return true;
	case OP_BOOL: return a->bool_ == b->bool_;
	case OP_NUM: return a->num == b->num ? a->num != 0 || signbit(a->num) == signbit(b->num) : isnan(a->num) && isnan(b->num);
	case OP_STR:
	case OP_STAND: return ap_equal(a, b);
	default: return false;
	}
}

// the value written as the computed node's
static void value_is(Computed *c, const op_value *value) {
	op_patch p = {.has_value = 1, .value = value};
	Patching pt = {c->api->self, "value", NULL, &p, 1};
	const ap_error *e = write_with(c->api, "compute", patching, &pt, NULL);
	if (e) say(c->os, "computed %s: %s", c->api->self, e->message ? e->message : e->code);
}

static char *setting(void *value, void *data) {
	value_is(data, value);
	return NULL;
}

// an effect's act, held till the pulse ends (ap_pulse): its value, and the one acted on before
typedef struct Act {
	Computed *c;
	op_value *value, *previous;
} Act;

// as the scheduler acts, the act is held: run after the pulse, with no run open, so what it writes
// is from outside, and a write to what its own compute read is the next pulse's, not a loop (as
// 10-12's effects were)
static char *acting(void *value, void *previous, void *data) {
	Computed *c = data;
	ap_os *os = c->os;
	GROW(os->acts, os->nacts, os->acts_room);
	os->acts[os->nacts++] = (Act){c, op_ref(value), op_ref(previous)};
	return NULL;
}

static void act(void *data) {
	Act *a = data;
	Computed *c = a->c;
	value_is(c, a->value);
	ap_given g = {.os = c->os, .part = AP_EFFECT, .api = c->api, .self = c->api->self, .name = c->api->name, .value = a->value, .previous = a->previous};
	op_value *out = NULL;
	int pending = 0;
	const ap_error *e = c->effect->call(c->effect, &g, &out, &pending);
	op_free(out);
	if (e) say(c->os, "effect of %s failed: %s%s%s", c->api->self, e->code ? e->code : "thrown", e->message ? ": " : "", e->message ? e->message : "");
}

void ap_pulse(ap_os *os) {
	for (int round = 0; round < 64; round++) {
		sc_pulse(os->s);
		if (!os->nacts) return;
		Act *acts = os->acts;
		size_t n = os->nacts;
		os->acts = NULL, os->nacts = os->acts_room = 0;
		for (size_t i = 0; i < n; i++) {
			// its scope torn down since: not acted on
			if (sc_scope_alive(acts[i].c->scope)) sc_run_with_scope(acts[i].c->scope, act, &acts[i]);
			op_free(acts[i].value), op_free(acts[i].previous);
		}
		free(acts);
	}
	say(os, "pulse: effects still acting after 64 rounds; the rest next turn");
}

static void computer(void *data) {
	Computed *c = data;
	sc_def def = {.f = computing, .equal = c->deep ? same_deep : same_is, .data = c};
	if (c->effect) {
		def.effect = acting;
		st_create_effect(c->os->sites, def);
	} else {
		def.set = setting;
		st_create_computer(c->os->sites, def);
	}
}

const ap_error *ap_start(ap_given *g, const ap_startop *op, const char **id) {
	ap_os *os = g->os;
	*id = NULL;
	size_t k;
	const char **names = resolve(g->api, op->address, op->naddress, &k);
	if (op->program) {
		if (!os->setup.start) return ap_error_new(os, "wrong-field", "no way to start a program");
		const char *name = op->name ? op->name : ap_pid(os);
		const char **at = ap_temp(os, sizeof *at * (k + 1));
		for (size_t i = 0; i < k; i++) at[i] = names[i];
		at[k] = name;
		// a program's path is from the root, "/" or not
		size_t np = 0;
		const char **program = ap_temp(os, sizeof *program * (op->nprogram + 1));
		for (size_t i = 0; i < op->nprogram; i++)
			if (strcmp(op->program[i], "/")) program[np++] = op->program[i];
		return os->setup.start(os->setup.ctx, at, k + 1, program, np, op->data, id);
	}
	if (!op->compute) return ap_error_new(os, "wrong-field", "start takes a program or code");
	// the parent: the node at the address
	tb_key parent;
	if (k && !pl_get(os->places, names, k, &parent)) return ap_error_new(os, "nothing-there", "nothing at the address");
	if (!k) parent = pl_root(os->places);
	const char *name = op->name ? op->name : ap_pid(os);
	const char *made = NULL;
	const ap_error *e = ap_create(g->api, NULL, NULL, 1, &made);
	if (!e) e = ap_insert(g->api, parent.string, name, made, NULL, NULL);
	if (e) return e;
	const char **at = keep(os, sizeof *at * (k + 1));
	for (size_t i = 0; i < k; i++) at[i] = keepdup(os, names[i]);
	at[k] = keepdup(os, name);
	op_value *path = op_list();
	for (size_t i = 0; i <= k; i++) op_push(path, op_str(at[i]));
	sc_pair *info = keep(os, sizeof *info);
	*info = (sc_pair){"process", path};
	sc_scope *scope = st_create_scope(os->sites, info, 1, NULL);
	if (!scope) return ap_error_new(os, "stopped", "no part running to start under");
	Computed *c = keep(os, sizeof *c);
	*c = (Computed){os, ap_process(os, scope, made, at, k + 1), op->compute, op->effect, op->deep, scope, 0};
	sc_run_with_scope(scope, computer, c);
	*id = made;
	return NULL;
}

// a setup's value: written as the process's
const ap_error *ap_run_setup(ap_api *api, ap_fn *f) {
	ap_given g = {.os = api->os, .part = AP_SETUP, .api = api, .self = api->self, .name = api->name};
	op_value *out = NULL;
	int pending = 0;
	const ap_error *e = f->call(f, &g, &out, &pending);
	if (e || pending || !out || !api->self) {
		op_free(out);
		return e;
	}
	op_patch p = {.has_value = 1, .value = out};
	Patching pt = {api->self, "value", NULL, &p, 1};
	e = write_with(api, "setup", patching, &pt, NULL);
	op_free(out);
	return e;
}
