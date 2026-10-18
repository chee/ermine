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
// the bytes back, into out (room: length; out may be data: it is decoded in place); how long, or -1 for what is not COBS
long ls_uncobs(const uint8_t *data, size_t length, uint8_t *out);
// a frame for the message: 0x00, the COBS of "L", message, its CRC-32 (little end), 0x00. Appended
// to *out (malloc'd, *length bytes, *capacity room); the room needed is 2 + the COBS of length + 5
void ls_frame(const uint8_t *message, size_t length, uint8_t **out, size_t *used, size_t *capacity);
// the message in a frame's bytes (between the zeros), decoded in place: its start (inside data) and
// length in *message, or 0 when it is not one (no "L", bad CRC, not COBS)
int ls_unframe(uint8_t *data, size_t length, const uint8_t **message, size_t *message_length);

#endif
