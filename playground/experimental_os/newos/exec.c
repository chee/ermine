// exec.c: the exec runner. A program of type
// party.chee.ermine.exec, its value {argv: [...]}, is an
// executable run as a Mac process of its own (posix_spawn), the OS at the
// other end of a socket on its fd 3 (ERMINE_FD), speaking the ABI below:
// libermine (lib/libermine.h) for C. argv[0] with no "/" is one of
// ermineOS's own programs, built beside the OS: programs/<name> in the OS
// binary's folder (headless.sh), else build/newos/programs/<name> there
// (build.sh's, beside playground/experimental_os/mac/ermineOS), else
// ../Resources/programs/<name> (an app's, app.sh's).
//
// Its process's setup starts it, places on/io inside the process's node,
// and gives the process's value, {path, argv, mac}: mac its Mac pid. A
// thread of its own, the pump, moves its bytes and never the OS's thread: in,
// what the program sends (frames on fd 3, lines on its stdout and stderr),
// held for the host's turn, which it wakes on EXEC_IRQ; out, the answers and
// events queued for it. The host's turn calls on/io, as the machine, and the
// handler answers each frame through its own api: as the machine, then the
// process (a handler acts as its caller, then the process that placed it). The
// program's environment says who it is: ERMINE_PID, the process's id, and
// ERMINE_NODE, its node's path.
//
// A program that does not read: what it asks waits. Past FRAMES frames held,
// or FULL bytes it has not taken, its socket is not read until it takes them;
// it is never ended for it, and the OS never waits on it. An event for it
// past MOST bytes waiting is refused ("busy").
//
// Its node is at its path for as long as it runs (a process's row): it is
// never renamed or moved, so on/io is where it was put.
//
// The ABI (frames: abi.h). From the program, each answered in order:
//   {seq, op, fields: {...}} → {seq, ok: v} or {seq, error: {code, message, name?}}
// op is core's process api, what a JavaScript program's part is given
// (PROGRAMS.md), fields named: each is a word of the one dispatch (words.h),
// its fields that word's arguments by name, its answer as Json. An address is
// a list of names, read from the process's place ("/" first: from the root);
// cause, in any op's fields, is api.as({cause}):
//   look, lookup, lookups, content {address}      → items
//   children {address, name?}                     → names; with name, that list's items
//   info {address, name}                          → items
//   node {id}                                     → {id, value, info, children}, or null
//   write {address, patches, index?, slot?}       → time; patches core's {path, range?, value?, move?}
//   set {address, name, patches, index?, slot?}   → time
//   insert {id, name, child, index?, slot?}       → time
//   remove {id, name, index, slot?}               → time
//   pop {id, name, slot}                          → time
//   rename {id, name, to}                         → time
//   move {id, name, index, to, toname, toindex?}  → time
//   create {value?, id?, ephemeral?}              → id
//   start {address, program, name?, data?}        → pid; program a path, a list of names
//   call {address, args?}                         → null: a call from a part is queued
//   handler {name, fn}                            → <process>/on/<name>'s address: a handler
//                                                   whose calls come to the program as events
//   here {}                                       → the process's node, ["/", ...] (ermine:os here)
//   kill {pid}                                    → null: that process killed (ermine:os kill)
// An item is core's: {id, route, node?: {id}, ephemeral?, up?, refused?,
// versions?: [{content, change: {time, node?, actor?, reader?, site?,
// cause?}, because?}]}, a status's version because {layer: "scheduler",
// place: "status"}. A live value comes as a stand-in of kind "live".
// From the OS, never answered: {event: fn, args}, a handler the program
// placed called with args (a list). The program acts on it when it reads it,
// as its process; the call answers null at once. "io" is the OS's own.
// An answer it cannot be sent (larger than ABI_MOST, or no encoding) comes as
// {seq, error} instead.
//
// What the program prints on its stdout and stderr is said in the OS's log,
// "exec <pid>: line", and kept in <process>/log, its last 50 lines, a list
// (ephemeral, the process's).
//
// Ending. The program exiting ends its process (hostKill); an exit not 0,
// or a signal, fails on/io's last run, said in the log as any failed run. A
// frame that is not one ends it, said in the log.
// Its process ending (a kill, a window closed) sends the program's process
// group SIGTERM, shuts its socket, and SIGKILL TERM ms later to what is still
// there. What it started ends with it: the program exiting sends its group
// SIGTERM, then SIGKILL TERM ms later to what stays. Power off waits QUIT ms,
// not TERM. A thread of each program's reaps it: no zombie.

#define _DARWIN_C_SOURCE

#include "exec.h"

#include "abi.h"
#include "drv.h"
#include "words.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

#define KEPT 50          // the lines <process>/log keeps
#define HELD 1000        // lines held for the host's turn at most; past it the older half is counted, not kept
#define LONGEST 4096     // a line's bytes; a longer one is cut there
#define FRAMES 256       // frames held at most before its socket waits; and answered in one turn at most
#define FULL (1u << 20)  // bytes it has not taken at which its socket waits
#define MOST (16u << 20) // bytes it has not taken past which an event is refused
#define TERM 2000        // ms from SIGTERM to SIGKILL
#define QUIT 500         // the same at power off: the metal gives the OS about 3 s in all

typedef struct Exec Exec;

/** a function of a program's: its on/io, its cleanup, or a handler it placed (fn, its own number) */
typedef struct ExecFn {
	ap_fn base;
	Exec *x;
	int64_t fn;
} ExecFn;

