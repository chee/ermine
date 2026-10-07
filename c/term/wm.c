// wm.c: ermine-term, the toy OS's window manager and main loop. ncurses
// draws; stdin is read raw, by hand (ncurses never reads it). Each node under
// /windows is a window: a process, or a node a program keeps (a mounted
// terminal's window, kept in step by programs/mount); what it shows is its
// screen node's value, drawn whenever the graph changes. Tiling as dvtm
// does: the newest window is the master, on the left; the others stack on
// the right, newest first. The last row is the status line.
//
// Keys: C-g, then
//   c  a new shell window          e  the counter example     t  the clock example
//   s  share over a link (programs/share; its window shows the channel): asks
//      what (the whole /windows, or the focused window), then on what (a
//      fresh channel, or a name or a channel typed in)
//   m  mount another terminal's windows: asks for a channel or a name (programs/mount)
//   n  focus the next window       p  focus the previous one
//   x  close the focused window (unplace its node: it is killed)
//   q  quit (unplace /windows: every window is killed)
//   C-g  a C-g to the focused window
// Everything else goes to the focused window.
//
// ERMINE_SHARE=<channel or name> is what C-g s offers to share on, rather
// than a fresh channel; ERMINE_MOUNT=<channel or name> mounts it when the
// terminal starts. A channel is 64 hex digits; anything else is a name, which
// link.ts turns into its channel (ts/src/link/name.ts).

#define _DARWIN_C_SOURCE

#include "draw.h"
#include "host.h"

#include <curses.h>
#include <fcntl.h>
#include <locale.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#define MAX_FDS 256
#define PREFIX 0x07 // C-g

typedef struct Rect {
	int y, x, h, w;
} Rect;

static volatile sig_atomic_t resized = 1;
static char focus[64];
static bool prefix, quitting;
typedef enum Asking { NOTHING, MOUNT, SHARE_WHAT, SHARE_ON } Asking;
static Asking asking;      // what the status line asks for: C-g m, C-g s's two questions
static char answer[160];   // what has been typed for it
static char sharing[64];   // C-g s: the window to share, or "" for the whole /windows
static char order[MAX_FDS][64]; // the windows' names, in the order they came
static int windowCount;

static void onWinch(int signal) {
	(void)signal;
	resized = 1;
}

// layout ---------------------------------------------------------------------------

/** keeps `order` in step with what is under /windows: gone names leave, new ones come last */
static void follow(Host *host) {
	const char *names[MAX_FDS];
	int n = hostWindows(host, names, MAX_FDS);
	int kept = 0;
	for (int i = 0; i < windowCount; i++) {
		bool here = false;
		for (int j = 0; j < n && !here; j++) here = strcmp(order[i], names[j]) == 0;
		if (here) memmove(order[kept++], order[i], sizeof order[i]);
	}
	windowCount = kept;
	for (int j = 0; j < n && windowCount < MAX_FDS; j++) {
		bool known = false;
		for (int i = 0; i < windowCount && !known; i++) known = strcmp(order[i], names[j]) == 0;
		if (!known) snprintf(order[windowCount++], sizeof order[0], "%s", names[j]);
	}
}

/** the windows' names newest first: the order they are laid out in */
static int ordered(Host *host, const char **out) {
	(void)host;
	for (int i = 0; i < windowCount; i++) out[i] = order[windowCount - 1 - i];
	return windowCount;
}

static Rect rectOf(int index, int count, int rows, int cols) {
	if (count == 1) return (Rect){ 0, 0, rows, cols };
	int half = cols / 2;
	if (index == 0) return (Rect){ 0, 0, rows, half };
	int stack = count - 1, each = rows / stack, y = (index - 1) * each;
	int h = index == count - 1 ? rows - y : each;
	return (Rect){ y, half + 1, h, cols - half - 1 };
}

/** the focused window's name, or NULL for none */
static const char *focused(Host *host) {
	(void)host;
	for (int i = 0; i < windowCount; i++) {
		if (strcmp(order[i], focus) == 0) return order[i];
	}
	if (!windowCount) return NULL;
	snprintf(focus, sizeof focus, "%s", order[windowCount - 1]);
	return order[windowCount - 1];
}

