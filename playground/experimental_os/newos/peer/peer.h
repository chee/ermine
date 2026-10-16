// peer.h: the card, as sync's store, on today's table, places and scheduler (peer.c): newos/peer.c
// ported onto today's subduction wiring and transport. The card's folder is as it was: the device's
// key and Subduction's store, the root's id, seen. Every node whose id is a document's (an ermine://
// id) is a document of its own; any other is ephemeral, never sent. What the card holds is taken in
// before anything else; a document a children entry reached from the root names is loaded when the
// card holds it.
//
// There is no graph `changed` to be wired to now (wiring.h): the host gives the peer each write it
// makes, as world.ts's write does (peerWrote, peerAdded). What comes from sync is written to the
// table as world.ts's versions writes it: value, attributes (a blop's info) and children, the first
// head of several. The network is the host's too: what the transport asks sent goes to its send;
// net.c, ported with host.c, will give it.

#ifndef ERMOS_PEER_PORT_H
#define ERMOS_PEER_PORT_H

#include "../../../../filesystem/places/c/places.h"

#include "../../../../extensions/subduction/c/history.h"
#include "../../../../extensions/subduction/c/id.h"
#include "../../../../extensions/subduction/c/transport.h"

#include <stdbool.h>
#include <stdint.h>

typedef struct Peer Peer;

/** what the peer asks of its host; any may be NULL */
typedef struct {
	/** a line for the host's log (hostSay) */
	void (*say)(void *context, const char *line);
	/** what the transport asks sent on a connection (net.c's netOut); none: dropped */
	void (*send)(void *context, const transport_out *out);
	/** whether there is a connection (net.c's netJoined): documents are synced again only then */
	bool (*joined)(void *context);
	/** what /dev/sync counts (net.c's netCount): documents followed, and one made, stored or heard */
	void (*count)(void *context, size_t followed, int made, int stored, int heard);
	void *context;
} peer_host;

/** the card in folder sd (made if need be; fresh: emptied first): NULL, with why */
Peer *peerOpen(const char *sd, bool fresh, const char **why);
/** the root's id: a document, made at the card's first boot */
const char *peerRoot(Peer *p);
/** a new document's id, for a node the host makes */
void peerFresh(Peer *p, char out[ID_LENGTH + 1]);
/** once the graph is made (its root peerRoot): the wiring; what the card held taken in, and what it names loaded. True: the card held a graph */
bool peerStart(Peer *p, pl *places, tb_table *table, sc_scheduler *s, const peer_host *host);
/** a write the host made, committed: what it changed of documents sent (pl_each_entry_change) */
void peerWrote(Peer *p, const pl_changed *changed);
/** an entry the host put in the table whole (tb_add, pl_upsert's made: no op of its own): its value sent, as made at once */
void peerAdded(Peer *p, tb_key part, tb_key id);
/** a turn: sealing and storing what changed, taking in what came, loading what that names; ms until it must run again, -1 for none. The host's network takes in what came (netIn) before, and sends after */
int64_t peerTurn(Peer *p);
/** what is left stored */
void peerStop(Peer *p);
/** everything let go: the wiring, the transport, the peer */
void peerFree(Peer *p);

/** the transport, for the host's network (net.c: transport_connect, transport_received, transport_closed) */
transport *peerTransport(Peer *p);

// for the histories (drv_sync.c)

/** this device's key, 64 hex digits: a change's signer */
const char *peerKey(Peer *p);
/** a document's stored histories; NULL for an id not a document's */
histories *peerHistories(Peer *p, const char *doc);
/** the objects of a document sync has told of, as a blop names each: "value", ["info", name], ["children", name]. A fresh list */
Json *peerObjects(Peer *p, const char *doc);
/** when a change, by its blop's name, was first taken in on this card: µs since 1970; 0 if not known */
int64_t peerSeen(Peer *p, const uint8_t name[32]);
/** told the id of each document a change is taken in to, made here or come; one listener, the last given */
void peerTold(Peer *p, void (*told)(void *context, const char *doc), void *context);

// for the link (drv_link.c)

/** a document a driver wants in memory though no list reached from the root may name it (brought true; false: no longer): loaded, as those reached from the root are */
void peerBring(Peer *p, const char *doc, bool brought);

#endif
