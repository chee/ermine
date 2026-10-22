// the cardputer's den on tippet (experiments/tippet), as the dens page's host.ts makes one (its
// contract): the den is its install, its node "ermine:ed01" + its key's hex, its name under
// /system/dens the key's hex, and the key the one its log signs with. in the host's world (host.h):
// the programs at /things/<kind> (ermine.type "thing.<kind>"), a den "chee's cardputer" (device
// "cardputer"; policy: yes to every ask, as the page's: the inbox checks who asked first), runners
// keys, screen and pigs, a surface screen (framebuffer, 240x135), and /work/keys, /work/screen and
// /work/pigs started. what syncs (history's kept): host.ts' list, as steps in the room's log
//   <den>                   attributes, children { on, things, inbox, authorized_keys }
//   <den>/things            children: each thing's process id -> <den>/things/<process id>
//   <den>/things/<process>  attributes: the process's, and thing.at
//   <den>/inbox             value: { <ask id>: { ask, claim, sig, answer? } }
//   <den>/authorized_keys   value: { <install id>: { name } }
// and the steps others write in their own (and into this inbox). who's here: tippet's live, every
// 2 s, { den }; another den not heard for 6 s is quiet. the log's steps on flash (store_file, in
// dir), so a reboot goes on from its last step
#ifndef DEN_H
#define DEN_H

#include <stddef.h>
#include <stdint.h>

#include "experiments/tippet/c/tippet.h"
#include "playground/dens/c/dens.h"
#include "playground/installs/c/installs.h"

// a room's code: 4 of these, read off a screen and typed (none that look like another); its tippet
// room "dens-" + the code
#define DEN_LETTERS "ACDEFHJKMNPRTWXY"
// how often this den says it is here, and how long until one not heard is quiet (host.ts' BEAT,
// QUIET)
#define DEN_BEAT 2000
#define DEN_QUIET 6000

// after host_init: the den of the install, in room code, its log kept in dir (made when not there).
// now: the clock's ms. 0: up
int den_boot(const inst_install *install, const char *code, const char *dir, int64_t now);
dn *den_get(void);
// the room's code ("": none yet)
const char *den_room(void);
// tippet's sync, for a carrier to link (poll.h); NULL before den_boot
tp_sync *den_sync(void);
// each loop, the clock's ms: the heartbeat every DEN_BEAT, the asks waiting answered, the screen's
// band drawn again when who's here changes
void den_tick(int64_t now);
// the carrier's state, in a few words, for the screen ("on galaxy.observer", "offline")
void den_net(const char *state);
// pairing: the den an ask came from last put in this den's keys, and the screen says so
void den_trust_last(void);
// the band at the screen's foot (fb.h): who's here, or what just happened, in words. from the
// screen thing's paint, last
void den_band(void);
// how many asks this den has answered; how many steps its log holds, every device's
unsigned den_asks(void);
uint64_t den_steps(void);
// the history's snapshot into the log's store (tippet's): a boot loads it and the steps after. 0 or a
// code
int den_snapshot(void);
// the dens heard, the keys, the log, a line each, on stdout
void den_print(void);
// tippet's own heap (its tp_mem): now, and the most yet
size_t den_heap(size_t *most);
// the platform's: the screen drawn again (the last picture, with the band); n random bytes
void frame_again(void);
void den_random(uint8_t *out, size_t n);
// the platform's: the heap at a stage of the den's boot, said
void den_mark(const char *what);

#endif
