// A shared node's id, which binds its lock (newcore/sync/ID.tex), in C. Same shape as id.ts: the
// BLAKE3 hash of "ermine/v0/id", the lock's name as a CBOR text string, and the 32 bytes its make
// gave; written ermine:// and 64 lowercase hex digits.
#ifndef ID_H
#define ID_H

#include <stddef.h>
#include <stdint.h>

typedef enum {
	ID_OK,
	ID_NAME,      // a lock name with no UTF-8 form (a lone surrogate)
	ID_SIZE,      // made is not 32 bytes
	ID_NOT_AN_ID, // not of this form
} id_code;

// "ermine://" and 64 digits
enum { ID_LENGTH = 73 };

// the id of a lock's name and what its make gave, written to out (NUL-terminated). lock is json.h's
// C text (U+0000 as C0 80, a lone surrogate as its WTF-8). A name with no UTF-8 form first, then the size
id_code id_make(const char *lock, const uint8_t *made, size_t made_length, char out[ID_LENGTH + 1]);
// whether a string has this form; upper-case hex does not
int id_is(const char *id);
// its 32 bytes; ID_NOT_AN_ID when it is not of this form
id_code id_bytes(const char *id, uint8_t out[32]);

#endif
