// drv_pty.c: /drivers/pty, Mac command-line programs (zsh, vim, htop, git)
// on pseudo-terminals, each session a node. A session is a line, as
// /dev/uart0 and a terminal window's are (programs/shell), seen from the
// program's side: rx what is typed to it, tx what it printed; and both
// counted in stats, so any number of readers each keep their own place.
//
//   /dev/pty/driver/on/new   (request?) starts a session: {argv?, cwd?, env?, cols?, rows?, to?, at?, screen?};
//                            argv the person's $SHELL, -l (argv[0] found on PATH, then in /opt/homebrew/bin,
//                            /usr/local/bin); cwd $HOME; env added to the OS's, TERM xterm-256color,
//                            COLORTERM truecolor and LANG en_US.UTF-8 (with no locale) unless given;
//                            at, a node to make it in (a shared document), else /dev/pty; screen,
//                            {lines, cursor: {row, col}}, what the terminal showed: its screen starts as
//                            that, as a terminal's goes on from where it was. Answers {name, address}
//   /dev/pty/<n>             the session: {argv, cwd}; or, made at an address, {at: that address}
//     rx                     bytes typed to the program, the last 4096; a writer appends and adds to stats.rx
//     tx                     bytes the program printed, the last 16384; only this driver writes it
//     stats                  {rx, tx, keys}: bytes in all, each way, and key records. A reader of tx
//                            takes the last (stats.tx - what it had seen) bytes of it, as the shell reads rx
//     size                   {cols, rows}: written, the pty is resized (TIOCSWINSZ, so SIGWINCH)
//     status                 {pid, running, exit, signal}: exit and signal null while it runs
//     to                     the redirect: a list of lines' addresses ([] none). Each line's
//                            machine side is this session while it is listed: what the program
//                            prints is appended to the line's tx, what is typed on its rx (by
//                            stats.rx) goes to the program. So a terminal window shows a session
//                            unchanged, and two show one. Emptied when the program exits.
//     screen                 what a terminal shows of it, libvterm's screen (below): what the program
//                            printed, read as xterm would. Only this driver writes it
//     scrollback             {lines, styles}: the last 1000 rows gone off the top of the main screen, oldest first
//     keys                   key records typed to it, the last 64: a writer appends and adds to
//                            stats.keys; libvterm's keyboard turns each into bytes, as the program's
//                            modes ask (below)
//
// The screen, erminex's grid (experimental_hosts/term/c/NOTES.md, The grid) and more:
//   {rows, cols, lines, styles, cursor, title, icon, alt, reverse, mouse, paste, app, keypad, focus, bell}
//   lines    a string a row, a code point a cell (a wide character's second cell left out),
//            trailing blanks left out but those a background or reverse shows
//   styles   a list of runs a row, [[col, style], ...], each from its col to the next's; [] plain.
//            style {fg?, bg?, rgb?: {fg?, bg?}, bold?, italic?, underline?, blink?, reverse?, conceal?,
//            strike?}: fg and bg xterm's 0-255, a true colour folded into them, and as it was in rgb
//            (0xrrggbb); a colour left out is the terminal's own
//   cursor   {row, col, visible, shape ("block", "underline", "bar"), blink}
//   title    and icon, what the program set (OSC 0, 1, 2), else ""
//   alt      the alternate screen is shown; reverse, the whole screen reversed (?5)
//   mouse    what the program asked to be told: "none", "click", "drag" (buttons held), "move" (any)
//   paste    bracketed paste (?2004); app, cursor keys (?1); keypad, the keypad's (DECKPAM); focus (?1004)
//   bell     bells rung, in all
// Written once a turn, with what changed since: a splice of each row that did (lines, styles), a
// set of the rest; whole when the size changes.
//
// A key record, as term gets them from the window manager: {key, mods?, text?}, key a name
// (Enter, Tab, Backspace, Escape, Space, ArrowUp, Home, PageUp, Delete, Help, F1...F20) or what
// the key is on a US keyboard ("a", "/"), text what it typed. mods: shift, ctrl, alt (meta, an
// escape first). Control and a letter, @ [ \ ] ^ _ / ? or a digit is the control character a VT
// sends for it. Or {text}: typed as it is (an input method's); {paste: text}: as the program's
// paste mode asks; {mouse: "down"|"up"|"move"|"wheel", button?: 1-3, dy?: -1|1, row, col, mods?}:
// what the program's mouse mode asks; {focus: bool}: a focus report if it asked.
//
// Unplacing a session hangs its program up (SIGHUP to its group). One that
// exited stays, with its status and its last output, until it is unplaced.
//
// The thread: polls every session's master; something there (or a write
// that waited) posts {"irq": 63} and waits for the host's turn to take it.
// The turn reads a burst on while it comes (8 ms at most), so a burst is
// one write of the screen. The turn (on/irq): each
// master read dry into tx and the lines in to, what waited written, the
// exited reaped.

#define _DARWIN_C_SOURCE

#include "drivers.h"
#include "drv.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <util.h> // forkpty
#include <vterm.h>

#define IRQ 63
#define KEEPIN 4096
#define KEEPOUT 16384
#define KEEPBACK 1000 // rows of scrollback
#define BUSY 8000 // µs a turn reads a burst for

extern char **environ;

typedef struct Seen {
	char *line; // the line's address, printed
	int64_t rx; // its stats.rx already sent
} Seen;

/** a row gone off the top: its cells, for libvterm to take back when the screen grows, and as written */
typedef struct Back {
	VTermScreenCell *cells;
	int cols;
	Json *line, *style;
} Back;

typedef struct Session {
	struct Pty *pty;
	int n, fd; // fd -1 once closed
	pid_t pid;
	Json *at; // its node's address
	bool running, gone;
	int64_t rx; // stats.rx already sent
	int64_t keys; // stats.keys already typed
	uint8_t *wait; // for the program, not yet taken
	size_t waiting;
	int cols, rows;
	ERM_LIST(Seen) lines;
	// the terminal: libvterm's, fed what the program prints
	VTerm *vt;
	VTermScreen *vs;
	bool changed, whole; // something to write; all of it
	bool *dirty; // rows, by damage
	Json **text, **runs; // each row as last written
	int wrows, wcols; // the size last written
	Json *props; // the rest, as last written
	char title[256], icon[256], building[256]; // a title comes in fragments
	size_t built;
	bool visible, blink, alt, reverse, focus;
	int shape, mouse;
	int64_t bells;
	Back back[KEEPBACK]; // a ring, oldest at head
	int head, backs;
	bool backed;
	// since the scrollback was last written: rows of it gone from the front, rows of it still there, rows
	// of it gone from the end, rows new at the end; whole after a clear
	int trimmed, left, popped, fresh;
	bool cleared;
	bool probing; // what libvterm sends is caught, not given: to learn a mode
	char probe[32];
	size_t probed;
} Session;

typedef struct Pty {
	Host *host;
	ERM_LIST(Session *) sessions;
	int count; // sessions made
	pthread_t watcher;
	pthread_mutex_t lock;
	pthread_cond_t taken;
	bool posted;
	int wake[2]; // a byte here: the watcher polls again, a session made
} Pty;

static Json *first(const ErmGiven *g) {
	return g->args && g->args->array.count ? g->args->array.items[0] : NULL;
}

