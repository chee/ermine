// The watcher (FILES.tex, From edits to changes), in C. Same rules as watch.ts, whose header has them: host code that
// watches a store's folder and makes each pass one call of the files program's edit. Events are only hints: once
// the folder has had none for 100 ms, or what the host sets, a pass compares each folder touched since the last pass with
// the layout, and calls edit with the differences, as the computer's user, with no person. The first pass, and a pass
// after the system dropped events, compares every folder. After the call, what edit answered is done on disk: ids set,
// entries removed or sent to the Trash, paths laid out again. Then the host saves the graph, as after any change.
//
// Events are FSEvents on macOS and inotify on Linux, noted by a thread of their own; a pass runs only on the host's thread,
// when it calls fw_poll (the scheduler and the store take one caller at a time, so no lock is taken). A test calls
// fw_pass itself and starts no events.
#ifndef WATCH_H
#define WATCH_H

#include "program.h"

#include <stdbool.h>
#include <stddef.h>

typedef struct fw fw;

typedef struct {
	st_store *store;
	fp *program;
	// ms with no event before a pass; 0: 100
	unsigned quiet;
	// who the calls are by; NULL: $USER
	const char *actor;
	// saves the graph into the store after a pass that called edit: 0, or nonzero for a failure
	int (*save)(void *context);
	// the host's: where a Finder alias leads (an absolute path, malloc'd), NULL for any other file
	char *(*alias)(void *context, const char *path);
	// told of what the watcher could not do
	void (*list)(void *context, const char *path, const char *why);
	void *context;
	// watch the folder with the system's events; false: a test runs its passes itself
	bool events;
} fw_options;

fw *fw_new(const fw_options *options);
void fw_free(fw *watcher);
// what the program's start and stop start and stop it with
fp_watch fw_watch(fw *watcher);
// runs a pass now: over the folders touched (none given: every folder). *called: edit was called
void fw_pass(fw *watcher, const char *const *touched, size_t count, bool *called);
// runs a pass if events have come and 100 ms have gone by since the last; true if it ran. *called as fw_pass's
bool fw_poll(fw *watcher, bool *called);

#endif
