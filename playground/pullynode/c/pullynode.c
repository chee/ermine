// Pullynode (pullynode.h), in C.
#include "pullynode.h"

#include <stdlib.h>
#include <string.h>

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) abort();
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }

#define PUSH(v, n, cap, x) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 8; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
		(v)[(n)++] = (x); \
	} while (0)

enum { NONE, ASLEEP, WAKING, AWAKE };
static const char *const status_names[] = {NULL, "asleep", "waking", "awake"};

struct pul_node {
	pul *pn;
	char *id;
	pul_provider provider;
	sc_scope *scope;
	// the keys read now (value spots of the id), each from tracking start till tracking end: how
	// many; the keys themselves are in pn->ids
	size_t nkeys;
	// the run that woke it, held till it starts
	sc_run *woke;
	// running: start was called, off its stop; checking: started by a check, not yet written
	int running;
	pul_off off;
	int checking;
	// a check's done, till its first write is dealt with (finish)
	pul_done done;
	void *ctx;
	// start of a check is open: its first write waits for it to return
	int starting, fired;
	int status;
	// held in pn->nodes now; queued in pn->due
	int live, queued;
};

struct pul {
	pl *places;
	tb_table *table;
	sc_scheduler *scheduler;
	sc_listener *starts, *ends;
	// every node ever made (freed at the end), and the live ones among them
	pul_node **nodes;
	size_t nnodes, capnodes;
	// a key read now, to its node: key a symbol, part "k"
	tb_table *ids;
	// to look at once no run is open, in order
	pul_node **due;
	size_t ndue, capdue;
	// the actors made here, and the ids in their scopes' info
	op_value **owned;
	size_t nowned, capowned;
};

static tb_key part_of(const char *name) { return tb_string(name); }

static pul_node *find(pul *pn, const char *id) {
	for (size_t i = 0; i < pn->nnodes; i++) {
		if (pn->nodes[i]->live && strcmp(pn->nodes[i]->id, id) == 0) return pn->nodes[i];
	}
	return NULL;
}

// writes ----------------------------------------------------------------------------------------

// a write's patches, copied with their keys and strings, and the values held: the node's change refers to it
typedef struct {
	op_patch *p;
	size_t n;
	op_key *keys;
	char *chars;
} block;

static void block_free(void *b) {
	block *k = b;
	for (size_t i = 0; i < k->n; i++) {
		if (k->p[i].has_value) op_free((op_value *)k->p[i].value);
	}
	free(k->p), free(k->keys), free(k->chars), free(k);
}

static size_t target_size(const op_target *t, size_t *chars) {
	for (size_t i = 0; i < t->length; i++) {
		if (t->path[i].type == OP_STR_KEY) *chars += strlen(t->path[i].s) + 1;
	}
	return t->length;
}

static void copy_target(op_target *to, const op_target *from, op_key **keys, char **chars) {
	*to = *from;
	to->path = from->length ? *keys : NULL;
	for (size_t i = 0; i < from->length; i++) {
		(*keys)[i] = from->path[i];
		if (from->path[i].type == OP_STR_KEY) {
			(*keys)[i].s = strcpy(*chars, from->path[i].s);
			*chars += strlen(from->path[i].s) + 1;
		}
	}
	*keys += from->length;
}

// the patches copied; own: their values are the caller's to give (taken), else held
static block *block_of(const op_patch *patches, size_t n, int own) {
	block *b = xalloc(sizeof *b);
	size_t nkeys = 0, nchars = 0;
	for (size_t i = 0; i < n; i++) {
		nkeys += target_size(&patches[i].place, &nchars);
		if (patches[i].has_move) nkeys += target_size(&patches[i].move, &nchars);
	}
	b->n = n;
	b->p = xalloc(n * sizeof *b->p);
	b->keys = xalloc(nkeys * sizeof *b->keys);
	b->chars = xalloc(nchars);
	op_key *keys = b->keys;
	char *chars = b->chars;
	for (size_t i = 0; i < n; i++) {
		b->p[i] = patches[i];
		copy_target(&b->p[i].place, &patches[i].place, &keys, &chars);
		if (patches[i].has_move) copy_target(&b->p[i].move, &patches[i].move, &keys, &chars);
		if (patches[i].has_value && !own) op_ref((op_value *)patches[i].value);
	}
	return b;
}

typedef struct {
	pul_node *h;
	const char *part;
	block *b;
	int code;
} putting;

static void put_in_scope(void *data) {
	putting *c = data;
	pul *pn = c->h->pn;
	tb_key part = part_of(c->part), id = tb_string(c->h->id);
	ch_header header;
	pl_made *made;
	char *bad = pl_header(pn->places, NULL, 0, CH_HERE, &header, &made);
	if (bad != NULL) {
		free(bad);
		c->code = -1;
		return;
	}
	nd_entry *there = tb_get(pn->table, part, id);
	size_t failed;
	if (there == NULL) {
		there = nd_make_entry(NULL, &header);
		c->code = nd_update(there, c->b->p, c->b->n, header, &failed);
		if (c->code != OP_OK) nd_free_entry(there);
		else {
			pl_own(pn->places, there);
			tb_add(pn->table, part, id, there);
		}
	} else {
		c->code = nd_update(there, c->b->p, c->b->n, header, &failed);
		if (c->code == OP_OK) {
			pl_changed changed = {1, {there}};
			pl_commit(pn->places, &changed);
		}
	}
	if (c->code != OP_OK) {
		pl_made_free(made);
		return;
	}
	pl_hold(pn->places, there, made, pl_made_free);
	pl_hold_also(pn->places, there, c->b, block_free);
	c->b = NULL;
}