static int64_t whole(const Json *v, int64_t otherwise) {
	int64_t n;
	return jsonIsWhole(v, &n) ? n : otherwise;
}

static Json *bytesOf(const Json *v) {
	return v && v->type == JSON_BYTES ? (Json *)v : NULL;
}

static Json *at(const Session *s, const char *name) {
	return drvUnder(s->at, name, NULL);
}

static Session *numbered(Pty *p, int n) {
	for (int i = 0; i < p->sessions.count; i++)
		if (p->sessions.items[i]->n == n) return p->sessions.items[i];
	return NULL;
}

/** bytes appended to a node holding bytes, the last keep kept */
static void append(const ErmPartApi *api, Json *address, const uint8_t *add, size_t n, size_t keep) {
	Json *old = bytesOf(drvRead(api, address));
	size_t had = old ? old->bytes.length : 0, total = had + n, from = total > keep ? total - keep : 0;
	uint8_t *all = malloc(total + 1);
	if (had) memcpy(all, old->bytes.data, had);
	memcpy(all + had, add, n);
	drvSnap(api, address, jsonBytes(all + from, total - from));
	free(all);
}

/** adds n to one count in a stats node */
static void count(const ErmPartApi *api, Json *address, const char *key, int64_t n) {
	Json *stats = drvRead(api, address);
	drvSet(api, address, key, jsonInteger(whole(jsonGet(stats, key), 0) + n));
}

// --- to the program: what waits is written as it is taken

static void give(Pty *p, Session *s, const uint8_t *bytes, size_t n) {
	if (s->fd < 0 || !n) return;
	if (!s->waiting) {
		ssize_t w = write(s->fd, bytes, n);
		if (w > 0) bytes += w, n -= (size_t)w;
		if (!n) return;
	}
	pthread_mutex_lock(&p->lock);
	s->wait = realloc(s->wait, s->waiting + n);
	memcpy(s->wait + s->waiting, bytes, n);
	s->waiting += n;
	pthread_mutex_unlock(&p->lock);
	char b = 0;
	if (write(p->wake[1], &b, 1) < 0) { } // the watcher polls for POLLOUT now
}

static void flush(Pty *p, Session *s) {
	pthread_mutex_lock(&p->lock);
	while (s->waiting && s->fd >= 0) {
		ssize_t w = write(s->fd, s->wait, s->waiting);
		if (w <= 0) break; // EAGAIN: its input is full for now
		memmove(s->wait, s->wait + w, s->waiting - (size_t)w);
		s->waiting -= (size_t)w;
	}
	pthread_mutex_unlock(&p->lock);
}

// --- the terminal: libvterm's screen, kept as the session's screen node

/** what libvterm sends the program: the keyboard's bytes, a mouse's, answers to its queries */
static void output(const char *bytes, size_t n, void *data) {
	Session *s = data;
	if (s->probing) {
		size_t m = n < sizeof s->probe - s->probed ? n : sizeof s->probe - s->probed;
		memcpy(s->probe + s->probed, bytes, m);
		s->probed += m;
		return;
	}
	give(s->pty, s, (const uint8_t *)bytes, n);
}

static int damaged(VTermRect rect, void *data) {
	Session *s = data;
	for (int r = rect.start_row; r < rect.end_row && r < s->rows; r++) if (r >= 0) s->dirty[r] = true;
	s->changed = true;
	return 1;
}

static int moved(VTermPos pos, VTermPos old, int visible, void *data) {
	(void)pos, (void)old, (void)visible;
	((Session *)data)->changed = true;
	return 1;
}

static int prop(VTermProp p, VTermValue *v, void *data) {
	Session *s = data;
	s->changed = true;
	switch (p) {
	case VTERM_PROP_CURSORVISIBLE: s->visible = v->boolean; break;
	case VTERM_PROP_CURSORBLINK: s->blink = v->boolean; break;
	case VTERM_PROP_ALTSCREEN: s->alt = v->boolean; break;
	case VTERM_PROP_REVERSE: s->reverse = v->boolean; break;
	case VTERM_PROP_CURSORSHAPE: s->shape = v->number; break;
	case VTERM_PROP_MOUSE: s->mouse = v->number; break;
	case VTERM_PROP_FOCUSREPORT: s->focus = v->boolean; break;
	case VTERM_PROP_TITLE:
	case VTERM_PROP_ICONNAME: {
		// a string comes in fragments: the last one says it is whole
		if (v->string.initial) s->built = 0;
		size_t m = v->string.len < sizeof s->building - 1 - s->built ? v->string.len : sizeof s->building - 1 - s->built;
		memcpy(s->building + s->built, v->string.str, m);
		s->built += m;
		if (v->string.final) {
			char *to = p == VTERM_PROP_TITLE ? s->title : s->icon;
			memcpy(to, s->building, s->built);
			to[s->built] = 0;
		}
		break;
	}
	default: break;
	}
	return 1;
}

static int rang(void *data) {
	Session *s = data;
	s->bells++;
	s->changed = true;
	return 1;
}

static int resized(int rows, int cols, void *data) {
	Session *s = data;
	s->dirty = realloc(s->dirty, (size_t)rows * sizeof *s->dirty);
	s->rows = rows, s->cols = cols;
	s->whole = s->changed = true;
	return 1;
}

static Json *rowJson(Session *s, const VTermScreenCell *cells, int cols, Json **runs);

/** a row off the top of the main screen: kept, the oldest let go past KEEPBACK */
static int pushed(int cols, const VTermScreenCell *cells, void *data) {
	Session *s = data;
	Back *b;
	if (s->backs == KEEPBACK) {
		if (s->left) s->left--, s->trimmed++;
		else s->fresh--;
		b = &s->back[s->head];
		free(b->cells);
		s->head = (s->head + 1) % KEEPBACK;
	} else b = &s->back[(s->head + s->backs++) % KEEPBACK];
	s->fresh++;
	b->cells = malloc((size_t)cols * sizeof *cells);
	memcpy(b->cells, cells, (size_t)cols * sizeof *cells);
	b->cols = cols;
	b->line = b->style = NULL; // made when first written: a burst pushes many a row that is gone before then
	s->backed = s->changed = true;
	return 1;
}

/** the screen grew taller: the newest row kept goes back on it */
static int popped(int cols, VTermScreenCell *cells, void *data) {
	Session *s = data;
	if (!s->backs) return 0;
	if (s->fresh) s->fresh--;
	else s->left--, s->popped++;
	Back *b = &s->back[(s->head + --s->backs) % KEEPBACK];
	VTermColor fg, bg;
	vterm_state_get_default_colors(vterm_obtain_state(s->vt), &fg, &bg);
	for (int c = 0; c < cols; c++) {
		if (c < b->cols) cells[c] = b->cells[c];
		else cells[c] = (VTermScreenCell){ .chars = { 0 }, .width = 1, .fg = fg, .bg = bg };
	}
	free(b->cells);
	b->cells = NULL;
	s->backed = s->changed = true;
	return 1;
}

static int cleared(void *data) {
	Session *s = data;
	for (int i = 0; i < s->backs; i++) free(s->back[(s->head + i) % KEEPBACK].cells);
	s->head = s->backs = 0;
	s->trimmed = s->left = s->popped = s->fresh = 0;
	s->backed = s->changed = s->cleared = true;
	return 1;
}

