// erminex.c: one program as one shared ermine window, with no chrome.
//
//   erminex [-s] <channel-or-name> <cmd> [args...]
//
// Runs <cmd> on a pty as the only window of a host (host.c, pty.c), drawn
// filling the terminal from its screen node (draw.c), and shares that window
// over the link (programs/share, ts/deno/link.ts host) on the channel: 64 hex
// digits, or a name, which link.ts turns into its channel (ts/src/link/name.ts),
// so another ermine-term (C-g m, or ERMINE_MOUNT) or the demo can mount it and
// type into it. Every key goes to the program: C-g is no prefix here, and
// there is no quit key. erminex exits when the program does, with its exit
// status (128 + n for a signal n), after killing the share and waiting for
// it. A hangup of the terminal (stdin closing), SIGHUP or SIGTERM kills the
// program and the share, and exits with 128 + the signal.
//
// -s, or ERMINEX_STATUS=1: a status line at the bottom, with the name (or the
// channel's first 8 digits), how many have mounted it (from the share's
// screen, "mounted by n"), and the time.
// ERMINEX_LOG=file: the share's stderr (its channel, its mounters' keys);
// /dev/null by default. ERMINEX_LINK=path: link.ts, if not where it was
// built from.
//
// The tree it boots:
//   /loaders/pty, /loaders/ermine
//   /programs/run     {"kind": "pty", "argv": [cmd, args...]}
//   /programs/share   {"kind": "ermine", "push": true, "relay": true, "argv": [deno ... link.ts host]}
//   /windows/<pid>    the program, with scope (a window's program, as ermine-term starts them)
//   /windows/<share>  the share, without scope, value {"channel": c, "place": [<pid>]}

#define _DARWIN_C_SOURCE

#include "draw.h"
#include "host.h"

#include <curses.h>
#include <errno.h>
#include <fcntl.h>
#include <locale.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifndef LINK_TS
#define LINK_TS "../../ts/deno/link.ts"
#endif

#define MAX_FDS 64

static volatile sig_atomic_t resized = 1, stopped = 0;
static Json *status; // the cause's "exited" when the program's node was unplaced because it exited

static void onWinch(int signal) {
	(void)signal;
	resized = 1;
}

static void onStop(int signal) {
	stopped = signal;
}

/** the host's watch of the program's address: the change that unplaces it because it exited says how */
static void watchRun(void *data, const ErmChange *change, const ErmItems *reaches) {
	(void)data;
	(void)reaches;
	Json *exited = change ? jsonGet(change->cause, "exited") : NULL;
	if (exited && !status) status = exited;
}

static ErmIds names(const char *first, const char *second) {
	ErmIds ids = { 0 };
	if (first) ERM_PUSH(ids, first);
	if (second) ERM_PUSH(ids, second);
	return ids;
}

/** places a node as the person, with its site */
static void place(Host *host, ErmIds at, const char *name, const char *id, Json *value, Json *cause) {
	ErmOp op = { .kind = ERM_OP_PLACE, .address = { .names = at }, .name = name, .id = id, .value = value };
	ErmCtx ctx = hostCtx(host);
	ErmResult out;
	ErmErr err = hostOp(host, &ctx, cause, &op, &out);
	if (err.kind) {
		fprintf(stderr, "erminex: place %s: %s\n", name, jsonPrint(ermErrToJson(err)));
		exit(1);
	}
}

static Json *loader(const char *name) {
	Json *value = jsonObject();
	jsonAdd(value, "loader", jsonString(name));
	return value;
}

static Json *share(void) {
	const char *link = getenv("ERMINEX_LINK");
	const char *words[] = { "deno", "run", "--quiet", "--allow-net", "--allow-read", "--allow-env", link && *link ? link : LINK_TS, "host" };
	Json *value = jsonObject(), *argv = jsonArray();
	jsonAdd(value, "kind", jsonString("ermine"));
	jsonAdd(value, "push", jsonBoolean(true));
	jsonAdd(value, "relay", jsonBoolean(true));
	for (size_t i = 0; i < sizeof words / sizeof *words; i++) jsonPush(argv, jsonString(words[i]));
	jsonAdd(value, "argv", argv);
	return value;
}

static Json *run(char **argv) {
	Json *value = jsonObject(), *args = jsonArray();
	jsonAdd(value, "kind", jsonString("pty"));
	for (int i = 0; argv[i]; i++) jsonPush(args, jsonString(argv[i]));
	jsonAdd(value, "argv", args);
	return value;
}

static Proc *start(Host *host, const char *program, bool scope, Json *value) {
	char path[64];
	snprintf(path, sizeof path, "[\"programs\", \"%s\"]", program);
	Proc *proc = NULL;
	ErmResult out;
	ErmErr err = hostStart(host, host->agent, SITE, &host->windows, jsonParse(path, strlen(path), NULL), value, scope, &out, &proc);
	if (err.kind && host->log >= 0) dprintf(host->log, "erminex: start %s: %s\n", program, jsonPrint(ermErrToJson(err)));
	return proc;
}

