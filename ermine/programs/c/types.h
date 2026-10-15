// Types (typescript/types.ts), in C: UTIs as nodes in the graph. Same rules as types.ts, which the
// scenarios in ermine/programs/conformance/ hold both to.
//
//   ty_install(&(ty_install_setup){ .places = p, .table = t, .root = tb_string("R"), ... });
//   ty_folder f;  ty_at(p, from, n, &f);                       // the nearest ermine/types
//   ty_conformance c = ty_conform(p, &f, "public.c-source");   // { known, all: [itself, ...] }
//
// A type is a node named by its UTI in the types folder, its value { conformsTo, fileNameExtension,
// mimeType }, each a list. Conformance: a type, then what its conformsTo names, and theirs, each
// once, in the order met (a UTI conforms to itself). The folder: ermine/types looked up from where
// the search is, nearest first (pl_lookup), the nearest only: a type not in it is unknown. Every
// read through places, so tracked.
//
// THE WELL-KNOWN LIST is Markus Felten's (arlac77), from his uti library (npm uti@8.11.3), with
// thanks, 0BSD (typescript/well-known-utis.LICENSE). utis.c is GENERATED from
// typescript/well-known-utis.mjs and types.ts' EXTRA by utis.ts; never edited by hand.
//
// MEMORY. What a read gives is the caller's (ty_folder_free, ty_conformance_free). Out of memory
// aborts.
#ifndef PROGRAMS_TYPES_H
#define PROGRAMS_TYPES_H

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

// a type's node's value, { conformsTo, fileNameExtension, mimeType }: new
op_value *ty_value(const ty_known *t);

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

#endif
