// libFuzzer target: the input bytes are operations on the table over 4 parts, 4 ids and 4 nodes,
// applied to the table and to a small model (triples in the order put, and each node's parts in
// the order first taken). Every return and every key's node is checked against the model. The
// strings given are scribbled over after each call, because the table keeps its own copies.
#include "table.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { KEYS = 4, NODES = 4, MAX = KEYS * KEYS };

static const char tokens[2];
// WTF-8: a pair and a modifier, a lone high, the first code point of 0 alone. Index 3 is a
// symbol. No NUL, because a key's string ends at one.
static const char *const strings[KEYS] = {"\xf0\x9f\x91\x8d\xf0\x9f\x8f\xbd", "\xed\xa0\xbd", "\xf0\x9f\x91\x8d", NULL};
static int nodes[NODES];

typedef struct {
	int part, id, node;
} triple;
static triple model[MAX];
static int length;
static int parts[NODES][KEYS], nparts[NODES];

static void die(const char *why, int step) {
	fprintf(stderr, "fuzz: step %d: %s\n", step, why);
	abort();
}

static char buffer[2][16];
static tb_key key(int k, int which) {
	if (k == 3) return tb_symbol(&tokens[which]);
	strcpy(buffer[which], strings[k]);
	return tb_string(buffer[which]);
}
static void scribble(void) { memset(buffer, 'x', sizeof buffer); }
static int key_index(tb_key k, int which) {
	if (k.symbol != NULL) return k.symbol == &tokens[which] ? 3 : -1;
	for (int i = 0; i < 3; i++)
		if (strcmp(k.string, strings[i]) == 0) return i;
	return -1;
}
static int node_index(const void *n) {
	for (int i = 0; i < NODES; i++)
		if (n == &nodes[i]) return i;
	return -1;
}

static int find(int part, int id) {
	for (int i = 0; i < length; i++)
		if (model[i].part == part && model[i].id == id) return i;
	return -1;
}
static int has_part(int node, int part) {
	for (int i = 0; i < length; i++)
		if (model[i].node == node && model[i].part == part) return 1;
	return 0;
}
static void put(int part, int id, int node) {
	if (!has_part(node, part)) parts[node][nparts[node]++] = part;
	model[length++] = (triple){part, id, node};
}
static void take(int at) {
	triple t = model[at];
	memmove(&model[at], &model[at + 1], (length - at - 1) * sizeof model[0]);
	length--;
	if (has_part(t.node, t.part)) return;
	for (int i = 0; i < nparts[t.node]; i++) {
		if (parts[t.node][i] != t.part) continue;
		memmove(&parts[t.node][i], &parts[t.node][i + 1], (nparts[t.node] - i - 1) * sizeof parts[0][0]);
		nparts[t.node]--;
		return;
	}
}

static void check(tb_table *t, int step) {
	for (int part = 0; part < KEYS; part++)
		for (int id = 0; id < KEYS; id++) {
			int at = find(part, id);
			void *n = tb_get(t, key(part, 0), key(id, 1));
			if (n != (at < 0 ? NULL : &nodes[model[at].node])) die("get is not the model's", step);
		}
}

int LLVMFuzzerTestOneInput(const unsigned char *data, size_t size) {
	tb_table *t = tb_new();
	length = 0;
	memset(nparts, 0, sizeof nparts);
	for (size_t i = 0; i + 1 < size && i / 2 < 300; i += 2) {
		int step = (int)(i / 2), op = data[i] % 9, part = data[i + 1] & 3, id = data[i + 1] >> 2 & 3,
			node = data[i + 1] >> 4 & 3, at = find(part, id), code;
		size_t n;
		tb_key p = key(part, 0), k = key(id, 1);
		if (op == 0) {
			code = tb_add(t, p, k, &nodes[node]);
			int want = at < 0 ? 0 : model[at].node == node ? 0 : TB_ALREADY_THERE;
			if (code != want) die("add's code", step);
			if (at < 0) put(part, id, node);
		} else if (op == 1) {
			tb_sub(t, p, k, &nodes[node]);
			if (at < 0 || model[at].node != node) {
				if (at >= 0) take(at);
				put(part, id, node);
			}
		} else if (op == 2) {
			const tb_key *ids = tb_ids(t, p, &nodes[node], &n);
			scribble();
			size_t m = 0;
			for (int j = 0; j < length; j++) {
				if (model[j].part != part || model[j].node != node) continue;
				if (m >= n || key_index(ids[m], 1) != model[j].id) die("ids are not the model's", step);
				m++;
			}
			if (m != n) die("ids are not the model's (length)", step);
		} else if (op == 3) {
			const tb_entry *es = tb_at(t, k, &n);
			scribble();
			size_t m = 0;
			for (int j = 0; j < length; j++) {
				if (model[j].id != id) continue;
				if (m >= n || key_index(es[m].part, 0) != model[j].part || node_index(es[m].node) != model[j].node)
					die("at is not the model's", step);
				m++;
			}
			if (m != n) die("at is not the model's (length)", step);
		} else if (op == 4) {
			const tb_where *ws = tb_who(t, &nodes[node], &n);
			scribble();
			size_t m = 0;
			for (int q = 0; q < nparts[node]; q++)
				for (int j = 0; j < length; j++) {
					if (model[j].node != node || model[j].part != parts[node][q]) continue;
					if (m >= n || key_index(ws[m].part, 0) != model[j].part || key_index(ws[m].id, 1) != model[j].id)
						die("who is not the model's", step);
					m++;
				}
			if (m != n) die("who is not the model's (length)", step);
		} else if (op == 5) {
			code = tb_del(t, p, k);
			if (code != (at < 0 ? TB_NOTHING_THERE : 0)) die("del's code", step);
			if (at >= 0) take(at);
		} else if (op == 6) {
			code = tb_del_part(t, p, &nodes[node]);
			int any = 0;
			for (int j = length - 1; j >= 0; j--)
				if (model[j].part == part && model[j].node == node) take(j), any = 1;
			if (code != (any ? 0 : TB_NOTHING_THERE)) die("del_part's code", step);
		} else if (op == 7) {
			code = tb_del_node(t, &nodes[node]);
			int any = 0;
			for (int j = length - 1; j >= 0; j--)
				if (model[j].node == node) take(j), any = 1;
			if (code != (any ? 0 : TB_NOTHING_THERE)) die("del_node's code", step);
		} else {
			void *got = tb_get(t, p, k);
			if (got != (at < 0 ? NULL : &nodes[model[at].node])) die("get is not the model's", step);
		}
		scribble();
		check(t, step);
	}
	tb_free(t);
	return 0;
}
