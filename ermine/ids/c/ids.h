// ermine ids in C: a node's id that syncs, as bytes, and its text; the rules are
// typescript/ids.ts's. an id is its bytes and their length; text is NUL-terminated.
// strings (domains, names, an outside id's) are UTF-8 with their length; one not well-formed is
// refused (false), as a lone surrogate is in TypeScript.
// randomness is the caller's: fresh is handed its 16 bytes
#ifndef IDS_H
#define IDS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// the longest id (key), and fresh's and hashed's
#define ID_MAX 34
#define ID_SHORT 18
// the longest text, its NUL included: "ermine:" + 68 hex
#define ID_TEXT (7 + 2 * ID_MAX + 1)

typedef enum { ID_NONE, ID_FRESH, ID_HASHED, ID_KEY } id_kind;

// hashed's inputs: bytes; the domain and each input hashed as its length (a varint), then its bytes
typedef struct {
	const uint8_t *data;
	size_t length;
} id_part;

// the domains of hashed's ids
#define ID_CHILD "ermine/v1/id/child"
#define ID_OUTSIDE "ermine/v1/id/outside"

// 00 10 + random
void id_fresh(const uint8_t random[16], uint8_t out[ID_SHORT]);
// 1e 10 + the first 16 bytes of BLAKE3(domain, parts); the domain is NUL-terminated
bool id_hashed(const char *domain, const id_part *parts, size_t count, uint8_t out[ID_SHORT]);
// a child's: its parent's bytes (an ermine id, else false), then its name
bool id_child(const uint8_t *parent, size_t size, const char *name, size_t length, uint8_t out[ID_SHORT]);
// an outside id's (automerge's): its bytes; text is UTF-8 and checked so (utf8 true), bytes not
bool id_outside(const uint8_t *data, size_t length, bool utf8, uint8_t out[ID_SHORT]);

// ID_NONE: not an ermine id
id_kind id_kind_of(const uint8_t *id, size_t length);
// the id's text, and its length; 0 when not an ermine id
size_t id_text(const uint8_t *id, size_t length, char out[ID_TEXT]);
// the bytes text is, and their length; 0 when not an ermine id
size_t id_parse(const char *text, size_t length, uint8_t out[ID_MAX]);

// whether the bytes are well-formed UTF-8 (no surrogates, no overlong forms, at most U+10FFFF)
bool id_utf8(const uint8_t *s, size_t length);

#endif
