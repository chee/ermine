// platform.h: the host's hooks, the one place a port gives them. The
// library (subduction.h) needs the first five; the C host (the
// transport, the stores) uses all of them. platform_posix.c is macOS's and
// Linux's; a board's would give the clock from its RTC or SNTP, randomness
// from its hardware generator (esp_fill_random), memory from its heap and
// the log to its console.

#ifndef ERM_PLATFORM_H
#define ERM_PLATFORM_H

#include <stddef.h>
#include <stdint.h>

#if defined(__cplusplus)
#define ERM_NORETURN [[noreturn]]
#else
#define ERM_NORETURN _Noreturn
#endif

/** fills length bytes at out with cryptographically secure random bytes */
void erm_host_random(uint8_t *out, size_t length);
/** memory, as malloc, realloc and free: NULL when there is none; aligned to at least a pointer's size (the library over-allocates for more) */
void *erm_host_malloc(size_t size);
void *erm_host_realloc(void *pointer, size_t size);
void erm_host_free(void *pointer);
/** stops the program and never returns (the library takes it as Rust's `-> !`): a panic in the library, or a failure nothing can go on from */
ERM_NORETURN void erm_host_abort(void);

/** the wall clock: ms since the Unix epoch */
uint64_t erm_host_now(void);
/** a line for whoever runs the program (stderr; a board's console), without its newline */
void erm_host_log(const char *line);

#endif
