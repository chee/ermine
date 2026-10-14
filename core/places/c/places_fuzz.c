// libFuzzer target: the input bytes are a small graph (a children node, or none, at the root and at
// four ids; each a map of names to lists of entries, some malformed) and then operations: open an
// address, read an opened place, drop one, a write (place, unplace, order, rename, move), a node
// replaced by the caller. Checked:
// - an opened place's items are a fresh pl_get's (source, id, name, at, path, and up the chain); the
//   very same list when nothing changed since its last read; the empty list once dropped;
// - a write gives back exactly the nodes whose change it moved, with their keys, the one moved into
//   first; any other node's value is as it was; a refused write changes nothing (but a move across
//   parents refused by op, which keeps its first write); each node written has, as its change, the
//   patches that took the value before to the value now.
#include "places.h"
#include "../../op/c/fuzz_values.h"

#include <stdio.h>

enum { CELLS = 5, HELD = 4, DEEP = 3 };

static void die(const char *why, int step) {
	fprintf(stderr, "fuzz: step %d: %s\n", step, why);
	abort();
}

// the hole: cell 0 the root (pl_root(), "R"), cells 1..4 ("s", "0".."3")
static const char *const ids[CELLS] = {"R", "0", "1", "2", "3"};
static nd_node *nodes[CELLS];
static tb_key source_of(int c) { return c ? tb_string("s") : pl_root(); }
static int cell_of(tb_key source, tb_key id) {
	for (int c = 0; c < CELLS; c++) {
		tb_key s = source_of(c);
		if ((s.symbol ? source.symbol == s.symbol : source.symbol == NULL && strcmp(source.string, "s") == 0) &&
			id.symbol == NULL && strcmp(id.string, ids[c]) == 0) return c;
	}
	return -1;
}
static nd_node *children(void *ctx, tb_key source, tb_key id) {
	(void)ctx;
	int c = cell_of(source, id);
	return c < 0 ? NULL : nodes[c];
}
// the root, as a value: {"root": true}
static int symbol(void *ctx, const op_value *v, const void **token) {
	(void)ctx;
	if (v->type != OP_MAP || v->count != 1 || strcmp(v->keys[0], "root") != 0) return 0;
	*token = &pl_root_mark;
	return 1;
}
static op_value *symbol_value(void *ctx, const void *token) {
	(void)ctx, (void)token;
	op_value *m = op_map();
	op_set(m, "root", op_bool(1));
	return m;
}

static const char *const names[] = {"a", "b", "c", "", ".", "..", "/"};

// an entry: mostly ["s", id], sometimes the root's, another source's, or no entry at all
static op_value *entry(fz_bytes *b) {
	unsigned c = fz_byte(b);
	if (c % 8 == 7) return op_num(1);
	op_value *e = op_list();
	op_push(e, c % 8 == 6 ? symbol_value(NULL, NULL) : op_str(c % 8 == 5 ? "t" : "s"));
	if (c % 16 != 15) op_push(e, op_str(ids[(c >> 4) % CELLS]));
	return e;
}
static op_value *children_value(fz_bytes *b) {
	unsigned c = fz_byte(b);
	if (c % 8 == 7) return fz_value(b, 2);
	op_value *m = op_map();
	for (unsigned n = c % 4; n > 0; n--) {
		const char *name = names[fz_byte(b) % 3];
		if (op_get(m, name) != NULL) continue;
		op_value *l = op_list();
		for (unsigned k = fz_byte(b) % 4; k > 0; k--) op_push(l, entry(b));
		op_set(m, name, l);
	}
	return m;
}
static void make(int c, fz_bytes *b) {
	nd_free(nodes[c]);
	nodes[c] = NULL;
	if (fz_byte(b) % 5 == 4) return;
	op_value *v = children_value(b);
	nodes[c] = nd_make(v, &(ch_header){.has_time = 1, .time = 0, .actor = "setup"}, NULL);
	op_free(v);
}

typedef struct {
	pl_held *h;
	const char *address[DEEP];
	size_t n;
	int dirty, dropped, read;
	uint64_t serial;
	const pl_list *last;
} held;

// the same item: keys, name, at, and up the chain the same
static int keq(tb_key a, tb_key b) {
	if (a.symbol || b.symbol) return a.symbol == b.symbol;
	return strcmp(a.string, b.string) == 0;
}
static int same_item(const pl_item *x, const pl_item *y) {
	for (; x != NULL && y != NULL; x = x->up, y = y->up) {
		if (!keq(x->source, y->source) || !keq(x->id, y->id) || (x->name == NULL) != (y->name == NULL)) return 0;
		if (x->name != NULL && (strcmp(x->name, y->name) != 0 || x->at != y->at)) return 0;
	}
	return x == y;
}

static long index_of(unsigned c) { return c % 8 == 7 ? PL_END : c % 8 == 6 ? -1 : (long)(c % 8) % 4; }