static const VTermScreenCallbacks screenCalls = {
	.damage = damaged, .movecursor = moved, .settermprop = prop, .bell = rang, .resize = resized,
	.sb_pushline = pushed, .sb_popline = popped, .sb_clear = cleared,
};

static void terminal(Session *s) {
	s->dirty = calloc((size_t)s->rows, sizeof *s->dirty);
	s->vt = vterm_new(s->rows, s->cols);
	vterm_set_utf8(s->vt, 1);
	vterm_output_set_callback(s->vt, output, s);
	s->vs = vterm_obtain_screen(s->vt);
	vterm_screen_set_callbacks(s->vs, &screenCalls, s);
	vterm_screen_set_damage_merge(s->vs, VTERM_DAMAGE_CELL);
	vterm_screen_enable_altscreen(s->vs, 1);
	vterm_screen_enable_reflow(s->vs, true);
	vterm_screen_reset(s->vs, 1);
	s->visible = s->blink = true;
	s->shape = VTERM_PROP_CURSORSHAPE_BLOCK;
	s->whole = s->changed = true;
}

/** what a terminal showed when the session began, {lines, cursor: {row, col}}: its screen starts as that, the cursor there */
static void seed(Session *s, const Json *screen) {
	Json *lines = jsonGet(screen, "lines"), *cursor = jsonGet(screen, "cursor");
	if (!jsonIsArray(lines)) return;
	int n = lines->array.count < s->rows ? lines->array.count : s->rows;
	for (int r = 0; r < n; r++) {
		const char *t = jsonText(lines->array.items[r]);
		char at[32];
		snprintf(at, sizeof at, "\x1b[%d;1H", r + 1);
		vterm_input_write(s->vt, at, strlen(at));
		if (t) vterm_input_write(s->vt, t, strlen(t));
	}
	int row = (int)whole(jsonGet(cursor, "row"), n), col = (int)whole(jsonGet(cursor, "col"), 0);
	char at[32];
	snprintf(at, sizeof at, "\x1b[%d;%dH", (row < s->rows ? row : s->rows - 1) + 1, (col < s->cols ? col : s->cols - 1) + 1);
	vterm_input_write(s->vt, at, strlen(at));
	// a row past the bottom: the screen goes up, as a newline there would take it
	for (int r = s->rows; r <= row; r++) vterm_input_write(s->vt, "\n", 1);
}

static void unterminal(Session *s) {
	if (s->vt) vterm_free(s->vt);
	s->vt = NULL;
	for (int i = 0; i < s->backs; i++) free(s->back[(s->head + i) % KEEPBACK].cells);
	s->backs = 0;
	free(s->dirty);
	free(s->text);
	free(s->runs);
}

/** a colour as the screen node has it: -1 the terminal's own, 0-255 xterm's, else 1 << 24 | 0xrrggbb */
static int colour(const VTermColor *c, bool fg) {
	if (fg ? VTERM_COLOR_IS_DEFAULT_FG(c) : VTERM_COLOR_IS_DEFAULT_BG(c)) return -1;
	if (VTERM_COLOR_IS_INDEXED(c)) return c->indexed.idx;
	return 1 << 24 | c->rgb.red << 16 | c->rgb.green << 8 | c->rgb.blue;
}

/** a true colour's nearest of xterm's 256: the 6x6x6 cube or the greys */
static int nearest(int rgb) {
	int r = rgb >> 16 & 255, g = rgb >> 8 & 255, b = rgb & 255;
	static const int level[] = { 0, 95, 135, 175, 215, 255 };
	int ri = r < 48 ? 0 : r < 115 ? 1 : (r - 35) / 40, gi = g < 48 ? 0 : g < 115 ? 1 : (g - 35) / 40, bi = b < 48 ? 0 : b < 115 ? 1 : (b - 35) / 40;
	int grey = ((r + g + b) / 3 - 3) / 10;
	grey = grey < 0 ? 0 : grey > 23 ? 23 : grey;
	int gv = 8 + 10 * grey;
	int dc = (r - level[ri]) * (r - level[ri]) + (g - level[gi]) * (g - level[gi]) + (b - level[bi]) * (b - level[bi]);
	int dg = (r - gv) * (r - gv) + (g - gv) * (g - gv) + (b - gv) * (b - gv);
	return dg < dc ? 232 + grey : 16 + 36 * ri + 6 * gi + bi;
}

typedef struct Pen {
	int fg, bg;
	unsigned flags;
} Pen;

enum { BOLD = 1, ITALIC = 2, UNDERLINE = 4, BLINK = 8, REVERSE = 16, CONCEAL = 32, STRIKE = 64 };

static Pen penOf(const VTermScreenCell *c) {
	Pen p = { colour(&c->fg, true), colour(&c->bg, false), 0 };
	if (c->attrs.bold) p.flags |= BOLD;
	if (c->attrs.italic) p.flags |= ITALIC;
	if (c->attrs.underline) p.flags |= UNDERLINE;
	if (c->attrs.blink) p.flags |= BLINK;
	if (c->attrs.reverse) p.flags |= REVERSE;
	if (c->attrs.conceal) p.flags |= CONCEAL;
	if (c->attrs.strike) p.flags |= STRIKE;
	return p;
}

static Json *penJson(Pen p) {
	Json *style = jsonObject(), *rgb = NULL;
	if (p.fg >= 0) jsonAdd(style, "fg", jsonInteger(p.fg > 255 ? nearest(p.fg) : p.fg));
	if (p.bg >= 0) jsonAdd(style, "bg", jsonInteger(p.bg > 255 ? nearest(p.bg) : p.bg));
	if (p.fg > 255 || p.bg > 255) {
		rgb = jsonObject();
		if (p.fg > 255) jsonAdd(rgb, "fg", jsonInteger(p.fg & 0xffffff));
		if (p.bg > 255) jsonAdd(rgb, "bg", jsonInteger(p.bg & 0xffffff));
		jsonAdd(style, "rgb", rgb);
	}
	static const char *names[] = { "bold", "italic", "underline", "blink", "reverse", "conceal", "strike" };
	for (int i = 0; i < 7; i++) if (p.flags & 1u << i) jsonAdd(style, names[i], jsonBoolean(true));
	return style;
}

