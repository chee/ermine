// libFuzzer target. The input bytes are a sequence of operations over a few nodes, applied to the
// tracker and to a small model. After every step, reads and readers must agree with the model
// (links may repeat) and both lists must be doubly linked and agree.
#include "tracker.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { NODES = 8, READERS = 4, MAX = 64 };

typedef struct {
	int to;
	unsigned id;
	unsigned gen;
} mlink;

typedef struct {
	mlink reads[MAX];
	int length;
	int open, at;
	unsigned gen; // the tick of this run
} mreader;

typedef struct {
	int from;
	unsigned id;
	unsigned gen;
} mreader_of;

static mreader model[NODES];
static mreader_of readers[NODES][MAX];
static int readers_length[NODES];
static unsigned ids, ticks;
static tg_node *nodes[NODES];
static int names[NODES];

static void die(const char *why, int step) {
	fprintf(stderr, "fuzz: step %d: %s\n", step, why);
	abort();
}

static void model_drop(int to, unsigned id) {
	for (int i = 0; i < readers_length[to]; i++) {
		if (readers[to][i].id != id) continue;
		memmove(&readers[to][i], &readers[to][i + 1], (readers_length[to] - i - 1) * sizeof readers[to][0]);
		readers_length[to]--;
		return;
	}
}

static void model_insert(int r, int at, int a, unsigned gen) {
	mreader *m = &model[r];
	memmove(&m->reads[at + 1], &m->reads[at], (m->length - at) * sizeof m->reads[0]);
	m->reads[at] = (mlink){a, ++ids, gen};
	m->length++;
	readers[a][readers_length[a]++] = (mreader_of){r, ids, gen};
}

static void model_set_gen(int r, int a, unsigned id, unsigned gen) {
	for (int i = 0; i < readers_length[a]; i++)
		if (readers[a][i].id == id) readers[a][i].gen = gen;
	(void)r;
}

// The same checks as tg_track: same spot as the last read, next in order, newest reader is this
// run.
static void model_track(int r, int a) {
	mreader *m = &model[r];
	if (m->at > 0 && m->reads[m->at - 1].to == a) return;
	if (m->at < m->length && m->reads[m->at].to == a) {
		m->reads[m->at].gen = m->gen;
		model_set_gen(r, a, m->reads[m->at].id, m->gen);
		m->at++;
		return;
	}
	int n = readers_length[a];
	if (n > 0 && readers[a][n - 1].from == r && readers[a][n - 1].gen == m->gen) return;
	model_insert(r, m->at++, a, m->gen);
}

static void model_end(int r) {
	mreader *m = &model[r];
	if (!m->open) return;
	m->open = 0;
	for (int i = m->at; i < m->length; i++) model_drop(m->reads[i].to, m->reads[i].id);
	m->length = m->at;
}

static void model_add(int r, int a) {
	mreader *m = &model[r];
	for (int i = 0; i < m->length; i++)
		if (m->reads[i].to == a) return;
	model_insert(r, m->length, a, 0);
}

static void model_untrack(int r, int a) { // a < 0: all
	mreader *m = &model[r];
	for (int i = m->length - 1; i >= 0; i--) {
		if (a >= 0 && m->reads[i].to != a) continue;
		model_drop(m->reads[i].to, m->reads[i].id);
		memmove(&m->reads[i], &m->reads[i + 1], (m->length - i - 1) * sizeof m->reads[0]);
		m->length--;
		if (m->open && i < m->at) m->at--;
	}
}

static int index_of(tg_node *n) {
	return *(int *)n->owner;
}

static void check(int step) {
	for (int n = 0; n < NODES; n++) {
		tg_node *t = nodes[n];
		tg_link *before = NULL;
		for (tg_link *l = t->first; l != NULL; l = l->after) {
			if (l->to != t) die("a reader's to is not its node", step);
			if (l->before != before) die("readers: before and after disagree", step);
			before = l;
		}
		if (t->last != before) die("last is not the end of the readers", step);
		for (int a = 0; a < NODES; a++) {
			int forward = 0, back = 0;
			for (tg_link *l = t->reads; l != NULL; l = l->next) {
				if (l->from != t) die("a read's from is not its node", step);
				if (l->to == nodes[a]) forward++;
			}
			for (tg_link *l = nodes[a]->first; l != NULL; l = l->after)
				if (l->from == t) back++;
			if (forward != back) die("symmetry broken", step);
		}
		int k = 0;
		for (tg_link *l = t->reads; l != NULL; l = l->next, k++)
			if (k >= model[n].length || model[n].reads[k].to != index_of(l->to))
				die("reads differ from the model", step);
		if (k != model[n].length) die("reads differ from the model (length)", step);
		k = 0;
		for (tg_link *l = t->first; l != NULL; l = l->after, k++)
			if (k >= readers_length[n] || readers[n][k].from != index_of(l->from))
				die("readers differ from the model", step);
		if (k != readers_length[n]) die("readers differ from the model (length)", step);
	}
}

int LLVMFuzzerTestOneInput(const unsigned char *data, size_t size) {
	memset(model, 0, sizeof model);
	memset(readers_length, 0, sizeof readers_length);
	ids = 0;
	ticks = 0;
	for (int i = 0; i < NODES; i++) {
		names[i] = i;
		nodes[i] = tg_node_new(&names[i]);
	}
	for (size_t i = 0; i + 1 < size && i / 2 < 400; i += 2) {
		int op = data[i] % 6, r = data[i + 1] % READERS, a = (data[i + 1] >> 2) % NODES;
		mreader *m = &model[r];
		// Track in a run; add and begin outside one (add in a run fails).
		if (op == 0 && !m->open) {
			tg_begin(nodes[r]);
			m->open = 1, m->at = 0, m->gen = ++ticks;
		} else if (op == 1 && m->open) {
			if (m->length >= MAX - 1) continue;
			if (tg_track(nodes[r], nodes[a]) != 0) abort();
			model_track(r, a);
		} else if (op == 2) {
			tg_end(nodes[r]);
			model_end(r);
		} else if (op == 3 && m->open) {
			if (tg_add(nodes[r], nodes[a]) != -2) abort();
		} else if (op == 3) {
			if (tg_add(nodes[r], nodes[a]) != 0) abort();
			model_add(r, a);
		} else if (op == 4) {
			tg_untrack(nodes[r], nodes[a]);
			model_untrack(r, a);
		} else if (op == 5) {
			tg_untrack(nodes[r], NULL);
			model_untrack(r, -1);
		} else continue;
		check((int)(i / 2));
	}
	for (int i = 0; i < NODES; i++) tg_untrack(nodes[i], NULL);
	for (int i = 0; i < NODES; i++) tg_node_free(nodes[i]);
	return 0;
}
