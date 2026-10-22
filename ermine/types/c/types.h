// types (typescript/types.ts) in C: UTIs as nodes in the graph. same rules as types.ts (typeOf
// says them), held to by the scenarios in playground/programs/conformance/programs.
//
//   ty_install(&(ty_install_setup){ .places = p, .table = t, .root = tb_string("R"), ... });
//   ty_folder f;  ty_at(p, from, n, &f);                       // the nearest ermine/types
//   ty_conformance c = ty_conform(p, &f, "public.c-source");   // { known, all: [itself, ...] }
//   char *t = ty_type_of(p, id, at, n, NULL);                  // the type of a node at a place
//
// the well-known list: Markus Felten's (arlac77) uti library (npm uti@8.11.3), with thanks, 0BSD
// (typescript/utis.LICENSE). utis.c is generated from typescript/utis.json and types.ts' EXTRA by
// utis.ts; never edit it by hand.
// memory: what a read gives is the caller's (ty_folder_free, ty_conformance_free). out of memory
// aborts.
#ifndef TYPES_H
#define TYPES_H

#include <stdbool.h>
#include <stddef.h>

#include "../../../filesystem/places/c/places.h"

// a type as the lists give it: each field a NULL-terminated list of strings, or NULL: none
typedef struct {
	const char *name;
	const char *const *conforms;
	const char *const *extensions;
	const char *const *mimes;
} ty_known;

// the well-known list, and the types it lacks that the scenarios need (types.ts' EXTRA)
extern const ty_known ty_well_known[];
extern const size_t ty_well_known_count;
extern const ty_known ty_extra[];
extern const size_t ty_extra_count;

// the types folder's path from a root: the one place it is said
#define TY_DEPTH 2
extern const char *const ty_path[TY_DEPTH];

// ids made, kept alive for the table (ty_ids_free once the table is gone)
typedef struct {
	char **items;
	size_t n, cap;
} ty_ids;
void ty_ids_free(ty_ids *ids);

typedef struct {
	pl *places;
	tb_table *table;
	// where ermine/types is made
	tb_key root;
	// the list (none, NULL: the well-known one and EXTRA); a type twice: the last wins
	const ty_known *list;
	size_t n;
	// new nodes' ids: malloc'd, from their path from root (NULL: "type:<random>")
	char *(*id)(void *ctx, const char *const *path, size_t n);
	void *ctx;
	// told each write's changed entries, as it lands (commit them: to every places, every box)
	void (*commit)(void *ctx, const pl_changed *changed);
	void *commit_ctx;
	// every id made is added here
	ty_ids *ids;
} ty_install_setup;

// the types installed at ermine/types under root: the folders on the way made where missing, a
// type's node made where missing, its value written where there and different, the names put in the
// folder last. Needs a scope open (the writes' who). 0, or -1: no scope open
int ty_install(const ty_install_setup *setup);

// the types folder seen from a place: ermine/types looked up from it, nearest first. 1 and *out (the
// caller's, ty_folder_free); none: 0
typedef struct {
	char *id;
	char **path;
	size_t n;
} ty_folder;
int ty_at(pl *p, const char *const *from, size_t nfrom, ty_folder *out);
void ty_folder_free(ty_folder *f);

// what a type conforms to, itself first, each once, in the order met (breadth first). known: whether
// the type itself has a node in the folder (folder NULL: none, so only itself)
typedef struct {
	bool known;
	char **all;
	size_t n;
} ty_conformance;
ty_conformance ty_conform(pl *p, const ty_folder *folder, const char *uti);
void ty_conformance_free(ty_conformance *c);

// the extensions the types in a folder claim: each lowercase with its ".", and the type claiming it,
// in the folder's order, the first claim kept
typedef struct {
	char *ext;
	char *uti;
} ty_claim;
typedef struct {
	ty_claim *items;
	size_t n, cap;
} ty_extensions;
// folder NULL: none. Reads each type's fileNameExtension, the folder's members
ty_extensions ty_extensions_of(pl *p, const ty_folder *folder);
void ty_extensions_free(ty_extensions *e);

// the type a name's extension gives: the longest end from a ".", with a name before it, that is
// claimed; borrowed from e. NULL: none
const char *ty_by_name(const ty_extensions *e, const char *name);

// the attribute a node's own type is in
#define TY_ATTRIBUTE "ermine.type"

// the type of the node id at the place at (n names, the name last): its ermine.type if a string, else
// its name's, with the extensions given (e: as a search holds them) or those of the nearest
// ermine/types from the placement's folder (e NULL). A copy, the caller's to free. NULL: none
char *ty_type_of(pl *p, const char *id, const char *const *at, size_t n, const ty_extensions *e);

#endif