/** a row's text, and its runs in *runs: as erminex's grid has them */
static Json *rowJson(Session *s, const VTermScreenCell *cells, int cols, Json **runs) {
	(void)s;
	*runs = jsonArray();
	Pen now = { -1, -1, 0 };
	int end = 0; // past the last cell that shows
	for (int c = 0; c < cols; c++) {
		const VTermScreenCell *cell = &cells[c];
		Pen p = penOf(cell);
		if ((cell->chars[0] && cell->chars[0] != ' ' && cell->chars[0] != (uint32_t)-1) || p.bg >= 0 || (p.flags & REVERSE)) end = c + 1;
		if (p.fg == now.fg && p.bg == now.bg && p.flags == now.flags) continue;
		Json *run = jsonArray();
		jsonPush(run, jsonInteger(c));
		jsonPush(run, penJson(p));
		jsonPush(*runs, run);
		now = p;
	}
	char *text = malloc((size_t)end * VTERM_MAX_CHARS_PER_CELL * 4 + 1);
	size_t n = 0;
	for (int c = 0; c < end; c++) {
		const uint32_t *ch = cells[c].chars;
		if (ch[0] == (uint32_t)-1) continue; // a wide character's second cell
		if (!ch[0]) {
			text[n++] = ' ';
			continue;
		}
		for (int i = 0; i < VTERM_MAX_CHARS_PER_CELL && ch[i]; i++) {
			uint32_t u = ch[i];
			if (u < 0x80) text[n++] = (char)u;
			else if (u < 0x800) text[n++] = (char)(0xc0 | u >> 6), text[n++] = (char)(0x80 | (u & 0x3f));
			else if (u < 0x10000) text[n++] = (char)(0xe0 | u >> 12), text[n++] = (char)(0x80 | (u >> 6 & 0x3f)), text[n++] = (char)(0x80 | (u & 0x3f));
			else if (u < 0x110000) text[n++] = (char)(0xf0 | u >> 18), text[n++] = (char)(0x80 | (u >> 12 & 0x3f)), text[n++] = (char)(0x80 | (u >> 6 & 0x3f)), text[n++] = (char)(0x80 | (u & 0x3f));
		}
	}
	Json *line = jsonStringOfLength(text, n);
	free(text);
	return line;
}

static Json *screenRow(Session *s, int row, Json **runs) {
	VTermScreenCell cells[1000];
	for (int c = 0; c < s->cols && c < 1000; c++) {
		if (!vterm_screen_get_cell(s->vs, (VTermPos){ row, c }, &cells[c])) cells[c] = (VTermScreenCell){ .chars = { 0 }, .width = 1 };
		// get_cell stops at the first empty char: the rest are as they were
		for (int i = 1; i < VTERM_MAX_CHARS_PER_CELL; i++) if (!cells[c].chars[i - 1]) cells[c].chars[i] = 0;
	}
	return rowJson(s, cells, s->cols, runs);
}

/** what the program's modes are: libvterm's keyboard asked, and what it would send caught */
static bool sends(Session *s, void (*ask)(VTerm *, int), int arg, const char *what) {
	s->probing = true;
	s->probed = 0;
	ask(s->vt, arg);
	s->probing = false;
	return s->probed >= strlen(what) && !memcmp(s->probe, what, strlen(what));
}

static void pasteStart(VTerm *vt, int arg) {
	(void)arg;
	vterm_keyboard_start_paste(vt);
}

static void keyAsk(VTerm *vt, int key) {
	vterm_keyboard_key(vt, (VTermKey)key, VTERM_MOD_NONE);
}

static Json *propsOf(Session *s) {
	VTermPos at;
	vterm_state_get_cursorpos(vterm_obtain_state(s->vt), &at);
	static const char *shapes[] = { "block", "block", "underline", "bar" };
	static const char *mice[] = { "none", "click", "drag", "move" };
	Json *cursor = drvMap("row", jsonInteger(at.row), "col", jsonInteger(at.col), "visible", jsonBoolean(s->visible),
	                      "shape", jsonString(shapes[s->shape >= 0 && s->shape < 4 ? s->shape : 0]), "blink", jsonBoolean(s->blink), NULL);
	return drvMap("cursor", cursor, "title", jsonString(s->title), "icon", jsonString(s->icon), "alt", jsonBoolean(s->alt),
	              "reverse", jsonBoolean(s->reverse), "mouse", jsonString(mice[s->mouse >= 0 && s->mouse < 4 ? s->mouse : 0]),
	              "paste", jsonBoolean(sends(s, pasteStart, 0, "\x1b[200~")), "app", jsonBoolean(sends(s, keyAsk, VTERM_KEY_UP, "\x1bO")),
	              "keypad", jsonBoolean(sends(s, keyAsk, VTERM_KEY_KP_ENTER, "\x1bO")), "focus", jsonBoolean(s->focus),
	              "bell", jsonInteger(s->bells), NULL);
}

static Json *range(int from, int to) {
	Json *r = jsonArray();
	jsonPush(r, jsonInteger(from));
	jsonPush(r, jsonInteger(to));
	return r;
}

static Json *splice(const char *key, int row, Json *value) {
	Json *path = jsonArray(), *range = jsonArray(), *with = jsonArray();
	jsonPush(path, jsonString(key));
	jsonPush(range, jsonInteger(row));
	jsonPush(range, jsonInteger(row + 1));
	jsonPush(with, value);
	return drvMap("type", jsonString("splice"), "path", path, "range", range, "value", with, NULL);
}

/** the screen node brought to libvterm's screen: the rows that changed, the rest that did; and the scrollback */
static void publish(const ErmGiven *g, Session *s) {
	if (!s->vt || s->gone) return;
	vterm_screen_flush_damage(s->vs);
	if (!s->changed) return;
	s->changed = false;
	bool whole = s->whole || s->wrows != s->rows || s->wcols != s->cols || !s->text;
	s->whole = false;
	Json *props = propsOf(s);
	if (whole) {
		free(s->text);
		free(s->runs);
		s->text = calloc((size_t)s->rows, sizeof *s->text);
		s->runs = calloc((size_t)s->rows, sizeof *s->runs);
		s->wrows = s->rows, s->wcols = s->cols;
		Json *lines = jsonArray(), *styles = jsonArray();
		for (int r = 0; r < s->rows; r++) {
			s->text[r] = screenRow(s, r, &s->runs[r]);
			jsonPush(lines, s->text[r]);
			jsonPush(styles, s->runs[r]);
			s->dirty[r] = false;
		}
		Json *screen = drvMap("rows", jsonInteger(s->rows), "cols", jsonInteger(s->cols), "lines", lines, "styles", styles, NULL);
		for (int i = 0; i < props->object.count; i++) jsonAdd(screen, props->object.members[i].key, props->object.members[i].value);
		drvSnap(g->api, at(s, "screen"), screen);
	} else {
		Json *patches = jsonArray();
		for (int r = 0; r < s->rows; r++) {
			if (!s->dirty[r]) continue;
			s->dirty[r] = false;
			Json *runs, *line = screenRow(s, r, &runs);
			if (!jsonEqual(line, s->text[r])) jsonPush(patches, splice("lines", r, s->text[r] = line));
			else jsonFree(line);
			if (!jsonEqual(runs, s->runs[r])) jsonPush(patches, splice("styles", r, s->runs[r] = runs));
			else jsonFree(runs);
		}
		for (int i = 0; i < props->object.count; i++) {
			JsonMember *m = &props->object.members[i];
			if (!jsonEqual(m->value, jsonGet(s->props, m->key)))
				jsonPush(patches, drvMap("type", jsonString("set"), "path", jsonArray(), "key", jsonString(m->key), "value", m->value, NULL));
		}
		if (patches->array.count) drvOp(g->api, "write", drvMap("address", at(s, "screen"), "patches", patches, NULL));
	}
	s->props = props;
	if (s->backed) {
		// a splice from the front for the rows gone there, one from the end for those taken back, one for
		// the new: the rows a burst pushes and lets go before this are never written
		s->backed = false;
		Json *patches = jsonArray();
		for (int k = 0; k < 2; k++) {
			const char *key = k ? "styles" : "lines";
			if (s->trimmed) jsonPush(patches, drvMap("type", jsonString("splice"), "path", drvPath(key, NULL), "range", range(0, s->trimmed), "value", jsonArray(), NULL));
			if (s->popped) jsonPush(patches, drvMap("type", jsonString("splice"), "path", drvPath(key, NULL), "range", range(s->left, s->left + s->popped), "value", jsonArray(), NULL));
			Json *rows = jsonArray();
			for (int i = s->backs - s->fresh; i < s->backs; i++) {
				Back *b = &s->back[(s->head + i) % KEEPBACK];
				if (!b->line) b->line = rowJson(s, b->cells, b->cols, &b->style);
				jsonPush(rows, k ? b->style : b->line);
			}
			if (s->fresh) jsonPush(patches, drvMap("type", jsonString("splice"), "path", drvPath(key, NULL), "range", range(s->left, s->left), "value", rows, NULL));
		}
		if (s->cleared) drvSnap(g->api, at(s, "scrollback"), drvMap("lines", jsonArray(), "styles", jsonArray(), NULL));
		if (patches->array.count) drvOp(g->api, "write", drvMap("address", at(s, "scrollback"), "patches", patches, NULL));
		s->left = s->backs;
		s->trimmed = s->popped = s->fresh = 0;
		s->cleared = false;
	}
}

