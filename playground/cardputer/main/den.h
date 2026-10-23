// the cardputer's den on tippet (experiments/tippet), as the dens page's host.ts makes one: the
// contract at its top. the den is its install: its node "ermine:ed01" + its key's hex, its id (its
// name under /system/dens) the key's hex, and the key the one its log signs with. in the host's
// world (host.h): the programs at /things/<kind> (ermine.type "thing.<kind>"), the den's node
// (attributes ermine.type ermine.den, .id, .name "chee's cardputer", .device "cardputer") at
// /system/den and /system/dens/<id>, software (experiments/software) with keys, screen and pigs
// offered under the node, and /home/keys, /home/screen and /home/pigs run. what syncs (history's
// kept): host.ts' list, as steps in the room's log
//   <node>                   attributes; children { things, inbox, authorized_keys, runners }
//   <node>/things            children: each thing's process id -> <node>/things/<process id>
//   <node>/things/<process>  attributes: the process's, and thing.at
//   <node>/inbox             value: { <ask id>: { ask, claim, sig, answer? } }
//   <node>/authorized_keys   value: { <node>: { name } }, only this den's own steps believed
// the inbox (den.c's, host.ts' /system/inbox): the one place that checks who may. start, stop and
// unpair only from a den in authorized_keys; pair from anyone it says it is, put to a person (tab
// yes, esc no). who's here: tippet's live, every 2 s, { den }, and { den, bye } going; another den
// not heard for 6 s is quiet. the log's steps on flash (store_file, in dir), so a reboot goes on
// from its last step
#ifndef DEN_H
#define DEN_H

#include <stddef.h>
#include <stdint.h>

#include "experiments/tippet/c/tippet.h"
#include "experiments/software/c/software.h"
#include "playground/installs/c/installs.h"
#include "core/op/c/value.h"

// a room's code: 4 of these, read off a screen and typed (none that look like another); its tippet
// room "dens-" + the code
#define DEN_LETTERS "ACDEFHJKMNPRTWXY"
// how often this den says it is here, and how long until one not heard is quiet (host.ts' BEAT,
// QUIET)
#define DEN_BEAT 2000
#define DEN_QUIET 6000

// why the den isn't up, in words ("": it is)
const char *den_why(void);
// 1: a boot again would mend what kept it from coming up (a snapshot let go)
int den_again(void);
// a message from the server, before the sync takes it: a have saying the room holds more of this
// den's steps than its log does is said on the screen
void den_heard(const uint8_t *message, size_t length);
// after host_init: the den of the install, in room code, its log kept in dir (made when not there).
// now: the clock's ms. 0: up
int den_boot(const inst_install *install, const char *code, const char *dir, int64_t now);
sw *den_software(void);
// the room's code ("": none yet)
const char *den_room(void);
// tippet's sync, for a carrier to link (poll.h); NULL before den_boot. software, what runs here
tp_sync *den_sync(void);
// each loop, the clock's ms: the heartbeat every DEN_BEAT, the asks waiting answered, the screen's
// band drawn again when who's here changes
void den_tick(int64_t now);
// the carrier's state, in a few words, for the screen ("on galaxy.observer", "offline")
void den_net(const char *state);
// pairing (host.ts' pair ask): the oldest pair ask waiting answered, yes (tab: the asker in this
// den's keys) or no (esc), and the screen says so; den_trust_last is a yes. whether one waits
void den_pair_answer(int yes);
void den_trust_last(void);
int den_pair_waiting(void);
// the band at the screen's foot (fb.h): who's here, or what just happened, in words. from the
// screen thing's paint, last
void den_band(void);
// how many asks this den has answered; how many steps its log holds, every device's
unsigned den_asks(void);
uint64_t den_steps(void);
// forgetting (tippet's try-out): the history keeps the newest per node, and each snapshot lets go
// of the runs that have passed on to galaxy (the keeper). before den_boot; off by default
void den_forgets(int yes);
// a thing of kind started at /home/<at> by the den itself (as at boot): 1 started
int den_start(const char *kind, const char *at);
// the history's snapshot into the log's store (tippet's): a boot loads it and the steps after. 0 or a
// code
int den_snapshot(void);
// the dens heard, the keys, the log, a line each, on stdout
void den_print(void);
// tippet's own heap (its tp_mem): now, and the most yet
size_t den_heap(size_t *most);
// what just happened, in words, in the band for 10 s (hot: cherry)
void den_say(int hot, const char *one, const char *two);
// an install's name, short and ASCII, for the screen
void den_short_name(const char *install, char *out, size_t cap);
// a menu item a paired den added (menu.h), picked: its handler (a start or stop ask) done as if
// from asked it now, refused when from isn't paired now; said in words. its answer, new
op_value *den_do(const char *from, const char *name, const op_value *handler);
// the den going (a room switched): a bye said, the log synced to flash
void den_leave(void);
// the platform's: the screen drawn again (the last picture, with the band); n random bytes
void frame_again(void);
void den_random(uint8_t *out, size_t n);
// the platform's: the clock, ms
int64_t den_clock(void);
// the platform's: the heap free now (bytes)
size_t den_free(void);
// the platform's: the heap at a stage of the den's boot, said
void den_mark(const char *what);

#endif
