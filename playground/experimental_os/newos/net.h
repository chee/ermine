// net.h: the network (net.c): this machine's connection to /etc/sync's server, over which the
// card's documents are synced (peer/peer.c), as the old OS's peer.c made it (c/peer.c). The host
// runs it each turn around the card's, and hands it what the transport asks to send.

#ifndef ERMOS_NET_H
#define ERMOS_NET_H

#include "host.h"

#include "../../../extensions/subduction/c/transport.h"

typedef struct Net Net;

/** the network of a transport, not yet connected: the first turn reads /etc/sync */
Net *netOpen(Host *host, transport *t, const char *key);
/** a turn's start, before the transport runs: /etc/sync read, a connection opened taken, what came handed to the transport */
void netIn(Net *n);
/** a turn's end, after it ran: a handshake done or given up, a connection begun again; /dev/sync/link written when it changed */
void netTurn(Net *n);
/** what the transport asks of the host: sent on the connection, or the connection closed */
void netOut(Net *n, const transport_out *out);
/** whether the handshake with the server is done, and the connection up */
bool netJoined(Net *n);
/** ms until the network must have a turn though nothing comes (a try again, a handshake given up): -1 for none */
int64_t netWait(Net *n);
/** what /dev/sync/link counts: documents followed, changes made here, taken in from elsewhere, ephemeral ones heard */
void netCount(Net *n, size_t documents, int out, int in, int heard);
/** the connection closed and its thread let go */
void netStop(Net *n);

#endif
