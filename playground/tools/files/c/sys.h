// The platform calls a store needs that POSIX has no plain call for (FILES.tex, Building it), in C: sys.ts's. Extended
// attributes, swaps, exclusive renames, clones, full syncs, file ids and the Trash. macOS first (APFS): getxattr and
// the rest with XATTR_NOFOLLOW, renamex_np with RENAME_SWAP and RENAME_EXCL, clonefile, F_FULLFSYNC. Linux behind
// #ifdef: the l* attribute calls, renameat2 with RENAME_EXCHANGE and RENAME_NOREPLACE, a plain copy for clone, fsync.
//
// Every call gives 0, or -1 with errno; a call with another answer says so. Paths are absolute. Nothing follows a link
// where sys.ts does not: an attribute is the entry's own.
//
// THE TRASH. sys_fake is sys.ts's fake: a folder of its own that an entry is moved into under its name, or "stem 2.ext",
// "stem 3.ext" and on; it is what a test gives. sys_trash, the real one (Finder over Apple Events on macOS, else
// NSFileManager, else <home>/.Trash; the freedesktop.org trash on Linux) is sys_trash. A home can be given
// (sys_trash_in), as sys.ts's system({home}): then it is that home's own Trash alone, and Finder is never asked. A test
// gives one, or the fake; no test touches the person's.
#ifndef SYS_H
#define SYS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// the extended attributes a store sets: party.chee.ermine.x on macOS, user.ermine.x on Linux
#ifdef __linux__
#define SYS_OWN "user.ermine."
#else
#define SYS_OWN "party.chee.ermine."
#endif
#define SYS_ID SYS_OWN "id"
#define SYS_SLOT SYS_OWN "slot"
#define SYS_SIDE SYS_OWN "side"
#define SYS_STORE SYS_OWN "store"
// a node's info, SYS_INFO then its name
#define SYS_INFO SYS_OWN "info."

// sys_rename's answers
#define SYS_DONE 0
#define SYS_TAKEN 1

// an extended attribute of the entry itself: 0 with *value (malloc'd) and *length, 1 if it has none
int sys_get(const char *path, const char *name, uint8_t **value, size_t *length);
// sets an extended attribute of the entry itself
int sys_set(const char *path, const char *name, const uint8_t *value, size_t length);
// removes an extended attribute of the entry itself, if it has one
int sys_unset(const char *path, const char *name);
// the names of the entry's own extended attributes: *names (malloc'd) holds each ending in NUL, *length bytes
int sys_names(const char *path, char **names, size_t *length);
// exchanges two entries in one step
int sys_swap(const char *a, const char *b);
// renames only if nothing is at to: SYS_DONE, or SYS_TAKEN if something is
int sys_rename(const char *from, const char *to);
// clones a file, or copies it where the volume cannot clone; to must not exist
int sys_clone(const char *from, const char *to);
// F_FULLFSYNC of a file or a folder (fsync where the volume has none); syncing a file's folder is the caller's
int sys_sync(const char *path);
// the file id of the entry itself
int sys_id(const char *path, uint64_t *id);
// whether sys.ts would class errno as the file system's (it names the code), rather than another failure
bool sys_known(int error);
// sends an entry to the person's real Trash
int sys_trash(const char *path);
// the same with a home folder whose Trash to use (NULL: the person's, as sys_trash): <home>/.Trash on macOS, under a free
// name, the entry itself and a link itself; <home>/.local/share/Trash on Linux
int sys_trash_in(const char *home, const char *path);
// the freedesktop.org trash in the data folder data (as $XDG_DATA_HOME): the entry in Trash/files, and in Trash/info its
// .trashinfo, where it was and when. Built on any system, for a test
int sys_trash_xdg(const char *data, const char *path);
// the fake Trash: moves path into dir, made if it is not there, under its own name or "stem 2.ext", ...
int sys_fake(const char *dir, const char *path);

#endif
