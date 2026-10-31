// The value patches are applied to (apply.h), in C. Out of memory aborts.
#ifndef OP_VALUE_H
#define OP_VALUE_H

#include <stddef.h>
#include <stdint.h>

// Content: null, bool, number (any double but -0, plus whole numbers past 2^53 as `big` beside
// the nearest double), string (UTF-8, positions count code points), list, map, bytes, typed array
// or stand-in (what a live value is sent as). An absent value is NULL.
typedef enum { OP_NULL, OP_BOOL, OP_NUM, OP_STR, OP_LIST, OP_MAP, OP_BYTES, OP_TYPED, OP_STAND } op_type;
typedef enum {
	OP_INT8, OP_INT16, OP_UINT16, OP_INT32, OP_UINT32, OP_INT64, OP_UINT64, OP_FLOAT32, OP_FLOAT64,
} op_elements;
typedef struct op_value op_value;
// Fields overlap (an anonymous union): read one only on a value of its kind.
struct op_value {
	op_type type;
	int bool_;
	size_t refs;
	size_t count;
	size_t capacity;
	union {
		struct {
			double num;
			unsigned char *big;
			size_t bigLength;
			int bigNegative;
		};
		struct {
			op_value **items;
			char **keys;
			size_t *index;
			size_t slots;
		};
		struct {
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
op_value *op_int(int64_t n);
op_value *op_uint(uint64_t n);
op_value *op_whole(int negative, const unsigned char *magnitude, size_t length);
int op_as_double(const op_value *v, double *out);
int op_as_int64(const op_value *v, int64_t *out);
int op_same_num(const op_value *a, const op_value *b);
op_value *op_str(const char *s);
op_value *op_str_n(const char *s, size_t n);
// s is malloc'd and becomes the value's.
op_value *op_str_take(char *s, size_t n);
op_value *op_list(void);
op_value *op_map(void);
op_value *op_bytes(const void *data, size_t n);
op_value *op_typed(op_elements kind, const void *data, size_t count);
op_value *op_stand(op_value *kind);
size_t op_size(op_elements kind);
size_t op_length(const op_value *typed); // a typed array's elements, or bytes'
// A map's keys are shared immutable names: make with op_name, share with op_name_ref, free with
// op_name_free. A map copied by hand must op_name_ref each key, never strdup.
char *op_name(const char *s);
char *op_name_ref(char *name);
void op_name_free(char *name);
void op_push(op_value *list, op_value *v);
void op_set(op_value *map, const char *key, op_value *v);
void op_set_name(op_value *map, char *name, op_value *v);
// A new map sharing from's keys and items (no references taken; that is the caller's).
op_value *op_map_copy(const op_value *from);
// Builds a big map's lookup table on first call, so it writes to the map: not thread-safe.
op_value *op_get(const op_value *map, const char *key);
long op_find(const op_value *map, const char *key);
void op_unset(op_value *map, size_t i);
void op_map_table_copy(op_value *to, const op_value *from);
// Returns v with one more holder. Not thread-safe.
op_value *op_ref(op_value *v);
// Lets one hold go; the last frees v.
void op_free(op_value *v);

#endif
