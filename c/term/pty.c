// pty.c: the pty loader. A program {"kind": "pty", "argv": [...]} runs on a
// pseudo-terminal; what it prints goes through vt.c into a grid, and the grid
// is written into its window's screen node, as the process, at most 60 times
// a second, as one snapshot whose rows are shared with the last one where
// they did not change (NOTES.md, The grid).
//
// Keys reach the pty one way only: from its window's keys node. What the
// person types here is written there (ptyKeys), as the person, and a mounter's
// keys are written there through share, as the mounter; the loader subscribes
// to the node and sends each write's key, or list of keys, to the pty
// (keysWritten), so a key is typed once and every key has who typed it.

#define _DARWIN_C_SOURCE

#include "host.h"

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <util.h> // forkpty

#define FRAME (1.0 / 60)

typedef struct Pty {
	Vt *vt;
	int rows, cols;  // of the screen as last written; 0: never written
	Json **lines;    // each row's text as last written
	Json **styles;   // each row's runs as last written
	Json *cursor;    // as last written
	double flushed;  // when it was last written
	Host *host;
	const char *keysId; // its keys node, "<pid>/keys"
	int64_t keysWatch;  // the subscription to it, which feeds the pty
	char *out;          // bytes for the pty not yet written
	size_t outLength, outCapacity;
} Pty;

static const char *ptyCheck(Json *program) {
	Json *argv = jsonGet(program, "argv");
	if (!jsonIsArray(argv) || !argv->array.count) return "a pty program is {\"kind\": \"pty\", \"argv\": [string, ...]}";
	for (int i = 0; i < argv->array.count; i++) {
		if (!jsonText(argv->array.items[i])) return "argv holds only strings";
	}
	return NULL;
}

/** writes what it can of what waits for the pty; the rest waits for POLLOUT */
static void flushOut(Proc *proc) {
	Pty *pty = proc->state;
	while (pty->outLength && proc->fd >= 0) {
		ssize_t n = write(proc->fd, pty->out, pty->outLength);
		if (n <= 0) break; // EAGAIN: its input is full for now
		memmove(pty->out, pty->out + n, pty->outLength - (size_t)n);
		pty->outLength -= (size_t)n;
	}
	proc->wantsOut = pty->outLength > 0;
}

/** bytes for the pty, after any that wait */
static void toPty(Proc *proc, const char *bytes, size_t length) {
	Pty *pty = proc->state;
	if (pty->outLength + length > pty->outCapacity) {
		pty->outCapacity = (pty->outLength + length) * 2;
		pty->out = realloc(pty->out, pty->outCapacity);
		if (!pty->out) abort();
	}
	memcpy(pty->out + pty->outLength, bytes, length);
	pty->outLength += length;
	flushOut(proc);
	proc->backlog = pty->outLength;
}

int keyBytes(const char *name, bool appCursor, char out[16]) {
	static const char *const named[][2] = { { "enter", "\r" }, { "tab", "\t" }, { "backspace", "\x7f" }, { "escape", "\033" },
		{ "pageup", "\033[5~" }, { "pagedown", "\033[6~" }, { "delete", "\033[3~" }, { "insert", "\033[2~" }, { "unknown", "" } };
	static const char *const cursor[][2] = { { "up", "A" }, { "down", "B" }, { "right", "C" }, { "left", "D" }, { "home", "H" }, { "end", "F" } };
	size_t length = strlen(name);
	for (size_t i = 0; i < sizeof named / sizeof *named; i++) {
		if (strcmp(name, named[i][0]) == 0) return (int)strlen(strcpy(out, named[i][1]));
	}
	for (size_t i = 0; i < sizeof cursor / sizeof *cursor; i++) {
		if (strcmp(name, cursor[i][0]) == 0) return snprintf(out, 16, "\033%c%s", appCursor ? 'O' : '[', cursor[i][1]);
	}
	if (length == 3 && name[0] == 'C' && name[1] == '-') {
		char c = name[2];
		if (c >= 'a' && c <= 'z') return out[0] = (char)(c - 'a' + 1), 1;
		if (c >= '@' && c <= '_') return out[0] = (char)(c - '@'), 1;
	}
	if (length > 2 && name[0] == 'M' && name[1] == '-') {
		char inner[16];
		int n = keyBytes(name + 2, appCursor, inner);
		if (n < 0 || n > 14) return -1;
		out[0] = 0x1b;
		memcpy(out + 1, inner, (size_t)n);
		return n + 1;
	}
	// one character, a code point's bytes: itself
	unsigned char b = (unsigned char)name[0];
	size_t one = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
	if (length && length == one) return (int)strlen(strcpy(out, name));
	return -1;
}