struct Exec {
	int n;            // programs.items[n - 1]
	Host *host;
	char *pid, *name; // its process; argv[0]'s last name
	Json *here;       // its process's node, ["/", ...]
	char *ioId;       // on/io's node
	pid_t child;
	int fd, out;      // the OS's end of its socket (not blocking); its stdout and stderr
	int wake[2];      // a pipe that wakes the pump: something to send, or room for frames again
	int stop[2];      // a pipe the pump stops on
	pthread_t pump, waiter;
	pthread_mutex_t lock;
	pthread_cond_t cond;
	// the pump's own
	unsigned char *in; // what came on the socket, not a whole frame yet
	size_t inn, inroom;
	// under the lock
	ERM_LIST(Json *) frames; // what it sent, not answered yet
	ERM_LIST(char *) lines;  // what it printed, not said yet
	int dropped;             // lines not held: more than HELD waited
	unsigned char *queue;    // frames for it, sent from sent up to queued
	size_t sent, queued, room;
	const char *broken;      // a frame that was not one
	bool waking;             // a wake is posted and not taken
	bool rung;               // a byte is in wake, not read yet
	bool stalled;            // the pump does not read the socket: too much waits
	bool deaf;               // nothing more reaches it: its end of the socket is gone
	bool reaped, drained;    // it was reaped (status); the pump is done
	bool killing, swept;     // its group asked to end (the killer runs); and ended
	int status;
	// the OS's thread's
	bool gone;               // its process ended
	bool ended;              // its exit taken: threads joined, descriptors closed
	char *log[KEPT];         // its last lines, oldest first
	int nlog;
	ExecFn io, cleanup;
};

/** a program node's setup: its argv */
typedef struct Program {
	ap_fn base;
	Host *host;
	char **argv;
	int argc;
} Program;

static ERM_LIST(Exec *) programs; // program n is programs.items[n - 1]

// --- small things

static struct timespec in(int ms) {
	struct timespec t;
	clock_gettime(CLOCK_REALTIME, &t);
	t.tv_sec += ms / 1000;
	t.tv_nsec += (long)(ms % 1000) * 1000000;
	if (t.tv_nsec >= 1000000000) t.tv_sec++, t.tv_nsec -= 1000000000;
	return t;
}

/** an exit or a signal said: "exited 0", "killed: Terminated: 15" */
static void how(int status, char *out, size_t n) {
	if (status == -1) snprintf(out, n, "ended (its status was taken elsewhere)");
	else if (WIFEXITED(status)) snprintf(out, n, "exited %d", WEXITSTATUS(status));
	else if (WIFSIGNALED(status)) snprintf(out, n, "killed: %s%s", strsignal(WTERMSIG(status)), WCOREDUMP(status) ? " (core dumped)" : "");
	else snprintf(out, n, "ended (%d)", status);
}

static bool failed(int status) {
	return status != -1 && !(WIFEXITED(status) && WEXITSTATUS(status) == 0);
}

/** the process's node and up to two names after it, as an address for this turn (hostTemp) */
static const char *const *under(Exec *x, size_t *n, const char *a, const char *b) {
	int k = x->here->array.count;
	const char **out = hostTemp(x->host, sizeof *out * (size_t)(k + 3));
	for (int i = 0; i < k; i++) out[i] = jsonText(x->here->array.items[i]);
	*n = (size_t)k;
	if (a) out[(*n)++] = a;
	if (b) out[(*n)++] = b;
	out[*n] = NULL;
	return out;
}

/** a line as the graph takes text: valid UTF-8, no NUL; each byte that is not, "?" */
static char *text(const char *bytes, size_t n) {
	char *t = malloc(n + 1);
	size_t k = 0;
	for (size_t i = 0; i < n;) {
		unsigned char c = (unsigned char)bytes[i];
		size_t more = c < 0x80 ? 0 : (c & 0xe0) == 0xc0 && c >= 0xc2 ? 1 : (c & 0xf0) == 0xe0 ? 2 : (c & 0xf8) == 0xf0 && c <= 0xf4 ? 3 : 4;
		bool ok = more < 4 && i + more < n;
		for (size_t j = 1; ok && j <= more; j++) ok = ((unsigned char)bytes[i + j] & 0xc0) == 0x80;
		if (ok && more == 2) ok = !(c == 0xe0 && (unsigned char)bytes[i + 1] < 0xa0) && !(c == 0xed && (unsigned char)bytes[i + 1] >= 0xa0);
		if (ok && more == 3) ok = !(c == 0xf0 && (unsigned char)bytes[i + 1] < 0x90) && !(c == 0xf4 && (unsigned char)bytes[i + 1] >= 0x90);
		if (!ok || !c) {
			t[k++] = '?';
			i++;
			continue;
		}
		memcpy(t + k, bytes + i, more + 1);
		k += more + 1;
		i += more + 1;
	}
	t[k] = 0;
	return t;
}

// --- the program's threads: the pump (what it sends and prints, what it is sent), its exit, its group

static void post(Exec *x, bool exited) {
	char record[96];
	snprintf(record, sizeof record, "{\"irq\": %d, \"exec\": %d%s}", EXEC_IRQ, x->n, exited ? ", \"exited\": true" : "");
	ermosPost(record);
}

/** a frame or a line (taken) held for the host's turn, which is woken unless it is already */
static void take(Exec *x, Json *frame, char *line) {
	pthread_mutex_lock(&x->lock);
	if (frame) ERM_PUSH(x->frames, frame);
	// too many waiting: the older half let go, so what it printed last is what is said
	if (line && x->lines.count == HELD) {
		for (int i = 0; i < HELD / 2; i++) free(x->lines.items[i]);
		memmove(x->lines.items, x->lines.items + HELD / 2, sizeof *x->lines.items * (HELD - HELD / 2));
		x->lines.count -= HELD / 2;
		x->dropped += HELD / 2;
	}
	if (line) ERM_PUSH(x->lines, line);
	bool wake = !x->waking;
	x->waking = true;
	pthread_mutex_unlock(&x->lock);
	if (wake) post(x, false);
}

/** the pump woken (under the lock): something to send, or room for frames again */
static void ring(Exec *x) {
	if (x->rung) return;
	x->rung = true;
	if (write(x->wake[1], "", 1) < 0) {}
}

