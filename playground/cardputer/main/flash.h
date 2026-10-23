// the den's place on the Cardputer's flash (flash.c): the install (its key and root) in NVS, and a
// FAT file system on the "den" partition (partitions.csv; wear levelling) at FLASH_DIR, where
// tippet's store_file keeps the room's log. a partition table with no "den" (an sdkconfig still on
// single-app-large): the same 1 MB registered at 4 MB at boot
#ifndef FLASH_H
#define FLASH_H

#include "playground/installs/c/installs.h"

#define FLASH_DIR "/f"
// the second, "den2" (3 MB): rooms not on /f go here
#define FLASH_DIR2 "/g"

// after nvs_flash_init: the install, the same every boot; its first open takes littlesync's key
// (NVS "littlesync"/"key") when there is one, so the den is the one it was. 0, or installs.h' code
int flash_install(inst_install *out);
// the file systems mounted (made the first time): 1 when "den" is; "den2" too when the table has it
int flash_mount(void);
// room code's folder moved from "den" to "den2" whole: copied (to t2<code>.tmp, read back the same,
// then renamed), then the old let go; a reset at any point leaves one whole copy that is used. 1
// moved, 0 nothing to move, -1 not (it stays on "den")
int flash_move(const char *code);
// where room code's log is kept: /f/t2<code> when it is there, else /g/t2<code> (/f without "den2")
void flash_room_dir(const char *code, char out[16]);
// once the den is up: the volume its room isn't on let go (about 10 KB of heap each), the rooms
// on it remembered (so a room switched to finds its log there, after the restart)
void flash_settle(const char *room);
// every room kept here, on either file system: its code, its files in K, its file system; how many
typedef struct {
	char code[5];
	unsigned kb;
	char fs[4];
} flash_room;
int flash_rooms(flash_room *out, int most);
// room code's files let go whole (its folder; the one let go for the heap mounted again for it):
// 0, *left its file system's K free after; -1, why in words
int flash_delete(const char *code, unsigned *left, char *why, size_t cap);
// whether room code has a log here (on either)
int flash_room_there(const char *code);
// the bytes free where room code's log is (or would be)
size_t flash_free_for(const char *code);

// the logs of tippet's old store format (folders not named t2…, which nothing reads now) let go,
// for room; the bytes free said before and after
// each room's folder and its bytes said too. under FLASH_LOW free on "den", a room joined moves to
// "den2" (flash_move). (a room's snapshot is never let go here: one with none lands its whole log
// at boot, which can take more heap than there is.) the bytes free on "den", in K, back
#define FLASH_LOW (96 * 1024)
unsigned flash_sweep(const char *const *keep, int nkeep);
// the same, said for "den2" (its rooms, its bytes free): nothing let go there

#endif
