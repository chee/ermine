// processes at paths (typescript/processes.ts) in C: a root's running processes as rows (a trie
// on its process part) and the contributor that walks them. ermine/processes/conformance/processes/
// holds both to the same rules.
//
//   (process, R).value = { work: { clock: "proc:7f3a" }, dev: { clock: "proc:44d0" } }
//
//   pr_processes rows;
//   pr_processes_init(&rows, tb_string("R"));
//   const pl_contributor *const walk[] = {&rows.contributor, &pl_children};
//   pl_connect(p, &(pl_setup){.root = .., .contributors = walk, .ncontributors = 2});
//   pr_add(p, table, root, path, n, id, header, &changed, &made);
//   pl_commit(p, &changed);
//
// a level is a map, a leaf a process id; a process with processes under it is a level holding its id
// under the key "" (no name is ""). walked by path; a running process
// shadows what is saved there. rows are never saved: what runs now, on this device.
// writes: return changed entries for pl_commit. refused, nothing changed: PL_NOT_A_NAME,
// PL_NOTHING_THERE, PL_ALREADY_THERE. memory: entries hold patches (pl_hold); the caller holds the
// header's block also (pl_hold_also) on each changed entry and *made.
//
// any other rows kept the same way (processes.ts' trie, addLeaf, removeLeaf): a trie of ids on a
// part of their own, by the same rules: pr_trie_init, pr_add_in, pr_remove_in. pr_processes_init,
// pr_add and pr_remove are these on PR_PART, from "process". pr_trie_init's part and from: kept,
// not copied
#ifndef PROCESSES_H
#define PROCESSES_H

#include "../../../core/places/c/places.h"

// the process part
#define PR_PART "process"

typedef struct {
	pl_contributor contributor;
	tb_key root;
	// the part the trie is on (pr_processes_init: PR_PART)
	const char *part;
} pr_processes;
// the processes running under root, by path: the leaf at here's path + the name. a walk from an id
// alone, its path not known: nothing. names: every name directly under here's path, a leaf or a
// level (processes deeper, no id: the walk goes through it, pl_list and pl_members_at show it).
// Reads through the places it is handed. Pruning (places.h): no level at here's path + the name (no
// leaf, nothing, or under a leaf): PL_NONE, so the walk asks it nothing more under there; the read
// that said so is of all under that path, so a start anywhere under it marks the walk and one
// elsewhere does not. No names under here's path: none too. A walk from an id alone: none at once
void pr_processes_init(pr_processes *p, tb_key root);
// the walk of a trie of ids by path on root's part, as pr_processes_init's on PR_PART. from: what
// its answers say (the contributor's from)
void pr_trie_init(pr_processes *p, const char *part, tb_key root, const char *from);

// id running at path under root: its leaf put in, the levels on the way made. refused: no name, or a
// name that is not one (PL_NOT_A_NAME); a process at exactly the path (PL_ALREADY_THERE; above or
// under it is fine: a leaf above becomes a level holding its id under ""). a saved thing at the path is fine:
// the row shadows it. the first row under root makes the part's entry (a table event tells readers):
// *changed nothing, *made the entry (the places' own), for the caller to hold the header's block on;
// else *made NULL. The entry is written through places' unread (pl_unread), as children are. made may be NULL. 0, or the code
int pr_add(pl *l, tb_table *table, tb_key root, const char *const *path, size_t n, tb_key id,
	ch_header header, pl_changed *changed, nd_entry **made);
// pr_add on any part: id at path in root's trie there, by the rules of a trie of one thing at a path:
// refused too (PL_ALREADY_THERE) where a leaf is above the path or a level under it
int pr_add_in(pl *l, tb_table *table, const char *part, tb_key root, const char *const *path,
	size_t n, tb_key id, ch_header header, pl_changed *changed, nd_entry **made);

// the process at path under root taken out, and with it every level left empty: one patch, at the
// highest of them. none there: PL_NOTHING_THERE
int pr_remove(pl *l, tb_table *table, tb_key root, const char *const *path, size_t n,
	ch_header header, pl_changed *changed);
// pr_remove on any part: the leaf at path in root's trie there, by the same rules
int pr_remove_in(pl *l, tb_table *table, const char *part, tb_key root, const char *const *path,
	size_t n, ch_header header, pl_changed *changed);

#endif
