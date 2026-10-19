// net.c: the network (net.h), as the old OS's peer.c made it (c/peer.c, The connection), on
// sync's device (playground/together/c/transport.h): a WebSocket to /etc/sync's server
// (subduction/websocket.c, over transport_openssl.c), the device's handshake on it, then every
// document the card follows synced over it, from both sides (transport.h's header): card.c follows
// each document made here, each one a list reached from the root names, and what drivers bring.
// The host runs it each turn, around the card's (card_host's send and count).
//
// A thread opens the WebSocket, which waits, then watches its descriptor; what may have come
// posts irq 61, the network's line (host.c), whose turn reads it and runs sync (card.c's turn).
// So the WebSocket and the device are only ever used on the OS's thread, but for the open.
//
// Losing the server (it stops, it is not there at boot, the handshake does not finish) never stops
// the OS: it is said in the log, as the old OS said it ("sync: could not connect to ..."), when it
// first happens and when the reason changes, and in /dev/sync/link; a connection is tried again 1 s
// later, then 2, 4, ... at most 30 s apart. What is changed meanwhile is stored on the card, and
// goes out when the server is back: each connection syncs every document followed.
//
//   /etc/sync        {server, service?}: server a ws:// or wss:// url, wss://galaxy.observer unless it
//                    names another ("" or null: none, offline); service the name it answers to in the
//                    handshake, else its url's host (tp_service). Read each turn: a server
//                    named anew is connected to at once
//   /dev/sync/link   the host's own (its id dev.sync.link, never a document): {server, connected, peer,
//                    key, documents, moved: {out, in, heard}, stage, error}; written as the host when
//                    it changes. peer: the server's key, 64 hex digits, null until joined; key
//                    this device's; documents how many are followed; moved the changes made here
//                    to documents, taken in from elsewhere, and ephemeral ones heard, since boot;
//                    stage "connecting", "handshake", "synced", "offline" (tried again at retry, µs
//                    on hostNow's clock), or "off"; error the last thing that went wrong, null once
//                    joined

#include "net.h"

#include "../../../together/stacks/subduction/c/subduction/transport.h"

#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *const SERVER = "wss://galaxy.observer";
static const int NET = 61; // the network's line (host.c)
static const int64_t SECOND = 1000000;

// a connection's thread: it opens the WebSocket, hands it over, then watches it while armed
typedef struct Line {
	pthread_mutex_t lock;
	pthread_cond_t wake;
	char *url;
	ErmTransport *ws; // opened: the OS's from now
	char *why;        // why it could not be
	bool opened, armed, stop;
	int holds; // the thread's and the network's: the last to let go frees it
} Line;

struct Net {
	Host *host;
	tp_device *t;
	const char *key;
	char *server, *service; // what /etc/sync names: the server connected to, or being; NULL: none
	bool read;              // /etc/sync read once
	Line *line;
	ErmTransport *ws; // the connection: NULL, none
	uint64_t conn;
	bool joined;    // its handshake is done
	char peer[65];  // the server's key, once joined
	int64_t asked;  // hostNow µs its handshake began
	int64_t retry;  // hostNow µs from which to connect again
	int64_t backoff;
	const char *stage;
	char *error; // the last thing that went wrong; NULL once joined
	char *said;  // the last said in the log, so it is said once
	size_t documents;
	int64_t out, in, heard;
	bool placed; // /dev/sync/link made
	char *shown; // its value as last written
};

// --- the thread

static void let(Line *l) {
	pthread_mutex_lock(&l->lock);
	bool last = --l->holds == 0;
	pthread_mutex_unlock(&l->lock);
	if (!last) return;
	if (l->ws) ermTransportClose(l->ws);
	pthread_mutex_destroy(&l->lock);
	pthread_cond_destroy(&l->wake);
	free(l->url), free(l->why), free(l);
}

static void post(void) {
	char record[32];
	snprintf(record, sizeof record, "{\"irq\": %d}", NET);
	ermosPost(record);
}

/** opens the WebSocket, which waits, hands it over; then wakes the host when something may have come, each time it is armed */
static void *watch(void *data) {
	Line *l = data;
	const char *why = "no reason given";
	ErmTransport *ws = ermTransportOpen(l->url, &why);
	int fd = ws ? ermTransportFd(ws) : -1;
	pthread_mutex_lock(&l->lock);
	bool going = !l->stop;
	if (going) l->ws = ws;
	l->why = strdup(why ? why : "no reason given");
	l->opened = true;
	pthread_mutex_unlock(&l->lock);
	// let go before it was open: not the OS's
	if (!going && ws) ermTransportClose(ws);
	if (going) post();
	while (going && ws) {
		pthread_mutex_lock(&l->lock);
		while (!l->armed && !l->stop) pthread_cond_wait(&l->wake, &l->lock);
		going = !l->stop;
		l->armed = false;
		pthread_mutex_unlock(&l->lock);
		while (going) {
			struct pollfd w = { fd, POLLIN, 0 };
			int n = poll(&w, 1, 500);
			pthread_mutex_lock(&l->lock);
			going = !l->stop;
			pthread_mutex_unlock(&l->lock);
			if (n != 0 || fd < 0) break;
		}
		if (going) post();
	}
	let(l);
	return NULL;
}

