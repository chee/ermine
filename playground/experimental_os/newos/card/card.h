// card.h: the card (card.c): what ermineOS keeps and syncs, on playground/together (sync.h) over today's
// table, places and scheduler. Every node whose id is a document's (an ermine id, of any kind) is kept: each
// change to one of its tables goes out as one commit, stored on the card and sent to /etc/sync's
// server; any other node (a process, a driver's state, "@n") is never stored or sent: that is what
// ephemeral is here. What comes in (the card at boot, the network after) is written to the table by
// sync itself, and the places are told; programs see it as any write.
//
// The host gives the card each write it makes (cardWrote: the entries changed, and those made
// whole), and runs it each turn (cardTurn) between the network's in and out (net.h). There is no
// store to load and no history to replay here: sync's own rules (sync.h's header) say what the
// table shows.

#ifndef ERMOS_CARD_H
#define ERMOS_CARD_H

#include "../../../../filesystem/places/c/places.h"

#include "../../../../playground/together/c/sync.h"

#include <stdbool.h>
#include <stdint.h>

typedef struct Card Card;

/** an id's text at most: littlesync's longest (LS_ID_LEN, 128 bytes). Today's are ermine ids: "ermine:" and a
 * key id's 68 hex digits (a fresh or hashed one's 36: ermine/ids) */
#define ID_LENGTH 128
/** whether text is a document's id (a kept node's) */
bool id_is(const char *text);

/** what the card asks of its host; any may be NULL */
typedef struct {
	/** a line for the host's log (hostSay) */
	void (*say)(void *context, const char *line);
	/** what the device asks sent on a connection, or a connection closed (net.c's netOut) */
	void (*send)(void *context, const tp_out *out);
	/** what /dev/sync/link counts: documents followed, and one made here, taken in, or heard */
	void (*count)(void *context, size_t followed, int made, int stored, int heard);
	void *context;
} card_host;

/** the card in folder sd (its own folder card/ inside, made if need be; fresh: emptied first): NULL, with why */
Card *cardOpen(const char *sd, bool fresh, const char **why);
/** the root's id: a document, made at the card's first boot */
const char *cardRoot(Card *c);
/** a new document's id, for a node the host makes */
void cardFresh(Card *c, char out[ID_LENGTH + 1]);
/** once the graph is made (its root cardRoot): sync over the table; what the card held taken in, the root and what it reaches followed. True: the card held the root */
bool cardStart(Card *c, pl *places, tb_table *table, sc_scheduler *s, const card_host *host);

/** an entry the host made and put in the table whole in a write, at its key */
typedef struct {
	nd_entry *entry;
	const char *part, *id;
} card_born;
/** a write the host made, committed: each kept table changed, one commit (an entry born in the write: its value whole) */
void cardWrote(Card *c, const pl_changed *changed, const card_born *born, size_t nborn);
/** a turn: sync run (sealing, storing, sending, taking in), the places told what came; ms until it must run again, -1 for none */
int64_t cardTurn(Card *c);
/** what is left stored */
void cardStop(Card *c);
/** everything let go: sync, the device, the card */
void cardFree(Card *c);

/** sync, and its device (net.c: tp_connect, tp_received, tp_closed) */
sy_sync *cardSync(Card *c);
tp_device *cardDevice(Card *c);
/** this device's key, 64 hex digits: a commit's signer */
const char *cardKey(Card *c);

/** who wrote a document's table: each stored commit of it the card holds (every head's, in the order taken
 * in) decoded, its change header given to f (actor, external[0] the site: file and function), until f says
 * false. How many it gave; -1: no history here (not a document, or none stored) */
long cardChanges(Card *c, const char *doc, const char *table, bool (*f)(void *context, const ch_header *change), void *context);

/** a document a driver wants synced though no list reached from the root may name it (drv_link.c): followed */
void cardFollow(Card *c, const char *doc);
/** told the id of each document a commit is taken in to, made here or come; one listener, the last given */
void cardTold(Card *c, void (*told)(void *context, const char *doc), void *context);

// --- live state (ERMINEOS.md, Live state): what a device shows and never stores (its pointer, its
// focus, a window mid-drag, its presence), sent as ephemeral commits of the document's `live` table
// (sync.h's header: never sealed, never stored; standing until a stored commit of this device's
// follows them or ttl ms of silence; sent again every beat ms)

/** this device's live state at a document: written to the document's `live` table and sent at most every beat
 * (LIVE_BEAT ms), held until then (op_ref'd). NULL: withdrawn: the stop (sy_stop), what stood ends at once everywhere */
void cardLive(Card *c, const char *doc, const op_value *value);
/** the live state standing at the document watched: cardLived's listener told when it changes (a peer's came, changed or lapsed) */
void cardWatch(Card *c, const char *doc, bool on);
void cardLived(Card *c, void (*lived)(void *context, const char *doc), void *context);
/** a peer's live state standing at a document: its key (64 hex digits) and its `live` value, held */
typedef struct {
	char key[65];
	op_value *value;
} card_stand;
/** every peer's live state standing at the document (never this device's own), by key; *out malloc'd, each value held (op_free them) */
size_t cardStanding(Card *c, const char *doc, card_stand **out);

#endif
