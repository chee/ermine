// drv_sock.c: /drivers/sock, the shell on a Unix socket. While ermineOS
// runs, a person reaches its shell from any Mac terminal: each connection is
// a line, as /dev/uart0 and a terminal window's are, and a shell runs on it
// as the console's does (programs/shell, data {line}), as the person.
//
//   ~/.ermine/shell.sock     the socket ($ERMINE_SOCK instead, if set): the folder 0700, the socket
//                            0600. A crashed run's is replaced; one another ermineOS listens on is
//                            left to it, and this one listens nowhere. Unlinked at power off
//   /dev/sock/socket         {path}: where it listens; null when it does not
//   /dev/sock/<n>            a connection, ephemeral: {shell}, its shell's pid
//     rx                     bytes from the socket, the last 4096; stats.rx counts them all
//     tx                     bytes to send: a writer appends, this driver sends them and empties it
//     stats                  {rx, tx}: bytes in all, each way
//     vt                     {cols, rows}: the far terminal's size, as it says it (below); null until it does.
//                            The shell's pty reads it, as it reads a terminal window's vt
//     shell                  its shell: programs/shell, data {line: ["dev", "sock", <n>]}
//
// Who connects is the person: the socket is the Mac user's, 0600 in a 0700
// folder, so whoever can open it is already that user, and its shell acts
// as the person, as the console's does.
//
// A connection closing kills its shell and its node; its shell ending (exit,
// ctrl-d) closes it; its node unplaced does both. The socket's input ending
// (shut, as bin/ermine-shell does at its own input's end) is a ctrl-d, so a
// script's last line, run, is the end.
//
// The size: CSI 8 ; rows ; cols t, as a terminal reports its own (xterm's
// window ops, the answer to CSI 18 t), taken out of what comes and written
// to vt, and to the size of each session whose to lists the line
// (drivers/pty), as term writes it. bin/ermine-shell sends it at the start
// and with each SIGWINCH.
//
// The thread: polls the listening socket and every connection; something
// there (or a send that waited) posts {"irq": 64} and waits for the host's
// turn to take it. The turn (on/irq): connections taken and each given its
// shell, each read dry into rx, what waited sent, the closed let go.

#define _DARWIN_C_SOURCE

#include "drivers.h"
#include "drv.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#define IRQ 64
#define KEEP 4096
#define MOST 256 // connections at once

typedef struct Conn {
	int n, fd;       // fd -1 once closed
	Json *at;        // its node's address
	char *pid;       // its shell's
	bool ended;      // its input ended: no more to read
	bool closing;    // closed once what waits is sent
	uint8_t *wait;   // to send, not yet taken
	size_t waiting;
} Conn;

typedef struct Sock {
	Host *host;
	int listen;      // -1: listening nowhere
	char *path;
	ino_t ino;       // the socket file's, so power off unlinks only its own
	ERM_LIST(Conn *) conns;
	int count;       // connections made
	pthread_t watcher;
	bool watching;
	pthread_mutex_t lock;
	pthread_cond_t taken;
	bool posted, stopping;
	int wake[2];     // a byte here: the watcher polls again
} Sock;

static Sock *running;

static int64_t whole(const Json *v, int64_t otherwise) {
	int64_t n;
	return jsonIsWhole(v, &n) ? n : otherwise;
}

static Json *bytesOf(const Json *v) {
	return v && v->type == JSON_BYTES ? (Json *)v : NULL;
}

static Json *at(const Conn *c, const char *name) {
	return drvUnder(c->at, name, NULL);
}

static void poke(Sock *k) {
	char b = 0;
	if (write(k->wake[1], &b, 1) < 0) { }
}

// --- the socket

