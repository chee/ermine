// Boxes (boxes.h), in C.
#include "boxes.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) {
		fputs("boxes: out of memory\n", stderr);
		abort();
	}
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }

struct bx {
	bx_host host;
	char *root;
	// its contributors: the processes at its root, children
	pr_processes rows;
	const pl_contributor *walk[2];
	pl *places;
};

size_t bx_inside(const char *const *steps, size_t n, const char *const *from, size_t nfrom,
	const char **out) {
	size_t k = 0;
	for (size_t i = 0; i < nfrom; i++) out[k++] = from[i];
	for (size_t i = 0; i < n; i++) {
		const char *s = steps[i];
		if (strcmp(s, ".") == 0) continue;
		if (strcmp(s, "/") == 0) k = 0;
		else if (strcmp(s, "..") == 0) k -= k > 0;
		else out[k++] = s;
	}
	return k;
}

// a box of the folder root (copied)
static bx *make(const bx_host *host, const char *root) {
	bx *b = xalloc(sizeof *b);
	b->host = *host;
	b->root = xdup(root);
	pr_processes_init(&b->rows, tb_string(b->root));
	b->walk[0] = &b->rows.contributor;
	b->walk[1] = &pl_children;
	b->places = pl_view(host->places, tb_string(b->root), b->walk, 2);
	return b;
}

void bx_free(bx *b) {
	if (b == NULL) return;
	pl_free(b->places);
	free(b->root);
	free(b);
}

const char *bx_root(const bx *b) { return b->root; }
pl *bx_places(bx *b) { return b->places; }

// a write said written, by the host's commit
static void said(const bx_host *h, const pl_changed *changed) {
	if (changed->n == 0) return;
	if (h->commit != NULL) h->commit(h->ctx, changed);
	else pl_commit(h->places, changed);
}

// what name holds in the saved children of at: 1 and *out an id (borrowed from the table); 0:
// nothing; -1: something that is no id
static int saved(tb_table *table, tb_key at, const char *name, tb_key *out) {
	const nd_entry *kids = tb_get(table, tb_string("children"), at);
	const op_value *v = kids != NULL ? kids->value : NULL;
	if (v == NULL || v->type != OP_MAP) return 0;
	const op_value *x = op_get(v, name);
	if (x == NULL) return 0;
	if (x->type != OP_STR) return -1;
	*out = tb_string(x->str);
	return 1;
}

// a version 4 uuid, fresh
static char *uuid(void) {
	static const char hex[] = "0123456789abcdef";
	unsigned char bytes[16];
	arc4random_buf(bytes, sizeof bytes);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	char *id = xalloc(37);
	char *o = id;
	for (size_t i = 0; i < sizeof bytes; i++) {
		if (i == 4 || i == 6 || i == 8 || i == 10) *o++ = '-';
		*o++ = hex[bytes[i] >> 4];
		*o++ = hex[bytes[i] & 15];
	}
	return id;
}

// the header's block held once more by an entry: also, beside the patches' (a changed one); alone
// (one made)
static void hold(const bx_host *h, nd_entry *node, pl_made *block, int also) {
	if (also) pl_hold_also(h->places, node, pl_made_ref(block), pl_made_free);
	else pl_hold(h->places, node, pl_made_ref(block), pl_made_free);
}

// names from the folder from, through saved children: each there gone into, each missing one made (a
// fresh id; the last, leaf when given, and then it must be missing). Checked first, so a refusal
// changes nothing. *changed: the entries changed, not yet said written; *end (NULL: not asked): the
// id at the end, fresh
static int land(const bx_host *h, const char *from, const char *const *names, size_t n,
	const char *leaf, ch_header header, pl_made *block, pl_changed *changed, char **end) {
	*changed = (pl_changed){0};
	tb_key at = tb_string(from);
	size_t k = 0;
	for (; k < n; k++) {
		tb_key id;
		int there = saved(h->table, at, names[k], &id);
		if (there < 0) return PL_ALREADY_THERE;
		if (there == 0) break;
		if (leaf != NULL && k == n - 1) return PL_ALREADY_THERE;
		at = id;
	}
	for (size_t i = k; i < n; i++) {
		if (!pl_is_name(names[i])) return PL_NOT_A_NAME;
	}
	// the last id made, ours
	char *made = NULL;
	for (; k < n; k++) {
		char *fresh = leaf != NULL && k == n - 1 ? xdup(leaf) : h->id != NULL ? h->id(h->ctx) : uuid();
		op_value *value = op_str(fresh);
		pl_changed one;
		nd_entry *node;
		pl_upsert(h->places, tb_string("children"), at, &names[k], 1, value, header, &one, &node);
		op_free(value);
		for (size_t i = 0; i < one.n; i++) {
			hold(h, one.entries[i], block, 1);
			changed->entries[changed->n++] = one.entries[i];
		}
		if (node != NULL) hold(h, node, block, 0);
		free(made);
		made = fresh;
		at = tb_string(made);
	}
	if (end != NULL) *end = made != NULL ? made : xdup(at.string);
	else free(made);
	return 0;
}

int bx_create(const bx_host *host, const char *const *steps, size_t n, const bx *parent,
	ch_header header, pl_made *block, bx **out) {
	*out = NULL;
	const char *from = parent != NULL ? parent->root : pl_root(host->places).string;
	const char **names = xalloc((n + 1) * sizeof *names);
	size_t k = bx_inside(steps, n, NULL, 0, names);
	pl_changed changed;
	char *end = NULL;
	int code = land(host, from, names, k, NULL, header, block, &changed, &end);
	free(names);
	if (code) return code;
	said(host, &changed);
	*out = make(host, end);
	free(end);
	return 0;
}

int bx_create_id(const bx_host *host, const char *id, const bx *parent, bx **out) {
	*out = NULL;
	if (parent != NULL) return PL_NOTHING_THERE;
	*out = make(host, id);
	return 0;
}

int bx_box(bx *b, const char *const *steps, size_t n, tb_key node, ch_header header,
	pl_made *block, pl_changed *changed) {
	*changed = (pl_changed){0};
	const char **names = xalloc((n + 1) * sizeof *names);
	size_t k = bx_inside(steps, n, NULL, 0, names);
	int code = k == 0 ? PL_NOT_A_NAME
	                  : land(&b->host, b->root, names, k, node.string, header, block, changed, NULL);
	free(names);
	if (code == 0) said(&b->host, changed);
	return code;
}

int bx_unbox(bx *b, const char *const *steps, size_t n, ch_header header, pl_made *block,
	pl_changed *changed) {
	*changed = (pl_changed){0};
	const char **names = xalloc((n + 1) * sizeof *names);
	size_t k = bx_inside(steps, n, NULL, 0, names);
	int code = k == 0 ? PL_NOTHING_THERE : 0;
	tb_key at = tb_string(b->root);
	for (size_t i = 0; code == 0 && i + 1 < k; i++) {
		if (saved(b->host.table, at, names[i], &at) != 1) code = PL_NOTHING_THERE;
	}
	nd_entry *kids = code == 0 ? tb_get(b->host.table, tb_string("children"), at) : NULL;
	if (code == 0 && kids == NULL) code = PL_NOTHING_THERE;
	if (code == 0) code = pl_unplace(b->host.places, kids, names[k - 1], header, changed);
	free(names);
	if (code) return code;
	for (size_t i = 0; i < changed->n; i++) hold(&b->host, changed->entries[i], block, 1);
	said(&b->host, changed);
	return 0;
}