// --- keys: records to libvterm's keyboard

static const struct {
	const char *name;
	VTermKey key;
} NAMED[] = {
	{ "Enter", VTERM_KEY_ENTER }, { "Tab", VTERM_KEY_TAB }, { "Backspace", VTERM_KEY_BACKSPACE }, { "Escape", VTERM_KEY_ESCAPE },
	{ "ArrowUp", VTERM_KEY_UP }, { "ArrowDown", VTERM_KEY_DOWN }, { "ArrowLeft", VTERM_KEY_LEFT }, { "ArrowRight", VTERM_KEY_RIGHT },
	{ "Insert", VTERM_KEY_INS }, { "Help", VTERM_KEY_INS }, { "Delete", VTERM_KEY_DEL }, { "Home", VTERM_KEY_HOME },
	{ "End", VTERM_KEY_END }, { "PageUp", VTERM_KEY_PAGEUP }, { "PageDown", VTERM_KEY_PAGEDOWN },
};

/** a US keyboard's key, shifted */
static uint32_t shifted(uint32_t c) {
	if (c >= 'a' && c <= 'z') return c - 32;
	const char *from = "1234567890-=[]\\;',./`", *to = "!@#$%^&*()_+{}|:\"<>?~";
	const char *at = c < 128 ? strchr(from, (int)c) : NULL;
	return at && c ? (uint32_t)to[at - from] : c;
}

/** control and a key, as a VT sends it: the control character, or -1 for one it has none for */
static int control(uint32_t c) {
	if (c >= 'a' && c <= 'z') return (int)(c - 'a' + 1);
	if (c >= 'A' && c <= 'Z') return (int)(c - 'A' + 1);
	switch (c) {
	case ' ': case '@': case '2': return 0;
	case '[': case '3': return 27;
	case '\\': case '4': return 28;
	case ']': case '5': return 29;
	case '^': case '6': case '~': case '`': return 30;
	case '_': case '/': case '-': case '7': return 31;
	case '?': case '8': return 127;
	}
	return -1;
}

/** one code point of UTF-8 text, and its length in *n; 0xfffd for what is not UTF-8 */
static uint32_t decode(const char *t, size_t left, size_t *n) {
	const unsigned char *u = (const unsigned char *)t;
	int need = u[0] < 0x80 ? 0 : u[0] >= 0xf0 ? 3 : u[0] >= 0xe0 ? 2 : u[0] >= 0xc0 ? 1 : -1;
	if (need < 0 || (size_t)need >= left) {
		*n = 1;
		return 0xfffd;
	}
	uint32_t c = need ? u[0] & (0x3f >> need) : u[0];
	for (int i = 1; i <= need; i++) c = c << 6 | (u[i] & 0x3f);
	*n = (size_t)need + 1;
	return c;
}

static VTermModifier modsOf(const Json *mods) {
	int m = VTERM_MOD_NONE;
	for (int i = 0; jsonIsArray(mods) && i < mods->array.count; i++) {
		const char *t = jsonText(mods->array.items[i]);
		if (!t) continue;
		if (!strcmp(t, "shift")) m |= VTERM_MOD_SHIFT;
		else if (!strcmp(t, "ctrl")) m |= VTERM_MOD_CTRL;
		else if (!strcmp(t, "alt")) m |= VTERM_MOD_ALT;
	}
	return (VTermModifier)m;
}

static void typeText(Session *s, const char *t, bool paste) {
	for (size_t i = 0, n, len = strlen(t); i < len; i += n) {
		uint32_t c = decode(t + i, len - i, &n);
		if (paste && c == '\n') c = '\r'; // a terminal's paste ends its lines with return, as Enter does
		if (c < 0x20 || c == 0x7f) {
			char b = (char)c;
			give(s->pty, s, (const uint8_t *)&b, 1);
		} else vterm_keyboard_unichar(s->vt, c, VTERM_MOD_NONE);
	}
}

static void typeKey(Session *s, const Json *r) {
	const char *key = jsonText(jsonGet(r, "key")), *text = jsonText(jsonGet(r, "text")), *paste = jsonText(jsonGet(r, "paste"));
	const char *mouse = jsonText(jsonGet(r, "mouse"));
	VTermModifier mod = modsOf(jsonGet(r, "mods"));
	if (paste) {
		vterm_keyboard_start_paste(s->vt);
		typeText(s, paste, true);
		vterm_keyboard_end_paste(s->vt);
		return;
	}
	if (mouse) {
		int row = (int)whole(jsonGet(r, "row"), 0), col = (int)whole(jsonGet(r, "col"), 0), button = (int)whole(jsonGet(r, "button"), 1);
		row = row < 0 ? 0 : row >= s->rows ? s->rows - 1 : row;
		col = col < 0 ? 0 : col >= s->cols ? s->cols - 1 : col;
		vterm_mouse_move(s->vt, row, col, mod);
		if (!strcmp(mouse, "down") || !strcmp(mouse, "up")) vterm_mouse_button(s->vt, button, !strcmp(mouse, "down"), mod);
		else if (!strcmp(mouse, "wheel")) vterm_mouse_button(s->vt, whole(jsonGet(r, "dy"), 1) < 0 ? 4 : 5, true, mod);
		return;
	}
	Json *focus = jsonGet(r, "focus");
	if (focus && focus->type == JSON_BOOLEAN) {
		if (focus->boolean) vterm_state_focus_in(vterm_obtain_state(s->vt));
		else vterm_state_focus_out(vterm_obtain_state(s->vt));
		return;
	}
	if (!key) {
		if (text) typeText(s, text, false);
		return;
	}
	for (size_t i = 0; i < sizeof NAMED / sizeof *NAMED; i++)
		if (!strcmp(key, NAMED[i].name)) {
			vterm_keyboard_key(s->vt, NAMED[i].key, mod);
			return;
		}
	if (key[0] == 'F' && key[1] >= '1' && key[1] <= '9') {
		vterm_keyboard_key(s->vt, VTERM_KEY_FUNCTION(atoi(key + 1)), mod);
		return;
	}
	size_t n;
	uint32_t c = !strcmp(key, "Space") ? ' ' : decode(key, strlen(key), &n);
	if (strcmp(key, "Space") && n != strlen(key)) return; // a name it does not know
	if (mod & VTERM_MOD_CTRL) {
		int k = control(mod & VTERM_MOD_SHIFT ? shifted(c) : c);
		if (k < 0) k = control(c);
		if (k >= 0) {
			char b[2] = { 0x1b, (char)k };
			give(s->pty, s, (const uint8_t *)b + !(mod & VTERM_MOD_ALT), (mod & VTERM_MOD_ALT) ? 2 : 1);
		} else vterm_keyboard_unichar(s->vt, c, mod);
	} else if (mod & VTERM_MOD_ALT) {
		vterm_keyboard_unichar(s->vt, mod & VTERM_MOD_SHIFT ? shifted(c) : c, VTERM_MOD_ALT);
	} else if (text && *text && (unsigned char)text[0] >= 0x20 && text[0] != 0x7f) typeText(s, text, false);
	else vterm_keyboard_unichar(s->vt, mod & VTERM_MOD_SHIFT ? shifted(c) : c, VTERM_MOD_NONE);
}