/** listens on path: a stale socket replaced, a live one left to whoever has it; -1 when it cannot */
static int listenOn(Sock *k, const char *path) {
	struct sockaddr_un addr = { .sun_family = AF_UNIX };
	if (strlen(path) >= sizeof addr.sun_path) {
		hostSay(k->host, "sock: %s is too long for a socket's path", path);
		return -1;
	}
	strcpy(addr.sun_path, path);
	// the folder: made 0700, and made so if it is the user's
	char *dir = copyString(path), *slash = strrchr(dir, '/');
	if (slash && slash != dir) {
		*slash = 0;
		struct stat st;
		if (mkdir(dir, 0700) < 0 && stat(dir, &st) == 0 && st.st_uid == getuid()) chmod(dir, 0700);
	}
	free(dir);
	struct stat st;
	if (lstat(path, &st) == 0) {
		if (!S_ISSOCK(st.st_mode)) {
			hostSay(k->host, "sock: %s is there and not a socket: left as it is", path);
			return -1;
		}
		int probe = socket(AF_UNIX, SOCK_STREAM, 0);
		bool live = probe >= 0 && connect(probe, (struct sockaddr *)&addr, sizeof addr) == 0;
		if (probe >= 0) close(probe);
		if (live) {
			hostSay(k->host, "sock: another ermineOS listens on %s: left to it", path);
			return -1;
		}
		unlink(path); // a crashed run's
	}
	int fd = socket(AF_UNIX, SOCK_STREAM, 0);
	if (fd < 0) return -1;
	if (bind(fd, (struct sockaddr *)&addr, sizeof addr) < 0 || chmod(path, 0600) < 0 || listen(fd, 16) < 0) {
		hostSay(k->host, "sock: %s: %s", path, strerror(errno));
		close(fd);
		return -1;
	}
	if (lstat(path, &st) == 0) k->ino = st.st_ino;
	fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
	fcntl(fd, F_SETFD, FD_CLOEXEC);
	return fd;
}

// --- to the socket: what waits is written as it is taken

/** false when the socket is gone */
static bool give(Sock *k, Conn *c, const uint8_t *bytes, size_t n) {
	if (c->fd < 0) return false;
	if (!n) return true;
	if (!c->waiting) {
		ssize_t w = write(c->fd, bytes, n);
		if (w > 0) bytes += w, n -= (size_t)w;
		if (!n) return true;
		if (w < 0 && errno != EAGAIN && errno != EINTR) return false;
	}
	pthread_mutex_lock(&k->lock);
	c->wait = realloc(c->wait, c->waiting + n);
	memcpy(c->wait + c->waiting, bytes, n);
	c->waiting += n;
	pthread_mutex_unlock(&k->lock);
	poke(k); // the watcher polls for POLLOUT now
	return true;
}

static void flush(Sock *k, Conn *c) {
	pthread_mutex_lock(&k->lock);
	while (c->waiting && c->fd >= 0) {
		ssize_t w = write(c->fd, c->wait, c->waiting);
		if (w <= 0) {
			if (w < 0 && errno != EAGAIN && errno != EINTR) c->waiting = 0; // gone: nothing to wait for
			break;
		}
		memmove(c->wait, c->wait + w, c->waiting - (size_t)w);
		c->waiting -= (size_t)w;
	}
	pthread_mutex_unlock(&k->lock);
}

/** a connection let go: its shell killed (unless it ended itself), its node unplaced, the socket closed */
static void hangup(const ErmGiven *g, Sock *k, Conn *c, const char *why) {
	Json *shell = at(c, "shell");
	// core kills by hand: taken out of its list and outro'd (hostKill)
	if (c->pid && drvHas(g->api, shell)) drvKill(c->pid);
	char n[16], *id = formatString("sock/%d", c->n);
	snprintf(n, sizeof n, "%d", c->n);
	if (drvHas(g->api, c->at)) drvOp(g->api, "unplace", drvMap("address", drvPath("/", "dev", "sock", NULL), "name", jsonString(n), "id", jsonString(id), NULL));
	free(id);
	pthread_mutex_lock(&k->lock);
	if (c->fd >= 0) close(c->fd);
	c->fd = -1;
	for (int i = 0; i < k->conns.count; i++)
		if (k->conns.items[i] == c) {
			memmove(&k->conns.items[i], &k->conns.items[i + 1], (size_t)(k->conns.count - i - 1) * sizeof *k->conns.items);
			k->conns.count--;
			break;
		}
	pthread_mutex_unlock(&k->lock);
	hostSay(k->host, "sock %d: %s", c->n, why);
	free(c->wait);
	free(c->pid);
	free(c);
}

// --- the thread

static void *watch(void *data) {
	Sock *k = data;
	struct pollfd fds[MOST + 2];
	for (;;) {
		int n = 0;
		pthread_mutex_lock(&k->lock);
		if (k->stopping) {
			pthread_mutex_unlock(&k->lock);
			return NULL;
		}
		fds[n++] = (struct pollfd){ k->wake[0], POLLIN, 0 };
		fds[n++] = (struct pollfd){ k->listen, POLLIN, 0 };
		for (int i = 0; i < k->conns.count && n < MOST + 2; i++) {
			Conn *c = k->conns.items[i];
			if (c->fd >= 0) fds[n++] = (struct pollfd){ c->fd, (short)((c->ended ? 0 : POLLIN) | (c->waiting ? POLLOUT : 0)), 0 };
		}
		pthread_mutex_unlock(&k->lock);
		if (poll(fds, (nfds_t)n, -1) < 0) continue;
		if (fds[0].revents & POLLIN) {
			char b[64];
			if (read(k->wake[0], b, sizeof b) < 0) { }
		}
		bool any = false;
		for (int i = 1; i < n; i++) any = any || fds[i].revents;
		if (!any) continue;
		pthread_mutex_lock(&k->lock);
		if (!k->stopping) {
			k->posted = true;
			ermosPost("{\"irq\": 64}");
			while (k->posted && !k->stopping) pthread_cond_wait(&k->taken, &k->lock);
		}
		pthread_mutex_unlock(&k->lock);
	}
	return NULL;
}

