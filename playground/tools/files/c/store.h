// A store (FILES.tex), in C: a folder holding one graph, as a host saves it. Same functions as store.ts, whose header
// has the rules; the order of its steps is kept exactly, so the folder, the manifest's frames, the attributes and the
// Trash are as the reference leaves them.
//
// Nothing here runs at once: every call finishes before it returns, so store.ts's lock is no call here (a host that
// takes the store from several threads takes its own).
//
// MEMORY. What the store keeps lives till st_close, in its own memory. Everything a call gives back (a Restored's
// arrays, the differences, the others, the graph) is held until st_release, which a host calls when it is done with
// them, as layout.h's layout_release (st_release is that, and drops what the store built from its records for the
// call). Nodes a st_read gives are new objects: st_restored_free frees them.
#ifndef STORE_H
#define STORE_H

#include "../../../../ermine/encoding/c/json.h"
#include "saved_pack.h"
#include "saved.h"
#include "external.h"
#include "foundation.h"
#include "layout.h"
#include "manifest.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef enum {
	ST_OK,
	ST_STORE, // StoreError: an invalid store, a folder that cannot become one, or a node that cannot be saved
	ST_ERROR, // anything else thrown: a call failed (st_message says how)
} st_code;

typedef struct st_store st_store;

// told of each entry left out or sent to the Trash
typedef void (*st_list)(void *context, const char *path, const char *why);
// sends an absolute path to the Trash: 0, or -1 with errno
typedef int (*st_bin)(void *context, const char *path);

typedef struct {
	// the Trash; NULL: sys.h's sys_trash_in with home (below): the real Trash if home is NULL
	st_bin trash;
	void *trash_context;
	// the host runs the files program: a folder holding others' entries may become a store
	bool files;
	// the names to pass over, each a whole name, * any run; NULL: names.ts's PASS for a new store
	const char *const *pass;
	size_t pass_length;
	// bytes past four times what it holds the manifest may grow before it is folded
	bool has_slack;
	size_t slack;
	st_list list;
	void *list_context;
	// the home folder whose .ermine/external holds outside manifests and the list of stores; NULL: the person's $HOME. A test
	// always gives one
	const char *home;
	// places whose folders keep their manifests outside, as a place a service syncs; on the home folder's volume
	const char *const *outside;
	size_t outside_length;
	// the calls into macOS's Foundation; NULL: foundation.h's fd_system
	const fd_foundation *foundation;
	// writes of entries a person sees are not made under NSFileCoordinator (macOS); false: they are
	bool uncoordinated;
} st_options;

// what a host saves: the graph from its root, as its table gives each node
typedef struct {
	const char *root;
	double time;
	// a node by its id, or NULL if it is not loaded
	const sd_node *(*get)(void *context, const char *id);
	// an ephemeral node: never saved, and left out of every list; NULL: none is
	bool (*ephemeral)(void *context, const char *id);
	void *context;
	// the host's own records, saved in the same frame; data NULL removes one
	const mf_record *records;
	size_t records_length;
} st_saving;

// what loading gives: the root, the last time given, the nodes reachable from the root in the order walked, and every
// other node the store keeps; missing: ids in a list with no record. The node arrays and missing are held till
// st_release; the nodes themselves are st_restored_free's
typedef struct {
	bool none; // a new store: there is nothing
	char *root;
	double time;
	const sd_node **nodes;
	size_t nodes_length;
	const sd_node **others;
	size_t others_length;
	const char **missing;
	size_t missing_length;
	sp_graph *graphs;
	size_t graphs_length;
} st_restored;
void st_restored_free(st_restored *restored);

// what is found at a path, as types.ts's Entry
typedef enum { ST_FILE, ST_FOLDER, ST_LINK } st_kind;
typedef struct {
	st_kind kind;
	const char *id; // NULL: none
	uint64_t ino;
	// a file: the form it is read in, and its value and hash, or why it does not read
	const char *form;
	const Json *value;
	const char *hash;
	bool why;
	// a folder: the holder and name of the slot it carries
	const char *holder, *name;
	// a link
	const char *target;
} st_entry;

// where the folder and the layout differ: what the layout has at a path, and what is there now (NULL: none)
typedef struct {
	const char *path;
	const Laid *was;
	const st_entry *now;
} st_difference;

// the stores home's list has, and where one is now, are external.h's ex_stores and ex_find.
//
// the store in folder (absolute), made if the folder has none: nothing is read or made yet
st_store *st_open(const char *folder, const st_options *options);
void st_close(st_store *store);
// frees what calls gave back, and what the store built for them
void st_release(st_store *store);
// the message of the last ST_ERROR or ST_STORE
const char *st_message(const st_store *store);

// a folder that is not a store (FILES.tex, A folder that is not a store): a host that keeps its graph elsewhere has a node's
// subtree laid out in the folder. Its manifest holds only the layout records and store, no saved graph and no kept values;
// the values are read from the graph the host gives, and each frame has a time of its own counting up. st_write takes the
// graph with each batch, and st_mirror_read, once, to carry out again a batch that was not done. st_read is refused
st_store *st_open_mirror(const char *folder, const st_options *options);
st_code st_mirror_read(st_store *store, const st_saving *saving);

// loads the store, or makes it (none); read again, it gives the graph as last written
st_code st_read(st_store *store, st_restored *out);
// saves the graph: a batch of what changed since the last write, laid out
st_code st_write(st_store *store, const st_saving *saving);

// the graph as the last batch, or loading, left it: its root and each node's shape, in the order kept
const char *st_root(const st_store *store);
size_t st_count(const st_store *store);
const char *st_id(const st_store *store, size_t index);
const mf_node *st_node(const st_store *store, size_t index);
// the host's records: every one but meta, the nodes', the layout's, store and plan; data held till st_release
size_t st_others(st_store *store, const mf_record **records);

// compares the folders touched (NULL: every folder) and the root's file with the layout; takes no lock
st_code st_differences(st_store *store, const char *const *touched, size_t count, const st_difference **out, size_t *length);
// lays paths out again as the graph has them (NULL: every path that differs), sending what is there to the Trash
st_code st_mend(st_store *store, const char *const *paths, size_t count);
// sends an entry (a path from the store's folder) to the Trash and lists it, with why
st_code st_trash(st_store *store, const char *path, const char *why);

// what the files program reads and sets (program.h): the store's folder, the layout it keeps in memory, the graph as its
// records give it, and the names passed over. The layout and the graph are held till st_release, and the layout is the
// one a write lays out from: what the program sets in it is what the next write sees. Do not release between an edit and
// the write that follows it
const char *st_folder(const st_store *store);
Omap *st_layout(st_store *store);
const Graph *st_graph(st_store *store);
const char *const *st_pass(const st_store *store, size_t *count);

#endif