// --- the thread

static void *watch(void *data) {
	Pty *p = data;
	struct pollfd fds[257];
	for (;;) {
		int n = 0;
		fds[n++] = (struct pollfd){ p->wake[0], POLLIN, 0 };
		pthread_mutex_lock(&p->lock);
		for (int i = 0; i < p->sessions.count && n < 257; i++) {
			Session *s = p->sessions.items[i];
			if (s->fd >= 0) fds[n++] = (struct pollfd){ s->fd, (short)(POLLIN | (s->waiting ? POLLOUT : 0)), 0 };
		}
		pthread_mutex_unlock(&p->lock);
		if (poll(fds, (nfds_t)n, -1) < 0) continue;
		if (fds[0].revents & POLLIN) {
			char b[64];
			if (read(p->wake[0], b, sizeof b) < 0) { }
		}
		bool any = false;
		for (int i = 1; i < n; i++) any = any || fds[i].revents;
		if (!any) continue;
		pthread_mutex_lock(&p->lock);
		p->posted = true;
		ermosPost("{\"irq\": 63}");
		while (p->posted) pthread_cond_wait(&p->taken, &p->lock);
		pthread_mutex_unlock(&p->lock);
	}
	return NULL;
}

// --- the turn

static Json *statusOf(const Session *s, int how) {
	bool ended = !s->running;
	return drvMap("pid", jsonInteger(s->pid), "running", jsonBoolean(s->running),
	              "exit", ended && WIFEXITED(how) ? jsonInteger(WEXITSTATUS(how)) : jsonNull(),
	              "signal", ended && WIFSIGNALED(how) ? jsonInteger(WTERMSIG(how)) : jsonNull(), NULL);
}

/** what the program printed in a turn, n bytes, of which the last (at most KEEPOUT) are kept: into tx, and
 * onto every line in to but one whose stats says screen (its reader shows the session's screen) */
static void printed(const ErmGiven *g, Session *s, const uint8_t *kept, size_t k, int64_t n) {
	append(g->api, at(s, "tx"), kept, k, KEEPOUT);
	count(g->api, at(s, "stats"), "tx", n);
	Json *to = drvRead(g->api, at(s, "to"));
	for (int i = 0; jsonIsArray(to) && i < to->array.count; i++) {
		Json *line = to->array.items[i], *screen = jsonGet(drvRead(g->api, drvUnder(line, "stats", NULL)), "screen");
		if (screen && screen->type == JSON_BOOLEAN && screen->boolean) continue;
		if (jsonIsArray(line) && bytesOf(drvRead(g->api, drvUnder(line, "tx", NULL)))) append(g->api, drvUnder(line, "tx", NULL), kept, k, KEEPOUT);
	}
}

static int64_t clockUs(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (int64_t)t.tv_sec * 1000000 + t.tv_nsec / 1000;
}

/** irq 63: each master read dry, what waits written, the exited reaped */
static ErmErr ptyIrq(void *data, const ErmGiven *g, Json **out) {
	Pty *p = data;
	*out = jsonNull();
	static uint8_t buf[16384], tail[KEEPOUT];
	// a burst goes on being read while it comes, up to BUSY µs a turn: a pty holds little, so its program
	// writes on at once, and the screen is written once for all of it
	int64_t until = clockUs() + BUSY;
	for (int i = 0; i < p->sessions.count; i++) {
		Session *s = p->sessions.items[i];
		if (s->fd < 0) continue;
		flush(p, s);
		size_t k = 0; // the last of it, in tail
		int64_t n = 0;
		bool done = false;
		for (;;) {
			ssize_t r = read(s->fd, buf, sizeof buf);
			if (r > 0) {
				if (s->vt && !s->gone) vterm_input_write(s->vt, (const char *)buf, (size_t)r);
				n += r;
				if ((size_t)r >= sizeof tail) memcpy(tail, buf + r - sizeof tail, k = sizeof tail);
				else {
					size_t keep = k + (size_t)r > sizeof tail ? sizeof tail - (size_t)r : k;
					memmove(tail, tail + k - keep, keep);
					memcpy(tail + keep, buf, (size_t)r);
					k = keep + (size_t)r;
				}
				continue;
			}
			if (r < 0 && errno == EINTR) continue;
			if (r < 0 && errno == EAGAIN) {
				// a burst (not a key's echo): more may come at once
				struct pollfd more = { s->fd, POLLIN, 0 };
				if (n >= 1024 && clockUs() < until && poll(&more, 1, 1) > 0) continue;
				break;
			}
			done = true; // EIO or 0: every slave side closed
			break;
		}
		if (n && !s->gone) printed(g, s, tail, k, n);
		int how = 0;
		if (s->running && waitpid(s->pid, &how, WNOHANG) == s->pid) {
			s->running = false;
			if (!s->gone) {
				drvSnap(g->api, at(s, "status"), statusOf(s, how));
				// the redirect ends with the program: each line's own machine side has it back
				drvSnap(g->api, at(s, "to"), jsonArray());
			}
		}
		if (done || (!s->running && !s->waiting)) {
			pthread_mutex_lock(&p->lock);
			close(s->fd);
			s->fd = -1;
			pthread_mutex_unlock(&p->lock);
		}
		publish(g, s);
	}
	// a session gone and its program reaped: forgotten
	pthread_mutex_lock(&p->lock);
	int k = 0;
	for (int i = 0; i < p->sessions.count; i++) {
		Session *s = p->sessions.items[i];
		if (s->running && s->fd < 0) {
			int how;
			if (waitpid(s->pid, &how, WNOHANG) == s->pid) {
				s->running = false;
				if (!s->gone) drvSnap(g->api, at(s, "status"), statusOf(s, how));
			}
		}
		if (s->gone && !s->running && s->fd < 0) {
			for (int j = 0; j < s->lines.count; j++) free(s->lines.items[j].line);
			free(s->lines.items);
			free(s->wait);
			unterminal(s);
			free(s);
			continue;
		}
		p->sessions.items[k++] = s;
	}
	p->sessions.count = k;
	p->posted = false;
	pthread_cond_signal(&p->taken);
	pthread_mutex_unlock(&p->lock);
	return ermOk();
}

// --- a session made