int LLVMFuzzerTestOneInput(const unsigned char *data, size_t size) {
	fz_bytes b = {data, size, 0};
	for (int c = 0; c < CELLS; c++) make(c, &b);
	pl_setup setup = {.root_source = pl_root(), .root_id = tb_string("R"), .children = children,
		.symbol = symbol, .symbol_value = symbol_value};
	pl *p = pl_new(&setup);
	held hs[HELD];
	int nheld = 0;
	ch_header header = {.has_time = 1, .time = 1, .actor = "me"};
	for (int step = 0; step < 60 && b.at < b.size; step++) {
		unsigned op = fz_byte(&b) % 10, c = fz_byte(&b);
		held *h = nheld ? &hs[c % nheld] : NULL;
		if (op == 0 && nheld < HELD) {
			held *o = &hs[nheld++];
			*o = (held){0};
			o->n = c % (DEEP + 1);
			for (size_t i = 0; i < o->n; i++) o->address[i] = names[fz_byte(&b) % 7];
			o->h = pl_open(p, o->address, o->n, NULL);
		} else if (op == 1 && h != NULL) {
			const pl_list *got = pl_items(h->h, NULL);
			if (h->dropped) {
				if (got->n != 0 || got->serial != 0) die("a dropped place is not empty", step);
				continue;
			}
			if (h->read && !h->dirty && (got != h->last || got->serial != h->serial)) die("nothing changed, and another list", step);
			pl_list *fresh = pl_get(p, h->address, h->n, NULL, NULL);
			if (fresh->n != got->n) die("an opened place's items are not a fresh get's (length)", step);
			for (size_t i = 0; i < got->n; i++)
				if (!same_item(got->items[i], fresh->items[i])) die("an opened place's items are not a fresh get's", step);
			pl_list_free(fresh);
			h->read = 1, h->dirty = 0, h->last = got, h->serial = got->serial;
		} else if (op == 2 && h != NULL) {
			pl_drop(h->h);
			h->dropped = 1;
		} else if (op == 3) {
			make((int)(c % CELLS), &b);
			for (int i = 0; i < nheld; i++) hs[i].dirty = 1;
		} else {
			// a write: what every node was, before
			op_value *was[CELLS];
			const nd_node *node_was[CELLS];
			const op_patch *change_was[CELLS];
			for (int k = 0; k < CELLS; k++) {
				node_was[k] = nodes[k];
				change_was[k] = nodes[k] ? nodes[k]->change.patches : NULL;
				was[k] = nodes[k] ? fz_copy(nodes[k]->value) : NULL;
			}
			int from = (int)(c % CELLS), to = (int)(c / CELLS % CELLS);
			pl_at at = pl_at_entry(source_of(from), tb_string(ids[from]));
			pl_at toat = pl_at_entry(source_of(to), tb_string(ids[to]));
			const char *name = names[fz_byte(&b) % 4], *toname = names[fz_byte(&b) % 4];
			unsigned i1 = fz_byte(&b), i2 = fz_byte(&b);
			pl_changed changed = {.n = 9};
			int code;
			if (op == 4) code = pl_place(p, at, name, tb_string("s"), tb_string(ids[1 + i2 % 4]), header, index_of(i1), NULL, &changed);
			else if (op == 5) code = pl_unplace(p, at, name, index_of(i1), header, NULL, &changed);
			else if (op == 6) code = pl_order(p, at, name, index_of(i1), index_of(i2), header, NULL, &changed);
			else if (op == 7) code = pl_rename(p, at, name, toname, header, NULL, &changed);
			else code = pl_move(p, at, name, index_of(i1), toat, toname, header, index_of(i2), NULL, &changed);

			if (changed.n > 2) die("more than two nodes written", step);
			if (code != PL_OK && code != PL_OP && changed.n != 0) die("refused, and nodes written", step);
			size_t moved = 0;
			for (int k = 0; k < CELLS; k++) {
				if (nodes[k] != node_was[k]) die("a node was replaced", step);
				int wrote = nodes[k] != NULL && nodes[k]->change.patches != change_was[k];
				if (!wrote && !fz_equal(was[k], nodes[k] ? nodes[k]->value : NULL)) die("a node not written changed", step);
				if (!wrote) continue;
				moved++;
				size_t j = 0;
				while (j < changed.n && changed.nodes[j].node != nodes[k]) j++;
				if (j == changed.n) die("a node written is not given back", step);
				if (!keq(changed.nodes[j].source, source_of(k)) || !keq(changed.nodes[j].id, tb_string(ids[k])))
					die("a node given back has another's keys", step);
				op_value *now = NULL;
				const ch_header *ch = &nodes[k]->change;
				if (op_apply(was[k], ch->patches, ch->patches_length, NULL, &now, NULL) != OP_OK ||
					!fz_equal(now, nodes[k]->value)) die("a node's change is not what took it to its value", step);
				op_free(now);
			}
			if (moved != changed.n) die("a node given back was not written", step);
			if (changed.n == 2 && (changed.nodes[0].node != nodes[to] || changed.nodes[1].node != nodes[from]))
				die("a move across parents: not the one moved into first", step);
			if (moved)
				for (int k = 0; k < nheld; k++) hs[k].dirty = 1;
			for (int k = 0; k < CELLS; k++) op_free(was[k]);
		}
	}
	for (int i = 0; i < nheld; i++) pl_close(hs[i].h);
	pl_free(p);
	for (int c = 0; c < CELLS; c++) nd_free(nodes[c]), nodes[c] = NULL;
	return 0;
}
