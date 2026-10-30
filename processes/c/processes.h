// Processes at paths (typescript/processes.ts) in C. Entries hold patches (pl_hold); the caller also
// holds the header's block (pl_hold_also) on each changed entry and *made. Writes return changed
// entries for pl_commit. Rows are never saved.
//
//   pr_processes rows;
//   pr_processes_init(&rows, tb_string("R"));
//   const pl_contributor *const walk[] = {&rows.contributor, &pl_children};
#ifndef PROCESSES_H
#define PROCESSES_H

#include "../../places/c/places.h"

#define PR_PART "process"

typedef struct {
	pl_contributor contributor;
	tb_key root;
	const char *part;
} pr_processes;
void pr_processes_init(pr_processes *p, tb_key root);
void pr_trie_init(pr_processes *p, const char *part, tb_key root, const char *from);

// *made gets the part's entry when this is the first row under root, else NULL; made may be NULL.
int pr_add(pl *l, tb_table *table, tb_key root, const char *const *path, size_t n, tb_key id,
	ch_header header, pl_changed *changed, nd_entry **made);
int pr_add_in(pl *l, tb_table *table, const char *part, tb_key root, const char *const *path,
	size_t n, tb_key id, ch_header header, pl_changed *changed, nd_entry **made);

int pr_remove(pl *l, tb_table *table, tb_key root, const char *const *path, size_t n,
	ch_header header, pl_changed *changed);
int pr_remove_in(pl *l, tb_table *table, const char *part, tb_key root, const char *const *path,
	size_t n, ch_header header, pl_changed *changed);

#endif