/** how many have mounted the share, from its screen's " mounted by n"; -1 when it is not there */
static int mounters(Host *host, const char *sharePid) {
	Proc *proc = sharePid ? hostFind(host, sharePid) : NULL;
	Json *lines = proc ? jsonGet(hostRead(host, proc, "screen"), "lines") : NULL;
	for (int i = 0; jsonIsArray(lines) && i < lines->array.count; i++) {
		const char *text = jsonText(lines->array.items[i]), *at = text ? strstr(text, "mounted by ") : NULL;
		if (at) return atoi(at + strlen("mounted by "));
	}
	return -1;
}

static bool isChannel(const char *given) {
	size_t n = strlen(given);
	if (n != 64) return false;
	for (size_t i = 0; i < n; i++) {
		if (!strchr("0123456789abcdefABCDEF", given[i])) return false;
	}
	return true;
}

static void draw(Host *host, const char *pid, const char *sharePid, const char *called, bool bar) {
	erase();
	int rows = bar ? LINES - 1 : LINES;
	Json *screen = hostRead(host, hostFind(host, pid), "screen");
	drawLines(screen, 0, 0, rows, COLS);
	int cy = -1, cx = -1;
	bool cursor = drawCursor(screen, 0, 0, rows, COLS, &cy, &cx);
	char watch[160];
	hostWatch(host, watch, sizeof watch);
	if (bar) {
		char line[512], connected[32], clock[16];
		int n = mounters(host, sharePid);
		if (n < 0) snprintf(connected, sizeof connected, "not shared");
		else snprintf(connected, sizeof connected, "%d connected", n);
		time_t now = time(NULL);
		strftime(clock, sizeof clock, "%H:%M", localtime(&now));
		snprintf(line, sizeof line, " %s  %s%s%s", called, connected, *watch ? "  " : "", watch);
		attrset(A_REVERSE);
		mvhline(LINES - 1, 0, ' ', COLS);
		mvaddnstr(LINES - 1, 0, line, COLS);
		int at = COLS - (int)strlen(clock) - 1;
		if (at > (int)strlen(line) + 1) mvaddstr(LINES - 1, at, clock);
		attrset(A_NORMAL);
	} else if (*watch) {
		// no status line: the watchdog speaks in the top right corner while it has something to say
		char tag[176];
		int length = snprintf(tag, sizeof tag, "[%s]", watch);
		attrset(A_REVERSE | A_BOLD);
		mvaddnstr(0, COLS > length ? COLS - length : 0, tag, COLS);
		attrset(A_NORMAL);
	}
	if (cursor) {
		curs_set(1);
		move(cy, cx);
	} else {
		curs_set(0);
	}
	refresh();
}

/** waits up to `seconds` for a child to end, then kills its group; whether it ended by itself */
static bool reap(pid_t child, double seconds) {
	if (child <= 0) return true;
	double until = hostNow() + seconds;
	while (hostNow() < until) {
		pid_t got = waitpid(child, NULL, WNOHANG);
		if (got == child || (got < 0 && errno == ECHILD)) return true;
		struct timespec pause = { 0, 20 * 1000 * 1000 };
		nanosleep(&pause, NULL);
	}
	kill(-child, SIGKILL);
	kill(child, SIGKILL);
	waitpid(child, NULL, 0);
	return false;
}

static int usage(void) {
	fprintf(stderr, "usage: erminex [-s] <channel-or-name> <cmd> [args...]\n"
		"  runs cmd as one ermine window filling the terminal, shared on the channel\n"
		"  (64 hex digits, or a name); exits when cmd does, with its status\n"
		"  -s (or ERMINEX_STATUS=1): a status line with the name, who is connected, and the time\n");
	return 2;
}

