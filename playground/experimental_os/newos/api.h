// api.h: newOS's API (api.c): what a program, a driver, an exec program and the JavaScript runner
// reach the graph through, over today's core. It keeps the shape 10-12's core gave a part
// (sc_api: look, content, children, info, write, set, insert, remove, rename, move, create, node,
// as; and a part's start, call, onCleanup), so the programs run as they were written.
//
// Under it: the table, places asked [processes, fronts, children] (ermine/processes' rows, fronts/,
// the children), the scheduler, scope nodes, statuses (status.h) and the card (card/). Processes are
// ermine/programs' (start.h): the host makes one per program started, and this is what its
// create_api hands over. What 10-12 had and today's ermine has not, newOS keeps here, each a pick,
// changeable (PORT.md):
//   - a node's members at a name: an ephemeral id goes in front (fronts.h), a document's id into
//     the children, one per name; a member is either, in that order (index 0 the first front)
//   - a handler: a node whose value is a live function (ap_live), called by address (ap_call), with
//     the scope of the process that placed it open
//   - a part's start of code ({compute, effect}): a node in front at the address, its value what the
//     compute gives, a computer (and an effect) in a scope of its own under the part's
//   - an ephemeral node goes, and out of every front, when the scope that made it is torn down
//
// Values are op_values; a live function is a stand-in {"live": n} only this os reads. A read is told
// to the scheduler as places tells it (so a computer's run tracks it), except through a peep's api.
// What a read gives is the turn's (ap_temp): good until ap_sweep.
#ifndef ERMOS_API_H
#define ERMOS_API_H

#include "../../../ermine/processes/c/processes.h"
#include "../../../ermine/processes/c/scopes.h"
#include "../../../ermine/sites/c/sites.h"
#include "../../../filesystem/places/c/status.h"
#include "fronts/fronts.h"
#include "card/card.h"

#include <stdbool.h>
#include <stdint.h>

typedef struct ap_os ap_os;
typedef struct ap_api ap_api;
typedef struct ap_given ap_given;
typedef struct ap_fn ap_fn;

// an error: code (a 10-12 code: nothing-there, wrong-field, stopped, not-a-handler, already-there,
// thrown) and message; name NULL but for a program's own
typedef struct {
	const char *name;
	const char *code;
	const char *message;
} ap_error;
// a fresh one, the turn's
const ap_error *ap_error_new(ap_os *os, const char *code, const char *message);

// a function: called with what a part is given; *out its value (NULL: none) or *pending. An error
// is returned (NULL: none)
struct ap_fn {
	const ap_error *(*call)(ap_fn *self, ap_given *g, op_value **out, int *pending);
	// a live function's (ap_live): let go when the node holding it is gone, or out of its last front,
	// or its process has ended; NULL: kept
	void (*free)(ap_fn *self);
};

// what made a version: the change's header, as 10-12 gave it
typedef struct {
	int64_t time;
	const op_value *actor;
	const char *reader;
	const op_value *site;
	const op_value *cause;
} ap_change;
typedef struct {
	const op_value *content;
	ap_change change;
	// a process's status ({pending: true}, {error: {...}}), in front of its value
	int status;
} ap_version;
// one answer at an address
typedef struct {
	const char *id;
	// the contributor that gave it: "process", "front" or "children"
	const char *from;
	const char *const *route;
	size_t nroute;
	// the table holds it
	int node;
	int ephemeral;
	int has_versions;
	ap_version *versions;
	size_t nversions;
} ap_item;
typedef struct {
	ap_item *items;
	size_t n;
} ap_items;
typedef struct {
	const char **names;
	size_t n;
} ap_namelist;

// an interface: whose its writes are (scope; NULL the host's), and where a relative address is read
// from (place, names from the root)
struct ap_api {
	ap_os *os;
	sc_scope *scope;
	// the process (or computed node) it is, its last name, the folder it is in
	const char *self, *name;
	const char *const *place;
	size_t nplace;
	// reads told to no one
	int peep;
	// its changes carry it (ap_as)
	const op_value *cause;
};

typedef enum { AP_SETUP, AP_COMPUTE, AP_EFFECT, AP_HANDLER, AP_CLEANUP } ap_part;
struct ap_given {
	ap_os *os;
	ap_part part;
	ap_api *api, *peep;
	const char *self, *name;
	const op_value *value, *previous, *args;
	int killed;
};

// what the host is to the API: the card, the root, the log, and starting and stopping a program
typedef struct {
	Card *card;
	const char *root;
	void (*say)(void *ctx, const char *line);
	// a program (path from the root) started at at (names from the root), its data in a node "data"
	// inside it: its id, or an error
	const ap_error *(*start)(void *ctx, const char *const *at, size_t nat, const char *const *program, size_t nprogram,
		const op_value *data, const char **id);
	void *ctx;
} ap_setup;