/** a frame queued for the program, the pump sends it: NULL, or why not, with its code (an event: refused past MOST waiting) */
static const char *tell(Exec *x, const Json *message, bool event, const char **code) {
	const char *why = NULL;
	size_t n = 0;
	unsigned char *frame = abiFrame(message, &n, &why);
	if (!frame) {
		*code = why && strstr(why, "larger") ? "too-large" : "wrong-field";
		return why ? why : "it has no encoding";
	}
	pthread_mutex_lock(&x->lock);
	if (x->deaf) *code = "stopped", why = "the program's end of its socket is gone";
	else if (event && x->queued - x->sent + n > MOST) *code = "busy", why = "the program is not reading: too much waits for it";
	else {
		if (x->queued + n > x->room) {
			// what was sent let go of first; then room for it
			memmove(x->queue, x->queue + x->sent, x->queued - x->sent);
			x->queued -= x->sent, x->sent = 0;
			if (x->queued + n > x->room) {
				x->room = x->queued + n > x->room * 2 ? x->queued + n : x->room * 2;
				x->queue = realloc(x->queue, x->room);
			}
		}
		memcpy(x->queue + x->queued, frame, n);
		x->queued += n;
		ring(x);
	}
	pthread_mutex_unlock(&x->lock);
	free(frame);
	return why;
}

/** what waits for the program sent, as much as its socket takes now (under the lock: the socket does not block) */
static void give(Exec *x) {
	while (x->sent < x->queued) {
		ssize_t w = send(x->fd, x->queue + x->sent, x->queued - x->sent, 0);
		if (w < 0 && errno == EINTR) continue;
		if (w < 0 && errno == EAGAIN) return;
		if (w <= 0) {
			// its end is gone: nothing more reaches it
			x->deaf = true;
			break;
		}
		x->sent += (size_t)w;
	}
	x->sent = x->queued = 0;
	if (x->room > FULL) free(x->queue), x->queue = NULL, x->room = 0;
}

/** a frame that was not one: no more are read, its socket is shut, and the host's turn ends it */
static void broke(Exec *x, const char *why) {
	pthread_mutex_lock(&x->lock);
	x->broken = why;
	pthread_mutex_unlock(&x->lock);
	shutdown(x->fd, SHUT_RDWR);
	take(x, NULL, NULL);
}

/** what came on its socket read, each whole frame held: false at its end, or on a frame that is not one */
static bool hear(Exec *x) {
	if (x->inroom - x->inn < 65536) {
		x->inroom = x->inn + 65536;
		x->in = realloc(x->in, x->inroom);
	}
	ssize_t r = recv(x->fd, x->in + x->inn, x->inroom - x->inn, 0);
	if (r < 0) return errno == EINTR || errno == EAGAIN;
	if (r == 0) return false;
	x->inn += (size_t)r;
	size_t at = 0, need = 0;
	const char *why = NULL;
	while (x->inn - at >= 4) {
		const unsigned char *h = x->in + at;
		size_t n = (size_t)h[0] | (size_t)h[1] << 8 | (size_t)h[2] << 16 | (size_t)h[3] << 24;
		if (n > ABI_MOST) {
			why = "a frame larger than the ABI allows";
			break;
		}
		if (x->inn - at - 4 < n) {
			// a frame not whole yet: room for it, so it comes in few reads
			need = 4 + n;
			break;
		}
		Json *frame = abiDecode(h + 4, n, &why);
		if (!frame) {
			if (!why) why = "a frame that is not one";
			break;
		}
		take(x, frame, NULL);
		at += 4 + n;
	}
	memmove(x->in, x->in + at, x->inn - at);
	x->inn -= at;
	if (need > x->inroom) x->inroom = need, x->in = realloc(x->in, need);
	else if (!x->inn && x->inroom > FULL) free(x->in), x->in = NULL, x->inroom = 0;
	if (why) {
		broke(x, why);
		return false;
	}
	return true;
}

/**
 * The pump: frames in from its socket, held for the host's turn; what waits for it out; lines in
 * from its stdout and stderr. Until all three are done, or it is stopped. Never waits on the OS's
 * thread, nor the OS's thread on it: a frame half sent, or a program not reading, holds up only it.
 */
static void *pump(void *data) {
	Exec *x = data;
	char *line = malloc(LONGEST);
	size_t have = 0;
	bool frames = true, lines = true;
	for (;;) {
		pthread_mutex_lock(&x->lock);
		// too much waits, frames not taken or answers it has not: what it asks waits in its socket
		bool full = x->frames.count >= FRAMES || x->queued - x->sent >= FULL;
		x->stalled = frames && full;
		bool sending = !x->deaf && x->sent < x->queued;
		pthread_mutex_unlock(&x->lock);
		if (!frames && !lines && !sending) break;
		short asks = (short)((frames && !full ? POLLIN : 0) | (sending ? POLLOUT : 0));
		struct pollfd p[4] = { { asks ? x->fd : -1, asks, 0 }, { lines ? x->out : -1, POLLIN, 0 }, { x->wake[0], POLLIN, 0 }, { x->stop[0], POLLIN, 0 } };
		if (poll(p, 4, -1) < 0) {
			if (errno == EINTR) continue;
			break;
		}
		if (p[3].revents) break;
		if (p[2].revents) {
			char bytes[64];
			while (read(x->wake[0], bytes, sizeof bytes) > 0) {}
			pthread_mutex_lock(&x->lock);
			x->rung = false;
			pthread_mutex_unlock(&x->lock);
		}
		if (sending && p[0].revents & (POLLOUT | POLLHUP | POLLERR)) {
			pthread_mutex_lock(&x->lock);
			give(x);
			pthread_mutex_unlock(&x->lock);
		}
		if (frames && p[0].revents & (POLLIN | POLLHUP | POLLERR)) frames = hear(x);
		if (p[1].revents) {
			char bytes[4096];
			ssize_t r = read(x->out, bytes, sizeof bytes);
			if (r < 0 && errno == EINTR) continue;
			if (r <= 0) {
				lines = false;
				continue;
			}
			for (ssize_t i = 0; i < r; i++) {
				if (bytes[i] == '\n') {
					if (have && line[have - 1] == '\r') have--;
					take(x, NULL, text(line, have));
					have = 0;
				} else if (have < LONGEST) line[have++] = bytes[i];
			}
		}
	}
	if (have) take(x, NULL, text(line, have));
	free(line);
	free(x->in);
	x->in = NULL, x->inn = x->inroom = 0;
	pthread_mutex_lock(&x->lock);
	// nothing more reaches it
	x->deaf = true;
	free(x->queue);
	x->queue = NULL, x->sent = x->queued = x->room = 0;
	x->drained = true;
	pthread_cond_broadcast(&x->cond);
	pthread_mutex_unlock(&x->lock);
	return NULL;
}

