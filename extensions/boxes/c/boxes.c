// boxes (boxes.h): typescript/boxes.ts in C
#include "boxes.h"

#include "../../../ermine/processes/c/processes.h"

#include <stdio.h>
#include <string.h>

#define BX_PART "binding"

typedef struct {
	char **names;
	size_t n;
} bound_t;

struct bx_box {
	es_ermine *e;
	char *root;
	// the key of this box's binding rows, its own
	char *key;
	pr_processes bindings, rows;
	const pl_contributor *walk[3];
	pl *places;
	// what is put and not taken, and what is started (es_started are the ermine's, till es_free or
	// the caller's es_started_free)
	bound_t *bound;
	size_t nbound, capbound;
	es_started **running;
	size_t nrunning, caprunning;
	int closed;
};

// the names an address comes to inside a root (processes' inside): "." here, ".." back one (at the
// root: stays there), "/" back to the root. copied, to bx_names_free
static char **names_of(const char *const *steps, size_t n, size_t *count) {
	char **names = es_alloc((n + 1) * sizeof *names);
	size_t k = 0;
	for (size_t i = 0; i < n; i++) {
		if (strcmp(steps[i], ".") == 0) continue;
		if (strcmp(steps[i], "/") == 0) {
			while (k) free(names[--k]);
		} else if (strcmp(steps[i], "..") == 0) {
			if (k) free(names[--k]);
		} else {
			names[k++] = es_dup(steps[i]);
		}
	}
	*count = k;
	return names;
}
static void names_free(char **names, size_t k) {
	for (size_t i = 0; i < k; i++) free(names[i]);
	free(names);
}

static int place_fail(int code, const char *at) {
	return at == NULL ? es_fail(code, "%s", es_code_name(code))
			  : es_fail(code, "%s (%s)", es_code_name(code), at);
}

static bx_box *make(es_ermine *e, const char *root, const char *serial) {
	bx_box *b = es_alloc(sizeof *b);
	b->e = e;
	b->root = es_dup(root);
	size_t room = strlen(serial) + 16;
	b->key = es_alloc(room);
	snprintf(b->key, room, "bindings:%s", serial);
	pr_trie_init(&b->bindings, BX_PART, tb_string(b->key), "box");
	pr_processes_init(&b->rows, tb_string(b->root));
	b->walk[0] = &b->bindings.contributor;
	b->walk[1] = &b->rows.contributor;
	b->walk[2] = &pl_children;
	b->places = pl_view(e->places, tb_string(b->root), b->walk, 3);
	return b;
}

static unsigned long serial_n;
static char *serial(void) {
	char s[32];
	snprintf(s, sizeof s, "%lu", ++serial_n);
	return es_dup(s);
}

int bx_create(es_ermine *e, bx_box **out) {
	char *n = serial();
	size_t room = strlen(n) + 8;
	char *root = es_alloc(room);
	snprintf(root, room, "box:%s", n);
	*out = make(e, root, n);
	free(root);
	free(n);
	return 0;
}

int bx_create_id(es_ermine *e, const char *id, bx_box **out) {
	char *n = serial();
	*out = make(e, id, n);
	free(n);
	return 0;
}

int bx_create_at(es_ermine *e, const char *const *path, size_t n, bx_box **out) {
	size_t k;
	char **names = names_of(path, n, &k);
	tb_key found;
	int there = pl_get(e->places, (const char *const *)names, k, &found);
	if (!there) {
		int code = place_fail(ES_NOTHING_THERE, k ? names[k - 1] : NULL);
		names_free(names, k);
		return code;
	}
	names_free(names, k);
	return bx_create_id(e, found.string, out);
}

const char *bx_root(const bx_box *b) { return b->root; }
pl *bx_places(const bx_box *b) { return b->places; }

// what a write does with the host's scope open
typedef struct {
	bx_box *b;
	char **names;
	size_t n;
	const char *node;
	int put;
	int code;
} writing;

static int write_run(void *data) {
	writing *w = data;
	bx_box *b = w->b;
	es_ermine *e = b->e;
	ch_header h;
	pl_made *made;
	char *bad = pl_header(e->places, NULL, 0, CH_HERE, &h, &made);
	if (bad != NULL) {
		w->code = es_fail(ES_FAILED, "%s", bad);
		free(bad);
		return w->code;
	}
	pl_changed changed;
	nd_entry *born = NULL;
	int code;
	if (w->put) {
		code = pr_add_in(e->places, e->table, BX_PART, tb_string(b->key),
			(const char *const *)w->names, w->n, tb_string(w->node), h, &changed, &born);
	} else {
		code = pr_remove_in(e->places, e->table, BX_PART, tb_string(b->key),
			(const char *const *)w->names, w->n, h, &changed);
	}
	if (code != 0) {
		pl_made_free(made);
		w->code = place_fail(code, w->n ? w->names[w->n - 1] : NULL);
		return w->code;
	}
	es_commit_changed(e, &changed);
	for (size_t i = 0; i < changed.n; i++) {
		pl_hold_also(e->places, changed.entries[i], pl_made_ref(made), pl_made_free);
	}
	if (born != NULL) pl_hold(e->places, born, pl_made_ref(made), pl_made_free);
	pl_made_free(made);
	return 0;
}