/** gives each window its size: its rect less its title row */
static void layout(Host *host) {
	const char *windows[MAX_FDS];
	int n = ordered(host, windows);
	for (int i = 0; i < n; i++) {
		Rect r = rectOf(i, n, LINES - 1, COLS);
		hostWindowResize(host, windows[i], r.h - 1, r.w);
	}
}

// drawing ----------------------------------------------------------------------------

static void drawWindow(Host *host, const char *name, Rect r, bool isFocused) {
	Json *screen = hostWindowRead(host, name, "screen");
	Proc *proc = hostFind(host, name);
	char title[256], behind[64] = "";
	const char *named = jsonText(jsonGet(screen, "title"));
	// the watchdog: a program not taking what is sent to it says so in its title row
	if (proc && proc->backlog >= BEHIND) snprintf(behind, sizeof behind, "  [behind %zu kB]", proc->backlog / 1024);
	else if (proc && proc->coalesced) snprintf(behind, sizeof behind, "  [%lld coalesced]", (long long)proc->coalesced);
	snprintf(title, sizeof title, " %s  %s%s%s%s ", name, proc ? proc->title : "mounted", named ? "  " : "", named ? named : "", behind);
	attrset(isFocused ? A_REVERSE | A_BOLD : A_REVERSE);
	mvhline(r.y, r.x, ' ', r.w);
	mvaddnstr(r.y, r.x, title, r.w);
	attrset(A_NORMAL);
	drawLines(screen, r.y + 1, r.x, r.h - 1, r.w);
}

static void draw(Host *host) {
	erase();
	const char *windows[MAX_FDS];
	int n = ordered(host, windows);
	const char *at = focused(host);
	Rect cursor = { -1, -1, 0, 0 };
	for (int i = 0; i < n; i++) {
		Rect r = rectOf(i, n, LINES - 1, COLS);
		drawWindow(host, windows[i], r, windows[i] == at);
		if (n > 1 && i == 0) mvvline(0, r.w, ACS_VLINE, LINES - 1);
		if (windows[i] != at) continue;
		int cy, cx;
		if (drawCursor(hostWindowRead(host, at, "screen"), r.y + 1, r.x, r.h - 1, r.w, &cy, &cx)) cursor = (Rect){ cy, cx, 0, 0 };
	}
	char status[512];
	if (asking == MOUNT) {
		snprintf(status, sizeof status, " mount: a channel or a name (enter mounts, escape cancels): %s", answer);
	} else if (asking == SHARE_WHAT) {
		snprintf(status, sizeof status, " share: w the whole /windows, f the focused window (%s); escape cancels", at ? at : "none");
	} else if (asking == SHARE_ON) {
		snprintf(status, sizeof status, " share %s on: a name or a channel, or nothing for a fresh channel (enter shares, escape cancels): %s",
			*sharing ? sharing : "/windows", answer);
	} else {
		char watch[160];
		hostWatch(host, watch, sizeof watch);
		snprintf(status, sizeof status, " ermine  %s%s%d window%s  t=%.0f  %s%s   C-g: c shell  e counter  t clock  s share  m mount  n/p focus  x close  q quit ",
			watch, *watch ? "  " : "", n, n == 1 ? "" : "s", host->clock, prefix ? "[C-g] " : "", at ? at : "no window");
	}
	attrset(A_REVERSE);
	mvhline(LINES - 1, 0, ' ', COLS);
	mvaddnstr(LINES - 1, 0, status, COLS);
	attrset(A_NORMAL);
	if (asking == MOUNT || asking == SHARE_ON) cursor = (Rect){ LINES - 1, (int)strlen(status) < COLS ? (int)strlen(status) : COLS - 1, 0, 0 };
	if (cursor.y >= 0) {
		curs_set(1);
		move(cursor.y, cursor.x);
	} else {
		curs_set(0);
	}
	refresh();
}

// keys ----------------------------------------------------------------------------------

