// common (common.h): what every part of a den shares. the den's facts as one struct (its scheduler,
// table, places, the processes it runs, the offers it makes, whether it is closed), the structs of
// what it holds (a process, an offer, a load, a folder), and the small helpers all of them use. no
// question of its own: each part answers its own. inside the den's files only.
#ifndef DN_COMMON_H
#define DN_COMMON_H
#include "dens.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../filesystem/places/c/status.h"
#include "../../../ermine/encoding/c/cbor.h"
#include "../../../ermine/encoding/c/hash.h"
#include "../../../ermine/encoding/c/pack.h"
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

enum { R_WITHDRAWN, R_RUNNER, R_DEN };

// an owner's folder of one kind: its node's id and scope, the scope's info
typedef struct {
	dn_kind kind;
	char *id;
	sc_scope *scope;
	sc_pair info[2];
	op_value *values[2];
} folder;

typedef struct offer offer;

// a process this den started, or the den's own (self): its node, its path, its scope and life, the
// scope its offers' folders go under (self: its scope); the folders of what it offers (in the order
// made) and its offers (in the order offered, while they stand); the loads it holds (in the order
// made, let go at its scope's teardown). a started one's: where it runs, the offer it runs on (NULL:
// a runner node of no offer of this den's); under, a scope under that offer's (none: the owner)
// holding, newest first, what it offers, its stopper (its handle's stop the teardown, its info the
// process's), then its scope; the runner and the code as read at start, the handle once the runner
// gave one; ended: out of the lists; the reason given (told: by a stop)
struct dn_process {
	dn *den;
	int self;
	char *id;
	char **at;
	size_t nat;
	sc_scope *scope;
	sc_scope *under;
	sc_scope *stopper;
	sc_pair under_info[1];
	op_value *under_value;
	pr_process *life;
	folder folders[3];
	size_t nfolders;
	offer **offers;
	size_t noffers, capoffers;
	pl *where;
	offer *on;
	hf_entry fn;
	op_value *code;
	hf_handle handle;
	void (*stop_reason)(void *ctx, const op_value *reason);
	int has_handle;
	sc_computer *first;
	char *failure;
	op_value *reason;
	int ended, told;
	dn_loaded **loads;
	size_t nloads, caploads;
};

// a load: its live form, the process (or the den's own) holding it; released, closed
struct dn_loaded {
	dn *den;
	dn_process *by;
	hf_live live;
	int released;
};

// an offer: its node (id, path), its owner and folder, its scope (what runs on it under it) and the
// scope's info; why: the reason it is withdrawn with (NULL: "runner-stopped", its owner going); gone,
// its node torn down
struct offer {
	dn *den;
	char *id;
	char **at;
	size_t nat;
	dn_kind kind;
	char *name;
	dn_process *owner;
	folder *folder;
	sc_scope *scope;
	sc_pair info[2];
	op_value *values[2];
	const op_value *why;
	int gone;
};

// what a refusal's strings are in, until the den's next call
typedef struct {
	char **names;
	size_t n;
	char *text;
} scrap;

// a node's part going at a scope's teardown: its id, and the value entry written (it goes only if
// still the one there), or all: every part goes; until dn_free
typedef struct {
	dn *den;
	char *id;
	const void *written;
	int all;
} living;