/** the thread may watch again: what came is read */
static void arm(Line *l) {
	pthread_mutex_lock(&l->lock);
	l->armed = true;
	pthread_cond_signal(&l->wake);
	pthread_mutex_unlock(&l->lock);
}

/** the thread told to stop, and let go: it ends by itself, within half a second, or when its open returns */
static void unwatch(Net *n) {
	Line *l = n->line;
	if (!l) return;
	n->line = NULL;
	pthread_mutex_lock(&l->lock);
	l->stop = true;
	// handed over: the OS's to close, not the thread's
	if (l->ws == n->ws) l->ws = NULL;
	pthread_cond_signal(&l->wake);
	pthread_mutex_unlock(&l->lock);
	let(l);
}

// --- the connection

/** said in the log unless it was the last thing said */
static void say(Net *n, char *what) {
	if (!n->said || strcmp(n->said, what)) hostSay(n->host, "sync: %s", what);
	free(n->said);
	n->said = what;
}

/** the connection gone, or never made: why said, and a connection tried again later */
static void lost(Net *n, char *why) {
	unwatch(n);
	if (n->ws) {
		ermTransportClose(n->ws);
		n->ws = NULL;
		tp_closed(n->t, n->conn);
	}
	n->joined = false;
	if (why) {
		free(n->error);
		n->error = strdup(why);
		say(n, why);
	}
	n->stage = n->server ? "offline" : "off";
	n->retry = hostNow(n->host) + n->backoff;
	n->backoff = n->backoff * 2 > 30 * SECOND ? 30 * SECOND : n->backoff * 2;
}

static void join(Net *n) {
	Line *l = calloc(1, sizeof *l);
	pthread_mutex_init(&l->lock, NULL);
	pthread_cond_init(&l->wake, NULL);
	l->url = strdup(n->server);
	l->holds = 2;
	pthread_t thread;
	if (pthread_create(&thread, NULL, watch, l) != 0) {
		l->holds = 1;
		let(l);
		lost(n, formatString("could not connect to %s: no thread", n->server));
		return;
	}
	pthread_detach(thread);
	n->line = l;
	n->stage = "connecting";
	if (!n->said) say(n, formatString("connecting to %s", n->server));
}

/** the WebSocket, once its thread has opened it: the device's handshake begun on it */
static void take(Net *n) {
	Line *l = n->line;
	pthread_mutex_lock(&l->lock);
	bool opened = l->opened;
	ErmTransport *ws = l->ws;
	char *why = l->why ? strdup(l->why) : NULL;
	pthread_mutex_unlock(&l->lock);
	if (!opened) {
		free(why);
		return;
	}
	if (!ws) {
		lost(n, formatString("could not connect to %s: %s", n->server, why ? why : "no reason given"));
		free(why);
		return;
	}
	free(why);
	n->ws = ws;
	n->conn = tp_connect(n->t, n->service);
	n->asked = hostNow(n->host);
	n->stage = "handshake";
}

/** what came on the WebSocket, handed to the device */
static void receive(Net *n) {
	while (n->ws) {
		uint8_t *bytes;
		size_t length;
		int got = ermTransportReceive(n->ws, &bytes, &length);
		if (got == 0) break;
		if (got < 0) {
			lost(n, formatString("the connection to %s closed", n->server));
			break;
		}
		tp_received(n->t, n->conn, bytes, length);
		erm_host_free(bytes);
	}
}

/** /etc/sync's server and service: a server named anew is connected to at once */
void netTarget(Net *n) {
	size_t count;
	const op_value *v = hostRead(ap_host(hostOs(n->host)), hostPath(n->host, &count, "etc", "sync", NULL), count);
	const op_value *server = v && v->type == OP_MAP ? op_get(v, "server") : NULL, *service = v && v->type == OP_MAP ? op_get(v, "service") : NULL;
	// no /etc/sync, or one naming none: the default; "" or null: none
	const char *url = !server ? SERVER : server->type == OP_STR && *server->str ? server->str : NULL;
	char host[256] = "";
	if (service && service->type == OP_STR && *service->str) snprintf(host, sizeof host, "%s", service->str);
	else if (url) tp_service(url, host, sizeof host);
	bool same = n->read && (url ? n->server && !strcmp(url, n->server) && !strcmp(host, n->service) : !n->server);
	n->read = true;
	if (same) return;
	bool was = n->server != NULL;
	unwatch(n);
	if (n->ws) {
		ermTransportClose(n->ws);
		n->ws = NULL;
		tp_closed(n->t, n->conn);
	}
	free(n->server), free(n->service), free(n->error), free(n->said);
	n->server = url ? strdup(url) : NULL;
	n->service = url ? strdup(host) : NULL;
	n->error = n->said = NULL;
	n->joined = false;
	n->retry = 0;
	n->backoff = SECOND;
	n->stage = url ? "offline" : "off";
	if (!url && was) hostSay(n->host, "sync: no server in /etc/sync: offline");
}

