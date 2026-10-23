// common (common.h): what offers and run share. the software's facts as one struct (its scheduler,
// table, places, the processes it runs, the offers it holds), the structs of what it holds (an
// owner, a process run here, an offer, a load, a folder), the parts' entry points, and the small
// helpers they use. no question of its own: each part answers its own. inside software's files only.
#ifndef SW_COMMON_H
#define SW_COMMON_H
#include "software.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../filesystem/places/c/status.h"
#include "../../../ermine/encoding/c/cbor.h"
#include "../../../playground/encoding/c/hash.h"
#include "../../../playground/encoding/c/pack.h"
#include "../../../ermine/processes/c/processes.h"
#include "../../../ermine/processes/c/start.h"

#define PUSH(v, n, cap, x) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 8; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
		(v)[(n)++] = (x); \
	} while (0)

// x out of v, the rest held in order
#define DROP(v, n, x) \
	do { \
		for (size_t i_ = 0; i_ < (n); i_++) { \
			if ((v)[i_] != (x)) continue; \
			memmove(&(v)[i_], &(v)[i_ + 1], ((n) - i_ - 1) * sizeof *(v)); \
			(n)--; \
			break; \
		} \
	} while (0)

enum { R_WITHDRAWN, R_RUNNER };

// an owner's folder of one kind: its node's id and scope, the scope's info
typedef struct {
	sw_kind kind;
	char *id;
	sc_scope *scope;
	sc_pair info[2];
	op_value *values[2];
	// the owner it is in, for its name's going (a place's)
	struct sw_process *owner;
} folder;

typedef struct offer offer;

// an owner (software.ts' Owner): a place's, or a process run here (run, software.ts' Running). its
// node, its path, stored (a place's: what it offers stays when its scope goes), its scope and the
// scope its offers' folders go under (a place's: its scope); its cwd (a place's: its path's folder;
// a process's are its life's); the folders of what it offers (in the order made) and its offers (in
// the order offered, while they stand); its holds on loads (in the order made, let go at its
// scope's teardown). a process's: where it runs, the offer it runs on (NULL: a runner node offered by none
// here); under, a scope under that offer's (none: setup.scope) holding, newest first, what it
// offers, its stopper (its handle's stop the teardown, its info the process's), then its scope; the
// runner and the code as read at the run, the handle once the runner gave one (or a late one
// landed); ended: out of the lists; the reason given (told: by a stop)
struct sw_process {
	sw *sw;
	int run;
	char *id;
	char **at;
	size_t nat;
	int stored;
	sc_scope *scope;
	sc_scope *under;
	char **cwd;
	size_t ncwd;
	folder folders[3];
	size_t nfolders;
	offer **offers;
	size_t noffers, capoffers;
	sw_loaded **loads;
	size_t nloads, caploads;
	// a process's
	sc_scope *stopper;
	sc_pair under_info[1];
	op_value *under_value;
	pr_process *life;
	offer *on;
	hf_entry fn;
	op_value *code;
	hf_handle handle;
	void (*stop_reason)(void *ctx, const op_value *reason);
	int has_handle;
	sc_computer *first;
	char *failure;
	sw_late *late;
	op_value *reason;
	int ended, told;
};
typedef struct sw_process owner;

// a load, shared by its holds: its key (run.c's key_of), the code (held, so a key naming it by its
// address stays its own), its live form, its scope (what its load made goes with it) and the scope's
// info, its holds standing; gone: closed, out of the standing ones
typedef struct load {
	sw *sw;
	char *key;
	op_value *code;
	hf_live live;
	sc_scope *scope;
	sc_pair info[2];
	op_value *values[2];
	size_t holds;
	int gone;
} load;

// one owner's hold on a load; released, let go
struct sw_loaded {
	sw *sw;
	owner *by;
	load *load;
	int released;
};

// a handle that lands later: the process waiting for it, the promise its status awaits; landed
struct sw_late {
	sw *sw;
	owner *p;
	sc_promise *promise;
	int landed;
};

// an offer: what it is (id, path, kind, name, owner's id), its owner and folder, its scope (what runs
// on it under it) and the scope's info; why: the reason it is withdrawn with (NULL: "runner-stopped",
// its owner going); gone, its node torn down
struct offer {
	sw_offered facts;
	sw *sw;
	char *id;
	char **at;
	char *name;
	owner *owner;
	folder *folder;
	sc_scope *scope;
	sc_pair info[2];
	op_value *values[2];
	const op_value *why;
	int gone;
};

// what a refusal's strings are in, until the software's next call
typedef struct {
	char **names;
	size_t n;
	char *text;
} scrap;

// a stored node's live value going at a scope's teardown: its id, and the value entry written (it
// goes only if still the one there); until sw_free
typedef struct {
	sw *sw;
	char *id;
	const void *written;
} living;