/**
 * starts programs/<program> in /windows: a window's program with scope, so
 * it names only its own window; share and mount without, so they can name
 * every window
 */
static void startWindow(Host *host, const char *program, bool scope, Json *value) {
	char path[128];
	snprintf(path, sizeof path, "[\"programs\", \"%s\"]", program);
	Proc *proc = NULL;
	ErmResult out;
	ErmErr err = hostStart(host, host->agent, SITE, &host->windows, jsonParse(path, strlen(path), NULL), value, scope, &out, &proc);
	follow(host);
	if (!err.kind && proc) snprintf(focus, sizeof focus, "%s", proc->pid);
	if (err.kind && host->log >= 0) dprintf(host->log, "start %s: %s\n", program, jsonPrint(ermErrToJson(err)));
}

static void cycle(Host *host, int by) {
	const char *windows[MAX_FDS];
	int n = ordered(host, windows);
	const char *at = focused(host);
	for (int i = 0; at && i < n; i++) {
		if (windows[i] != at) continue;
		snprintf(focus, sizeof focus, "%s", windows[(i + by + n) % n]);
		return;
	}
}

/** the value programs/mount is started with: the channel or name in the environment variable, or null */
static Json *channelFrom(const char *variable) {
	const char *channel = getenv(variable);
	return channel && *channel ? jsonString(channel) : jsonNull();
}

/** programs/share's value: null for the whole /windows on a fresh channel, else {"channel": channel or name?, "place": [window]?} */
static Json *shareValue(const char *on, const char *window) {
	if (!*on && !*window) return jsonNull();
	Json *value = jsonObject();
	if (*on) jsonAdd(value, "channel", jsonString(on));
	if (*window) {
		Json *place = jsonArray();
		jsonPush(place, jsonString(window));
		jsonAdd(value, "place", place);
	}
	return value;
}

static void quit(Host *host) {
	ErmCtx ctx = hostCtx(host);
	ErmOp op = { .kind = ERM_OP_UNPLACE, .name = "windows", .id = "windows" };
	ErmResult out;
	hostOp(host, &ctx, SITE, &op, &out);
	quitting = true;
}

static void command(Host *host, char key) {
	const char *name = focused(host);
	Proc *at = name ? hostFind(host, name) : NULL;
	switch (key) {
	case 'c': startWindow(host, "shell", true, NULL); break;
	case 'e': startWindow(host, "counter", true, NULL); break;
	case 't': startWindow(host, "clock", true, NULL); break;
	case 's': asking = SHARE_WHAT; break;
	case 'm':
		asking = MOUNT;
		answer[0] = 0;
		break;
	case 'n': cycle(host, 1); break;
	case 'p': cycle(host, -1); break;
	case 'x': if (at) hostUnplace(host, at, SITE); break; // a mounted window goes when its mount does
	case 'q': quit(host); break;
	case PREFIX: if (name) hostWindowKeys(host, name, "\a", 1); break;
	default: break;
	}
	host->dirty = true;
}

/**
 * a byte typed while the status line asks: for C-g s, w or f, then a name or
 * a channel (nothing: a fresh one) and enter shares; for C-g m, a channel or
 * a name, and enter mounts; escape or C-g cancels
 */
static void ask(Host *host, char byte) {
	size_t n = strlen(answer);
	if (byte == 0x1b || byte == PREFIX) {
		asking = NOTHING;
	} else if (asking == SHARE_WHAT) {
		const char *at = focused(host);
		if (byte == 'w' || byte == 'f' || byte == '\r') {
			snprintf(sharing, sizeof sharing, "%s", byte == 'f' && at ? at : "");
			const char *offered = getenv("ERMINE_SHARE");
			snprintf(answer, sizeof answer, "%s", offered ? offered : "");
			asking = SHARE_ON;
		}
	} else if (byte == '\r' || byte == '\n') {
		if (asking == MOUNT && n) startWindow(host, "mount", false, jsonString(answer));
		if (asking == SHARE_ON) startWindow(host, "share", false, shareValue(answer, sharing));
		asking = NOTHING;
	} else if (byte == 0x7f || byte == 0x08) {
		while (n && ((unsigned char)answer[n - 1] & 0xc0) == 0x80) answer[--n] = 0; // a whole UTF-8 character
		if (n) answer[n - 1] = 0;
	} else if ((unsigned char)byte >= ' ' && byte != 0x7f && n + 1 < sizeof answer) {
		answer[n] = byte;
		answer[n + 1] = 0;
	}
	host->dirty = true;
}

