#include "rank.h"

#include <stdlib.h>

void rk_rank(size_t n, const size_t *off, const size_t *adj, int *out) {
	if (n == 0) return;
	// -1: not visited
	long *index = malloc(n * sizeof *index);
	long *low = malloc(n * sizeof *low);
	size_t *comp = malloc(n * sizeof *comp);
	char *on = calloc(n, 1);
	size_t *stack = malloc(n * sizeof *stack);
	size_t *call = malloc(n * sizeof *call);
	size_t *edge = malloc(n * sizeof *edge);
	if (!index || !low || !comp || !on || !stack || !call || !edge) abort();
	for (size_t i = 0; i < n; i++) index[i] = -1;
	long next = 0;
	size_t sp = 0, cp = 0, comps = 0;
	for (size_t root = 0; root < n; root++) {
		if (index[root] >= 0) continue;
		index[root] = low[root] = next++;
		stack[sp++] = root;
		on[root] = 1;
		call[cp] = root;
		edge[cp++] = off[root];
		while (cp > 0) {
			size_t p = call[cp - 1];
			if (edge[cp - 1] < off[p + 1]) {
				size_t q = adj[edge[cp - 1]++];
				if (index[q] < 0) {
					index[q] = low[q] = next++;
					stack[sp++] = q;
					on[q] = 1;
					call[cp] = q;
					edge[cp++] = off[q];
				} else if (on[q] && index[q] < low[p]) {
					low[p] = index[q];
				}
				continue;
			}
			cp--;
			if (cp > 0 && low[p] < low[call[cp - 1]]) low[call[cp - 1]] = low[p];
			if (low[p] != index[p]) continue;
			// p heads a component: its members are on the stack down to p
			size_t from = sp;
			while (stack[from - 1] != p) from--;
			from--;
			size_t id = comps++;
			for (size_t k = from; k < sp; k++) {
				comp[stack[k]] = id;
				on[stack[k]] = 0;
			}
			int r = 0;
			for (size_t k = from; k < sp; k++) {
				size_t x = stack[k];
				for (size_t e = off[x]; e < off[x + 1]; e++) {
					size_t q = adj[e];
					if (comp[q] != id && out[q] + 1 > r) r = out[q] + 1;
				}
			}
			for (size_t k = from; k < sp; k++) out[stack[k]] = r;
			sp = from;
		}
	}
	free(index);
	free(low);
	free(comp);
	free(on);
	free(stack);
	free(call);
	free(edge);
}
