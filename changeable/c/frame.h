// a frame (changeable/typescript/changeable.ts's Frame), in C: what a change was made in (a
// process, a run, a call, a step), as info (key/value pairs, an object) and the frame it is under.
// plain data a change points at, shared, never copied: a reference held (ch_frame_ref), let go
// (ch_frame_free). a frame holds its parent, so a header that holds a frame holds the chain up to
// where it began. its info never changes once made.
//
// memory: ch_frame_make copies the pair keys (op_name) and takes a hold (op_ref) of each value,
// which are op_values: what the caller gives may go as soon as it has made the frame. the parent
// is held (ch_frame_ref'd) too, by the one frame made on it. out of memory aborts.
//
// where in code: a location comes from compile time (CH_HERE: __FILE__, __LINE__), never a stack.
// at the outside edge (no run open, no frame up the chain holding locations) a write's frame is
// one of its own whose info holds the one location, external true (ch_frame_at)
#ifndef CH_FRAME_H
#define CH_FRAME_H

// the key of the pair naming a scope's node (its value: the id, an op_value string): Info's node
// (changeable.ts). the one spelling: use this, never the string
#define CH_NODE "node"

#include <stddef.h>

#include "value.h"

// one of a frame's info: a key and its value, an op_value
typedef struct {
	const char *key;
	const void *value;
} ch_pair;

typedef struct ch_frame ch_frame;
struct ch_frame {
	size_t refs;
	// the frame it is under; NULL: the top
	ch_frame *parent;
	// its info: n pairs, keys unique, in the order given; no meaning in the order
	ch_pair *pairs;
	size_t n;
};

// a frame of its own: info n pairs, under parent (held; NULL: none). refs 1: the caller's, to
// ch_frame_free. n may be 0: a frame that says nothing
ch_frame *ch_frame_make(const ch_pair *pairs, size_t n, ch_frame *parent);
// one hold more on f (NULL: NULL), and one let go (NULL: nothing); the last frees f and lets go of
// its parent and its values
ch_frame *ch_frame_ref(ch_frame *f);
void ch_frame_free(ch_frame *f);
// the value at key in f's own info; NULL: none
const void *ch_frame_get(const ch_frame *f, const char *key);
// the value of the nearest frame up from f holding key; NULL: none
const void *ch_frame_find(const ch_frame *f, const char *key);

// the frames from f up as a list of infos, innermost first, each a map of f's pairs (values held,
// not copied); NULL f: an empty list. new: the caller's, to op_free
op_value *ch_frame_value(const ch_frame *f);

// where in code: column only when has_column, function NULL when not known
typedef struct {
	const char *file;
	long line;
	long column;
	const char *function;
	int has_column;
} ch_location;

// the location of the code writing it
#define CH_HERE (&(ch_location){__FILE__, __LINE__, 0, __func__, 0})

// the info key whose value is a list of locations, outside the graph
#define CH_LOCATIONS "locations"

// the value of a locations key: a list of one location at, { file, line, column?, function?,
// external: true }. new: the caller's, to op_free
op_value *ch_locations(const ch_location *at);
// a frame under parent whose info is { locations: [at] }, at as { file, line, column?, function?,
// external: true }. refs 1, as ch_frame_make
ch_frame *ch_frame_at(const ch_location *at, ch_frame *parent);
// whether some frame up from f (itself too) holds locations
int ch_frame_located(const ch_frame *f);

#endif