struct sw {
	sw_setup s;
	// its own processes, so a write's site skips these files too
	pr *life;
	// every owner made (until sw_free); the places' standing, each once by id
	owner **all;
	size_t nall, capall;
	owner **places;
	size_t nplaces, capplaces;
	// the processes running, in start order
	owner **running;
	size_t nrunning, caprunning;
	// every offer made (until sw_free); those standing, in the order offered; sw_offers' answer
	offer **offers;
	size_t noffers, capoffers;
	offer **live;
	size_t nlive, caplive;
	const sw_offered **listing;
	size_t caplisting;
	// every hold and load made, every late handle (until sw_free); the loads standing, by key
	sw_loaded **loaded;
	size_t nloaded, caploaded;
	load **loads;
	size_t nloads, caploads;
	load **standing;
	size_t nstanding, capstanding;
	sw_late **lates;
	size_t nlates, caplates;
	// the stored nodes whose live value goes at a scope's teardown (until sw_free)
	living **lives;
	size_t nlives, caplives;
	// what sw_running and sw_offers track, marked at every offer, withdraw, run and process end
	char version;
	int freeing, queued;
	op_value *reasons[2];
	scrap *scraps;
	size_t nscraps, capscraps;
	// the site of the outside call in progress (sw_enter); NULL: none
	const ch_site *site;
	// the process whose runner's start is being called; the facts of the load being called
	owner *calling;
	const sw_starting *loading;
};

// small pieces (common.c)
void *sw_xalloc(size_t n);
char *sw_xdup(const char *s);
// a and b, a "/" between: a derived id
char *sw_joined(const char *a, const char *b);
int sw_is_str(const op_value *v);
int sw_is_map(const op_value *v);
const op_value *sw_get(const op_value *map, const char *key);
char **sw_copy_names(const char *const *names, size_t n);
char **sw_names_and(const char *const *names, size_t n, const char *a, const char *b, size_t *out);
op_value *sw_names_value(const char *const *names, size_t n);
// a refusal's strings, until the software's next call
void sw_forget(sw *s);
const char *const *sw_keep_names(sw *s, char **names, size_t n);
const char *sw_keep_text(sw *s, const char *text);
const char *sw_keep_owned(sw *s, char *text);
void sw_later(sw *s);
void sw_changed(sw *s);
// a one-shot effect's run: true, so it acts once
sc_out sw_once_f(void *previous, void *data);
// give: the node's entries go with the scope (sn_give); 0: a stored node's, kept
sc_scope *sw_scope_of(sw *s, sc_pair *info, op_value **values, const char *key, const char *what,
	const char *id, sc_scope *parent, int give);
// a stored node's live value (just written) gone at the scope's teardown if still the one there,
// its other parts left
void sw_live_until(sw *s, sc_scope *scope, const char *id);

// writes, with a scope open
enum { W_UPSERT, W_ADD, W_SUB, W_UNPLACE };

// one write: an upsert at path in (part, id); an entry added at (part, id), or put in place of what
// was there; name out of id's children. code: 0, places' code, -1 (no scope open)
typedef struct {
	sw *s;
	int what;
	const char *part, *id, *name;
	const char *const *path;
	size_t n;
	const op_value *value;
	int code;
} writing;

void sw_write_now(void *data);
// the write with o open (NULL, or o torn down: with what is open)
int sw_write_in(sw *s, sc_scope *o, writing w);

// sites: every outside call into software (an _at function) holds its caller's site for its length,
// an inner call's over an outer's. sw_enter gives the one before, for sw_leave
const ch_site *sw_enter(sw *s, const ch_site *site);
void sw_leave(sw *s, const ch_site *was);
// a write's site: the outside call's in progress; none (a teardown from above, a pulse): the
// nearest noted (setup.sites) up the run open's computer, else up the scope open; else NULL. buf:
// room for one
const ch_site *sw_site(sw *s, ch_site *buf);
// a row's going with no stop's caller (processes' setup.site): sw_site
const ch_site *sw_site_of(void *software, ch_site *buf);
// a hold let go, out of its holder's list; the last on its load: the load's scope torn down (run.c's
// unload closes it); twice: nothing
void sw_drop(sw_loaded *l);
// an owner just made (a process's: in its body): at its scope's teardown every hold it has let
// go, newest first. registered then, so after what is registered later (its program's
// teardowns), before processes' own
void sw_holder(sw *s, owner *o);

// the owner of what by offers and loads (software.c): a process run here, its own; any other place,
// one made the first time, gone with its scope. NULL: by's scope gone
owner *sw_owner_of(sw *s, const sw_place *by);
// the standing offer at an id (offers.c); NULL: none
offer *sw_live_offer(const sw *s, const char *id);
// the kinds' names, by sw_kind
extern const char *const sw_kinds[3];

#endif
