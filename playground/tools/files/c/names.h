// Names on disk (FILES.tex, Values and Names), in C. Same functions as names.ts: extensions, stems, how a slot's name
// is written as a stem and a person's name read back, the key two stems compare by, names passed over, and a union's
// members' names. Pure: nothing here touches the disk.
// Strings are json.h's: UTF-8, NUL-terminated, U+0000 held as C0 80, a lone surrogate as its 3-byte WTF-8 form. A
// string returned is fresh (free it); a form is a name like "txt", "bin", "cbor" or a typed array's kind.
#ifndef NAMES_H
#define NAMES_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** a name's extension, without its dot: a dot not first, then 1 to 8 ASCII letters and digits; NULL if it has none */
char *names_extension(const char *name);
/** whether a value of the form may have the extension */
bool names_fits(const char *ext, const char *form);
/** a bin value's extension by how its bytes start: png, jpg, gif, pdf, webp, or bin */
const char *names_sniff(const uint8_t *head, size_t length);
/** the extension the store adds for a value of the form; a form that is none of them gives itself */
const char *names_suffix(const char *form, const uint8_t *head, size_t length);

typedef struct {
	char *stem;
	char *ext;
	bool added;
} names_split_result;
/** a slot's name split for a value of the form; pass (count patterns) may be NULL */
names_split_result names_split(const char *name, const char *form, const uint8_t *head, size_t length, const char *const *pass, size_t count);
/** a name written as a stem: / as :, : as U+FF1A, NUL as U+FFFD, "" as untitled, and _ at both ends of a name passed over */
char *names_write(const char *name, const char *const *pass, size_t count);
/** a stem cut between scalar values so that it, ext ("" is none), and five .FINALs fit in 255 bytes of UTF-8, when it and ext are over 255 */
char *names_cut(const char *stem, const char *ext);
/** the stem with .FINAL added until taken says it is free; . and .. are always taken */
char *names_free(const char *stem, bool (*taken)(const char *stem, void *context), void *context);
/** a name a person gave, read back: : as /, U+FF1A as :, anything else as itself */
char *names_read(const char *name);
/** what two stems compare by: full case folding, then NFD, as names.ts does it */
char *names_key(const char *stem);
/** whether a whole name matches one of the patterns, * standing for any run of characters */
bool names_passes(const char *name, const char *const *pass, size_t count);
/** a union member's stem: its number, from 1, then a person's words */
char *names_member(double n, const char *words);
/** the number a member's stem starts with and the words after it (a fresh string); false if it has none */
bool names_number(const char *stem, double *n, char **words);

typedef struct {
	char *slot;
	char *form; // NULL when the name gives none
} names_take_result;
/** what a new file's name gives: its slot, read back, less a .text or .kind extension, which gives its form */
names_take_result names_take(const char *entry);
/** the slot a renamed entry gives; ext NULL or "" is none */
char *names_renamed(const char *entry, const char *ext, bool folder);
/** an id as a URL path segment, percent-encoded, with . as %2E; NULL for an id with a lone surrogate (encodeURIComponent throws) */
char *names_percent(const char *id);
/** the id a segment names; a segment that does not decode names itself */
char *names_unpercent(const char *segment);
/** code point order, UTF-16's with surrogates after U+E000 to U+FFFF: <0, 0, >0 */
int names_bycodepoint(const char *a, const char *b);

/** a name in a folder, as the store makes them (n bytes): not "", "." or "..", and no "/" or NUL (raw, or as json.h
 * holds it, C0 80) */
static inline bool names_isname(const char *s, size_t n) {
	if (n == 0 || (n == 1 && s[0] == '.') || (n == 2 && s[0] == '.' && s[1] == '.')) return false;
	for (size_t i = 0; i < n; i++) {
		unsigned char c = (unsigned char)s[i];
		if (c == '/' || c == 0 || (c == 0xC0 && i + 1 < n && (unsigned char)s[i + 1] == 0x80)) return false;
	}
	return true;
}
/** a path from the store's folder, as the store makes them (n bytes): names joined by "/", or "" for the folder itself.
 * Anything else (absolute, or ".." in it) could reach out of the folder */
static inline bool names_ispath(const char *s, size_t n) {
	if (n == 0) return true;
	for (size_t at = 0;;) {
		size_t end = at;
		while (end < n && s[end] != '/') end++;
		if (!names_isname(s + at, end - at)) return false;
		if (end == n) return true;
		at = end + 1;
	}
}

#endif
