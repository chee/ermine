// frames (littlesync.h's wire): COBS and the CRC-32, and what a message is wrapped in. Internal.
#ifndef LS_FRAME_H
#define LS_FRAME_H

#include <stddef.h>
#include <stdint.h>

// the most bytes between two zeros that are kept (a frame, COBS encoded)
#define LS_FRAME_MAX 4608

// the CRC-32 (zlib's, as a number)
uint32_t ls_crc32(const uint8_t *data, size_t length);
// the COBS of the bytes into out (room: length + length / 254 + 1): how long. No zero in it
size_t ls_cobs(const uint8_t *data, size_t length, uint8_t *out);
// the same written a piece at a time: begin with out, put the bytes, end (how long). out's room: every
// byte put, + 1 + their count / 254
typedef struct {
	uint8_t *out;
	size_t at, code_at;
	uint8_t code;
} ls_cobs_out;
void ls_cobs_begin(ls_cobs_out *c, uint8_t *out);
void ls_cobs_put(ls_cobs_out *c, const uint8_t *data, size_t length);
size_t ls_cobs_end(ls_cobs_out *c);
// the bytes back, into out (room: length; out may be data: it is decoded in place); how long, or -1 for what is not COBS
long ls_uncobs(const uint8_t *data, size_t length, uint8_t *out);
// a frame for the message: 0x00, the COBS of "L", message, its CRC-32 (little end), 0x00. Appended
// to *out (malloc'd, *length bytes, *capacity room); the room needed is 2 + the COBS of length + 5
void ls_frame(const uint8_t *message, size_t length, uint8_t **out, size_t *used, size_t *capacity);
// the room a frame of a message of n bytes takes (ls_frame_into)
#define LS_FRAMED(n) ((n) + 8 + ((n) + 5) / 254)
// ls_frame's frame of the message written straight into out (LS_FRAMED(length) room): how long
size_t ls_frame_into(const uint8_t *message, size_t length, uint8_t *out);
// a frame shared by every link it goes to: one holder each (refs), freed with the last
typedef struct {
	unsigned refs;
	size_t length;
	uint8_t bytes[];
} ls_framed;
// the message's frame, one holder (the caller). Out of memory aborts
ls_framed *ls_framed_of(const uint8_t *message, size_t length);
void ls_framed_drop(ls_framed *f);
// the link's queued frames handed over, the oldest first, up to max: how many, into out (each one
// holder, the caller's: ls_framed_drop it). For a transport that sends them as they are (http.c)
struct ls_link;
size_t ls_take(struct ls_link *link, ls_framed **out, size_t max);
// the message in a frame's bytes (between the zeros), decoded in place: its start (inside data) and
// length in *message, or 0 when it is not one (no "L", bad CRC, not COBS)
int ls_unframe(uint8_t *data, size_t length, const uint8_t **message, size_t *message_length);

#endif