/** one key from the keys node to the pty: a key's name as its bytes, any other text as it is */
static void feedKey(Proc *proc, Json *key) {
	Pty *pty = proc->state;
	if (!key || key->type != JSON_STRING) return;
	char bytes[16];
	int n = strlen(key->string) == key->stringLength ? keyBytes(key->string, pty->vt->appCursor, bytes) : -1;
	if (n >= 0) toPty(proc, bytes, (size_t)n);
	else toPty(proc, key->string, key->stringLength);
}

/** a write to its keys node, by anyone: what the node then holds, a key or a list of keys, goes to the pty */
static void keysWritten(void *data, const ErmChange *change, const ErmItems *reaches) {
	(void)reaches; // NULL for a change to the node itself; a route's change is no key
	Proc *proc = data;
	Pty *pty = proc->state;
	if (!pty || change->kind != ERM_WRITE || strcmp(change->node, pty->keysId) != 0) return;
	Json *keys = hostRead(pty->host, proc, "keys");
	if (jsonIsArray(keys)) {
		for (int i = 0; i < keys->array.count; i++) feedKey(proc, keys->array.items[i]);
	} else {
		feedKey(proc, keys);
	}
}

static bool ptyStart(Host *host, Proc *proc, Json *program) {
	Json *argv = jsonGet(program, "argv");
	char **args = allocate(((size_t)argv->array.count + 1) * sizeof *args);
	for (int i = 0; i < argv->array.count; i++) args[i] = (char *)jsonText(argv->array.items[i]);
	struct winsize size = { .ws_row = (unsigned short)proc->rows, .ws_col = (unsigned short)proc->cols };
	int fd;
	pid_t child = forkpty(&fd, NULL, NULL, &size);
	if (child < 0) {
		free(args);
		return false;
	}
	if (child == 0) {
		setenv("TERM", "screen-256color", 1);
		setenv("ERMINE_PID", proc->pid, 1);
		unsetenv("COLUMNS");
		unsetenv("LINES");
		signal(SIGPIPE, SIG_DFL);
		execvp(args[0], args);
		_exit(127);
	}
	free(args);
	fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
	Pty *pty = allocate(sizeof *pty);
	pty->vt = vtNew(proc->rows, proc->cols);
	pty->host = host;
	pty->keysId = formatString("%s/keys", proc->pid);
	proc->state = pty;
	proc->child = child;
	proc->fd = proc->in = fd; // in: written when POLLOUT says so, what the pty could not take at once
	// beneath any wrapper, as the host's other watches; synchronous, so a key typed reaches the pty in the same call
	ErmCtx root = hostCtx(host);
	ErmIds at = { 0 };
	for (int i = 0; i < proc->address.count; i++) ERM_PUSH(at, proc->address.items[i]);
	ERM_PUSH(at, "keys");
	ErmAddress keys = { .names = at };
	host->graph.vt->subscribe(host->graph.self, &root, &keys, keysWritten, proc, &pty->keysWatch);
	return true;
}

static void forgetWritten(Pty *pty) {
	free(pty->lines);
	free(pty->styles);
	pty->lines = pty->styles = NULL;
	pty->rows = pty->cols = 0;
}

