// The commits a sync harness makes from a request, each under a label (extensions/sync/
// conformance/README.md, "a commit by label"; extensions/sync/typescript/harnesses.ts), in C. Kept
// across lines: the harness holds one of these. Memory taken from a request is the line's
// (conformance/c/harness.h); what is kept here is its own
#ifndef CS_COMMITS_HARNESS_H
#define CS_COMMITS_HARNESS_H

#include "seal.h"
#include "../../../conformance/c/harness.h"

#include <stdbool.h>
#include <stdio.h>

typedef struct cs_commits cs_commits;

typedef struct {
	char *label;
	uint8_t *bytes;
	size_t length;
	uint8_t name[32];
	int64_t lamport;
	// what signs it
	sl_seeded *signer;
} cs_made;

cs_commits *cs_create(void);
void cs_destroy(cs_commits *c);
// why a commit was not made: a commit's own refusal (code, field: free it) or else text (static or
// the line's)
typedef struct {
	const char *text;
	cm_code code;
	char *field;
} cs_failure;
// the commit the request says, made under its label (name). Made already: that one, if no fields
// are given. NULL with *why set
const cs_made *cs_make(cs_commits *c, const op_value *request, cs_failure *why);
const cs_made *cs_get(const cs_commits *c, const char *label);
// a label made here, else a name as 64 hex digits; false with *error set
bool cs_resolve(const cs_commits *c, const op_value *x, uint8_t name[32], const char **error);
// the commit with this name, the first made; NULL when none made here
const cs_made *cs_find(const cs_commits *c, const uint8_t name[32]);
// a name as a JSON string: its label, else its hex
void cs_put_name(const cs_commits *c, FILE *out, const uint8_t name[32]);
// the made commit, sealed by its seed's signer for a document (its 32 bytes): malloc'd into *out,
// free it
void cs_sealed(const cs_made *m, const uint8_t doc[32], uint8_t **out, size_t *length);
// the default document's 32 bytes (2a × 16, then 00 × 16): what a harness seals for when told none
extern const uint8_t cs_doc[32];

#endif
