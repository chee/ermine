// The disk of the store's and the program's harnesses (store_harness.c, program_harness.c), in C: disk_harness.ts's. A temp folder of
// the run's own, the edits made on it between requests, and what it shows when looked at. A harness makes the edits and the
// snapshots itself, the same for every implementation, as a person's Finder would: never through the store. Nothing here is
// the store's or the program's rule. disk_harness.ts has the edits and what a snapshot shows; this is the same, in the same order.
//
// The temp folder (under $TMPDIR, else /tmp) holds Store (the store's folder), Trash (the fake Trash, made by the store or an
// edit), Home (a test home, there from the start), Outside (made by an edit when needed) and scratch (where a write is made
// before it is renamed in). A path in an edit or a request is from the store's folder ("" is the folder itself), or, written
// "@path", from the temp folder ("@" is the temp folder itself).
//
// What a run shows of what is not the same each run: the temp folder in a path is "@", and each label's kind by the order met:
// DISK_UUIDS "uuid", "uuid2", ...; DISK_IDS "id1", "id2", ... (the ids a harness mints: "i" and a number, not touching
// [A-Za-z0-9_-]). The order met is the order the snapshots and deep take their strings in.
//
// Memory: a Json given is borrowed unless it says it is taken; a Json returned is the caller's (jsonFree it).
#ifndef DISK_HARNESS_H
#define DISK_HARNESS_H

#include "../../../../ermine/encoding/c/json.h"

#include <stddef.h>

typedef enum { DISK_UUIDS, DISK_IDS } DiskKind;

typedef struct {
	char *dir; // the temp folder, realpath'd
	char *store, *trash, *home, *outside, *scratch;
	DiskKind kind;
	char **raws; // the raw text of each label met, in order; its label is the nth
	char **labels;
	size_t count, capacity;
} Disk;

// a new temp folder (prefix, then six random characters), with Home and scratch in it; NULL if it cannot be made
Disk *disk_make(const char *prefix, DiskKind kind);
// removes the temp folder and all in it
void disk_free(Disk *d);

// a path of a scenario: "@x" is x in the temp folder, "" is folder, the rest from folder; fresh
char *disk_path(const Disk *d, const char *p, const char *folder);
// a label's raw text, for a request; what is not a label as it is (owned by d, or p itself)
const char *disk_raw(const Disk *d, const char *label);
// every string in a Json value as text, in place (object keys are not touched); v is fresh, not shared
void disk_deep(Disk *d, Json *v);

// an edit (the request's "edit" and its fields), its plain paths from folder: 0, or -1 with a message in why
int disk_edit(Disk *d, const Json *request, const char *folder, char *why, size_t size);

// the store's snapshot of folder (the one shown), the Trash and what was listed: {folder, trash, listed, at?}. look is the
// request ({attrs?, at?}); listed is taken (shown already); NULL with a message in why if a file it reads is not what it holds
Json *disk_store_snapshot(Disk *d, const char *folder, Json *listed, const Json *look, char *why, size_t size);
// the program's snapshot of the store's folder, the Trash and what was listed: {folder, trash, listed}; listed is taken; the
// ids of the folder and the Trash are labelled, in that order
Json *disk_program_snapshot(Disk *d, Json *listed);

#endif
