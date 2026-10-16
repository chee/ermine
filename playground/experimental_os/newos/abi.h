// abi.h: the frames of ermineOS's ABI (exec.c says
// what they hold), for both ends: the OS (exec.c), and a program through
// libermine (lib/libermine.h). A frame
// is a 4-byte little-endian length, then that many bytes of one value in
// core's CBOR (ermine/encoding/c/cbor.h), a map.

#ifndef ERMOS_ABI_H
#define ERMOS_ABI_H

#include "../../../ermine/encoding/c/json.h"

#include <stdbool.h>

/** the most bytes one frame may hold */
#define ABI_MOST (64u << 20)

/** one frame's bytes, its length first: fresh, *n of them; NULL, with why, for a value with no encoding or too large */
unsigned char *abiFrame(const Json *message, size_t *n, const char **why);
/** a frame's value from its n bytes after the length: NULL, with why, if it is not a map */
Json *abiDecode(const unsigned char *body, size_t n, const char **why);
/** writes one frame; false, with why, if it could not (the other end gone, or a value with no encoding) */
bool abiWrite(int fd, const Json *message, const char **why);
/** reads one frame, waiting for it; NULL, with why, at the end or on a frame that is not one */
Json *abiRead(int fd, const char **why);

#endif