static void ptyKill(Host *host, Proc *proc) {
	Pty *pty = proc->state;
	host->graph.vt->unsubscribe(host->graph.self, NULL, pty->keysWatch);
	if (proc->child) {
		kill(-proc->child, SIGHUP); // its process group, which forkpty made
		kill(proc->child, SIGHUP);
	}
	if (proc->fd >= 0) close(proc->fd);
	proc->fd = proc->in = -1;
	proc->wantsOut = false;
	free(pty->out);
	vtFree(pty->vt);
	forgetWritten(pty);
	free(pty);
	proc->state = NULL;
}

static void ptyReady(Host *host, Proc *proc, int fd, short revents) {
	(void)fd;
	Pty *pty = proc->state;
	if (revents & POLLOUT) {
		flushOut(proc);
		proc->backlog = pty->outLength;
		return;
	}
	char buffer[65536];
	for (int reads = 0; reads < 16; reads++) {
		ssize_t n = read(proc->fd, buffer, sizeof buffer);
		if (n < 0 && (errno == EAGAIN || errno == EINTR)) break;
		if (n <= 0) { // EIO on macOS once every holder of the other side has gone
			close(proc->fd);
			proc->fd = proc->in = -1;
			proc->wantsOut = false;
			hostClosed(host, proc);
			return;
		}
		vtWrite(pty->vt, buffer, (size_t)n);
		if (pty->vt->replyLength) {
			toPty(proc, pty->vt->reply, (size_t)pty->vt->replyLength);
			pty->vt->replyLength = 0;
		}
	}
}

/**
 * What the person typed, as the terminal sent it, written to the keys node
 * as the person, with this site: one change for what one read gave, a key's
 * name, or a list of them for more than one (a paste). A key whose name
 * would not give the pty the same bytes (C-h, C-j, an F key, a sequence
 * keyName calls "unknown") is written as its bytes. The arrows, home and end
 * are the one change: they go as the program asked for them (?1), as before.
 * The pty gets them from the node (keysWritten).
 */
static void ptyKeys(Host *host, Proc *proc, const char *bytes, size_t length) {
	Pty *pty = proc->state;
	Json *keys = jsonArray();
	while (length) {
		char name[16], back[16];
		size_t n = keyName(bytes, length, name);
		int m = keyBytes(name, pty->vt->appCursor, back);
		bool cursor = n == 3 && bytes[0] == 0x1b && (bytes[1] == '[' || bytes[1] == 'O') && strchr("ABCDHF", bytes[2]);
		bool same = m >= 0 && (size_t)m == n && (memcmp(back, bytes, n) == 0 || cursor);
		jsonPush(keys, same ? jsonString(name) : jsonStringOfLength(bytes, n));
		bytes += n;
		length -= n;
	}
	if (!keys->array.count) return;
	hostWriteKeys(host, proc, keys->array.count == 1 ? keys->array.items[0] : keys, SITE);
}

static void ptyResized(Host *host, Proc *proc) {
	(void)host;
	Pty *pty = proc->state;
	vtResize(pty->vt, proc->rows, proc->cols);
	struct winsize size = { .ws_row = (unsigned short)proc->rows, .ws_col = (unsigned short)proc->cols };
	ioctl(proc->fd, TIOCSWINSZ, &size);
}

// the screen node's value -------------------------------------------------------------

static void flag(Json *style, uint8_t flags, uint8_t bit, const char *name) {
	if (flags & bit) jsonAdd(style, name, jsonBoolean(true));
}

static Json *styleJson(VtStyle s) {
	Json *style = jsonObject();
	if (s.fg >= 0) jsonAdd(style, "fg", jsonInteger(s.fg));
	if (s.bg >= 0) jsonAdd(style, "bg", jsonInteger(s.bg));
	flag(style, s.flags, VT_BOLD, "bold");
	flag(style, s.flags, VT_DIM, "dim");
	flag(style, s.flags, VT_ITALIC, "italic");
	flag(style, s.flags, VT_UNDERLINE, "underline");
	flag(style, s.flags, VT_BLINK, "blink");
	flag(style, s.flags, VT_REVERSE, "reverse");
	return style;
}

