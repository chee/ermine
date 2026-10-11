// notify (newcore/notify/ts/notify.ts), in C. A patch and its facts (or the content before it), into fine-grained
// notifies on the reads of that content. Same shape as notify.ts.
// Out of memory aborts: nothing here returns it.
#ifndef NOTIFY_H
#define NOTIFY_H

#include <stddef.h>

// content: null, bool, number, string (UTF-8; positions count code points), list, map (keys in
// the order given), bytes, typed array (encoding/ENCODING.tex). An absent value is a NULL pointer.
// bytes are a leaf; a typed array is a sequence of its elements (its length: how many)
typedef enum { NT_NULL, NT_BOOL, NT_NUM, NT_STR, NT_LIST, NT_MAP, NT_BYTES, NT_TYPED } nt_type;
// a typed array's kind, in ENCODING.tex's order
typedef enum {
	NT_INT8, NT_UINT8, NT_INT16, NT_UINT16, NT_INT32, NT_UINT32, NT_INT64, NT_UINT64, NT_FLOAT32,
	NT_FLOAT64,
} nt_elements;
typedef struct nt_value nt_value;
struct nt_value {
	nt_type type;
	int bool_;
	double num;
	char *str;
	// a string's: its bytes, and whether they are all ASCII (then a byte is a code point).
	// bytes' and a typed array's: data, bytes long; a typed array's elements little-endian
	size_t bytes;
	int ascii;
	// a list's or a map's: count, items (a map's values), keys (a map's only)
	size_t count;
	size_t capacity;
	nt_value **items;
	char **keys;
	// a big map's lookup table, made when first asked
	size_t *index;
	size_t slots;
	unsigned char *data;
	nt_elements kind;
	// holders past the first: nt_ref adds one, nt_free lets one go
	size_t refs;
};

nt_value *nt_null(void);
nt_value *nt_bool(int b);
nt_value *nt_num(double n);
nt_value *nt_str(const char *s);
nt_value *nt_list(void);
nt_value *nt_map(void);
// copies n bytes
nt_value *nt_bytes(const void *data, size_t n);
// copies count elements of the kind, each little-endian
nt_value *nt_typed(nt_elements kind, const void *data, size_t count);
// one element's bytes: 1 ... 8
size_t nt_size(nt_elements kind);
// a typed array's elements
size_t nt_length(const nt_value *typed);
// takes v; a map's key set twice keeps its first place (the value there before let go of)
void nt_push(nt_value *list, nt_value *v);
void nt_set(nt_value *map, const char *key, nt_value *v);
// NULL when absent
nt_value *nt_get(const nt_value *map, const char *key);
// one more holder of v, and so of all it holds; v. NULL: NULL. not thread-safe
nt_value *nt_ref(nt_value *v);
// lets one hold of v go: the last frees it, and lets go of what it holds. a tree never
// nt_ref'd is freed whole, as it always was
void nt_free(nt_value *v);

// a path item: a key (number or string, never the same), or a span [a, b) last
typedef enum { NT_NUM_KEY, NT_STR_KEY, NT_SPAN } nt_key_type;
typedef struct {
	nt_key_type type;
	long n; // a number key
	const char *s; // a string key
	long a, b; // a span
} nt_key;

// a place: keys, and maybe a range of the sequence there
typedef struct {
	const nt_key *path;
	size_t length;
	int has_range;
	long from, to;
} nt_place;

// has_value: a "value" was given (null counts); else the place is removed
typedef struct {
	nt_place place;
	int has_value;
	const nt_value *value;
	int has_move;
	nt_place move;
} nt_patch;

typedef enum { NT_VALUE, NT_KEYS, NT_LENGTH, NT_MOVED, NT_GONE } nt_kind;
typedef enum { NT_OUT, NT_IN } nt_edge;
typedef enum { NT_KEEP, NT_DROP } nt_empty;

typedef struct {
	int deep;
	int chase;
	nt_edge edges[2];
	nt_empty empty;
} nt_options;

typedef struct nt_notify nt_notify;
typedef struct nt_read nt_read;

// get: the content now, NULL when absent
nt_notify *nt_create(const nt_value *(*get)(void *), void *ctx);
// frees it and every read it made
void nt_destroy(nt_notify *n);

// path: keys, maybe a span last (copied); NULL options: all off
nt_read *nt_open(nt_notify *n, const nt_key *path, size_t length, const nt_options *options);
void nt_on(nt_read *r, void (*f)(nt_kind kind, void *user), void *user);
void nt_off(nt_read *r, void (*f)(nt_kind kind, void *user), void *user);
void nt_stop(nt_read *r);
// the keys (not a span) it is at now; live until the next patched
const nt_key *nt_keys(const nt_read *r, size_t *length);
// its span, or 0
int nt_span(const nt_read *r, long *a, long *b);
// what it sees: a new value to nt_free, or NULL when absent
nt_value *nt_value_of(const nt_read *r);

// what notify reads of the content before a patch, never the content (notify.ts's Facts).
// a place: is it a list, how long (code points for a string), was the key there
typedef struct {
	int list;
	size_t length;
	int had;
} nt_fact;
#define NT_FACTS
typedef struct {
	// the patch's place, as it is when the patch lands (a move's: with what left gone).
	// ranged: the sequence at its path; else its parent, had: its last key there (a list's:
	// the index is in it). at [], unranged: had: the object there
	nt_fact place;
	// a move: where it came from, as place is
	int has_from;
	nt_fact from;
	// a ranged move: how many places what moved fills where it lands
	int has_size;
	size_t size;
} nt_facts;

// the caller applied the patch; facts: about the content before it
void nt_patched_facts(nt_notify *n, const nt_patch *patch, const nt_facts *facts);
// the facts, from the whole content before the patch: for a caller that has it
nt_facts nt_facts_of(const nt_patch *patch, const nt_value *before);
// nt_patched_facts with nt_facts_of(patch, before)
void nt_patched(nt_notify *n, const nt_patch *patch, const nt_value *before);

#endif