int main(int argc, char **argv) {
	bool bar = getenv("ERMINEX_STATUS") && strcmp(getenv("ERMINEX_STATUS"), "1") == 0;
	int i = 1;
	for (; i < argc && argv[i][0] == '-'; i++) {
		if (strcmp(argv[i], "--") == 0) {
			i++;
			break;
		}
		if (strcmp(argv[i], "-s") == 0) bar = true;
		else return usage();
	}
	if (argc - i < 2 || !*argv[i]) return usage();
	const char *channel = argv[i];
	char **command = argv + i + 1;
	char called[80];
	if (isChannel(channel)) snprintf(called, sizeof called, "%.8s", channel);
	else snprintf(called, sizeof called, "%s", channel);

	setlocale(LC_ALL, "");
	signal(SIGPIPE, SIG_IGN);
	signal(SIGWINCH, onWinch);
	signal(SIGHUP, onStop);
	signal(SIGTERM, onStop);
	signal(SIGINT, onStop);
	Host *host = hostNew("root");
	const char *logPath = getenv("ERMINEX_LOG");
	host->log = open(logPath && *logPath ? logPath : "/dev/null", O_WRONLY | O_CREAT | O_APPEND, 0644);

	ErmIds root = { 0 };
	place(host, root, "loaders", "loaders", jsonNull(), SITE);
	place(host, names("loaders", NULL), "pty", "loader-pty", loader("pty"), SITE);
	place(host, names("loaders", NULL), "ermine", "loader-ermine", loader("ermine"), SITE);
	place(host, root, "programs", "programs", jsonNull(), SITE);
	place(host, names("programs", NULL), "run", "run", run(command), SITE);
	place(host, names("programs", NULL), "share", "share", share(), SITE);
	place(host, root, "windows", "windows", jsonNull(), SITE);

	Proc *proc = start(host, "run", true, NULL);
	if (!proc) {
		fprintf(stderr, "erminex: could not start %s\n", command[0]);
		return 127;
	}
	const char *pid = proc->pid;
	ErmCtx ctx = hostCtx(host);
	ErmAddress address = { .names = names("windows", pid) };
	int64_t watch;
	host->graph.vt->subscribe(host->graph.self, &ctx, &address, watchRun, NULL, &watch);

	Json *value = jsonObject(), *at = jsonArray();
	jsonAdd(value, "channel", jsonString(channel));
	jsonPush(at, jsonString(pid));
	jsonAdd(value, "place", at);
	Proc *shared = start(host, "share", false, value);
	const char *sharePid = shared ? shared->pid : NULL;
	pid_t shareChild = shared ? shared->child : 0;

	initscr();
	raw();
	noecho();
	nonl();
	if (has_colors()) {
		start_color();
		use_default_colors();
	}
	int code = 0, minute = -1;
	ErmTime drawn = -1;
	char watched[160] = "";
	double turn = hostNow();
	while (hostFind(host, pid)) {
		if (stopped) {
			code = 128 + stopped;
			break;
		}
		if (resized) {
			resized = 0;
			struct winsize size;
			if (ioctl(1, TIOCGWINSZ, &size) == 0 && size.ws_row && size.ws_col) resizeterm(size.ws_row, size.ws_col);
			host->dirty = true;
		}
		int wait = hostTick(host);
		if (!hostFind(host, pid)) break;
		hostWindowResize(host, pid, bar ? LINES - 1 : LINES, COLS);
		time_t now = time(NULL);
		int thisMinute = (int)(now / 60);
		char watch[160];
		hostWatch(host, watch, sizeof watch);
		if (host->dirty || host->clock != drawn || (bar && thisMinute != minute) || strcmp(watch, watched) != 0) {
			host->dirty = false;
			drawn = host->clock;
			minute = thisMinute;
			snprintf(watched, sizeof watched, "%s", watch);
			draw(host, pid, sharePid, called, bar);
		}
		struct pollfd fds[MAX_FDS];
		Proc *owners[MAX_FDS];
		fds[0] = (struct pollfd){ .fd = 0, .events = POLLIN };
		int n = 1 + hostPollFds(host, fds + 1, owners + 1, MAX_FDS - 1);
		hostTurn(host, hostNow() - turn);
		int ready = poll(fds, (nfds_t)n, wait < 0 || wait > 1000 ? 1000 : wait);
		turn = hostNow();
		if (ready <= 0) continue;
		if (fds[0].revents & (POLLIN | POLLHUP | POLLERR)) {
			char bytes[4096];
			ssize_t got = read(0, bytes, sizeof bytes);
			if (got <= 0) {
				code = 128 + SIGHUP; // the terminal went
				break;
			}
			hostWindowKeys(host, pid, bytes, (size_t)got);
		}
		for (int k = 1; k < n; k++) {
			if (fds[k].revents) hostReady(host, owners[k], fds[k].fd, fds[k].revents);
		}
	}
	// the program exited (or the terminal or a signal ended it): unplacing
	// /windows kills what is left, the share saying goodbye to its mounters
	Proc *still = hostFind(host, pid);
	pid_t runChild = still ? still->child : 0;
	if (sharePid && !hostFind(host, sharePid)) shareChild = 0; // it already went, and was reaped
	ErmOp op = { .kind = ERM_OP_UNPLACE, .name = "windows", .id = "windows" };
	ErmResult out;
	hostOp(host, &ctx, SITE, &op, &out);
	endwin();
	reap(runChild, 2);
	reap(shareChild, 3);
	if (!code && status) {
		int64_t whole, sig;
		if (jsonIsWhole(status, &whole)) code = (int)whole;
		else if (jsonIsWhole(jsonGet(status, "signal"), &sig)) code = 128 + (int)sig;
		else code = 1;
	} else if (!code) {
		code = 1;
	}
	return code;
}