static bool past(struct timespec t) {
	struct timespec now;
	clock_gettime(CLOCK_REALTIME, &now);
	return now.tv_sec > t.tv_sec || (now.tv_sec == t.tv_sec && now.tv_nsec >= t.tv_nsec);
}

/**
 * Its group asked to end (SIGTERM): SIGKILL TERM ms later to the program and what it started, if
 * any is still there. Done once it is reaped and its group is empty: its zombie holds the group's
 * id until it is reaped, and after, the id is not given again while any of the group is left.
 * Detached: x is never let go of.
 */
static void *killer(void *data) {
	Exec *x = data;
	pthread_mutex_lock(&x->lock);
	struct timespec until = in(TERM);
	while (!x->reaped || !kill(-x->child, 0)) {
		struct timespec soon = in(50);
		if (soon.tv_sec > until.tv_sec || (soon.tv_sec == until.tv_sec && soon.tv_nsec > until.tv_nsec)) soon = until;
		pthread_cond_timedwait(&x->cond, &x->lock, &soon);
		if (past(until)) {
			kill(-x->child, SIGKILL);
			if (!x->reaped) kill(x->child, SIGKILL);
			break;
		}
	}
	x->swept = true;
	pthread_cond_broadcast(&x->cond);
	pthread_mutex_unlock(&x->lock);
	return NULL;
}

/** the killer started, once (under the lock) */
static void sweep(Exec *x) {
	if (x->killing) return;
	pthread_t t;
	x->killing = true;
	if (pthread_create(&t, NULL, killer, x)) x->swept = true;
	else pthread_detach(t);
}

/** waits for the program to exit, ends what it started, and reaps it; tells the host once what it printed last is read (300 ms at most) */
static void *waiter(void *data) {
	Exec *x = data;
	siginfo_t info;
	// waited for, not reaped: until it is, under the lock, a signal sent reaches it or its zombie, never a pid given again
	bool waited = false;
	for (;;) {
		if (!waitid(P_PID, (id_t)x->child, &info, WEXITED | WNOWAIT)) {
			waited = true;
			break;
		}
		if (errno != EINTR) break;
	}
	int status = 0;
	pid_t got = -1;
	if (!waited)
		while ((got = waitpid(x->child, &status, 0)) < 0 && errno == EINTR) {}
	pthread_mutex_lock(&x->lock);
	if (waited) {
		// what it started ends with it: its group, while its zombie still holds the group's id
		kill(-x->child, SIGTERM);
		while ((got = waitpid(x->child, &status, 0)) < 0 && errno == EINTR) {}
	}
	x->status = got == x->child ? status : -1;
	x->reaped = true;
	sweep(x);
	pthread_cond_broadcast(&x->cond);
	struct timespec until = in(300);
	while (!x->drained && pthread_cond_timedwait(&x->cond, &x->lock, &until) != ETIMEDOUT) {}
	pthread_mutex_unlock(&x->lock);
	post(x, true);
	return NULL;
}

/** asks the program to end: SIGTERM to its process group, its socket shut; SIGKILL TERM ms later to what stays */
static void end(Exec *x) {
	pthread_mutex_lock(&x->lock);
	if (!x->reaped) {
		kill(-x->child, SIGTERM);
		kill(x->child, SIGTERM);
	}
	sweep(x);
	pthread_mutex_unlock(&x->lock);
	if (x->fd >= 0) shutdown(x->fd, SHUT_RDWR);
}

/** the program reaped: its pump and waiter joined, its descriptors closed, what still waited let go */
static void finish(Exec *x) {
	if (write(x->stop[1], "", 1) < 0) {}
	if (x->fd >= 0) shutdown(x->fd, SHUT_RDWR);
	pthread_join(x->pump, NULL);
	pthread_join(x->waiter, NULL);
	int *fds[] = { &x->fd, &x->out, &x->wake[0], &x->wake[1], &x->stop[0], &x->stop[1] };
	for (int i = 0; i < 6; i++)
		if (*fds[i] >= 0) close(*fds[i]), *fds[i] = -1;
	pthread_mutex_lock(&x->lock);
	for (int i = 0; i < x->frames.count; i++) jsonFree(x->frames.items[i]);
	for (int i = 0; i < x->lines.count; i++) free(x->lines.items[i]);
	free(x->frames.items);
	free(x->lines.items);
	x->frames.items = NULL, x->lines.items = NULL;
	x->frames.count = x->frames.capacity = x->lines.count = x->lines.capacity = 0;
	pthread_mutex_unlock(&x->lock);
}

// --- what it printed: the OS's log, and <process>/log

/** a line said in the log and kept among the last KEPT (taken) */
static void keep(Exec *x, char *line) {
	hostSay(x->host, "exec %s: %s", x->pid, line);
	if (x->nlog == KEPT) {
		free(x->log[0]);
		memmove(x->log, x->log + 1, sizeof *x->log * (KEPT - 1));
		x->nlog--;
	}
	x->log[x->nlog++] = line;
}