/** argv[0] as the program to run: a path, or found on PATH, then where Homebrew keeps them (a Mac app's PATH is short) */
static char *found(const char *name) {
	if (strchr(name, '/')) return copyString(name);
	const char *path = getenv("PATH");
	char *all = formatString("%s:/opt/homebrew/bin:/usr/local/bin", path && *path ? path : "/usr/bin:/bin:/usr/sbin:/sbin"), *rest = all;
	for (char *dir; (dir = strsep(&rest, ":"));) {
		char *f = formatString("%s/%s", *dir ? dir : ".", name);
		if (access(f, X_OK) == 0) {
			free(all);
			return f;
		}
		free(f);
	}
	free(all);
	return NULL;
}

/** the OS's environment, then TERM, COLORTERM and a UTF-8 locale, then what was given (a null takes one away) */
static char **environment(const Json *given) {
	ERM_LIST(char *) env = { 0 };
	const char *term = "TERM=xterm-256color";
	// the terminal is libvterm's: true colour, and UTF-8 unless the OS says what its locale is
	bool locale = getenv("LANG") || getenv("LC_ALL") || getenv("LC_CTYPE");
	for (char **e = environ; *e; e++) {
		const char *eq = strchr(*e, '=');
		bool replaced = !strncmp(*e, "TERM=", 5);
		for (int i = 0; given && given->type == JSON_OBJECT && eq && i < given->object.count; i++) {
			const JsonMember *m = &given->object.members[i];
			if (m->keyLength == (size_t)(eq - *e) && !memcmp(m->key, *e, m->keyLength)) replaced = true;
		}
		if (!replaced) ERM_PUSH(env, copyString(*e));
	}
	bool termGiven = false, colourGiven = false;
	for (int i = 0; given && given->type == JSON_OBJECT && i < given->object.count; i++) {
		const JsonMember *m = &given->object.members[i];
		if (!strcmp(m->key, "TERM")) termGiven = true;
		if (!strcmp(m->key, "COLORTERM")) colourGiven = true;
		if (!strcmp(m->key, "LANG") || !strcmp(m->key, "LC_ALL") || !strcmp(m->key, "LC_CTYPE")) locale = true;
		if (jsonText(m->value)) ERM_PUSH(env, formatString("%s=%s", m->key, jsonText(m->value)));
	}
	if (!termGiven) ERM_PUSH(env, copyString(term));
	if (!colourGiven && !getenv("COLORTERM")) ERM_PUSH(env, copyString("COLORTERM=truecolor"));
	if (!locale) ERM_PUSH(env, copyString("LANG=en_US.UTF-8"));
	ERM_PUSH(env, NULL);
	return env.items;
}

static void freeAll(char **list) {
	for (char **e = list; e && *e; e++) free(*e);
	free(list);
}

/** on/new: (request?) a session, its program started on a pty */
static ErmErr ptyNew(void *data, const ErmGiven *g, Json **out) {
	Pty *p = data;
	*out = jsonNull();
	Json *r = first(g), *argv = jsonGet(r, "argv"), *place = jsonGet(r, "at");
	const char *shell = getenv("SHELL") && *getenv("SHELL") ? getenv("SHELL") : "/bin/zsh";
	const char *home = getenv("HOME") && *getenv("HOME") ? getenv("HOME") : "/";
	Json *args = jsonArray();
	for (int i = 0; jsonIsArray(argv) && i < argv->array.count; i++) {
		if (!jsonText(argv->array.items[i])) return ermField("wrong-field", "argv");
		jsonPush(args, argv->array.items[i]);
	}
	if (!args->array.count) jsonPush(args, jsonString(shell)), jsonPush(args, jsonString("-l"));
	const char *cwd = jsonText(jsonGet(r, "cwd")) ? jsonText(jsonGet(r, "cwd")) : home;
	int cols = (int)whole(jsonGet(r, "cols"), 80), rows = (int)whole(jsonGet(r, "rows"), 24);
	if (cols < 1 || cols > 1000) cols = 80;
	if (rows < 1 || rows > 1000) rows = 24;
	if (place && (!jsonIsArray(place) || !drvHas(g->api, place))) return ermField("wrong-field", "at");

	// everything the child needs, made before the fork: it only changes folder and runs it
	char *path = found(jsonText(args->array.items[0]));
	if (!path) return ermDetail(ermInvalid("not-found"), "argv", jsonShallow(args));
	char **cargs = calloc((size_t)args->array.count + 1, sizeof *cargs);
	for (int i = 0; i < args->array.count; i++) cargs[i] = copyString(jsonText(args->array.items[i]));
	char **env = environment(jsonGet(r, "env"));
	char *dir = copyString(cwd);
	struct winsize ws = { .ws_row = (unsigned short)rows, .ws_col = (unsigned short)cols };
	int fd = -1;
	pid_t pid = forkpty(&fd, NULL, NULL, &ws);
	if (pid == 0) {
		if (chdir(dir) < 0 && chdir("/") < 0) _exit(126);
		signal(SIGPIPE, SIG_DFL);
		execve(path, cargs, env);
		_exit(127);
	}
	free(path);
	free(dir);
	freeAll(cargs);
	freeAll(env);
	if (pid < 0) return ermDetail(ermInvalid("pty"), "errno", jsonInteger(errno));
	fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
	fcntl(fd, F_SETFD, FD_CLOEXEC);

	Session *s = calloc(1, sizeof *s);
	s->pty = p;
	s->n = ++p->count;
	s->fd = fd;
	s->pid = pid;
	s->running = true;
	s->cols = cols;
	s->rows = rows;
	char n[16], *id = formatString("pty/%d", s->n);
	snprintf(n, sizeof n, "%d", s->n);
	Json *dev = drvPath("/", "dev", "pty", NULL), *what = drvMap("argv", args, "cwd", jsonString(cwd), NULL);
	if (place) {
		// made where it was asked, a shared document's node; /dev/pty/<n> says where
		s->at = drvUnder(place, n, NULL);
		drvMake(g->api, place, n, id, what);
		free(id);
		id = formatString("pty/%d/at", s->n);
		drvMake(g->api, dev, n, id, drvMap("at", s->at, NULL));
	} else {
		s->at = drvUnder(dev, n, NULL);
		drvMake(g->api, dev, n, id, what);
	}
	free(id);
	Json *to = jsonArray(), *given = jsonGet(r, "to");
	for (int i = 0; jsonIsArray(given) && i < given->array.count; i++)
		if (jsonIsArray(given->array.items[i])) jsonPush(to, given->array.items[i]);
	const char *names[] = { "rx", "tx", "stats", "size", "status", "to", "keys", "screen", "scrollback" };
	Json *values[] = { jsonBytes("", 0), jsonBytes("", 0), drvMap("rx", jsonInteger(0), "tx", jsonInteger(0), "keys", jsonInteger(0), NULL),
		           drvMap("cols", jsonInteger(cols), "rows", jsonInteger(rows), NULL), statusOf(s, 0), to, jsonArray(), jsonNull(),
		           drvMap("lines", jsonArray(), "styles", jsonArray(), NULL) };
	for (int i = 0; i < 9; i++) {
		char *nid = formatString("pty/%d/%s", s->n, names[i]);
		drvMake(g->api, s->at, names[i], nid, values[i]);
		free(nid);
	}
	terminal(s);
	seed(s, jsonGet(r, "screen"));
	publish(g, s);
	pthread_mutex_lock(&p->lock);
	ERM_PUSH(p->sessions, s);
	pthread_mutex_unlock(&p->lock);
	char b = 0;
	if (write(p->wake[1], &b, 1) < 0) { }
	hostSay(p->host, "pty %d: %s, pid %d", s->n, jsonText(args->array.items[0]), (int)pid);
	*out = drvMap("name", jsonString(n), "address", s->at, NULL);
	return ermOk();
}