// --- /dev/sync/link

static op_value *count(int64_t v) {
	return op_num((double)v);
}

static op_value *text(const char *t) {
	return t ? op_str(t) : op_null();
}

/** /dev/sync/link: what the connection is doing, written when it changes */
static void show(Net *n) {
	op_value *v = op_map(), *moved = op_map();
	op_set(v, "server", text(n->server));
	op_set(v, "connected", op_bool(n->joined));
	op_set(v, "peer", n->joined ? text(n->peer) : op_null());
	op_set(v, "key", text(n->key));
	op_set(v, "documents", count((int64_t)n->documents));
	op_set(moved, "out", count(n->out));
	op_set(moved, "in", count(n->in));
	op_set(moved, "heard", count(n->heard));
	op_set(v, "moved", moved);
	op_set(v, "stage", text(n->stage));
	op_set(v, "error", text(n->error));
	if (!strcmp(n->stage, "offline")) op_set(v, "retry", count(n->retry));
	char *printed = valPrint(v);
	if (n->shown && !strcmp(printed, n->shown)) {
		free(printed);
		op_free(v);
		return;
	}
	ap_api *api = ap_host(hostOs(n->host));
	size_t c;
	const char *const *at = hostPath(n->host, &c, "dev", "sync", "link", NULL);
	const ap_error *e = NULL;
	if (!n->placed) {
		// the host's own, as the clock is (host.c tick): made each boot, ephemeral, in front at /dev/sync
		const ap_item *sync = hostLook(api, at, 2);
		if (!sync) {
			// no /dev/sync yet: written once there is
			free(printed);
			op_free(v);
			return;
		}
		const char *made = NULL;
		e = ap_create(api, NULL, "dev.sync.link", 1, &made);
		if (!e && !hostLook(api, at, c)) e = ap_insert(api, sync->id, "link", made, NULL, NULL);
		n->placed = !e;
	}
	if (!e) e = hostSnap(api, at, c, v);
	hostFailed(n->host, e, "sync: /dev/sync/link");
	op_free(v);
	free(n->shown);
	n->shown = e ? NULL : printed;
	if (e) free(printed);
}

// --- what the host calls

Net *netOpen(Host *host, tp_device *t, const char *key) {
	// a send on a socket closed from the other side is an error, not the end
	signal(SIGPIPE, SIG_IGN);
	Net *n = calloc(1, sizeof *n);
	n->host = host;
	n->t = t;
	n->key = key;
	n->backoff = SECOND;
	n->stage = "off";
	netTarget(n);
	return n;
}

void netIn(Net *n) {
	if (n->line && !n->ws) take(n);
	receive(n);
}

void netTurn(Net *n) {
	int64_t now = hostNow(n->host);
	uint8_t key[SL_KEY]; // the multikey: 0xed 0x01, then the 32 bytes of the Ed25519 key
	if (n->ws && !n->joined && tp_connected(n->t, n->conn, key)) {
		n->joined = true;
		for (int i = 0; i < 32; i++) snprintf(n->peer + 2 * i, 3, "%02x", key[SL_KEY - 32 + i]);
		n->backoff = SECOND;
		free(n->error);
		n->error = NULL;
		n->stage = "synced";
		say(n, formatString("joined %s as %.16s…", n->server, n->key));
	} else if (n->ws && !n->joined && now - n->asked > 20 * SECOND) {
		lost(n, formatString("the handshake with %s did not finish", n->server));
	}
	if (n->server && !n->ws && !n->line && now >= n->retry) join(n);
	if (n->ws && n->line) arm(n->line);
	show(n);
}

void netOut(Net *n, const tp_out *o) {
	if (!n->ws || o->conn != n->conn) return;
	if (o->kind == TP_SEND) {
		if (!ermTransportSend(n->ws, o->bytes, o->length)) lost(n, strdup("the connection broke while sending"));
	} else if (o->kind == TP_CLOSE) {
		lost(n, strdup("Subduction closed the connection"));
	}
}

bool netJoined(Net *n) {
	return n->ws && n->joined;
}

int64_t netWait(Net *n) {
	int64_t now = hostNow(n->host), at = -1;
	if (n->server && !n->ws && !n->line) at = n->retry;
	else if (n->ws && !n->joined) at = n->asked + 20 * SECOND;
	if (at < 0) return -1;
	return at <= now ? 0 : (at - now + 999) / 1000;
}

void netCount(Net *n, size_t documents, int out, int in, int heard) {
	n->documents = documents;
	n->out += out;
	n->in += in;
	n->heard += heard;
}

void netStop(Net *n) {
	unwatch(n);
	if (n->ws) {
		ermTransportClose(n->ws);
		n->ws = NULL;
		tp_closed(n->t, n->conn);
	}
}
