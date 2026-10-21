// A device for ermine-pigs: a table (core/table) with sync beside it (playground/together/c/sync.h),
// connected to one Subduction server over a WebSocket, as playground/term/host.c makes one, with
// sync's ephemeral option on: a write made through dv_wave goes out as an ephemeral commit (seen on
// top of what is stored, stored nowhere), every other write as a stored one. Its presence messages
// go over the device's own connection (tp_send, tp_listen). No places, no scheduler: reads are the
// table's. One thread; nothing here is called from a callback of sync's.
#ifndef PIGS_DEVICE_H
#define PIGS_DEVICE_H

#include "../../../../core/node/c/node.h"
#include "../../../../core/table/c/table.h"
#include "../../../../playground/together/c/sync.h"

#include <poll.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct dv dv;

// an id at most: littlesync's longest (LS_ID_LEN, 128 bytes; today's ids are ermine ids, "ermine:"
// and 36 or 68 hex), and the NUL
enum { DV_ID = 128 + 1 };
// a device's key as hex: its multikey (seal.h), and the 0
enum { DV_KEY = 2 * SL_KEY + 1 };

// server: ws:// or wss://, or NULL for none; service: what it answers to (NULL or "": its host).
// zeros: ids minted with their last 16 bytes zero (galaxy.observer stores no other). actor: the name
// written in each change's header (copied). NULL, with why, when it cannot be made
dv *dv_new(const char *server, const char *service, bool zeros, const char *actor, const char **why);
// lets go of everything: dv_flush first, or what is not sent yet is lost
void dv_free(dv *d);
// this device's key, a multikey as 68 hex digits (what presence names its rows by)
const char *dv_key(dv *d);
bool dv_online(dv *d);

// the value under (part, id), borrowed, good until the next write or turn; NULL: none
const op_value *dv_value(dv *d, const char *part, const char *id);

void dv_mint(dv *d, char out[DV_ID]);
// what comes for the id is taken in (anything but a kept id: nothing)
void dv_follow(dv *d, const char *id);
// the id's value replaced by value (taken): one stored commit. 0, or op's code
int dv_store(dv *d, const char *id, op_value *value);
// one key of the node's value set, a stored commit (takes value): a map's key changed alone
int dv_set(dv *d, const char *id, const char *key, op_value *value);
// the node's value taken away, a stored commit: it has none
int dv_clear(dv *d, const char *id);
// id placed under name in holder's children, a stored commit; unplace: the name taken out (the node stays)
int dv_place(dv *d, const char *holder, const char *name, const char *id);
int dv_unplace(dv *d, const char *holder, const char *name);
// the same as an ephemeral commit
int dv_wave(dv *d, const char *id, op_value *value);
// the id's versions made one, keeping the one shown
void dv_settle(dv *d, const char *id);

// messages (presence's, and others): bytes to whoever listens on the topic; a listener on a topic, told
// each message there (at most 4 listeners, kept until dv_free)
void dv_send(dv *d, const char *topic, const uint8_t *bytes, size_t n);
typedef void (*dv_heard_fn)(void *context, const char *from, const uint8_t *bytes, size_t n);
void dv_listen(dv *d, const char *topic, dv_heard_fn fn, void *context);

// the loop: descriptors to wait on (at most room), what came in taken (after poll), sync run and
// what it asks sent (the ms until it must run again, at most 1000)
size_t dv_fds(dv *d, struct pollfd *fds, size_t room);
void dv_ready(dv *d);
int dv_turn(dv *d);
// runs until nothing is left to send and the server has been quiet a while, or ms pass
void dv_flush(dv *d, int ms);

double dv_now(void);

#endif
