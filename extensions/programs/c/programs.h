// Programs (typescript/programs.ts), in C: what runs a program, found by matching types, every way
// listed; and what opens a file. Same rules as programs.ts (its header says them once: the model, the
// attributes, candidates, chains, why), which the scenarios in extensions/programs/conformance/programs
// and open hold both to.
//
//   pg_found *f = pg_satisfy(places, "catclock.c", from, nfrom);
//   // f->refused NULL: f->program, f->chains (every one, nearest first), f->why
//   pg_opened *o = pg_open_with(places, file_id, from, nfrom);
//   pg_opened *o = pg_open_with_at(places, file_id, at, nat, from, nfrom);   // typed by its name too
//
// reads only, all through places (pl_read, pl_members_at, pl_lookup, pl_get, pl_walk_at), so all
// tracked: a computer calling either reruns when the answer may change. In a run, ask pl_status
// (places.h) after: SC_STOP means the run must end now, and what was found is then no answer.
//
// MEMORY. A result is the caller's, let go of with its _free; strings in it are copies. Out of
// memory aborts.
#ifndef PROGRAMS_H
#define PROGRAMS_H

#include <stddef.h>

#include "../../../ermine/types/c/types.h"

// the attributes read: names are placeholders, said here once
#define PG_TYPE "ermine.type"
#define PG_TAKES "ermine.programs.takes"
#define PG_GIVES "ermine.programs.gives"
#define PG_NEEDS "ermine.programs.needs"
#define PG_PROVIDES "ermine.programs.provides"
#define PG_OPENS "ermine.programs.opens"
#define PG_LOADERS "ermine.programs.loaders"
#define PG_LOADER "ermine.programs.loader"

// a node, and where it sits in the box
typedef struct {
	char *id;
	char **at;
	size_t n;
} pg_place;

typedef struct pg_step pg_step;
// compilers in order, then a runner
typedef struct {
	pg_step *steps;
	size_t n;
} pg_chain;
// a step, and how it is itself run (by: empty, the host runs it)
struct pg_step {
	pg_place place;
	pg_chain by;
};
typedef struct {
	pg_chain *items;
	size_t n;
} pg_chains;

typedef enum {
	PG_WRONG_TYPE,
	PG_UNKNOWN_TYPE,
	PG_NEEDS_UNMET,
	PG_NO_CHAIN,
	PG_NO_TYPE,
	PG_IN_THE_CHAIN,
} pg_reason;
// "wrong-type", "unknown-type", "needs", "no-chain", "no-type", "in-the-chain"
const char *pg_reason_name(pg_reason why);

// a candidate looked at and not taken: for, the node being run (or the file opened); type, the type
// looked for; missing, what a runner lacks (needs only)
typedef struct {
	pg_place place;
	char *for_;
	char *type;
	pg_reason why;
	char **missing;
	size_t nmissing;
} pg_why;
typedef struct {
	pg_why *items;
	size_t n;
} pg_whys;

// satisfy's answer. refused: NULL (found), "nothing-there" (path, at: the place looked up from), "no-type"
// (program), or "no-chain" (program, why)
typedef struct {
	const char *refused;
	pg_place program;
	char *path;
	char **at;
	size_t nat;
	pg_chains chains;
	pg_whys why;
} pg_found;

// a program and one chain running it: satisfy's program with each of its chains, alike
typedef struct {
	pg_place program;
	pg_chain chain;
} pg_way;
typedef struct {
	pg_way *items;
	size_t n;
} pg_ways;

// openWith's answer. refused: NULL, or "no-type" (id: the file)
typedef struct {
	const char *refused;
	char *id;
	pg_ways ways;
	pg_whys why;
} pg_opened;

// the program named, looked up from the place from (names from the root), and every chain running
// it, nearest first
pg_found *pg_satisfy(pl *places, const char *name, const char *const *from, size_t nfrom);
void pg_found_free(pg_found *f);

// every way to open the file, looked for from the place from, nearest first. A node's type is its
// ermine.type, else its name's (types.h): the file's, pg_open_with_at, the name it is at (nat names,
// its own last); pg_open_with has no place, so only its attribute
pg_opened *pg_open_with(pl *places, const char *file, const char *const *from, size_t nfrom);
pg_opened *pg_open_with_at(pl *places, const char *file, const char *const *at, size_t nat,
	const char *const *from, size_t nfrom);
void pg_opened_free(pg_opened *o);

// copies, for a caller keeping a piece of an answer
void pg_place_copy(pg_place *to, const pg_place *from);
void pg_place_free(pg_place *p);
void pg_chain_copy(pg_chain *to, const pg_chain *from);
void pg_chain_free(pg_chain *c);

#endif
