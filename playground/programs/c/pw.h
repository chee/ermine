// the world the programs and start harnesses run in: an ermine (ermine/system) made at the first line, root "R", its host's
// scope { actor: "test" }, and the names a request gives scopes and computers. A harness answers its own lines with pw_line;
// the world's are root, kids, value (an entry replaced) and pulse. Every line is kept (retained) till pw_free, for what refers
// into it
#ifndef PROGRAMS_WORLD_H
#define PROGRAMS_WORLD_H

#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>

#include "../../../conformance/c/harness.h"
#include "../../../ermine/system/c/ermine.h"

extern es_ermine *pw_ermine;
extern sc_scheduler *pw_scheduler;
extern tb_table *pw_table;
extern pl *pw_places;
extern sc_scope *pw_host;

// the world made, once (pw_line does it too)
void pw_start(void);
// the line answered by the harness's answer, else the world's (NULL from both: an unknown op)
void pw_line(const op_value *request, FILE *out, op_value *(*answer)(const op_value *request));
// the world closed (its processes stopped, its scheduler and table let go of), then, after whatever of the harness's still
// refers to its names, let go of: pw_close first, pw_free last
void pw_close(void);
void pw_free(void);

// f once in the host's scope
const char *pw_hosted(void (*f)(void *data), void *data);
// an entry of the table replaced, as a host does it (the host's scope open)
void pw_put_entry(const char *part, tb_key id, const op_value *value);

// calloc that aborts (zeroed); a copy of a string; a string as printf has it: all fresh, the caller's to free
void *pw_alloc(size_t size);
char *pw_copy(const char *text);
char *pw_format(const char *format, ...) __attribute__((format(printf, 1, 2)));

// the parts of a request
const char *pw_text(const op_value *v);
bool pw_is(const op_value *v, op_type type);
tb_key pw_key(const op_value *v);
const char *pw_part(const op_value *v);
// a list of names, NULL-terminated, borrowed from the request; the array the caller's to free
const char **pw_address(const op_value *list, size_t *n);
op_value *pw_error(const char *why);
op_value *pw_error_take(char *why);

// a compute made in the scope named: its runs counted, its latest result kept (and let go of at pw_free). def.data is a
// struct of the harness's that starts with a pw_watch; pw_set and pw_equal go in its sc_def
typedef struct {
	char *name;
	unsigned runs;
	op_value *value;
} pw_watch;
char *pw_set(void *value, void *data);
bool pw_equal(const void *a, const void *b, void *data);
// NULL, or the error (no scope, the name taken)
char *pw_make(pw_watch *w, const char *name, const char *scope, sc_def def);

#endif
