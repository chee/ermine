// The graph the files program works on, in C, as today's core has it (typescript/graph.ts has the rules; this is the same
// thing on core's table, places and scheduler): entries under an id (value, attributes, children), writes made with a scope
// open, said written through places. The program and the store were written against a graph whose nodes keep ordered lists
// of ids in named slots and versions of a value; this is what they are given of today's:
//
//   a node is there when its children entry is (one made here always has one). Its value is the value entry's: one
//   version, core keeps no more (a side, a second version, is left out). A slot is a name in the children entry's value:
//   none, an empty list; one id, the bare id (places' walk goes through it); several, a list of ids in order.
//
// get and intro turn between this and the shape the store saves (saved.h): a version of a value is the entry's value and
// change, a slot's one list its ids, an info name's one version the attributes entry's name.
//
// ERRORS. A call that can fail answers a message (NULL: it did not), held till the next call that fails on this graph.
// MEMORY. A value given is held by the graph (op_ref), the caller lets go of its own. The ids and names a read gives are
// borrowed from the table: good until the node changes. A node get gives is held till fg_release, or fg_free.
#ifndef FILES_GRAPH_H
#define FILES_GRAPH_H

#include "../../../../core/op/c/apply.h"
#include "../../../../core/op/c/value.h"
#include "../../../../core/node/c/node.h"
#include "../../../../core/scheduler/c/scheduler.h"
#include "../../../../core/table/c/table.h"
#include "../../../../ermine/encoding/c/json.h"
#include "../../../../filesystem/protect/c/protect.h"
#include "saved.h"

#include <stdbool.h>
#include <stddef.h>

typedef struct fg fg;
typedef struct fg_api fg_api;

// root: the id names start from. may: the policy every write is asked, NULL: all are allowed; not freed. mint: gives the
// id of each node made here that is not ephemeral (malloc'd), NULL: made up; an ephemeral one's is always made up.
// event: told each table event, after places is. wrote: told the entries each write here changed in place, after places'
// commit (an entry made is told by its event). Either NULL: none (a host's sync hangs on these two)
typedef struct {
	const char *root;
	const pr_policy *may;
	char *(*mint)(void *context);
	void (*event)(void *context, tb_key part, tb_key id);
	void (*wrote)(void *context, nd_entry *const *changed, size_t count);
	void *context;
} fg_options;

fg *fg_new(const fg_options *options);
void fg_free(fg *g);
sc_scheduler *fg_scheduler(const fg *g);
// the table the graph's entries are in (a host's sync writes to it too)
tb_table *fg_table(const fg *g);
// entries changed in place by someone else (a host's sync): said written, as a write here is (places' commit)
void fg_landed(fg *g, nd_entry *const *changed, size_t count);

// the api for changes by an actor (NULL: none); the graph frees it
fg_api *fg_actor(fg *g, const char *actor);
// the same with a cause in every change it makes: {file, from?}; the cause is held
fg_api *fg_as(fg_api *api, const char *file, const char *from);
fg *fg_of(const fg_api *api);

// reads, told to no one
bool fg_loaded(const fg *g, const char *id);
// the node's value; NULL: none
const op_value *fg_value(const fg *g, const char *id);
// a slot's ids in order, in a new array the caller frees (the ids are borrowed); the count
size_t fg_ids(const fg *g, const char *holder, const char *slot, const char ***out);
// a node's slot names, in the order the graph has them, in a new array the caller frees (borrowed)
size_t fg_slots(const fg *g, const char *id, const char ***out);
bool fg_ephemeral(const fg *g, const char *id);

// writes: a message, or NULL
// a node, holding the value if there is one (held); *id its id, malloc'd, the caller's
const char *fg_create(fg_api *api, op_value *value, bool ephemeral, char **id);
// id put into a slot at a position (at < 0: the end); to >= 0: the members in [at, to) are replaced by it
const char *fg_insert(fg_api *api, const char *holder, const char *slot, const char *id, long at, long to);
// the members of a slot in [from, to)
const char *fg_remove(fg_api *api, const char *holder, const char *slot, long from, long to);
// the member at a position moved to a position in another slot (to < 0: the end); in one slot, the position it ends at
const char *fg_move(fg_api *api, const char *holder, const char *slot, long at, const char *into, const char *name, long to);
// the patches to a node's value (copied; their values held); version: only 0 is there
const char *fg_write(fg_api *api, const char *id, const op_patch *patches, size_t n, size_t version);

// the store's: the node as it saves it; NULL: not in the graph. Held till fg_release
const sd_node *fg_get(fg *g, const char *id);
void fg_release(fg *g);
// a node the store loaded, taken in whole (by the host's hand: a scope of its own); a message, or NULL
const char *fg_intro(fg *g, const sd_node *node);

// values and JSON
op_value *fg_value_of(const Json *json);
Json *fg_json_of(const op_value *value);

#endif
