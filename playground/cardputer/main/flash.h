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
// the bytes free where room code's log is (or would be)
size_t flash_free_for(const char *code);

// the logs of tippet's old store format (folders not named t2…, which nothing reads now) let go,
// for room; the bytes free said before and after
// and when the flash is nearly full (under FLASH_LOW free), the snapshots of the rooms but keep[]
// let go: a snapshot is the history as it was, made again when that room is next joined (its boot
// lands its whole log); a log is never touched. the bytes free, in K, back
#define FLASH_LOW (96 * 1024)
unsigned flash_sweep(const char *const *keep, int nkeep);
// the same, said for "den2" (its rooms, its bytes free): nothing let go there

#endif