/** the lines waiting, each kept; true if there were any */
static bool lines(Exec *x) {
	pthread_mutex_lock(&x->lock);
	char **items = x->lines.items;
	int count = x->lines.count, dropped = x->dropped;
	x->lines.items = NULL, x->lines.count = x->lines.capacity = 0, x->dropped = 0;
	pthread_mutex_unlock(&x->lock);
	if (dropped) keep(x, formatString("(%d lines not kept: it printed faster than they were read)", dropped));
	for (int i = 0; i < count; i++) keep(x, items[i]);
	free(items);
	return count || dropped;
}

/** <process>/log written whole, or made (ephemeral, the process's), through api */
static void writeLog(Exec *x, ap_given *g) {
	op_value *list = op_list();
	for (int i = 0; i < x->nlog; i++) op_push(list, op_str(x->log[i]));
	char doing[96];
	snprintf(doing, sizeof doing, "exec %s: its log", x->pid);
	size_t n;
	const char *const *at = under(x, &n, "log", NULL);
	if (hostLook(g->api, at, n)) hostFailed(x->host, hostSnap(g->api, at, n, list), doing);
	else {
		const char *made = NULL;
		if (!hostFailed(x->host, ap_create(g->api, list, NULL, 1, &made), doing)) hostFailed(x->host, ap_insert(g->api, g->self, "log", made, NULL, NULL), doing);
	}
	op_free(list);
}

/** a string field, for this turn; NULL if it is not one */
static const char *textOf(Host *h, const Json *f, const char *key) {
	const char *t = jsonText(jsonGet(f, key));
	return t ? hostTempDup(h, t) : NULL;
}

// --- a handler the program placed: its calls go to the program, as events

static const ap_error *event(ap_fn *self, ap_given *g, op_value **out, int *pending) {
	(void)pending;
	ExecFn *f = (ExecFn *)self;
	Exec *x = f->x;
	*out = NULL;
	if (x->gone || x->ended) return ap_error_new(g->os, "stopped", "the program has ended");
	Json *e = drvMap("event", jsonInteger(f->fn), "args", g->args ? jsonOfVal(g->args) : jsonArray(), NULL);
	const char *code = NULL, *why = tell(x, e, true, &code);
	if (why) return ap_error_new(g->os, code, why);
	return NULL;
}

/** a live function placed at <process>/on/<name> through api, or written there if one is: an error, or NULL; *at its node's id */
static const ap_error *place(Exec *x, ap_given *g, const char *name, ap_fn *fn, const char **at) {
	op_value *live = ap_live(g->api, fn);
	const ap_error *e = NULL;
	size_t n;
	const char *const *on = under(x, &n, "on", NULL);
	const ap_item *it = hostLook(g->api, on, n);
	const char *onId = it ? it->id : NULL, *made = NULL;
	if (!onId && !(e = ap_create(g->api, NULL, NULL, 1, &made)) && !(e = ap_insert(g->api, g->self, "on", made, NULL, NULL))) onId = made;
	const char *const *there = under(x, &n, "on", name);
	const ap_item *was = !e ? hostLook(g->api, there, n) : NULL;
	if (was) {
		*at = was->id;
		e = hostSnap(g->api, there, n, live);
	} else if (!e) {
		if (!(e = ap_create(g->api, live, NULL, 1, &made))) e = ap_insert(g->api, onId, name, made, NULL, NULL);
		*at = made;
	}
	op_free(live);
	return e;
}

// --- on/io: each frame answered, as the process

/** what a frame asks for, done through g's api: its answer's value, or NULL with *e or *wrong */
static Json *perform(Exec *x, ap_given *g, const char *op, const Json *f, const ap_error **e, const char **wrong) {
	Host *h = x->host;
	ap_api *api = g->api;
	const Json *cause = jsonGet(f, "cause");
	op_value *by = cause ? valOf(cause) : NULL;
	if (by) api = ap_as(api, by);
	Json *answer = NULL;
	const char *const *fields = op ? wdFields(op) : NULL;
	if (!op) *wrong = "a frame says its op";
	else if (fields) {
		// a word of the API's: its fields as values, in the order the dispatch takes them (words.h)
		op_value *args[8] = { 0 }, *out = NULL;
		size_t n = 0;
		for (; fields[n] && n < 8; n++) {
			const Json *v = jsonGet(f, fields[n]);
			// the ABI's slot: remove's index by another name
			if (!v && !strcmp(fields[n], "index") && (!strcmp(op, "remove") || !strcmp(op, "pop"))) v = jsonGet(f, "slot");
			args[n] = v ? valOf(v) : NULL;
		}
		if (!(*e = wdDo(g, api, op, (const op_value *const *)args, n, &out))) answer = out ? jsonOfVal(out) : jsonNull();
		for (size_t i = 0; i < n; i++) op_free(args[i]);
		op_free(out);
	} else if (!strcmp(op, "handler")) {
		const char *name = textOf(h, f, "name");
		int64_t fn;
		const char *made = NULL;
		if (!name || !*name || strchr(name, '/') || !jsonIsWhole(jsonGet(f, "fn"), &fn)) *wrong = "handler takes a name and fn, the program's number for it";
		else if (!strcmp(name, "io")) *wrong = "on/io is the OS's own: the program's frames come through it";
		else {
			ExecFn *ef = calloc(1, sizeof *ef);
			*ef = (ExecFn){ { event, NULL }, x, fn };
			if (!(*e = place(x, g, name, &ef->base, &made))) {
				answer = jsonShallow(x->here);
				jsonPush(answer, jsonString("on"));
				jsonPush(answer, jsonString(name));
			}
		}
	} else if (!strcmp(op, "here")) {
		answer = jsonShallow(x->here);
	} else if (!strcmp(op, "kill")) {
		const char *pid = textOf(h, f, "pid");
		if (!pid) *wrong = "kill takes a pid";
		else {
			hostKill(h, pid);
			answer = jsonNull();
		}
	} else *wrong = "no such op";
	op_free(by);
	return answer;
}