static void typed(Host *host, const char *bytes, size_t length) {
	size_t start = 0;
	for (size_t i = 0; i < length && !quitting; i++) {
		if (asking) {
			ask(host, bytes[i]);
			start = i + 1;
		} else if (prefix) {
			prefix = false;
			command(host, bytes[i]);
			start = i + 1;
		} else if (bytes[i] == PREFIX) {
			const char *at = focused(host);
			if (at && i > start) hostWindowKeys(host, at, bytes + start, i - start);
			prefix = true;
			host->dirty = true;
			start = i + 1;
		}
	}
	const char *at = focused(host);
	if (at && !quitting && !asking && length > start) hostWindowKeys(host, at, bytes + start, length - start);
}

// the loop --------------------------------------------------------------------------------

int main(int argc, char **argv) {
	const char *bootPath = argc > 1 ? argv[1] : "boot.json";
	setlocale(LC_ALL, "");
	signal(SIGPIPE, SIG_IGN);
	signal(SIGWINCH, onWinch);
	Host *host = hostNew("root");
	const char *logPath = getenv("ERMINE_TERM_LOG");
	host->log = open(logPath ? logPath : "/dev/null", O_WRONLY | O_CREAT | O_APPEND, 0644);
	char *why = NULL;
	if (!hostBoot(host, bootPath, &why)) {
		fprintf(stderr, "ermine-term: boot: %s\n", why);
		return 1;
	}
	if (getenv("ERMINE_MOUNT") && *getenv("ERMINE_MOUNT")) startWindow(host, "mount", false, channelFrom("ERMINE_MOUNT"));
	ErmTime drawn = -1;
	char watched[160] = "";
	double turn = hostNow();
	initscr();
	raw();
	noecho();
	nonl();
	if (has_colors()) {
		start_color();
		use_default_colors();
	}
	while (!quitting) {
		if (resized) {
			resized = 0;
			struct winsize size;
			if (ioctl(1, TIOCGWINSZ, &size) == 0 && size.ws_row && size.ws_col) resizeterm(size.ws_row, size.ws_col);
			host->dirty = true;
		}
		int wait = hostTick(host);
		follow(host);
		layout(host);
		// the watchdog: what it says is drawn when it changes, as well as when the graph does
		char watch[160];
		hostWatch(host, watch, sizeof watch);
		if (host->dirty || host->clock != drawn || strcmp(watch, watched) != 0) {
			host->dirty = false;
			drawn = host->clock;
			snprintf(watched, sizeof watched, "%s", watch);
			draw(host);
		}
		struct pollfd fds[MAX_FDS];
		Proc *owners[MAX_FDS];
		fds[0] = (struct pollfd){ .fd = 0, .events = POLLIN };
		int n = 1 + hostPollFds(host, fds + 1, owners + 1, MAX_FDS - 1);
		hostTurn(host, hostNow() - turn); // one turn: what the last poll gave, handled, and the loop's own work
		int ready = poll(fds, (nfds_t)n, wait < 0 || wait > 250 ? 250 : wait);
		turn = hostNow();
		if (ready <= 0) continue;
		if (fds[0].revents & (POLLIN | POLLHUP)) {
			char bytes[4096];
			ssize_t got = read(0, bytes, sizeof bytes);
			if (got <= 0) quit(host);
			else typed(host, bytes, (size_t)got);
		}
		for (int i = 1; i < n && !quitting; i++) {
			if (fds[i].revents) hostReady(host, owners[i], fds[i].fd, fds[i].revents);
		}
	}
	endwin();
	return 0;
}
