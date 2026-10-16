// What a store asks of macOS's Foundation (FILES.tex, Building it), in C: foundation.ts's. Through the Objective-C runtime,
// libobjc's objc_getClass, sel_registerName and objc_msgSend, found with dlopen and dlsym, so nothing is linked. Four
// things, each a no-op or nothing off macOS:
//
//   coordinate  runs a function under NSFileCoordinator, so an app with the file open, as TextEdit or Preview, is told
//               before it changes
//   bookmark    an NSURL bookmark of a path, which follows it when it moves; resolve leads one back to a path
//   ubiquitous  whether macOS says a path is in iCloud (NSURLIsUbiquitousItemKey)
//   alias       the path a Finder alias file leads to
//
// Every call is made on the calling thread, each in an autorelease pool of its own. coordinate gives the coordinator a
// block built by hand, a global block (_NSConcreteGlobalBlock) that holds no state: the function and its context are
// kept in the call. NSFileCoordinator runs its accessor synchronously before the method returns.
#ifndef FOUNDATION_H
#define FOUNDATION_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// NSFileCoordinatorWritingOptions
#define FD_DELETING 1u
#define FD_MOVING 2u
#define FD_MERGING 4u
#define FD_REPLACING 8u

typedef struct {
	// runs fn(context) once, and gives what it gives, under NSFileCoordinator for the item at path, writing or reading;
	// options are the coordinator's
	int (*coordinate)(const char *path, bool writing, unsigned options, int (*fn)(void *), void *context);
	// a bookmark of the item at path (*data malloc'd); false where there are none, or the path is not there
	bool (*bookmark)(const char *path, uint8_t **data, size_t *length);
	// the path a bookmark leads to now, without asking a person or mounting anything (malloc'd); NULL if it leads nowhere
	char *(*resolve)(const uint8_t *data, size_t length);
	// whether macOS says the item is in iCloud: a path that is not there is not
	bool (*ubiquitous)(const char *path);
	// the path a Finder alias file leads to (malloc'd); NULL for anything else
	char *(*alias)(const char *path);
} fd_foundation;

// sends the item at path to the person's Trash by NSFileManager's trashItemAtURL (Put Back may not work; Finder's own
// delete, which sys.c tries first, is better): false where it cannot, and off macOS
bool fd_trash(const char *path);

// the platform's: macOS's, or off macOS calls that do nothing
extern const fd_foundation fd_system;
// no folder is in iCloud, there are no bookmarks, a coordinated write is just made: what a test gives
extern const fd_foundation fd_plain;

#endif
