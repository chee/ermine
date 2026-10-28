// types (typescript/types.ts) in C: UTIs as nodes in the graph. same rules as types.ts (typeOf
// says them), held to by the scenarios in playground/programs/conformance/programs.
//
//   ty_install(&(ty_install_setup){ .places = p, .table = t, .root = tb_string("R"), ... });
//   ty_folder f;  ty_at(p, from, n, &f);                       // the nearest ermine/types
//   ty_conformance c = ty_conform(p, &f, "public.c-source");   // { known, all: [itself, ...] }
//   char *t = ty_type_of(p, id, at, n, NULL);                  // the type of a node at a place
//   ty_conforms_to(p, &f, TY_JPEG, TY_IMAGE)                   // swift's UTType, below
//
// the well-known list: typescript/utis.json, gathered from what macs declare (mac/gather.ts). utis.c
// and constants.h are generated from it, types.ts' EXTRA and typescript/constants.json by utis.ts;
// never edit them by hand.
// memory: what a read gives is the caller's (ty_folder_free, ty_conformance_free). out of memory
// aborts.
#ifndef TYPES_H
#define TYPES_H

#include <stdbool.h>
#include <stddef.h>

#include "../../../core/places/c/places.h"
#include "constants.h"

// a type as the lists give it: each list NULL-terminated, or NULL: none. its node's value: {
// conformsTo, filenameExtension (no "."), mimeType, referenceURL, version }
typedef struct {
	const char *identifier;
	const char *const *conforms;
	const char *const *extensions;
	const char *const *mimes;
	// NULL: none
	const char *reference_url;
	const long long *version;
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

// the extensions the types in a folder claim: each lowercase, no ".", and the type claiming it,
// in the folder's order, the first claim kept
typedef struct {
	char *ext;
	char *uti;
} ty_claim;
typedef struct {
	ty_claim *items;
	size_t n, cap;
} ty_extensions;
// folder NULL: none. Reads each type's filenameExtension, the folder's members
ty_extensions ty_extensions_of(pl *p, const ty_folder *folder);
void ty_extensions_free(ty_extensions *e);

// the type a name's extension gives: the longest end after a ".", with a name before the ".", that is
// claimed; borrowed from e. NULL: none
const char *ty_by_name(const ty_extensions *e, const char *name);

// the attribute a node's own type is in
#define TY_ATTRIBUTE "ermine.type"

// the type of the node id at the place at (n names, the name last): its ermine.type if a string, else
// its name's, with the extensions given (e: as a search holds them) or those of the nearest
// ermine/types from the placement's folder (e NULL). A copy, the caller's to free. NULL: none
char *ty_type_of(pl *p, const char *id, const char *const *at, size_t n, const ty_extensions *e);

// swift's UTType, each read through places from a types folder (ty_at; NULL: nothing declared), so a
// computer asking reruns when what it asked changes. a type is its identifier. what a char * gives
// is a copy, the caller's to free; NULL: none
//
//   ty_preferred_mime_type(p, &f, TY_JPEG)                       "image/jpeg"
//   ty_from_filename_extension(p, &f, "jpg", NULL)               "public.jpeg"
//   ty_conforms_to(p, &f, TY_JPEG, TY_IMAGE)                     true

// isDeclared: the type has a node in the folder. isDynamic: its identifier starts "dyn.";
// isPublic: "public."
bool ty_is_declared(pl *p, const ty_folder *folder, const char *type);
bool ty_is_dynamic(const char *type);
bool ty_is_public(const char *type);

// the first of its filenameExtension and its mimeType; its referenceURL
char *ty_preferred_filename_extension(pl *p, const ty_folder *folder, const char *type);
char *ty_preferred_mime_type(pl *p, const ty_folder *folder, const char *type);
char *ty_reference_url(pl *p, const ty_folder *folder, const char *type);
// its version: 1 and *out, or 0: none
int ty_version(pl *p, const ty_folder *folder, const char *type, long long *out);

// every type it conforms to, not itself, in the order met (ty_conform's, less the first); known
// as ty_conform's. ty_conformance_free
ty_conformance ty_supertypes(pl *p, const ty_folder *folder, const char *type);
// conforms(to:): it is to, or to is one of its supertypes
bool ty_conforms_to(pl *p, const ty_folder *folder, const char *type, const char *to);
// isSubtype(of:): conforms, and is not it. isSupertype(of:): of is a subtype of it
bool ty_is_subtype_of(pl *p, const ty_folder *folder, const char *type, const char *of);
bool ty_is_supertype_of(pl *p, const ty_folder *folder, const char *type, const char *of);

// UTType(filenameExtension:conformingTo:), UTType(mimeType:conformingTo:): the first type in the
// folder's order claiming the tag (any case; an extension with no ".") that conforms to
// conforming_to (NULL: TY_DATA, as swift's). NULL: none (where swift would make a dynamic type)
char *ty_from_filename_extension(pl *p, const ty_folder *folder, const char *extension,
	const char *conforming_to);
char *ty_from_mime_type(pl *p, const ty_folder *folder, const char *mime_type, const char *conforming_to);

#endif
