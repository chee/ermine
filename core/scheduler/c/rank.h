// rank: strongly connected components (Tarjan), each ranked after the ones its members are
// after. members of one component share a rank; a component with nothing after it is 0.
// items are 0..n-1; the edges of item i are adj[off[i]..off[i+1]). out gets n ranks.
#ifndef RANK_H
#define RANK_H

#include <stddef.h>

void rk_rank(size_t n, const size_t *off, const size_t *adj, int *out);

#endif