struct dn {
	dn_setup s;
	char *id, *name;
	op_value *device;
	// the owner: [["den", id]], under the scope open at dn_new
	sc_scope *owner;
	sc_pair owner_info;
	op_value *owner_value;
	pr *life;
	dn_process *self;
	// on: the folder's and its methods' ids (start, stop), scopes, info
	char *on_ids[3];
	sc_scope *on_scopes[3];
	sc_pair on_info[3][2];
	op_value *on_values[3][2];
	// every process made (until dn_free); those running, in start order (dn_close tears them down
	// newest first)
	dn_process **all;
	size_t nall, capall;
	dn_process **running;
	size_t nrunning, caprunning;
	// every offer made (until dn_free); those standing
	offer **offers;
	size_t noffers, capoffers;
	offer **live;
	size_t nlive, caplive;
	// every load made (until dn_free)
	dn_loaded **loaded;
	size_t nloaded, caploaded;
	// the stored nodes whose live value goes at a scope's teardown (until dn_free)
	living **lives;
	size_t nlives, caplives;
	// the asks answered this session (their answer may not have landed yet), by id
	char **answered;
	size_t nanswered, capanswered;
	// what dn_nodes tracks, marked at every offer, withdraw, start and process end
	char version;
	// the den's node is an install's: kept across sessions (else all of it goes with the session)
	int stored;
	// the node's own scope when it is not (given: its entries go with it)
	sc_scope *node_scope;
	sc_pair node_info[2];
	op_value *node_values[2];
	// here_placed: the leaves put in, 1 /system/dens/<name>, 2 /system/den
	int closed, here_placed, here_failed, freeing, queued;
	// the reason the den's own process goes with: dn_close's, else "den-stopped"
	op_value *pending;
	op_value *reasons[3];
	op_value *scratch;
	scrap *scraps;
	size_t nscraps, capscraps;
	// the site of the outside call in progress (dn_enter); NULL: none
	const ch_site *site;
};

// small pieces (common.c)
void *dn_xalloc(size_t n);
char *dn_xdup(const char *s);
// a and b, a "/" between: a derived id
char *dn_joined(const char *a, const char *b);
int dn_is_str(const op_value *v);
int dn_is_map(const op_value *v);
const op_value *dn_get(const op_value *map, const char *key);
const char *dn_str_at(const op_value *map, const char *key);
char **dn_copy_names(const char *const *names, size_t n);
char **dn_names_and(const char *const *names, size_t n, const char *a, const char *b, size_t *out);
op_value *dn_names_value(const char *const *names, size_t n);
// a refusal's strings, until the den's next call
void dn_forget(dn *d);
const char *const *dn_keep_names(dn *d, char **names, size_t n);
const char *dn_keep_text(dn *d, const char *s);
const char *dn_keep_owned(dn *d, char *s);
void dn_later(dn *d);
void dn_changed(dn *d);
// a one-shot effect's run: true, so it acts once
sc_out dn_once_f(void *previous, void *data);
// give: the node's entries go with the scope (sn_give); 0: a stored node's, kept
sc_scope *dn_scope_of(dn *d, sc_pair *info, op_value **values, const char *key, const char *what,
	const char *id, sc_scope *parent, int give);
// a stored node's live value (its function, just written) gone at the scope's teardown if still the
// one there, its other parts left
void dn_live_until(dn *d, sc_scope *scope, const char *id);
// every part at the id gone at the scope's teardown
void dn_forget_at(dn *d, sc_scope *scope, const char *id);

// writes, with a scope open
enum { W_UPSERT, W_ADD, W_SUB, W_UNPLACE, W_HERE, W_UNHERE };

// one write: an upsert at path in (part, id); an entry added at (part, id), or put in place of what
// was there; name out of id's children; the den (id) at path in the process part, or out of it.
// code: 0, places' code, -1 (no scope open)
typedef struct {
	dn *d;
	int what;
	const char *part, *id, *name;
	const char *const *path;
	size_t n;
	const op_value *value;
	int code;
} writing;


void dn_write_now(void *data);
int dn_write_in(dn *d, sc_scope *o, writing w);

// sites: every outside call into a den (an _at function) holds its caller's site for its length,
// an inner call's over an outer's. dn_enter gives the one before, for dn_leave
const ch_site *dn_enter(dn *d, const ch_site *site);
void dn_leave(dn *d, const ch_site *was);
// a write's site: the outside call's in progress; none (a teardown from above, a pulse): the
// nearest noted (setup.sites) up the run open's computer, else up the scope open; else NULL. buf:
// room for one
const ch_site *dn_site(dn *d, ch_site *buf);
// a row's going with no stop's caller (processes' setup.site): dn_site
const ch_site *dn_site_of(void *den, ch_site *buf);
// a load closed, out of its holder's list; twice: nothing
void dn_drop(dn_loaded *l);
// an owner just made, in its process's body: at its scope's teardown every load it holds closed,
// newest first. registered then, so after what is registered later (its program's teardowns),
// before processes' own
void dn_holder(dn *d, dn_process *o);

#endif
