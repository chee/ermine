// The files program (FILES.tex, The files program), in C. Same rules as program.ts, whose header has them: a process
// that takes the edits people and tools make in a store's folder in as changes. The host starts it with its code,
// fp_code: its value says which folder it watches; its effect places its handler edit and an ephemeral node listed
// beneath its process node, and starts the watcher; its cleanup stops the watcher and unplaces edit. A store has one:
// a second's run fails, naming the store already watched.
//
// edit is called through the scheduler as any handler is, by sc_call at [name, "edit"]. A handler is given what the
// scheduler has: no value, so the differences are given to the program before the call (fp_give), and what edit
// answers, the disk work for the watcher, is taken after it (fp_taken). Each difference is made into changes on its own,
// so one refused does not stop the others; a program acts on a node by its id. What edit sets in the store's layout
// (st_layout) is the layout as the disk now is: do not st_release between the call and the write after it.
//
// Strings in what is given and taken are held in layout.h's arena, till st_release.
#ifndef PROGRAM_H
#define PROGRAM_H

#include "../../../ermine/encoding/c/json.h"
#include "graph.h"
#include "store.h"

#include <stdbool.h>
#include <stddef.h>

// a difference, and for a new folder the differences of what is in it, all the way down
typedef struct fp_edit fp_edit;
struct fp_edit {
	const char *path;
	const Laid *was;
	const st_entry *now;
	bool has_inside;
	const fp_edit *inside;
	size_t inside_length;
};

typedef struct {
	const char *path, *id;
} fp_mark;
typedef struct {
	const char *path, *holder, *slot;
} fp_slot;
typedef struct {
	const char *path, *why;
} fp_listed;

// what edit answers: what the watcher does on disk once the changes are made
typedef struct {
	// entries taken in as a node's: the id set in party.chee.ermine.id
	fp_mark *marks;
	size_t marks_length;
	// unions' folders renamed: the holder and slot set in party.chee.ermine.slot
	fp_slot *slots;
	size_t slots_length;
	// copies of a side, taken in as new nodes: party.chee.ermine.side removed
	const char **unside;
	size_t unside_length;
	// entries removed, so the store lays its own in their place: a person's link, a file saved through a link, an alias
	const char **clear;
	size_t clear_length;
	// entries sent to the Trash, with why
	fp_listed *trash;
	size_t trash_length;
	// paths laid out again as the graph has them, after the rest
	const char **mend;
	size_t mend_length;
	// everything not taken in or sent to the Trash, with why
	fp_listed *listed;
	size_t listed_length;
} fp_done;

// the host's watcher on the store's folder: started and stopped by fp_start and fp_stop
typedef struct {
	void (*start)(void *context);
	void (*stop)(void *context);
	void *context;
} fp_watch;

typedef struct fp fp;

// the program for a store on a graph; the store, the graph and the watch outlive it. Not started
fp *fp_new(st_store *store, fg *graph, fp_watch watch);
// the watch, when it could not be given at fp_new (the watcher is made with the program)
void fp_set_watch(fp *program, fp_watch watch);
// stops it, and frees it
void fp_free(fp *program);
// starts the watcher: NULL, or why it could not (the store is already watched). Starting a started program is nothing
const char *fp_start(fp *program);
// stops the watcher, and lets the store go: another program may then watch it
void fp_stop(fp *program);
// the id of the node it lists on, a list of {path, why}; NULL until started
const char *fp_listing(const fp *program);

// takes the differences in as changes by the actor (NULL: none); what it answers, or NULL when it failed outright
// (fp_message says why)
const fp_done *fp_edit_in(fp *program, const fp_edit *edits, size_t count, const char *actor);
// the message of the last call that failed
const char *fp_message(const fp *program);

#endif
