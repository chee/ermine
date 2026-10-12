// transport.h: the host's connection to a Subduction server, whole binary
// messages each way, for peer.c (subduction.h is sans-IO: the host moves
// its bytes). Two layers, so a platform replaces what it has its own of:
//
// - messages (ErmTransport): a WebSocket client. websocket.c is one, RFC
//   6455 over a stream below, in portable C; an ESP-IDF build may give its
//   own over esp_websocket_client instead.
// - streams (ErmStream): a TCP connection, with TLS for wss. transport_openssl.c
//   is the desktop one (POSIX sockets, OpenSSL); an ESP-IDF build would give
//   one over lwIP and mbedTLS.
//
// Randomness (the key, the masks) is platform.h's. After open, nothing here
// blocks but a send, while the network takes it.

#ifndef ERM_TRANSPORT_H
#define ERM_TRANSPORT_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// messages ---------------------------------------------------------------------------------------

typedef struct ErmTransport ErmTransport;

/** a WebSocket to a ws:// or wss:// URL, opened (this waits): NULL, with why in *error, when it cannot be */
ErmTransport *ermTransportOpen(const char *url, const char **error);
/** a descriptor that is readable when something may have come; -1 when there is none to wait on */
int ermTransportFd(const ErmTransport *transport);
/** sends one binary message; false when the connection is gone */
bool ermTransportSend(ErmTransport *transport, const uint8_t *bytes, size_t length);
/**
 * the next whole message that came, 1, in *bytes (the caller frees it with erm_host_free) and
 * *length; 0 when none has yet; -1 when the connection is closed. Call it
 * until it gives 0 before waiting on the descriptor again.
 */
int ermTransportReceive(ErmTransport *transport, uint8_t **bytes, size_t *length);
/** closes the connection (a close frame first, when it is still open) and frees it */
void ermTransportClose(ErmTransport *transport);

// streams ----------------------------------------------------------------------------------------

typedef struct ErmStream ErmStream;

/** a connection to host:port, through TLS (the server's certificate checked for host) when tls: NULL, with why in *error */
ErmStream *ermStreamOpen(const char *host, const char *port, bool tls, const char **error);
/** what has come, up to room bytes: how many; 0 when nothing has yet; -1 when the stream is closed or broken */
long ermStreamRead(ErmStream *stream, uint8_t *out, size_t room);
/** writes all of it, waiting while the network takes it; false when the stream is broken */
bool ermStreamWrite(ErmStream *stream, const uint8_t *bytes, size_t length);
/** a descriptor readable when something may have come, or -1 */
int ermStreamFd(const ErmStream *stream);
/** waits up to ms for something to come */
void ermStreamWait(ErmStream *stream, int ms);
void ermStreamClose(ErmStream *stream);

#endif