/** one frame answered, through g's api: the answer queued for the program */
static void serve(Exec *x, ap_given *g, const Json *frame) {
	const char *op = jsonText(jsonGet(frame, "op"));
	const Json *fields = jsonGet(frame, "fields"), *seq = jsonGet(frame, "seq");
	if (!jsonIsObject(fields)) fields = NULL;
	Json *empty = fields ? NULL : jsonObject();
	const ap_error *e = NULL;
	const char *wrong = NULL;
	Json *ok = perform(x, g, op, fields ? fields : empty, &e, &wrong);
	jsonFree(empty);
	Json *answer = drvMap("seq", seq ? jsonShallow(seq) : jsonNull(), NULL);
	if (wrong || e) {
		Json *why = drvMap("code", jsonString(wrong ? "wrong-field" : e->code ? e->code : "thrown"),
		                   "message", jsonString(wrong ? wrong : e->message ? e->message : e->code ? e->code : "thrown"), NULL);
		if (e && e->name) jsonAdd(why, "name", jsonString(e->name));
		jsonAdd(answer, "error", jsonRef(why));
		jsonFree(ok);
	} else jsonAdd(answer, "ok", ok ? ok : jsonNull());
	const char *code = NULL, *why = tell(x, answer, false, &code);
	if (why && strcmp(code, "stopped")) {
		// an answer that cannot be sent (too large, or no encoding): it is told so instead, so it does not wait for it
		Json *instead = drvMap("seq", seq ? jsonShallow(seq) : jsonNull(), "error", drvMap("code", jsonString(code), "message", jsonString(why), NULL), NULL);
		tell(x, instead, false, &code);
	}
}

/** on/io: what the program printed kept, what it sent answered, in order, FRAMES at most (the rest on the next turn); called with ["exited"] last */
static const ap_error *io(ap_fn *self, ap_given *g, op_value **out, int *pending) {
	(void)pending;
	Exec *x = ((ExecFn *)self)->x;
	*out = NULL;
	bool said = lines(x);
	pthread_mutex_lock(&x->lock);
	int count = x->frames.count < FRAMES ? x->frames.count : FRAMES;
	Json **batch = malloc(sizeof *batch * (size_t)(count ? count : 1));
	memcpy(batch, x->frames.items, sizeof *batch * (size_t)count);
	memmove(x->frames.items, x->frames.items + count, sizeof *x->frames.items * (size_t)(x->frames.count - count));
	x->frames.count -= count;
	bool more = x->frames.count || x->lines.count;
	if (!more) x->waking = false;
	// the pump waits for room for frames: there is now
	if (x->stalled && x->frames.count < FRAMES) ring(x);
	pthread_mutex_unlock(&x->lock);
	if (more) post(x, false);
	for (int i = 0; i < count; i++) {
		serve(x, g, batch[i]);
		jsonFree(batch[i]);
	}
	free(batch);
	if (said) writeLog(x, g);
	const op_value *a = g->args && g->args->type == OP_LIST && g->args->count ? g->args->items[0] : NULL;
	if (a && a->type == OP_STR && !strcmp(a->str, "exited") && failed(x->status)) {
		char ended[128], message[256];
		how(x->status, ended, sizeof ended);
		pthread_mutex_lock(&x->lock);
		const char *broken = x->broken;
		pthread_mutex_unlock(&x->lock);
		snprintf(message, sizeof message, "%s %s%s%s", x->name, ended, broken ? "; it sent a frame that was not one: " : "", broken ? broken : "");
		return ap_error_new(g->os, "exited", message);
	}
	return NULL;
}

/** its process ended (a kill, its window closed, power off): the program asked to end */
static const ap_error *cleanup(ap_fn *self, ap_given *g, op_value **out, int *pending) {
	(void)g, (void)pending;
	Exec *x = ((ExecFn *)self)->x;
	*out = NULL;
	if (x->gone) return NULL;
	x->gone = true;
	if (!x->ended) end(x);
	return NULL;
}

// --- the host's turn: calls on/io, takes the exit

/**
 * calls the process's on/io, as the machine; last: with ["exited"]. False if it could not be: said
 * in the log, and (not last) the program ended, as it cannot be answered
 */
static bool call(Host *h, Exec *x, bool last) {
	size_t n;
	const char *const *at = under(x, &n, "on", "io");
	const ap_item *there = hostLook(ap_host(hostOs(h)), at, n);
	const ap_error *e = NULL;
	if (!there || strcmp(there->id, x->ioId)) e = ap_error_new(hostOs(h), "nothing-there", "its on/io is not where it was put");
	if (!e) {
		op_value *args = NULL, *answer = NULL;
		if (last) {
			args = op_list();
			op_push(args, op_str("exited"));
		}
		e = ap_call_host(hostOs(h), at, n, args, &answer);
		op_free(args);
		if (!e) return true;
		// a failing exit is the program's own: said as any failed run's
		if (last && e->code && !strcmp(e->code, "exited")) {
			hostFailed(h, e, x->pid);
			return true;
		}
	}
	char doing[96];
	snprintf(doing, sizeof doing, "exec %s: its on/io%s", x->pid, last ? "" : ", so it is ended");
	hostFailed(h, e, doing);
	if (last) return false;
	pthread_mutex_lock(&x->lock);
	x->waking = false;
	pthread_mutex_unlock(&x->lock);
	end(x);
	hostKill(h, x->pid);
	return false;
}

/** the program reaped: what it sent and printed last taken, its process ended, its threads and descriptors let go */
static void exited(Host *h, Exec *x) {
	if (x->ended) return;
	char said[128];
	how(x->status, said, sizeof said);
	if (!x->gone) {
		// a failing exit fails this call: said in the log as any failed run
		bool called = call(h, x, true);
		hostKill(h, x->pid);
		if (!called || !failed(x->status)) hostSay(h, "exec %s: %s %s", x->pid, x->name, said);
	} else {
		lines(x);
		hostSay(h, "exec %s: %s %s", x->pid, x->name, said);
	}
	x->ended = true;
	finish(x);
}