// --- the turn

/** CSI 8 ; rows ; cols t at p: its length, and the size; 0 when it is not one */
static size_t sized(const uint8_t *p, size_t left, int *rows, int *cols) {
	if (left < 7 || memcmp(p, "\x1b[8;", 4)) return 0;
	size_t i = 4;
	int v[2] = { 0, 0 };
	for (int k = 0; k < 2; k++) {
		size_t from = i;
		while (i < left && p[i] >= '0' && p[i] <= '9' && i - from < 5) v[k] = v[k] * 10 + (p[i++] - '0');
		if (i == from || i >= left) return 0;
		if (p[i++] != (k ? 't' : ';')) return 0;
	}
	*rows = v[0], *cols = v[1];
	return i;
}

/** the far terminal's size: to vt, and to each session whose to lists this line */
static void resize(const ErmGiven *g, Conn *c, int rows, int cols) {
	if (rows < 1 || cols < 1 || rows > 1000 || cols > 1000) return;
	Json *size = drvMap("cols", jsonInteger(cols), "rows", jsonInteger(rows), NULL);
	Json *was = drvRead(g->api, at(c, "vt"));
	if (was && jsonEqual(was, size)) return;
	drvSnap(g->api, at(c, "vt"), size);
	Json *names = drvNames(g->api, drvPath("/", "dev", "pty", NULL));
	for (int i = 0; jsonIsArray(names) && i < names->array.count; i++) {
		const char *n = jsonText(names->array.items[i]);
		if (!n || !strcmp(n, "driver")) continue;
		Json *there = drvPath("/", "dev", "pty", n, NULL), *elsewhere = jsonGet(drvRead(g->api, there), "at");
		Json *base = jsonIsArray(elsewhere) ? elsewhere : there, *to = drvRead(g->api, drvUnder(base, "to", NULL));
		for (int j = 0; jsonIsArray(to) && j < to->array.count; j++)
			if (jsonEqual(to->array.items[j], c->at)) drvSnap(g->api, drvUnder(base, "size", NULL), jsonShallow(size));
	}
}

/** bytes from the socket: sizes taken out, the rest appended to rx */
static void came(const ErmGiven *g, Conn *c, const uint8_t *bytes, size_t n) {
	uint8_t *keep = malloc(n + 1);
	size_t m = 0;
	for (size_t i = 0; i < n;) {
		int rows, cols;
		size_t s = bytes[i] == 0x1b ? sized(bytes + i, n - i, &rows, &cols) : 0;
		if (s) {
			resize(g, c, rows, cols);
			i += s;
		} else keep[m++] = bytes[i++];
	}
	if (m) {
		Json *old = bytesOf(drvRead(g->api, at(c, "rx")));
		size_t had = old ? old->bytes.length : 0, total = had + m, from = total > KEEP ? total - KEEP : 0;
		uint8_t *all = malloc(total + 1);
		if (had) memcpy(all, old->bytes.data, had);
		memcpy(all + had, keep, m);
		drvSnap(g->api, at(c, "rx"), jsonBytes(all + from, total - from));
		free(all);
		Json *stats = drvRead(g->api, at(c, "stats"));
		drvSet(g->api, at(c, "stats"), "rx", jsonInteger(whole(jsonGet(stats, "rx"), 0) + (int64_t)m));
	}
	free(keep);
}

