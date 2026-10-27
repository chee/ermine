// op's value, in C: what patches are applied to (apply.h).
// Out of memory aborts: nothing here returns it.
#ifndef OP_VALUE_H
#define OP_VALUE_H

#include <stddef.h>
#include <stdint.h>

// content: null, bool, number, string (UTF-8; positions count code points), list, map (keys in
// the order given), bytes, typed array (the encoding: ermine/encoding/typescript/cbor.ts's header).
// An absent value is a NULL pointer. a number: any double but -0 (it is 0: whole numbers are
// integers), and every whole number, of any size: one no double holds exactly (past 2^53) is `big`
// (whole.h) beside the double nearest it, in num.
// bytes are a leaf; a typed array is a sequence of its elements (its length: how many); a stand-in
// (what a live value is sent as) is a leaf holding its kind, any value, as its one item
typedef enum { OP_NULL, OP_BOOL, OP_NUM, OP_STR, OP_LIST, OP_MAP, OP_BYTES, OP_TYPED, OP_STAND } op_type;
// a typed array's kind, in cbor.ts's order; no uint8: bytes are that
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
		// a number's: the number (a big one's, the double nearest it); a whole number no double
		// holds exactly: its magnitude, big-endian, no leading zero, and its sign (NULL otherwise)
		struct {
			double num;
			unsigned char *big;
			size_t bigLength;
			int bigNegative;
		};
		// a list's or a map's: items (a map's values), keys (a map's only)
		struct {
			op_value **items;
			char **keys;
			// a big map's lookup table (positions plus one), made when first asked
			size_t *index;
			size_t slots;
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
// a number: -0 is 0
op_value *op_num(double n);
op_value *op_int(int64_t n);
op_value *op_uint(uint64_t n);
// a whole number from its sign and magnitude, big-endian (leading zeros allowed): a plain num when
// a double holds it exactly. copies the bytes
op_value *op_whole(int negative, const unsigned char *magnitude, size_t length);
// a number as a double (a big one: the double nearest it); 0 when not a number
int op_as_double(const op_value *v, double *out);
// a whole number from INT64_MIN to INT64_MAX; 0 for anything else (a fraction, past them)
int op_as_int64(const op_value *v, int64_t *out);
// two numbers the same: by value, NaN the same as NaN, big ones by their bytes
int op_same_num(const op_value *a, const op_value *b);
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
// a map's keys are names: strings never changed, each shared by every map that has it and freed
// with the last (a count of holders before its bytes). read one as any string; make one with
// op_name, share it with op_name_ref, let go of it with op_name_free. a map copied by hand shares
// its keys: op_name_ref each, never a strdup; a map freed by hand lets go of each with op_name_free
char *op_name(const char *s);
char *op_name_ref(char *name);
void op_name_free(char *name);
// takes v; a map's key set twice keeps its first place (the value there before let go of)
void op_push(op_value *list, op_value *v);
void op_set(op_value *map, const char *key, op_value *v);
// op_set with a name for the key (another map's keys[i]): shared, not copied
void op_set_name(op_value *map, char *name, op_value *v);
// a new map of from's keys (shared) and items (the same pointers: no reference taken, that is the
// caller's), in from's order, with from's lookup table; room for exactly them
op_value *op_map_copy(const op_value *from);
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
