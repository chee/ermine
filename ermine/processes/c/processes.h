// Processes at paths (typescript/processes.ts), in C: the rows of a root's running processes, a trie on
// the root's process part, and the contributor that walks it. Same rules as processes.ts, which the
// suite in ermine/processes/conformance/processes/ holds both to.
//
//   (process, R).value = { work: { clock: "proc:7f3a" }, dev: { clock: "proc:44d0" } }
//
// a level a map, a leaf a process's id. a process's own things (its subprocesses too) are inside its
// node, its children, so nothing sits under a leaf.
//
// the walk: the contributor goes by the path, never the id. given before children, a process shadows what
// is saved at its path while it runs ("the ephemeral wins"), and what is saved is there again at its stop.
// a walk reads only its own root's rows.
//
//   pr_processes rows;
//   pr_processes_init(&rows, tb_string("R"));
//   const pl_contributor *const walk[] = {&rows.contributor, &pl_children};
//   pl_connect(p, &(pl_setup){.root = .., .contributors = walk, .ncontributors = 2});
//   pr_add(p, table, root, path, n, id, header, &changed, &made);
//   pl_commit(p, &changed);
//
// the rows are never saved: they are the processes running now, on this device.
//
// writes: plain functions on the table, as places' pl_place is, each giving back the entries it changed for
// pl_commit: a patch at the path, so a start or a stop marks its own path and the names above it, nothing
// beside. refused: a pl_code (PL_NOT_A_NAME, PL_NOTHING_THERE, PL_ALREADY_THERE), nothing changed. The
// patches are held by the entry as places' writes are (pl_hold): the header's block is the caller's to hold
// also (pl_hold_also) on each entry changed, and on *made.
#ifndef PROCESSES_H
#define PROCESSES_H

#include "../../../filesystem/places/c/places.h"

// the process part
#define PR_PART "process"

typedef struct {
	pl_contributor contributor;
	tb_key root;
} pr_processes;
// the processes running under root, by path: the leaf at here's path + the name. a walk from an id
// alone, its path not known: nothing. names: the leaves directly under here's path (a level, with
// processes deeper, is no name of its own: what is there is whatever else is). Reads through the
// places it is handed
void pr_processes_init(pr_processes *p, tb_key root);

// id running at path under root: its leaf put in, the levels on the way made. refused: no name, or a
// name that is not one (PL_NOT_A_NAME); a process at the path, above it or under it
// (PL_ALREADY_THERE: a leaf holds no levels, a level is no leaf). a saved thing at the path is fine:
// the row shadows it. the first row under root makes the part's entry (a table event tells readers):
// *changed nothing, *made the entry (the places' own), for the caller to hold the header's block on;
// else *made NULL. The entry is changed in place, as places' children are. made may be NULL. 0, or the code
int pr_add(pl *l, tb_table *table, tb_key root, const char *const *path, size_t n, tb_key id,
	ch_header header, pl_changed *changed, nd_entry **made);

// the process at path under root taken out, and with it every level left empty: one patch, at the
// highest of them. none there: PL_NOTHING_THERE
int pr_remove(pl *l, tb_table *table, tb_key root, const char *const *path, size_t n,
	ch_header header, pl_changed *changed);

#endif