void execRecords(Host *h, const Json *records) {
	for (int i = 0; jsonIsArray(records) && i < records->array.count; i++) {
		const Json *r = records->array.items[i], *done = jsonGet(r, "exited");
		int64_t n = -1;
		if (!jsonIsWhole(jsonGet(r, "exec"), &n) || n < 1 || n > programs.count) continue;
		Exec *x = programs.items[n - 1];
		pthread_mutex_lock(&x->lock);
		const char *broken = x->broken;
		pthread_mutex_unlock(&x->lock);
		if (done && done->type == JSON_BOOLEAN && done->boolean) exited(h, x);
		else if (x->ended) continue;
		else if (!x->gone && broken) {
			// it cannot be answered: what came first is, then it is ended, as its process
			call(h, x, false);
			hostSay(h, "exec %s: %s sent a frame that was not one (%s): ended", x->pid, x->name, broken);
			end(x);
			hostKill(h, x->pid);
		} else if (!x->gone) call(h, x, false);
		else {
			// its process is gone: what it printed is said, what it sent is not answered (its socket is shut)
			pthread_mutex_lock(&x->lock);
			for (int k = 0; k < x->frames.count; k++) jsonFree(x->frames.items[k]);
			x->frames.count = 0;
			x->waking = false;
			pthread_mutex_unlock(&x->lock);
			lines(x);
		}
	}
}

void execStop(Host *h) {
	int left = 0;
	for (int i = 0; i < programs.count; i++)
		if (!programs.items[i]->ended) end(programs.items[i]), left++;
	// QUIT ms, not TERM, for each to end with what it started; then SIGKILL to what stays
	struct timespec until = in(QUIT);
	for (int i = 0; i < programs.count; i++) {
		Exec *x = programs.items[i];
		pthread_mutex_lock(&x->lock);
		while (!(x->reaped && (!x->killing || x->swept)) && pthread_cond_timedwait(&x->cond, &x->lock, &until) != ETIMEDOUT) {}
		if (!x->reaped || (x->killing && !x->swept)) {
			kill(-x->child, SIGKILL);
			if (!x->reaped) kill(x->child, SIGKILL);
		}
		pthread_mutex_unlock(&x->lock);
	}
	// each reaped by its own thread
	until = in(500);
	for (int i = 0; i < programs.count; i++) {
		Exec *x = programs.items[i];
		pthread_mutex_lock(&x->lock);
		while (!x->reaped && pthread_cond_timedwait(&x->cond, &x->lock, &until) != ETIMEDOUT) {}
		pthread_mutex_unlock(&x->lock);
	}
	if (left) hostSay(h, "exec: %d program%s ended", left, left == 1 ? "" : "s");
}

// --- the setup: the program started

/** the folder the OS's binary is in: fresh, or NULL */
static char *folder(void) {
	char path[PATH_MAX], real[PATH_MAX];
	uint32_t size = sizeof path;
	if (_NSGetExecutablePath(path, &size) || !realpath(path, real)) return NULL;
	char *slash = strrchr(real, '/');
	if (!slash) return NULL;
	*slash = 0;
	return strdup(real);
}

/** the executable argv[0] names: as given with a "/", else one of ermineOS's own; fresh, or NULL with where it looked */
static char *find(const char *name, char *looked, size_t n) {
	if (strchr(name, '/')) {
		snprintf(looked, n, "%s", name);
		return access(name, X_OK) ? NULL : strdup(name);
	}
	char *dir = folder();
	const char *places[] = { "programs", "build/newos/programs", "../Resources/programs" };
	looked[0] = 0;
	for (size_t i = 0; dir && i < sizeof places / sizeof *places; i++) {
		char *path = formatString("%s/%s/%s", dir, places[i], name);
		snprintf(looked + strlen(looked), n - strlen(looked), "%s%s", i ? ", " : "", path);
		if (!access(path, X_OK)) {
			free(dir);
			return path;
		}
		free(path);
	}
	free(dir);
	return NULL;
}

/** its socket (the OS's end, then the program's), its output, the pump's wake and stop: close on exec, no SIGPIPE on the socket, the pump's ends never blocking */
static bool pipes(int pair[2], int out[2], int wake[2], int stop[2]) {
	int all[8], made = 0, on = 1;
	if (!socketpair(AF_UNIX, SOCK_STREAM, 0, pair)) all[made++] = pair[0], all[made++] = pair[1];
	if (made == 2 && !pipe(out)) all[made++] = out[0], all[made++] = out[1];
	if (made == 4 && !pipe(wake)) all[made++] = wake[0], all[made++] = wake[1];
	if (made == 6 && !pipe(stop)) all[made++] = stop[0], all[made++] = stop[1];
	if (made < 8) {
		int keep = errno;
		for (int i = 0; i < made; i++) close(all[i]);
		errno = keep;
		return false;
	}
	for (int i = 0; i < 8; i++) fcntl(all[i], F_SETFD, FD_CLOEXEC);
	int open[] = { pair[0], wake[0], wake[1] };
	for (int i = 0; i < 3; i++) fcntl(open[i], F_SETFL, fcntl(open[i], F_GETFL) | O_NONBLOCK);
	setsockopt(pair[0], SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof on);
	setsockopt(pair[1], SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof on);
	return true;
}