// a write to (part, id), under the provider's scope: a new entry, or patches on the one there. 0, or
// op's code (-1: no header); the values of patches are taken when own, else held
static int put(pul_node *h, const char *part, const op_patch *patches, size_t n, int own) {
	putting c = {.h = h, .part = part, .b = block_of(patches, n, own)};
	if (sc_run_with_scope(h->scope, put_in_scope, &c) != NULL) c.code = -1;
	if (c.b != NULL) block_free(c.b);
	return c.code;
}

static void status(pul_node *h, int s) {
	if (h->status == s) return;
	h->status = s;
	const nd_entry *e = tb_get(h->pn->table, part_of("attributes"), tb_string(h->id));
	const op_value *v = e != NULL ? e->value : NULL;
	op_patch ps[2] = {0};
	size_t n = 0;
	if (v == NULL || v->type != OP_MAP) {
		ps[n++] = (op_patch){.has_value = 1, .value = op_map()};
	}
	static const op_key key = {.type = OP_STR_KEY, .s = PUL_STATUS};
	ps[n++] = (op_patch){.place = {.path = &key, .length = 1}, .has_value = 1,
		.value = op_str(status_names[s])};
	put(h, "attributes", ps, n, 1);
}

// a check's first write dealt with: stopped again unless a reader came; the value now
static void finish(pul_node *h) {
	if (h->live && h->running) {
		if (h->nkeys == 0) {
			pul_off off = h->off;
			h->running = 0;
			if (off.f != NULL) off.f(off.ctx);
		} else if (h->status == ASLEEP) status(h, AWAKE);
	}
	const nd_entry *e = tb_get(h->pn->table, part_of("value"), tb_string(h->id));
	h->done(h->ctx, e != NULL ? e->value : NULL, NULL);
}

// what start is given: writes land; the first after waking says awake
int pul_write(pul_writer *h, const op_patch *patches, size_t n) {
	if (!h->live) return 0;
	int code = put(h, "value", patches, n, 0);
	if (code != 0) return code;
	int check = 0;
	if (h->checking) {
		h->checking = 0;
		if (h->starting) h->fired = 1;
		else check = 1;
	}
	// started for readers (waking is only then), and this its first write since
	if (h->nkeys && h->status == WAKING) status(h, AWAKE);
	if (check) finish(h);
	return 0;
}

// settling --------------------------------------------------------------------------------------

// started or stopped as its readers say
static void settle(pul_node *h) {
	if (!h->live) return;
	if (h->nkeys && !h->running) {
		status(h, WAKING);
		sc_run *woke = h->woke;
		h->woke = NULL;
		h->off = h->provider.start(h, woke, h->provider.data);
		h->running = 1;
		if (woke != NULL) sc_run_unref(woke);
	} else if (h->nkeys && h->checking) {
		// a reader came while a check runs: it stays running after, for the reader
		status(h, WAKING);
	} else if (h->nkeys && h->status == ASLEEP) {
		// running from a check that has written: the reader keeps it
		status(h, AWAKE);
	} else if (h->nkeys == 0 && h->running && !h->checking) {
		pul_off off = h->off;
		h->running = 0;
		if (off.f != NULL) off.f(off.ctx);
		status(h, ASLEEP);
	}
}

void pul_flush(pul *pn) {
	while (pn->ndue > 0) {
		pul_node *h = pn->due[0];
		memmove(pn->due, pn->due + 1, --pn->ndue * sizeof *pn->due);
		h->queued = 0;
		settle(h);
	}
}

// now when no run is open; else at the pulse's end (pul_flush)
static void soon(pul_node *h) {
	if (!h->queued) {
		h->queued = 1;
		PUSH(h->pn->due, h->pn->ndue, h->pn->capdue, h);
	}
	if (sc_get_run(h->pn->scheduler) == NULL) pul_flush(h->pn);
}

static void on_start(const void *key, sc_run *run, void *data) {
	pul *pn = data;
	pl_where w;
	if (!pl_spot(pn->places, key, &w) || w.part.string == NULL || strcmp(w.part.string, "value") != 0) return;
	pul_node *h = find(pn, w.id.string);
	if (h == NULL) return;
	tb_key k = tb_symbol(key);
	pul_node *old = tb_get(pn->ids, part_of("k"), k);
	if (h->nkeys == 0) {
		if (h->woke != NULL) sc_run_unref(h->woke);
		h->woke = run != NULL ? sc_run_ref(run) : NULL;
	}
	if (old != NULL) tb_sub(pn->ids, part_of("k"), k, h);
	else tb_add(pn->ids, part_of("k"), k, h);
	if (old != h) {
		h->nkeys++;
		if (old != NULL) old->nkeys--;
	}
	soon(h);
}

