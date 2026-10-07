// host.h: the toy OS's host. It holds the bare C graph and its clock, boots
// from a boot image, and starts and kills processes for programs that run
// outside it, as SCHEDULER.tex's start and Killing say as far as they apply
// to programs with no compute or effect (NOTES.md, Departures). Every
// process here is a window: placed under /windows, with three ephemeral nodes
// of its own, screen, keys and size. Nothing here knows about ncurses.

#ifndef TERM_HOST_H
#define TERM_HOST_H

#include "../ermine.h"
#include "collect.h"
#include "protocol.h"
#include "vt.h"

#include <poll.h>
#include <sys/types.h>

typedef struct Host Host;
typedef struct Proc Proc;

/** a loader the host has (LOADERS.tex), named by a loader node {"loader": name} */
typedef struct Loader {
	const char *name;
	/** NULL when the program's value is one it runs, or why it is not (not-a-program) */
	const char *(*check)(Json *program);
	/** runs the process; false when it could not */
	bool (*start)(Host *host, Proc *proc, Json *program);
	/** the process is killed: stop it and let go of what it holds */
	void (*kill)(Host *host, Proc *proc);
	/** one of its fds is ready; it may end the process (hostExited), so touch nothing after that */
	void (*ready)(Host *host, Proc *proc, int fd, short revents);
	/** what the person typed into its window, as the terminal sent it (the pty loader writes it to the keys node, which it feeds the pty from) */
	void (*keys)(Host *host, Proc *proc, const char *bytes, size_t length);
	/** its window has a new size, proc->rows by proc->cols */
	void (*resized)(Host *host, Proc *proc);
	/** time passes: writes what is due; ms until it wants to be called again, or -1 */
	int (*tick)(Host *host, Proc *proc, double now);
} Loader;

extern const Loader ptyLoader;    // pty.c
extern const Loader ermineLoader; // speak.c

struct Proc {
	const char *pid;
	const char *title;     // the last name of its program's path, for people
	ErmIds address;        // names from the root to its node
	ErmPlace place;        // where it acts: with scope, its own node, chrooted there; else the node it was placed into
	Json *agent;           // {"actor": a, "code": [{"process": pid, "program": identity, "external": true}]}
	char *agentText;
	Json *program;         // identities, {"node": id, "time": t}
	Json *loaderIdentity;
	const Loader *loader;
	ErmIds made;           // the ephemeral nodes the host made as it: screen, keys, size
	int rows, cols;        // its window's size, as its size node has it
	pid_t child;           // 0 once reaped
	Json *status;          // how it ended once reaped (exitStatus); NULL before
	double closed;         // when its output closed (hostClosed); 0: still open
	int fd;                // what the loader reads: the pty, or the program's stdout; -1: none
	int in;                // what the loader writes when `wantsOut`: the program's stdin; -1: none
	bool wantsOut;
	bool push;             // an ermine program whose value says "push": true: its events are sent to it unasked
	bool relay;            // an ermine program whose value says "relay": true: it acts for others (protocol.h, Binding)
	void *state;           // the loader's
	Speaker *speaker;      // when it speaks lines: what its requests made is let go when it is killed
	int64_t watch;         // the host's subscription to its address
	int64_t screenWatch;   // and to its screen
	size_t backlog;        // bytes for it that it has not taken yet: answers and pushed events not read, keys a pty has not taken
	int64_t coalesced;     // pushed events dropped because a newer one replaced them while it was behind (speak.c)
	bool doomed;           // its address no longer reaches it: it is killed when the change is done
	Json *killAgent;       // who made the change that killed it, and when
	const char *killProcess;
	ErmTime killTime;
};

struct Host {
	ErmInterface graph;
	ErmTime clock;          // the last time given; every change is stamped with the next
	Json *agent;            // the person at the keyboard: {"actor": $USER, "code": []}
	char *agentText;
	ERM_LIST(Proc *) procs; // running, in the order they started
	ErmIds windows;         // where windows are started: ["windows"]
	bool dirty;             // a screen changed, or a window came or went
	bool settling;
	int log;                // programs' stderr, and the host's notes
	Collector *collector;   // frees what writes to ephemeral nodes left once nothing reaches it (collect.h)
	double lag, lagAt;      // the longest one turn of the loop took (seconds), and when: the watchdog (hostTurn)
};

/** a change's site, its cause when made from outside any process (CORE Changes) */
Json *hostSite(const char *file, int line, const char *function);
#define SITE hostSite(__FILE__, __LINE__, __func__)

