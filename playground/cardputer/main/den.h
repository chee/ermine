// the cardputer's den, as the dens page's (playground/demos/dens host.ts and main.ts ?as=cardputer):
// in the host's world (host.h), the programs at /things/<kind> (ermine.type "thing.<kind>"), a den
// "chee's cardputer" (device "cardputer"; policy: yes to every ask, as the page's), runners keys,
// screen and pigs (ermine.runner.takes "thing.<kind>"), a surface screen (framebuffer, 240x135),
// and at boot /work/keys, /work/screen and /work/pigs started. away links it to the other dens over
// a channel named its id (away.h: the channel's name is the den's id)
#ifndef DEN_H
#define DEN_H

#include "playground/dens/c/away.h"

// after host_init. id: the den's (the page's: its device key's multikey as hex); code: the room's
// (below), known before the screen first draws, which shows it. 0: up
int den_boot(const char *id, const char *code);
dn *den_get(void);
// a room: who meets. its code: 4 of DEN_LETTERS, read off a screen and typed (none that look like
// another); its id, the node the rows go on: "ermine://" + hex(blake3("party.chee.ermine.dens.room:"
// + code)), as the dens page's host.ts makes it from the same code
#define DEN_LETTERS "ACDEFHJKMNPRTWXY"
#define DEN_ROOM_ID_LEN (9 + 64)
void den_room_id(const char *code, char out[DEN_ROOM_ID_LEN + 1]);
// the room's code it connected to ("": none yet)
const char *den_room(void);
// the link over channel (its name the den's id) in den_boot's room: its row at "dens:" + the
// room's id, others' there mirrored in. NULL: refused
dn_link *den_connect(chn_channel *channel);
// the clock's ms: the row beat again every 3 s, lapsed rows swept every 1 s
void den_tick(int64_t now_ms);
// each /work thing's out, a line each, on stdout
void den_print(void);

#endif
