// Where a store's manifest is (FILES.tex, The manifest), in C: external.ts's. It is .ermine in the store's folder, unless a
// service that syncs files watches the folder (iCloud Drive, which macOS says of a folder; anything under
// ~/Library/CloudStorage; any place the host names, on the home folder's volume). Then it is ~/.ermine/external/<uuid>/,
// <uuid> the store's own, which the folder carries in an attribute.
//
// ~/.ermine/external/stores is a CBOR map from each uuid to {path, bookmark}: the folder's last path, and on macOS a
// bookmark of it. A folder found carrying a uuid whose bookmark leads to another live folder is a copy: a uuid of its
// own and an empty manifest. A folder with a uuid and no manifest here is a new store. A folder that came into a synced
// place, or left one, has its .ermine moved out or in.
//
// Every call gives 0, or -1 with errno; what it gives back is malloc'd.
#ifndef EXTERNAL_H
#define EXTERNAL_H

#include "foundation.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// where a host's home is, how to ask Foundation, and the places it names
typedef struct {
	// the home folder; NULL: $HOME, and without one nothing is outside and no store is listed
	const char *home;
	// NULL: fd_system
	const fd_foundation *foundation;
	// places whose folders have their manifests outside
	const char *const *places;
	size_t places_length;
} ex_where;

// a store, as the list has it
typedef struct {
	char *uuid, *path;
	uint8_t *bookmark; // NULL: none
	size_t bookmark_length;
} ex_stored;

// where a store's manifest is, and what loading must do about it
typedef struct {
	char *dir;  // the manifest's folder, absolute
	char *uuid; // the store's uuid, new or as the folder carries it
	bool set;   // the folder must be given the uuid: it carried none, or a copy's
	bool copy;  // the folder is a copy: its own manifest, if inside, is not its own
} ex_located;

// the stores a host has
int ex_stores(const ex_where *where, ex_stored **out, size_t *count);
void ex_stores_free(ex_stored *list, size_t count);
// where a store is now: its bookmark's path while that is a folder that is there, else its last path; NULL if it leads
// nowhere. A folder in the Trash is not found
char *ex_find(const char *uuid, const ex_where *where);
// records where a store is, if that is not what the list has
int ex_note(const char *uuid, const char *folder, const ex_where *where);
// finds a store's manifest, moving it when its folder came into a synced place or left one, as the store's folder says
int ex_locate(const char *folder, const ex_where *where, ex_located *out);

#endif
