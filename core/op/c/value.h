// op's value, in C: what patches are applied to (apply.h).
// Out of memory aborts: nothing here returns it.
#ifndef OP_VALUE_H
#define OP_VALUE_H

#include <stddef.h>

// content: null, bool, number, string (UTF-8; positions count code points), list, map (keys in
// the order given), bytes, typed array (encoding/ENCODING.tex). An absent value is a NULL pointer.
// bytes are a leaf; a typed array is a sequence of its elements (its length: how many); a stand-in
// (what a live value is sent as) is a leaf holding its kind, any value, as its one item
typedef enum { OP_NULL, OP_BOOL, OP_NUM, OP_STR, OP_LIST, OP_MAP, OP_BYTES, OP_TYPED, OP_STAND } op_type;
// a typed array's kind, in ENCODING.tex's order; no uint8: bytes are that
typedef enum {
	OP_INT8, OP_INT16, OP_UINT16, OP_INT32, OP_UINT32, OP_INT64, OP_UINT64, OP_FLOAT32, OP_FLOAT64,
} op_elements;
typedef struct op_value op_value;
// Fields are live by type: those of one kind overlap those of the others (an anonymous union), so
// one is read only on a value of its kind. type, bool_, refs, count and capacity belong to all.
struct op_value {
	op_type type;
	int bool_;
	// holders past the first: op_ref adds one, op_free lets one go
	size_t refs;
	// a list's, map's or stand-in's: how many items; 0 on any other
	size_t count;
	// a list's or a map's: room for items (and keys). a string's: bytes allocated for str, or 0
	// when it is exactly bytes + 1 (what the constructors make)
	size_t capacity;
	union {
		double num;
		// a list's or a map's: items (a map's values), keys (a map's only)
		struct {
			op_value **items;
			char **keys;
			// a big map's lookup table, made when first asked
			size_t *index;
			size_t slots;
			// removals since the table was made: how many, then where (see value.c)
			size_t *gaps;
		};
		struct {
			// a string's: its bytes, and whether they are all ASCII (then a byte is a code point).
			// bytes' and a typed array's: data, bytes long; a typed array's elements little-endian
			union {
				char *str;
				unsigned char *data;
			};
			size_t bytes;
			union {
				int ascii;
				op_elements kind;
			};
		};
	};
};

op_value *op_null(void);
op_value *op_bool(int b);
op_value *op_num(double n);
op_value *op_str(const char *s);
// copies n bytes of s
op_value *op_str_n(const char *s, size_t n);
// the string is s, n bytes then a 0, malloc'd: the value's from here, freed with it
op_value *op_str_take(char *s, size_t n);
op_value *op_list(void);
op_value *op_map(void);
// copies n bytes
op_value *op_bytes(const void *data, size_t n);
// copies count elements of the kind, each little-endian
op_value *op_typed(op_elements kind, const void *data, size_t count);
// takes the kind (any value): a stand-in, a leaf, its kind its one item
op_value *op_stand(op_value *kind);
// one element's bytes: 1 ... 8
size_t op_size(op_elements kind);
// a typed array's elements
size_t op_length(const op_value *typed);
// takes v; a map's key set twice keeps its first place (the value there before let go of)
void op_push(op_value *list, op_value *v);
void op_set(op_value *map, const char *key, op_value *v);
// NULL when absent. A map of many keys builds its lookup table on the first call, so this writes
// to the map: not safe on one map from two threads, whatever the const
op_value *op_get(const op_value *map, const char *key);
// where the key is in the map's items, or -1
long op_find(const op_value *map, const char *key);
// takes out the entry at position i (not its value: the caller has it); the later ones move down,
// the lookup table is kept
void op_unset(op_value *map, size_t i);
// to: a map with the same keys in the same order as from (the keys its own): from's lookup table,
// if it has one, copied to it, not made again
void op_map_table_copy(op_value *to, const op_value *from);
// one more holder of v, and so of all it holds; v. NULL: NULL. not thread-safe
op_value *op_ref(op_value *v);
// lets one hold of v go: the last frees it, and lets go of what it holds. a tree never
// op_ref'd is freed whole, as it always was
void op_free(op_value *v);

#endif