/** a connection taken: its node, its line, and its shell, as the person */
static void connected(const ErmGiven *g, Sock *k, int fd) {
	fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
	fcntl(fd, F_SETFD, FD_CLOEXEC);
	int on = 1;
	setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof on);
	if (k->conns.count >= MOST) {
		const char *full = "ermine: too many connections\r\n";
		if (write(fd, full, strlen(full)) < 0) { }
		close(fd);
		return;
	}
	Conn *c = calloc(1, sizeof *c);
	c->n = ++k->count;
	c->fd = fd;
	char n[16], *id = formatString("sock/%d", c->n);
	snprintf(n, sizeof n, "%d", c->n);
	Json *dev = drvPath("/", "dev", "sock", NULL);
	c->at = drvUnder(dev, n, NULL);
	drvMake(g->api, dev, n, id, drvMap("shell", jsonNull(), NULL));
	free(id);
	const char *names[] = { "rx", "tx", "stats", "vt" };
	Json *values[] = { jsonBytes("", 0), jsonBytes("", 0), drvMap("rx", jsonInteger(0), "tx", jsonInteger(0), NULL), jsonNull() };
	for (int i = 0; i < 4; i++) {
		char *nid = formatString("sock/%d/%s", c->n, names[i]);
		drvMake(g->api, c->at, names[i], nid, values[i]);
		free(nid);
	}
	pthread_mutex_lock(&k->lock);
	ERM_PUSH(k->conns, c);
	pthread_mutex_unlock(&k->lock);
	// the shell, as the console's (the image's boot list): programs/shell, data {line}; a start has no
	// actor, so the shell starts as the processes do (AFFORDANCES: start as someone)
	Json *line = drvPath("dev", "sock", n, NULL);
	size_t na, np;
	const char *const *address = hostPathOf(k->host, c->at, &na), *const *program = hostPath(k->host, &np, "programs", "shell", NULL);
	op_value *data = valOf(drvMap("line", line, NULL));
	ap_startop op = { .address = address, .naddress = na, .program = program, .nprogram = np, .name = "shell", .data = data };
	const char *pid = NULL;
	const ap_error *err = address ? ap_start(g->sc, &op, &pid) : NULL;
	op_free(data);
	if (err || !pid) {
		char *say = formatString("ermine: no shell: %s\r\n", err && err->message ? err->message : err && err->code ? err->code : "");
		give(k, c, (const uint8_t *)say, strlen(say));
		free(say);
		c->closing = true;
		return;
	}
	c->pid = copyString(pid);
	drvSet(g->api, c->at, "shell", jsonString(pid));
	hostSay(k->host, "sock %d: connected, shell %s", c->n, pid);
}

/** irq 64: connections taken, each read dry, what waits sent, the closed let go */
static ErmErr sockIrq(void *data, const ErmGiven *g, Json **out) {
	Sock *k = data;
	*out = jsonNull();
	int had = k->conns.count;
	for (int fd; k->listen >= 0 && (fd = accept(k->listen, NULL, NULL)) >= 0;) connected(g, k, fd);
	uint8_t buf[65536];
	for (int i = k->conns.count - 1; i >= 0; i--) {
		Conn *c = k->conns.items[i];
		// one taken this turn is read the next, once its shell has run: what was typed ahead is its
		if (i >= had && !c->closing) continue;
		flush(k, c);
		if (c->closing && !c->waiting) {
			hangup(g, k, c, "closed");
			continue;
		}
		size_t got = 0;
		bool eof = false, gone = false;
		while (!c->ended && c->fd >= 0) {
			ssize_t r = read(c->fd, buf + got, sizeof buf - got);
			if (r > 0) {
				got += (size_t)r;
				if (got == sizeof buf) came(g, c, buf, got), got = 0;
				continue;
			}
			if (r < 0 && (errno == EAGAIN || errno == EINTR)) break;
			if (r < 0) gone = true; // reset
			eof = true;
			break;
		}
		if (got) came(g, c, buf, got);
		// its input ended: gone altogether (hung up), or only its sending side (a script's end, a ctrl-d).
		// Polled for writing, a socket hung up says POLLHUP, one only shut says POLLOUT
		struct pollfd q = { c->fd, POLLOUT, 0 };
		if (c->fd >= 0 && eof && poll(&q, 1, 0) > 0 && q.revents & (POLLHUP | POLLERR)) gone = true;
		if (gone) {
			hangup(g, k, c, "hung up");
			continue;
		}
		if (eof && !c->ended) {
			c->ended = true;
			came(g, c, (const uint8_t *)"\x04", 1);
		}
	}
	pthread_mutex_lock(&k->lock);
	k->posted = false;
	pthread_cond_signal(&k->taken);
	pthread_mutex_unlock(&k->lock);
	return ermOk();
}

// --- what is written: each line's tx to its socket; a shell or a node gone, a hangup