/** a row's runs: [[col, style], ...], each from its col to the next's, the row plain before the first; [] for a plain row */
static Json *rowStyles(Vt *vt, int row) {
	Json *runs = jsonArray();
	VtStyle now = { -1, -1, 0 };
	for (int c = 0; c < vt->cols; c++) {
		VtStyle s = vtCell(vt, row, c)->style;
		if (vtSameStyle(s, now)) continue;
		Json *run = jsonArray();
		jsonPush(run, jsonInteger(c));
		jsonPush(run, styleJson(s));
		jsonPush(runs, run);
		now = s;
	}
	return runs;
}

static Json *cursorJson(Vt *vt) {
	Json *cursor = jsonObject();
	jsonAdd(cursor, "row", jsonInteger(vt->cursor.row));
	jsonAdd(cursor, "col", jsonInteger(vt->cursor.col));
	jsonAdd(cursor, "visible", jsonBoolean(vt->cursorVisible));
	return cursor;
}

/**
 * The write that brings the screen node from what was last written to the
 * grid now, one snapshot of the whole screen, whose rows are the very values
 * last written where a row did not change; NULL: nothing changed. One patch,
 * so the graph makes no copies along the way, and what the last frame was
 * made of that this one does not reach is freed after the write (collect.h).
 */
static Json *screenPatches(Pty *pty) {
	Vt *vt = pty->vt;
	bool whole = pty->rows != vt->rows || pty->cols != vt->cols;
	if (whole) {
		forgetWritten(pty);
		pty->rows = vt->rows;
		pty->cols = vt->cols;
		pty->lines = allocate((size_t)vt->rows * sizeof *pty->lines);
		pty->styles = allocate((size_t)vt->rows * sizeof *pty->styles);
		pty->cursor = NULL;
	}
	bool changed = whole;
	for (int r = 0; r < vt->rows; r++) {
		char *text = vtRowText(vt, r);
		Json *line = jsonString(text), *styles = rowStyles(vt, r);
		free(text);
		// a row as it was is kept, and the new copy, never handed on, freed
		if (whole || !jsonEqual(line, pty->lines[r])) {
			pty->lines[r] = line;
			changed = true;
		} else {
			jsonFree(line);
		}
		if (whole || !jsonEqual(styles, pty->styles[r])) {
			pty->styles[r] = styles;
			changed = true;
		} else {
			jsonFree(styles);
		}
	}
	Json *cursor = cursorJson(vt);
	if (!whole && jsonEqual(cursor, pty->cursor)) {
		jsonFree(cursor);
	} else {
		pty->cursor = cursor;
		changed = true;
	}
	if (!changed) return NULL;
	Json *screen = jsonObject(), *lines = jsonArray(), *styles = jsonArray();
	for (int r = 0; r < vt->rows; r++) {
		jsonPush(lines, pty->lines[r]);
		jsonPush(styles, pty->styles[r]);
	}
	jsonAdd(screen, "rows", jsonInteger(vt->rows));
	jsonAdd(screen, "cols", jsonInteger(vt->cols));
	jsonAdd(screen, "lines", lines);
	jsonAdd(screen, "styles", styles);
	jsonAdd(screen, "cursor", pty->cursor);
	Json *snapshot = jsonObject(), *patches = jsonArray();
	jsonAdd(snapshot, "type", jsonString("snapshot"));
	jsonAdd(snapshot, "value", screen);
	jsonPush(patches, snapshot);
	return patches;
}

static int ptyTick(Host *host, Proc *proc, double now) {
	Pty *pty = proc->state;
	if (!pty->vt->dirty) return -1;
	double wait = pty->flushed + FRAME - now;
	if (wait > 0) return (int)(wait * 1000) + 1;
	pty->vt->dirty = false;
	pty->flushed = now;
	Json *patches = screenPatches(pty);
	if (patches) hostWriteOwn(host, proc, "screen", patches);
	return -1;
}

const Loader ptyLoader = { "pty", ptyCheck, ptyStart, ptyKill, ptyReady, ptyKeys, ptyResized, ptyTick };