typedef struct {
	pl *p;
	const char *const *names;
	size_t n;
	int there;
} looking;
static void look_run(void *data) {
	looking *l = data;
	tb_key id;
	l->there = pl_get(l->p, l->names, l->n, &id);
}

static int gone(void) { return es_fail(ES_GONE, "gone: this box was closed"); }

// a path in the bound list: its index, or -1
static long bound_at(const bx_box *b, char **names, size_t k) {
	for (size_t i = 0; i < b->nbound; i++) {
		if (b->bound[i].n != k) continue;
		size_t j = 0;
		while (j < k && strcmp(b->bound[i].names[j], names[j]) == 0) j++;
		if (j == k) return (long)i;
	}
	return -1;
}
static void bound_drop(bx_box *b, size_t i) {
	names_free(b->bound[i].names, b->bound[i].n);
	b->bound[i] = b->bound[--b->nbound];
}

int bx_put(bx_box *b, const char *const *path, size_t n, const char *node) {
	if (b->closed) return gone();
	size_t k;
	char **names = names_of(path, n, &k);
	writing w = {b, names, k, node, 1, 0};
	int code = 0;
	if (k > 0) {
		looking l = {b->places, (const char *const *)names, k, 0};
		pl_peep(b->places, look_run, &l);
		if (l.there) code = place_fail(ES_ALREADY_THERE, names[k - 1]);
	}
	if (!code) code = es_within(es_host_context(b->e), write_run, &w);
	if (code || bound_at(b, names, k) >= 0) {
		names_free(names, k);
		return code;
	}
	// kept, to close: names is the list's now
	bound_t kept = {names, k};
	ES_PUSH(b->bound, b->nbound, b->capbound, kept);
	return 0;
}

int bx_take(bx_box *b, const char *const *path, size_t n) {
	if (b->closed) return gone();
	size_t k;
	char **names = names_of(path, n, &k);
	writing w = {b, names, k, NULL, 0, 0};
	int code = es_within(es_host_context(b->e), write_run, &w);
	if (!code) {
		long i = bound_at(b, names, k);
		if (i >= 0) bound_drop(b, (size_t)i);
	}
	names_free(names, k);
	return code;
}

int bx_start(bx_box *b, es_program fn, void *ctx, es_at at, const es_start_options *o,
	es_started **out, es_refused *refused) {
	if (b->closed) return gone();
	es_start_options so = o != NULL ? *o : (es_start_options){0};
	so.places = b->places;
	int code = es_start(b->e, fn, ctx, at, &so, out, refused);
	if (code == 0 && *out != NULL) ES_PUSH(b->running, b->nrunning, b->caprunning, *out);
	return code;
}

typedef struct {
	bx_box *b;
	int code;
} closing;
static int close_run(void *data) {
	closing *c = data;
	bx_box *b = c->b;
	es_ermine *e = b->e;
	while (b->nbound > 0) {
		bound_t *last = &b->bound[b->nbound - 1];
		ch_header h;
		pl_made *made;
		char *bad = pl_header(e->places, NULL, 0, CH_HERE, &h, &made);
		if (bad != NULL) {
			c->code = es_fail(ES_FAILED, "%s", bad);
			free(bad);
			return c->code;
		}
		pl_changed changed;
		int code = pr_remove_in(e->places, e->table, BX_PART, tb_string(b->key),
			(const char *const *)last->names, last->n, h, &changed);
		if (code == 0) {
			es_commit_changed(e, &changed);
			for (size_t i = 0; i < changed.n; i++) {
				pl_hold_also(e->places, changed.entries[i], pl_made_ref(made), pl_made_free);
			}
		} else if (code != ES_NOTHING_THERE) {
			pl_made_free(made);
			c->code = place_fail(code, NULL);
			return c->code;
		}
		pl_made_free(made);
		bound_drop(b, b->nbound - 1);
	}
	return 0;
}

int bx_close(bx_box *b) {
	if (b->closed) return 0;
	b->closed = 1;
	for (size_t i = 0; i < b->nrunning; i++) es_stop(b->running[i], "box closed");
	b->nrunning = 0;
	closing c = {b, 0};
	return es_within(es_host_context(b->e), close_run, &c);
}

void bx_free(bx_box *b) {
	if (b == NULL) return;
	pl_free(b->places);
	for (size_t i = 0; i < b->nbound; i++) names_free(b->bound[i].names, b->bound[i].n);
	free(b->bound);
	free(b->running);
	free(b->root);
	free(b->key);
	free(b);
}
