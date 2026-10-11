// libFuzzer target: the input bytes are a sequence of operations over a few nodes, applied to
// the trackgraph and to a small model (newcore/conformance/model.ts, in C). After every step:
// reads and readers agree with the model (duplicates removed on both sides, each at its first
// place: the model makes them too, when a run reads a node out of order), and
// the laws hold (symmetry; a link's at is its slot; holes counted; the last reader a link).
#include "trackgraph.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { NODES = 8, READERS = 4, MAX = 64 };

typedef struct {
	int to;
	unsigned id;
} mlink;

typedef struct {
	mlink reads[MAX];
	int length;
	int open, at;
	unsigned read; // bit per node read in this run
} mreader;

typedef struct {
	int from;
	unsigned id;
} mreader_of;

static mreader model[NODES];
static mreader_of readers[NODES][MAX];
static int readers_length[NODES];
static unsigned ids;
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

static void model_insert(int r, int at, int a) {
	mreader *m = &model[r];
	memmove(&m->reads[at + 1], &m->reads[at], (m->length - at) * sizeof m->reads[0]);
	m->reads[at] = (mlink){a, ++ids};
	m->length++;
	readers[a][readers_length[a]++] = (mreader_of){r, ids};
}

static void model_track(int r, int a) {
	mreader *m = &model[r];
	if (m->at < m->length && m->reads[m->at].to == a) m->at++;
	else if (m->read & (1u << a)) return;
	else model_insert(r, m->at++, a);
	m->read |= 1u << a;
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
	model_insert(r, m->length, a);
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
	if (a >= 0) m->read &= ~(1u << a);
	else m->read = 0;
}

static int index_of(tg_node *n) {
	return *(int *)n->owner;
}

static void check(int step) {
	for (int n = 0; n < NODES; n++) {
		tg_node *t = nodes[n];
		// laws, before tg_readers compacts
		size_t holes = 0;
		for (size_t i = 0; i < t->length; i++) {
			if (t->readers[i] == NULL) holes++;
			else if (t->readers[i]->at != i || t->readers[i]->to != t) die("a reader's at is not its slot", step);
		}
		if (holes != t->holes) die("holes miscounted", step);
		if (t->length != 0 && t->readers[t->length - 1] == NULL) die("the last reader is a hole", step);
		if (t->holes * 2 > t->length && t->length != 0) die("more than half holes", step);
		// symmetry: links from n to each node, counted both ways
		for (int a = 0; a < NODES; a++) {
			int forward = 0, back = 0;
			for (tg_link *l = t->reads; l != NULL; l = l->next) {
				if (l->from != t) die("a read's from is not its node", step);
				if (l->next != NULL && l->next->prev != l) die("reads: prev and next disagree", step);
				if (l->to == nodes[a]) forward++;
			}
			for (size_t i = 0; i < nodes[a]->length; i++)
				if (nodes[a]->readers[i] != NULL && nodes[a]->readers[i]->from == t) back++;
			if (forward != back) die("symmetry broken", step);
		}
		// reads, duplicates removed, against the model's
		int want[NODES], wanted = 0, had[NODES] = {0};
		for (int i = 0; i < model[n].length; i++)
			if (!had[model[n].reads[i].to]++) want[wanted++] = model[n].reads[i].to;
		int seen[NODES] = {0}, k = 0;
		for (tg_link *l = t->reads; l != NULL; l = l->next) {
			int a = index_of(l->to);
			if (seen[a]++) continue;
			if (k >= wanted || want[k] != a) die("reads differ from the model", step);
			k++;
		}
		if (k != wanted) die("reads differ from the model (length)", step);
		// readers, duplicates removed, against the model
		size_t length;
		tg_link *const *rs = tg_readers(t, &length);
		int who[NODES], whos = 0, got[NODES] = {0};
		for (int i = 0; i < readers_length[n]; i++)
			if (!got[readers[n][i].from]++) who[whos++] = readers[n][i].from;
		int met[NODES] = {0};
		k = 0;
		for (size_t i = 0; i < length; i++) {
			int f = index_of(rs[i]->from);
			if (met[f]++) continue;
			if (k >= whos || who[k] != f) die("readers differ from the model", step);
			k++;
		}
		if (k != whos) die("readers differ from the model (length)", step);
	}
}

int LLVMFuzzerTestOneInput(const unsigned char *data, size_t size) {
	memset(model, 0, sizeof model);
	memset(readers_length, 0, sizeof readers_length);
	ids = 0;
	for (int i = 0; i < NODES; i++) {
		names[i] = i;
		nodes[i] = tg_node_new(&names[i]);
	}
	for (size_t i = 0; i + 1 < size && i / 2 < 400; i += 2) {
		int op = data[i] % 6, r = data[i + 1] % READERS, a = (data[i + 1] >> 2) % NODES;
		mreader *m = &model[r];
		// only what TRACKGRAPH.tex defines: track in a run, add and begin outside one
		if (op == 0 && !m->open) {
			tg_begin(nodes[r]);
			m->open = 1, m->at = 0, m->read = 0;
		} else if (op == 1 && m->open) {
			if (m->length >= MAX - 1) continue;
			if (tg_track(nodes[r], nodes[a]) != 0) abort();
			model_track(r, a);
		} else if (op == 2) {
			tg_end(nodes[r]);
			model_end(r);
		} else if (op == 3 && !m->open) {
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