/** [[n, there, shell there, tx], ...], read tracked */
static ErmErr sendCompute(void *data, const ErmGiven *g, Json **out) {
	Sock *k = data;
	*out = jsonArray();
	// read so a connection made since runs this again
	drvNames(g->api, drvPath("/", "dev", "sock", NULL));
	for (int i = 0; i < k->conns.count; i++) {
		Conn *c = k->conns.items[i];
		Json *row = jsonArray();
		bool there = drvHas(g->api, c->at);
		Json *tx = there ? bytesOf(drvRead(g->api, at(c, "tx"))) : NULL;
		jsonPush(row, jsonInteger(c->n));
		jsonPush(row, jsonBoolean(there));
		jsonPush(row, jsonBoolean(there && drvHas(g->api, at(c, "shell"))));
		jsonPush(row, tx ? tx : jsonBytes("", 0));
		jsonPush(*out, row);
	}
	return ermOk();
}

static ErmErr sendEffect(void *data, const ErmGiven *g, Json **out) {
	Sock *k = data;
	*out = jsonNull();
	for (int i = 0; jsonIsArray(g->value) && i < g->value->array.count; i++) {
		Json *row = g->value->array.items[i];
		int n = (int)whole(row->array.items[0], 0);
		Conn *c = NULL;
		for (int j = 0; j < k->conns.count && !c; j++) if (k->conns.items[j]->n == n) c = k->conns.items[j];
		if (!c) continue;
		if (!row->array.items[1]->boolean) {
			hangup(g, k, c, "unplaced, hung up");
			continue;
		}
		Json *tx = bytesOf(row->array.items[3]);
		if (tx && tx->bytes.length) {
			bool there = give(k, c, tx->bytes.data, tx->bytes.length);
			Json *stats = drvRead(g->api, at(c, "stats"));
			drvSnap(g->api, at(c, "tx"), jsonBytes("", 0));
			drvSet(g->api, at(c, "stats"), "tx", jsonInteger(whole(jsonGet(stats, "tx"), 0) + (int64_t)tx->bytes.length));
			// its input had ended, and now it is gone too: found as it is written to
			if (!there) {
				hangup(g, k, c, "hung up");
				continue;
			}
		}
		// its shell ended (exit, ctrl-d): the connection closes once what it said is sent
		if (c->pid && !row->array.items[2]->boolean && !c->closing) {
			c->closing = true;
			flush(k, c);
			if (!c->waiting) hangup(g, k, c, "its shell ended, closed");
			else poke(k);
		}
	}
	return ermOk();
}

/** at power off: the thread stopped, every connection closed, the socket unlinked */
void sockStop(void) {
	Sock *k = running;
	if (!k) return;
	running = NULL;
	pthread_mutex_lock(&k->lock);
	k->stopping = true;
	pthread_cond_broadcast(&k->taken);
	pthread_mutex_unlock(&k->lock);
	poke(k);
	if (k->watching) pthread_join(k->watcher, NULL);
	for (int i = 0; i < k->conns.count; i++)
		if (k->conns.items[i]->fd >= 0) close(k->conns.items[i]->fd);
	k->conns.count = 0;
	if (k->listen >= 0) {
		close(k->listen);
		struct stat st;
		if (lstat(k->path, &st) == 0 && st.st_ino == k->ino) unlink(k->path);
	}
	k->listen = -1;
}

ErmErr driverSock(void *data, const ErmGiven *g, Json **out) {
	*out = jsonNull();
	sockStop(); // a boot before this one's, in the same run
	Sock *k = calloc(1, sizeof *k);
	k->host = data;
	k->listen = -1;
	const char *given = getenv("ERMINE_SOCK");
	const char *home = getenv("HOME") && *getenv("HOME") ? getenv("HOME") : "/tmp";
	k->path = given && *given ? copyString(given) : formatString("%s/.ermine/shell.sock", home);
	Json *dev = drvPath("/", "dev", "sock", NULL);
	if (pipe(k->wake) < 0) {
		hostSay(k->host, "sock: no pipe");
		return ermOk();
	}
	for (int i = 0; i < 2; i++) fcntl(k->wake[i], F_SETFL, O_NONBLOCK), fcntl(k->wake[i], F_SETFD, FD_CLOEXEC);
	k->listen = listenOn(k, k->path);
	drvMake(g->api, dev, "socket", "sock/socket", drvMap("path", k->listen >= 0 ? jsonString(k->path) : jsonNull(), NULL));
	if (k->listen < 0) return ermOk();
	hostSay(k->host, "sock: a shell on %s", k->path);
	Json *here = drvHere(g);
	drvHandler(g, here, "irq", (ErmFn){ sockIrq, k });
	drvClaim(g, here, IRQ);
	drvChild(g, here, "send", (ErmFn){ sendCompute, k }, (ErmFn){ sendEffect, k });
	pthread_mutex_init(&k->lock, NULL);
	pthread_cond_init(&k->taken, NULL);
	k->watching = pthread_create(&k->watcher, NULL, watch, k) == 0;
	running = k;
	return ermOk();
}