// --- what is written to a session: rx and its lines' rx to the program, size to the pty, gone to a hangup

/** [[n, there, rx, stats.rx, size, [[line, rx, stats.rx], ...], keys, stats.keys], ...], read tracked */
static ErmErr pumpCompute(void *data, const ErmGiven *g, Json **out) {
	Pty *p = data;
	*out = jsonArray();
	// read so a session made since runs this again
	drvNames(g->api, drvPath("/", "dev", "pty", NULL));
	for (int i = 0; i < p->sessions.count; i++) {
		Session *s = p->sessions.items[i];
		if (s->gone) continue;
		Json *row = jsonArray(), *lines = jsonArray(), *to = drvRead(g->api, at(s, "to"));
		bool there = drvHas(g->api, s->at);
		jsonPush(row, jsonInteger(s->n));
		jsonPush(row, jsonBoolean(there));
		Json *rx = there ? bytesOf(drvRead(g->api, at(s, "rx"))) : NULL;
		jsonPush(row, rx ? rx : jsonBytes("", 0));
		jsonPush(row, jsonInteger(there ? whole(jsonGet(drvRead(g->api, at(s, "stats")), "rx"), 0) : 0));
		Json *size = there ? drvRead(g->api, at(s, "size")) : NULL;
		jsonPush(row, size ? size : jsonNull());
		for (int j = 0; there && jsonIsArray(to) && j < to->array.count; j++) {
			Json *line = to->array.items[j], *l = jsonArray();
			if (!jsonIsArray(line)) continue;
			Json *lrx = bytesOf(drvRead(g->api, drvUnder(line, "rx", NULL)));
			jsonPush(l, line);
			jsonPush(l, lrx ? lrx : jsonBytes("", 0));
			jsonPush(l, jsonInteger(whole(jsonGet(drvRead(g->api, drvUnder(line, "stats", NULL)), "rx"), 0)));
			jsonPush(lines, l);
		}
		jsonPush(row, lines);
		Json *keys = there ? drvRead(g->api, at(s, "keys")) : NULL;
		jsonPush(row, jsonIsArray(keys) ? keys : jsonArray());
		jsonPush(row, jsonInteger(there ? whole(jsonGet(drvRead(g->api, at(s, "stats")), "keys"), 0) : 0));
		jsonPush(*out, row);
	}
	return ermOk();
}

/** the bytes after seen of a rolling rx whose count is total: its last (total - seen), at most all it holds */
static void typed(Pty *p, Session *s, const Json *rx, int64_t total, int64_t *seen) {
	int64_t n = total - *seen;
	*seen = total;
	if (n <= 0 || !rx) return;
	size_t m = (size_t)n < rx->bytes.length ? (size_t)n : rx->bytes.length;
	give(p, s, rx->bytes.data + rx->bytes.length - m, m);
}

static ErmErr pumpEffect(void *data, const ErmGiven *g, Json **out) {
	Pty *p = data;
	*out = jsonNull();
	for (int i = 0; jsonIsArray(g->value) && i < g->value->array.count; i++) {
		Json *row = g->value->array.items[i];
		Session *s = numbered(p, (int)whole(row->array.items[0], 0));
		if (!s || s->gone) continue;
		if (!row->array.items[1]->boolean) {
			// unplaced: its program hung up; reaped when its master says so
			s->gone = true;
			if (s->running) kill(-s->pid, SIGHUP), kill(s->pid, SIGHUP);
			hostSay(p->host, "pty %d: unplaced, hung up", s->n);
			continue;
		}
		typed(p, s, bytesOf(row->array.items[2]), whole(row->array.items[3], 0), &s->rx);
		Json *size = row->array.items[4];
		int cols = (int)whole(jsonGet(size, "cols"), s->cols), rows = (int)whole(jsonGet(size, "rows"), s->rows);
		if (s->fd >= 0 && cols > 0 && rows > 0 && cols <= 1000 && rows <= 1000 && (cols != s->cols || rows != s->rows)) {
			// the terminal first, so what the program draws at its new size lands on a screen that size
			vterm_set_size(s->vt, rows, cols);
			struct winsize ws = { .ws_row = (unsigned short)rows, .ws_col = (unsigned short)cols };
			ioctl(s->fd, TIOCSWINSZ, &ws);
			s->cols = cols, s->rows = rows;
		}
		// the key records typed since: the last (stats.keys - seen) of keys, at most all it holds
		Json *keys = row->array.items[6];
		int64_t total = whole(row->array.items[7], 0), more = total - s->keys;
		s->keys = total;
		if (more > keys->array.count) more = keys->array.count;
		for (int64_t k = keys->array.count - (more > 0 ? more : 0); k < keys->array.count; k++) typeKey(s, keys->array.items[k]);
		// each line in to: what is typed there since it was joined; a line no longer listed is forgotten
		Json *lines = row->array.items[5];
		ERM_LIST(Seen) kept = { 0 };
		for (int j = 0; j < lines->array.count; j++) {
			Json *l = lines->array.items[j];
			char *key = jsonPrint(l->array.items[0]);
			int64_t total = whole(l->array.items[2], 0);
			Seen *was = NULL;
			for (int k = 0; k < s->lines.count && !was; k++) if (!strcmp(s->lines.items[k].line, key)) was = &s->lines.items[k];
			Seen now = { key, was ? was->rx : total }; // joined now: what was typed before is not the program's
			typed(p, s, bytesOf(l->array.items[1]), total, &now.rx);
			ERM_PUSH(kept, now);
		}
		for (int k = 0; k < s->lines.count; k++) free(s->lines.items[k].line);
		free(s->lines.items);
		s->lines.items = kept.items, s->lines.count = kept.count, s->lines.capacity = kept.capacity;
		publish(g, s);
	}
	return ermOk();
}

ErmErr driverPty(void *data, const ErmGiven *g, Json **out) {
	*out = jsonNull();
	Pty *p = calloc(1, sizeof *p);
	p->host = data;
	if (pipe(p->wake) < 0) {
		hostSay(p->host, "pty: no pipe");
		return ermOk();
	}
	fcntl(p->wake[0], F_SETFL, O_NONBLOCK);
	fcntl(p->wake[1], F_SETFL, O_NONBLOCK);
	fcntl(p->wake[0], F_SETFD, FD_CLOEXEC);
	fcntl(p->wake[1], F_SETFD, FD_CLOEXEC);
	Json *here = drvHere(g);
	drvHandler(g, here, "new", (ErmFn){ ptyNew, p });
	drvHandler(g, here, "irq", (ErmFn){ ptyIrq, p });
	drvClaim(g, here, IRQ);
	drvChild(g, here, "pump", (ErmFn){ pumpCompute, p }, (ErmFn){ pumpEffect, p });
	pthread_mutex_init(&p->lock, NULL);
	pthread_cond_init(&p->taken, NULL);
	pthread_create(&p->watcher, NULL, watch, p);
	return ermOk();
}
