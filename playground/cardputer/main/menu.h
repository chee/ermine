// the G0 menu (menu.c): a folder in the den's graph, /system/menu, a process's (its node the
// folder): each child an item, its name what's shown, its value a handler, an action (the process
// api's es_create_action), run with es_execute_action when it is picked. three are the den's own: "join a room"
// (four letters typed, enter), "new room" (a code picked, shown big to read off) and "rooms" (every
// room kept here with its size; one picked is deleted on tab, never the one it's in). a paired den
// adds more through the inbox (host.ts' contract: the menu ask), each a start or stop it asked for,
// done when picked as if it asked then, while it is still paired
//
//   menu_start();                       // after host_init, before the den's inbox is read
//   if (menu_key("enter")) ...          // a key, taken while the menu is open
//   menu_toggle();                      // G0
#ifndef MENU_H
#define MENU_H

#include "core/op/c/value.h"

// the menu process at /system/menu, with its two items
void menu_start(void);
// open or shut (G0); whether it is open
void menu_toggle(void);
int menu_open(void);
// a key ("a", "enter", "esc", "up", "down", "backspace"): 1 when the menu took it
int menu_key(const char *k);
// what the screen shows while it is open (fb.h's paint)
void menu_paint(void);
// a paired den's item (the inbox's menu ask, from its node): name, and its handler, an ask (start or
// stop) done when picked; handler NULL: its item taken out. the answer, new: {} or a refusal
op_value *menu_ask(const char *from, const char *name, const op_value *handler);

// the platform's: the den goes to room code, kept from now on (main.c: NVS, then a restart)
void room_go(const char *code);

// a room kept on this device: its code, its files' size in K (log, snapshot, key), the file
// system it is on ("/f", "/g")
typedef struct {
	char code[5];
	unsigned kb;
	char fs[4];
} menu_room;
// the platform's: every room kept here (both file systems), at most most: how many
int rooms_list(menu_room *out, int most);
// the platform's: a room's files let go whole (never the room the den is in). 0, and *left the K
// free on its file system after; -1, and why in words
int room_delete(const char *code, unsigned *left, char *why, size_t cap);

#endif
