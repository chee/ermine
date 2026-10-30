// Strongly connected components (Tarjan), each ranked after the ones its members come after.
// Members of a component share a rank. Items are 0..n-1; item i's edges are adj[off[i]..off[i+1]).
// The optional per-item array (NULL for none) sets a minimum rank for a component: the largest
// value among its members. out gets n ranks.
#ifndef RANK_H
#define RANK_H

#include <stddef.h>

void rk_rank(size_t n, const size_t *off, const size_t *adj, const int *floor, int *out);

#endif