// the table, places, scheduler, scope nodes and statuses, made and connected; the machine's scope
ap_os *ap_new(const ap_setup *setup);
void ap_free(ap_os *os);
sc_scheduler *ap_scheduler(ap_os *os);
tb_table *ap_table(ap_os *os);
pl *ap_places(ap_os *os);
sn *ap_scopes(ap_os *os);
// the machine's scope: the host's writes, the processes' parent
sc_scope *ap_machine(ap_os *os);
// where each scope the API (and the host) makes was made (ermine/sites)
st_sites *ap_sites(ap_os *os);
// a write's changed entries said written: to places, and to the card
void ap_commit(void *os, const pl_changed *changed);
// the scheduler's pulse, then the effects' acts it held (each with no run open), until none is left
void ap_pulse(ap_os *os);
// the turn's memory, let go at ap_sweep
void *ap_temp(ap_os *os, size_t n);
char *ap_dup(ap_os *os, const char *text);
void ap_sweep(ap_os *os);
// a fresh ephemeral id, kept until ap_free
const char *ap_pid(ap_os *os);
// the node id goes when scope is torn down: out of every front it is in, its entries out of the table
void ap_goes_with(ap_os *os, sc_scope *scope, const char *id);

// interfaces
ap_api *ap_host(ap_os *os);
// a process's (or computed node's): kept until ap_free. at: its path, names from the root
ap_api *ap_process(ap_os *os, sc_scope *scope, const char *self, const char *const *at, size_t nat);
ap_api *ap_peep(ap_api *api);
// the same, its changes carrying cause (the turn's)
ap_api *ap_as(ap_api *api, const op_value *cause);
// where a process (or computed node) is, names from the root ("/" first); NULL: not known
const char *const *ap_here(ap_os *os, const char *id, size_t *n);
// says where a process is (at: names from the root), where it shows, in place of its row's path
void ap_here_is(ap_os *os, const char *id, const char *const *at, size_t n);

// an address that starts at a node by its id, not at the root: AP_ID, the id, then names from it
// (10-12's address by id). Children and fronts go by the id; a process's row by its path, so a
// process under a node reached by id is not seen
#define AP_ID "\001id"

// reads
const ap_error *ap_look(ap_api *a, const char *const *address, size_t n, ap_items *out);
const ap_error *ap_content(ap_api *a, const char *const *address, size_t n, ap_items *out);
// names looked up from where you are, up to the root: the nearest, or every one
const ap_error *ap_lookup(ap_api *a, const char *const *path, size_t n, ap_items *out);
const ap_error *ap_lookups(ap_api *a, const char *const *path, size_t n, ap_items *out);
// the names under the node there
const ap_error *ap_names(ap_api *a, const char *const *address, size_t n, ap_namelist *out);
// its "info" (attributes) or "children" names
const ap_error *ap_names_of(ap_api *a, const char *const *address, size_t n, const char *part, ap_namelist *out);
const ap_error *ap_children(ap_api *a, const char *const *address, size_t n, const char *name, ap_items *out);
const ap_error *ap_info(ap_api *a, const char *const *address, size_t n, const char *name, ap_items *out);
// the node whole: {id, value: versions, info: {name: versions}, children: {name: [{content: [ids]}]}}
const ap_error *ap_node(ap_api *a, const char *id, op_value **out);
// the first loaded item at an address, NULL if none; its value (its first version not a status)
const ap_item *ap_first(ap_api *a, const char *const *address, size_t n);
const op_value *ap_read(ap_api *a, const char *const *address, size_t n);

// writes. *time: a number each change takes, rising
const ap_error *ap_write(ap_api *a, const char *const *address, size_t n, const op_patch *patches, size_t np,
	const long *index, int64_t *time);
const ap_error *ap_set(ap_api *a, const char *const *address, size_t n, const char *name, const op_patch *patches,
	size_t np, const long *index, int64_t *time);
const ap_error *ap_insert(ap_api *a, const char *id, const char *name, const char *child, const long *index,
	int64_t *time);
const ap_error *ap_remove(ap_api *a, const char *id, const char *name, long index, int64_t *time);
const ap_error *ap_rename(ap_api *a, const char *id, const char *name, const char *to, int64_t *time);
const ap_error *ap_move(ap_api *a, const char *id, const char *name, long index, const char *toid,
	const char *toname, const long *toindex, int64_t *time);
// a new node holding value (NULL: none): an ephemeral one, or a document; id given: that id
const ap_error *ap_create(ap_api *a, const op_value *value, const char *id, int ephemeral, const char **out);
// the whole value written at an address; a key of a map there set
const ap_error *ap_snap(ap_api *a, const char *const *address, size_t n, const op_value *value);
// a node holding value made and placed under parent (an id) as name: its id, NULL on an error said
const char *ap_put(ap_api *a, const char *parent, const char *name, const op_value *value, int ephemeral);

// live functions
op_value *ap_live(ap_api *a, ap_fn *f);
ap_fn *ap_live_fn(ap_os *os, const op_value *v);
// two values the same all the way down; live ones by what they hold
bool ap_equal(const op_value *a, const op_value *b);

// what a part does with what it is given
typedef struct {
	// where (from the part's place), and its name (NULL: a fresh id)
	const char *const *address;
	size_t naddress;
	const char *name;
	// code, or a program by path
	ap_fn *compute, *effect;
	int deep;
	const char *const *program;
	size_t nprogram;
	const op_value *data;
} ap_startop;
const ap_error *ap_start(ap_given *g, const ap_startop *op, const char **id);
const ap_error *ap_call(ap_given *g, const char *const *address, size_t n, const op_value *args, op_value **out);
const ap_error *ap_cleanup(ap_given *g, ap_fn *f);
// the host's call (an irq's records, a timer): as the machine
const ap_error *ap_call_host(ap_os *os, const char *const *address, size_t n, const op_value *args, op_value **out);
// a setup run as a process's: f called with api's given; what it gives written as the process's value
const ap_error *ap_run_setup(ap_api *api, ap_fn *f);

#endif