static const ap_error *setup(ap_fn *self, ap_given *g, op_value **out, int *pending) {
	(void)pending;
	Program *p = (Program *)self;
	Host *h = p->host;
	*out = NULL;
	char looked[2048], why[2600];
	char *path = find(p->argv[0], looked, sizeof looked);
	if (!path) {
		snprintf(why, sizeof why, "no program %s (looked at %s)", p->argv[0], looked);
		return ap_error_new(g->os, "nothing-there", why);
	}
	Json *here = hostHere(h, g->self);
	if (!here) {
		free(path);
		return ap_error_new(g->os, "nothing-there", "the host does not know where this process is");
	}
	int pair[2], output[2], wake[2], stop[2];
	if (!pipes(pair, output, wake, stop)) {
		jsonFree(here);
		snprintf(why, sizeof why, "no socket for %s: %s", path, strerror(errno));
		free(path);
		return ap_error_new(g->os, "thrown", why);
	}

	// who it is, beside what it inherits; the OS's own ERMINE_ names left out
	char node[2048] = "";
	for (int i = 1; i < here->array.count; i++) snprintf(node + strlen(node), sizeof node - strlen(node), "/%s", jsonText(here->array.items[i]));
	int count = 0;
	while (environ[count]) count++;
	char **env = calloc((size_t)count + 4, sizeof *env);
	int e = 0;
	for (int i = 0; i < count; i++)
		if (strncmp(environ[i], "ERMINE_FD=", 10) && strncmp(environ[i], "ERMINE_PID=", 11) && strncmp(environ[i], "ERMINE_NODE=", 12)) env[e++] = environ[i];
	char *fd = strdup("ERMINE_FD=3"), *pid = formatString("ERMINE_PID=%s", g->self), *at = formatString("ERMINE_NODE=%s", node);
	env[e++] = fd, env[e++] = pid, env[e++] = at;
	char **args = calloc((size_t)p->argc + 1, sizeof *args);
	args[0] = path;
	for (int i = 1; i < p->argc; i++) args[i] = p->argv[i];

	// its own process group (so a kill reaches what it starts), every signal as the Mac's default
	// (the metal ignores SIGINT, SIGHUP and SIGTERM, and that is inherited), none blocked, and
	// only fds 0 to 3 its: stdin /dev/null, stdout and stderr the pipe, 3 the socket
	posix_spawnattr_t attr;
	posix_spawnattr_init(&attr);
	sigset_t none, every;
	sigemptyset(&none);
	sigfillset(&every);
	sigdelset(&every, SIGKILL);
	sigdelset(&every, SIGSTOP);
	posix_spawnattr_setsigmask(&attr, &none);
	posix_spawnattr_setsigdefault(&attr, &every);
	posix_spawnattr_setpgroup(&attr, 0);
	posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_CLOEXEC_DEFAULT);
	posix_spawn_file_actions_t actions;
	posix_spawn_file_actions_init(&actions);
	posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0);
	posix_spawn_file_actions_adddup2(&actions, output[1], 1);
	posix_spawn_file_actions_adddup2(&actions, output[1], 2);
	posix_spawn_file_actions_adddup2(&actions, pair[1], 3);
	pid_t child = -1;
	int err = posix_spawn(&child, path, &actions, &attr, args, env);
	posix_spawn_file_actions_destroy(&actions);
	posix_spawnattr_destroy(&attr);
	free(args);
	free(env);
	free(fd), free(pid), free(at);
	close(pair[1]);
	close(output[1]);
	if (err) {
		close(pair[0]), close(output[0]), close(wake[0]), close(wake[1]), close(stop[0]), close(stop[1]);
		jsonFree(here);
		snprintf(why, sizeof why, "%s could not start: %s", path, strerror(err));
		free(path);
		return ap_error_new(g->os, "thrown", why);
	}

	Exec *x = calloc(1, sizeof *x);
	x->host = h;
	x->n = programs.count + 1;
	x->pid = strdup(g->self);
	const char *slash = strrchr(p->argv[0], '/');
	x->name = strdup(slash ? slash + 1 : p->argv[0]);
	x->here = here;
	x->child = child;
	x->fd = pair[0], x->out = output[0], x->wake[0] = wake[0], x->wake[1] = wake[1], x->stop[0] = stop[0], x->stop[1] = stop[1];
	pthread_mutex_init(&x->lock, NULL);
	pthread_cond_init(&x->cond, NULL);
	x->io = (ExecFn){ { io, NULL }, x, 0 };
	x->cleanup = (ExecFn){ { cleanup, NULL }, x, 0 };
	ERM_PUSH(programs, x);
	hostSay(h, "exec: %s is pid %d, as %s", path, (int)child, x->pid);

	// on/io, and the cleanup that ends it; then what it sends is read
	const char *io = NULL;
	const ap_error *wrong = place(x, g, "io", &x->io.base, &io);
	x->ioId = strdup(io ? io : "");
	if (!wrong) wrong = ap_cleanup(g, &x->cleanup.base);
	pthread_create(&x->pump, NULL, pump, x);
	pthread_create(&x->waiter, NULL, waiter, x);
	if (wrong) {
		// it cannot be answered: ended, its exit taken as any
		x->gone = true;
		end(x);
		free(path);
		return wrong;
	}
	op_value *value = op_map(), *argv = op_list();
	op_set(value, "path", op_str(path));
	for (int i = 0; i < p->argc; i++) op_push(argv, op_str(p->argv[i]));
	op_set(value, "argv", argv);
	op_set(value, "mac", op_num((double)child));
	*out = value;
	free(path);
	return NULL;
}

hf_run execRun(const op_value *program, void *api, void *data) {
	Host *h = data;
	const op_value *argv = program && program->type == OP_MAP ? op_get(program, "argv") : NULL;
	bool ok = argv && argv->type == OP_LIST && argv->count && argv->items[0]->type == OP_STR && *argv->items[0]->str;
	for (size_t i = 0; ok && i < argv->count; i++) ok = argv->items[i]->type == OP_STR;
	if (!ok) return (hf_run){ .error = strdup("not-a-program: an exec program's value has argv, a list of strings, the first its executable") };
	Program *p = calloc(1, sizeof *p);
	p->base.call = setup;
	p->host = h;
	p->argc = (int)argv->count;
	p->argv = calloc(argv->count + 1, sizeof *p->argv);
	for (size_t i = 0; i < argv->count; i++) p->argv[i] = strdup(argv->items[i]->str);
	const ap_error *e = ap_run_setup(api, &p->base);
	if (!e) return (hf_run){ 0 };
	char text[1024];
	snprintf(text, sizeof text, "%s%s%s", e->code ? e->code : "thrown", e->message ? ": " : "", e->message ? e->message : "");
	return (hf_run){ .error = strdup(text) };
}
