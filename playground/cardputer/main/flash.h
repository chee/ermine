// the den's place on the Cardputer's flash (flash.c): the install (its key and root) in NVS, and a
// FAT file system on the "den" partition (partitions.csv; wear levelling) at FLASH_DIR, where
// tippet's store_file keeps the room's log. a partition table with no "den" (an sdkconfig still on
// single-app-large): the same 1 MB registered at 4 MB at boot
#ifndef FLASH_H
#define FLASH_H

#include "playground/installs/c/installs.h"

#define FLASH_DIR "/f"

// after nvs_flash_init: the install, the same every boot; its first open takes littlesync's key
// (NVS "littlesync"/"key") when there is one, so the den is the one it was. 0, or installs.h' code
int flash_install(inst_install *out);
// the file system mounted (made the first time): 1; 0 not
int flash_mount(void);

// the logs of tippet's old store format (folders not named t2…, which nothing reads now) let go,
// for room; the bytes free said before and after
void flash_sweep(void);

#endif