Host *hostNew(const char *root);
/** an operation on the bare graph, stamped with the clock; then kills what it left unreached */
ErmErr hostOp(Host *host, const ErmCtx *ctx, Json *cause, const ErmOp *op, ErmResult *out);
/** the person's ctx at the root */
ErmCtx hostCtx(Host *host);
/** kills every process whose address no longer reaches it, in the order they started */
void hostSettle(Host *host);
/**
 * SCHEDULER start: looks up `path` (a list of names, or "/" then names) from
 * the node the names `at` reach, then its loader at loaders/<kind>, picks a
 * pid, places the process node there as `agent`, makes its window's
 * ephemeral nodes as it, and runs it. *out is the placement's answer. With
 * scope, the process's "/" is its own node (SCHEDULER start); without, it acts
 * at the node it was placed into, with the caller's "/", the root.
 */
ErmErr hostStart(Host *host, Json *agent, Json *cause, const ErmIds *at, Json *path, Json *value, bool scope, ErmResult *out, Proc **proc);
/** unplaces a process's node, as the person: it is killed */
ErmErr hostUnplace(Host *host, Proc *proc, Json *cause);
/**
 * a program ended on its own: its node is unplaced, as the person, with the
 * site and {"exited": status} as the cause (SCHEDULER What a process acts as);
 * status is its exit code, {"signal": n}, or null when it never ran
 */
void hostExited(Host *host, Proc *proc, Json *status);
/** its output closed: it is taken as exited once it is reaped (or a second later, status null) */
void hostClosed(Host *host, Proc *proc);
/** runs a boot image: PROTOCOL requests, one per line ("#" lines and blank lines skipped), start included */
bool hostBoot(Host *host, const char *path, char **why);
/** a window's new size: writes its size node, as the person, and tells its loader */
void hostResize(Host *host, Proc *proc, int rows, int cols);
/** what the person typed into a window */
void hostKeys(Host *host, Proc *proc, const char *bytes, size_t length);
/** writes a key to a window's keys node, as the person */
void hostKey(Host *host, Proc *proc, const char *key);
/** writes a key, or a list of keys, to a process's keys node, as the person, with `cause` (its site) */
void hostWriteKeys(Host *host, Proc *proc, Json *keys, Json *cause);

// windows by name: every node under /windows is a window, a process or not (a
// mounted window a program keeps in step, say). A process's goes to its
// loader; any other's keys are written to its keys node, and its size to its
// size node, as the person.

/** the names under /windows whose slot holds a node that is here, in the slot order; how many */
int hostWindows(Host *host, const char **names, int max);
/** the value of node `node` (screen, keys, size) of the window `name`, or NULL */
Json *hostWindowRead(Host *host, const char *name, const char *node);
/** what the person typed into the window `name` */
void hostWindowKeys(Host *host, const char *name, const char *bytes, size_t length);
/** the window `name` has a new size */
void hostWindowResize(Host *host, const char *name, int rows, int cols);
/** writes patches to one of a process's own nodes, as the process */
ErmErr hostWriteOwn(Host *host, Proc *proc, const char *name, Json *patches);
/** the value of one of a process's own nodes (screen, size, keys), or NULL */
Json *hostRead(Host *host, Proc *proc, const char *name);
/** the fds to poll: fills fds and owners, returns how many */
int hostPollFds(Host *host, struct pollfd *fds, Proc **owners, int max);
/** an fd hostPollFds gave is ready */
void hostReady(Host *host, Proc *proc, int fd, short revents);
/** reaps children, lets loaders write what is due; ms to the next tick it wants, or -1 */
int hostTick(Host *host);
Proc *hostFind(Host *host, const char *pid);
/** speak.c: the name of the key at the front of bytes the terminal sent, and how many bytes it took */
size_t keyName(const char *bytes, size_t length, char name[16]);
/**
 * pty.c: the bytes a pty gets for the key named `name` (keyName's names; the
 * arrows, home and end in the form ?1 asks for, `appCursor`), into out; how
 * many, or -1 when `name` names no key, so it is typed as it is
 */
int keyBytes(const char *name, bool appCursor, char out[16]);
double hostNow(void);
/**
 * the watchdog: the loop says how long one turn took, poll's wait left out;
 * hostLag is the longest of the last two seconds, so a slow turn shows for a
 * while (wm.c's status line)
 */
void hostTurn(Host *host, double seconds);
double hostLag(Host *host);
/** the process with the most bytes waiting for it, or NULL when none has BEHIND or more */
Proc *hostBehind(Host *host);
#define BEHIND (64 * 1024)
/**
 * what the watchdog has to say, for a status line: "lag 340ms" when a turn
 * of the loop took 100 ms or more in the last two seconds, and "@9-wixib
 * share behind 300 kB, 12 coalesced" for the process most behind; "" when
 * all is well. Its length.
 */
int hostWatch(Host *host, char *out, size_t size);

#endif