// places may have let the key go already: it is looked up here, not described
static void on_end(const void *key, void *data) {
	pul *pn = data;
	tb_key k = tb_symbol(key);
	pul_node *h = tb_get(pn->ids, part_of("k"), k);
	if (h == NULL) return;
	tb_del(pn->ids, part_of("k"), k);
	if (--h->nkeys == 0) soon(h);
}

// providing --------------------------------------------------------------------------------------

pul *pul_new(const pul_setup *setup) {
	pul *pn = xalloc(sizeof *pn);
	pn->places = setup->places;
	pn->table = setup->table;
	pn->scheduler = setup->scheduler;
	pn->ids = tb_new();
	pn->starts = sc_on_tracking_start(pn->scheduler, on_start, pn);
	pn->ends = sc_on_tracking_end(pn->scheduler, on_end, pn);
	return pn;
}

pul_node *pul_provide(pul *pn, const char *id, const pul_provider *provider, const sc_pair *info, size_t n) {
	if (find(pn, id) != NULL) return NULL;
	pul_node *h = xalloc(sizeof *h);
	h->pn = pn;
	h->id = xdup(id);
	h->provider = *provider;
	sc_pair actor;
	if (n == 0) {
		op_value *who = op_str(id);
		PUSH(pn->owned, pn->nowned, pn->capowned, who);
		actor = (sc_pair){"actor", who};
		info = &actor, n = 1;
	}
	h->scope = sc_create_root_scope(pn->scheduler, info, n);
	h->live = 1;
	PUSH(pn->nodes, pn->nnodes, pn->capnodes, h);
	const nd_entry *e = tb_get(pn->table, part_of("attributes"), tb_string(id));
	const op_value *there = e != NULL && e->value != NULL && e->value->type == OP_MAP
		? op_get(e->value, PUL_STATUS) : NULL;
	if (there != NULL && there->type == OP_STR && strcmp(there->str, "asleep") == 0) h->status = ASLEEP;
	else if (sc_get_run(pn->scheduler) == NULL) status(h, ASLEEP);
	return h;
}

// h stopped and let go: asleep if it was running, and no run is open to write in
static void end(pul_node *h) {
	int was = h->running;
	pul_off off = h->off;
	h->running = h->checking = 0;
	if (was && off.f != NULL) off.f(off.ctx);
	if (was && sc_get_run(h->pn->scheduler) == NULL) status(h, ASLEEP);
	h->live = 0;
	if (h->woke != NULL) sc_run_unref(h->woke);
	h->woke = NULL;
}

void pul_unprovide(pul_node *h) {
	if (!h->live) return;
	tb_del_node(h->pn->ids, h);
	h->nkeys = 0;
	end(h);
}

void pul_check(pul *pn, const char *id, pul_done done, void *ctx) {
	pul_node *h = find(pn, id);
	if (h == NULL || h->running) {
		const nd_entry *e = tb_get(pn->table, part_of("value"), tb_string(id));
		done(ctx, e != NULL ? e->value : NULL, NULL);
		return;
	}
	if (h->provider.once != NULL) {
		const op_value *v = NULL;
		char *bad = h->provider.once(h->provider.data, &v);
		if (bad != NULL) {
			done(ctx, NULL, bad);
			free(bad);
			return;
		}
		op_value *nothing = v == NULL ? op_null() : NULL;
		op_patch p = {.has_value = 1, .value = v != NULL ? v : nothing};
		if (h->live) put(h, "value", &p, 1, 0);
		done(ctx, v, NULL);
		if (nothing != NULL) op_free(nothing);
		return;
	}
	h->checking = 1;
	h->done = done;
	h->ctx = ctx;
	h->starting = 1;
	h->off = h->provider.start(h, NULL, h->provider.data);
	h->running = 1;
	h->starting = 0;
	if (h->fired) {
		h->fired = 0;
		finish(h);
	}
}

bool pul_reading(pul *pn, const char *id) {
	pul_node *h = find(pn, id);
	return h != NULL && h->nkeys > 0;
}

void pul_stop(pul *pn) {
	if (pn->starts != NULL) sc_remove_listener(pn->starts);
	if (pn->ends != NULL) sc_remove_listener(pn->ends);
	pn->starts = pn->ends = NULL;
	for (size_t i = 0; i < pn->nnodes; i++) {
		if (pn->nodes[i]->live) end(pn->nodes[i]);
	}
	tb_free(pn->ids);
	pn->ids = tb_new();
	for (size_t i = 0; i < pn->nnodes; i++) pn->nodes[i]->nkeys = 0, pn->nodes[i]->queued = 0;
	pn->ndue = 0;
}

void pul_free(pul *pn) {
	if (pn == NULL) return;
	for (size_t i = 0; i < pn->nnodes; i++) free(pn->nodes[i]->id), free(pn->nodes[i]);
	for (size_t i = 0; i < pn->nowned; i++) op_free(pn->owned[i]);
	free(pn->nodes), free(pn->due), free(pn->owned);
	tb_free(pn->ids);
	free(pn);
}
