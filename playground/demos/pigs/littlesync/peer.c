// littlesync-pigs: the Mac peer of a littlesync device (littlesync.h). Opens a serial port (the first
// /dev/cu.usbmodem*, or --port PATH), follows lab-pig's room and its pigs, and shows them as letters on
// a plain field in the terminal, and under it a line per pig: where, what it costs (stored bytes,
// commits held, parents of its newest commit), who holds it; then the room's cost. A pig two devices
// dropped at once (two items at its node, a clash) is drawn twice, the other faint, with an "also" line
// for it under the pig's. Keys: tab selects, space picks up and drops (a drop replaces every item: the
// clash ends), arrows or hjkl move this peer's pointer (+) and carry what it holds (ephemeral beats go
// out while it is carried), a adds a pig, q quits. The pointer is this peer's presence row at the room
// ({name, colour, pointer: {x, y}}, as web pigs' rows are); the others' pointers are drawn as @, and
// listed under the pigs ("@ name x= y="), web pigs' and littlesync devices' alike.
//
//   littlesync-pigs [--port PATH | --pty | --pipe | --http URL]... [--state DIR] [--room ID] [--name NAME]
//                   [--dump FILE] [--log FILE] [--keys KEYS] [--exit-after MS] [--pty-file FILE]
// streams: each --port and --pty is one more (LS_LINKS at most), a link of its own; the device relays
//   between them (a hop: a - b - c with b given two). None: the first /dev/cu.usbmodem*.
// --http URL: the gateway (http://host:port, or https://galaxy.observer; playground/together/stacks/littlesync/gateway) over its
//   HTTP sessions (http.h), a link too; its posts on a thread of their own, so the loop never waits.
// --pty: makes a pty and talks on its master; its slave path is printed on stderr (and written to
//   --pty-file, a line per pty): another littlesync-pigs --port PATH is the other end. --pipe: the
//   protocol is stdin and stdout, no keyboard (for fifos, a pipeline). --state DIR: this peer's key and nodes (default
//   ./.littlesync-state). --dump FILE: the screen as text, written when it changes and at the end. --log
//   FILE: the protocol events. --keys: keys as if typed, 120 ms apart, "." is a pause of 500 ms.
//   --exit-after MS: quits then. Without a terminal there is no drawing: --dump is the screen.
#define _DARWIN_C_SOURCE
#include "../../../../playground/together/stacks/littlesync/littlesync.h"
#include "../../../../playground/together/stacks/littlesync/http.h"
#include "pigs.h"

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <glob.h>
#include <math.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

enum { FW = 60, FH = 18, MAXPIGS = 26, MAXITEMS = 4 };
static const char *NAMES[] = {"otter", "newt", "wren", "moth", "vole", "finch", "toad", "hare", "mole", "kiwi"};
static const char *COLOURS[] = {"#d1495b", "#2e86ab", "#3b8b5a", "#c27c0e", "#8e44ad", "#16a085", "#e4572e"};

static volatile sig_atomic_t stop;
static void on_signal(int s) {
	(void)s;
	stop = 1;
}

static int64_t mono_ms(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}
static int64_t wall_ms(void) {
	struct timespec ts;
	clock_gettime(CLOCK_REALTIME, &ts);
	return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}
static void random_bytes(void *c, uint8_t *out, size_t n) {
	(void)c;
	arc4random_buf(out, n);
}

static FILE *logfile;
static int64_t start_ms;
static void log_line(void *c, const char *line) {
	(void)c;
	if (logfile == NULL) return;
	fprintf(logfile, "%6lld %s\n", (long long)(mono_ms() - start_ms), line);
	fflush(logfile);
}

// ---- the peer's state

typedef struct {
	char id[LS_ID_LEN + 1];
	ls_node *node;
} pigslot;

static ls_dev *dev;
// the byte streams, each a link: read from rfd, written to wfd. http: the gateway's session, rfd the
// pipe its thread says a post is over on
typedef struct {
	int rfd, wfd, keep_open, pipe;
	struct ls_link *link;
	ls_http *http;
} stream;
static stream streams[LS_LINKS];
static int n_streams;
static ls_node *room;
static char room_id[LS_ID_LEN + 1] = PIGS_ROOM;
static const char *my_name, *my_colour;
static char my_who[LS_KEY_LEN * 2 + 1];
static pigslot pigs[MAXPIGS];
static int n_pigs, selected;
static ls_node *carrying; // the pig carried by this peer
static double carry_x = 0.5, carry_y = 0.5; // this peer's pointer: a carried pig is there

static int cmp_id(const void *a, const void *b) { return strcmp(((const pigslot *)a)->id, ((const pigslot *)b)->id); }

// the pigs of the room, followed, sorted by id so every peer has the same letters
static void refresh_pigs(void) {
	const op_value *rv = ls_value(room);
	pigslot found[MAXPIGS];
	int n = 0;
	if (pig_room_has(rv, PIGS_FIRST)) strcpy(found[n].id, PIGS_FIRST), n++;
	for (size_t i = 0, k = pig_room_count(rv); i < k && n < MAXPIGS; i++) {
		const char *id = pig_room_at(rv, i);
		if (strcmp(id, PIGS_FIRST) != 0 && pig_room_has(rv, id)) strcpy(found[n++].id, id);
	}
	qsort(found, (size_t)n, sizeof *found, cmp_id);
	for (int i = 0; i < n; i++) found[i].node = ls_follow(dev, found[i].id);
	char sel[LS_ID_LEN + 1] = "";
	if (selected < n_pigs) strcpy(sel, pigs[selected].id);
	memcpy(pigs, found, sizeof pigs);
	n_pigs = n;
	for (int i = 0; i < n; i++)
		if (strcmp(sel, pigs[i].id) == 0) selected = i;
	if (selected >= n) selected = n ? n - 1 : 0;
	if (carrying != NULL) {
		int there = 0;
		for (int i = 0; i < n; i++) there |= pigs[i].node == carrying;
		if (!there) carrying = NULL;
	}
}

// where a pig is drawn: carried (by anyone: ours first) or at rest. 0 when binned
static int where_is(const pigslot *p, double *x, double *y, const char **by) {
	pig_value st;
	pig_read(ls_value(p->node), p->id, &st);
	*x = st.x, *y = st.y, *by = NULL;
	if (st.binned) return 0;
	static char who[40];
	for (size_t i = 0, k = ls_helds(p->node); i < k; i++) {
		const ls_held *h = ls_held_at(p->node, i);
		pig_held ph;
		if ((h->own || *by == NULL) && pig_held_read(h->value, &ph)) {
			*x = ph.x, *y = ph.y;
			snprintf(who, sizeof who, "%s", ph.by);
			*by = who;
		}
	}
	return 1;
}

// a presence row's pointer (0 to 1 each way, as web pigs clamp it) and name. 0: none
static int pointer_of(const ls_row *r, double *x, double *y, const char **name) {
	const op_value *v = r->value, *p = v && v->type == OP_MAP ? op_get(v, "pointer") : NULL;
	if (p == NULL || p->type != OP_MAP) return 0;
	const op_value *px = op_get(p, "x"), *py = op_get(p, "y"), *n = op_get(v, "name");
	*x = px && px->type == OP_NUM && px->num == px->num ? fmin(fmax(px->num, 0), 1) : 0.5;
	*y = py && py->type == OP_NUM && py->num == py->num ? fmin(fmax(py->num, 0), 1) : 0.5;
	if (name != NULL) *name = n && n->type == OP_STR ? n->str : "?";
	return 1;
}

// ---- the screen

static char screen[(FW + 8) * (FH + 8 + MAXPIGS * 2) + 1024];
static size_t screen_len;
static void put(const char *s) {
	size_t n = strlen(s);
	if (screen_len + n < sizeof screen) memcpy(screen + screen_len, s, n), screen_len += n;
	screen[screen_len] = 0;
}

// the screen as text: selected pig in capitals. ansi: the selected in reverse video, instead
static void render(int ansi) {
	screen_len = 0;
	char line[512], peers[64] = "";
	// a link: up, down, or down and never heard
	for (int i = 0; i < n_streams; i++)
		snprintf(peers + strlen(peers), sizeof peers - strlen(peers), "%s%s", i ? "," : "",
			ls_up(streams[i].link) ? "up" : ls_peer(streams[i].link) ? "down" : "down (not heard)");
	snprintf(line, sizeof line, "littlesync-pigs  room %.8s  peer%s %s  pigs %d  you %s\n", room_id + 9, n_streams > 1 ? "s" : "",
		peers, n_pigs, my_name);
	put(line);
	char grid[FH][FW];
	memset(grid, ' ', sizeof grid);
	grid[0][FW - 1] = 'S';
	grid[FH - 1][FW - 1] = 'B';
	int cell[FH][FW];
	memset(cell, 0, sizeof cell);
	// the other items of a clash first, faint (3), so a pig drawn over one wins the cell
	for (int i = 0; i < n_pigs; i++) {
		ls_item it[MAXITEMS];
		size_t k = ls_values(pigs[i].node, NULL, 0, it, MAXITEMS);
		for (size_t j = 1; j < k && j < MAXITEMS; j++) {
			pig_value o;
			if (it[j].value == NULL) continue;
			pig_read(it[j].value, pigs[i].id, &o);
			if (o.binned) continue;
			int cx = (int)floor(fmin(fmax(o.x, 0), 1) * (FW - 1)), cy = (int)floor(fmin(fmax(o.y, 0), 1) * (FH - 1));
			grid[cy][cx] = (char)('a' + i);
			cell[cy][cx] = 3;
		}
	}
	for (int i = 0; i < n_pigs; i++) {
		double x, y;
		const char *by;
		if (!where_is(&pigs[i], &x, &y, &by)) continue;
		int cx = (int)floor(fmin(fmax(x, 0), 1) * (FW - 1)), cy = (int)floor(fmin(fmax(y, 0), 1) * (FH - 1));
		grid[cy][cx] = (char)(i == selected && !ansi ? 'A' + i : 'a' + i);
		cell[cy][cx] = i == selected ? 2 : 1;
	}
	// the pointers under the pigs: the others' (@), then mine (+)
	for (size_t i = 0, k = ls_rows(room); i < k; i++) {
		double x, y;
		if (!pointer_of(ls_row_at(room, i), &x, &y, NULL)) continue;
		int cx = (int)floor(x * (FW - 1)), cy = (int)floor(y * (FH - 1));
		if (cell[cy][cx] == 0) grid[cy][cx] = ls_row_at(room, i)->own ? '+' : '@';
	}
	put("+");
	for (int x = 0; x < FW; x++) put("-");
	put("+\n");
	for (int y = 0; y < FH; y++) {
		put("|");
		for (int x = 0; x < FW; x++) {
			char c[16];
			if (ansi && cell[y][x] == 2) snprintf(c, sizeof c, "\x1b[7m%c\x1b[0m", grid[y][x]);
			else if (ansi && cell[y][x] == 3) snprintf(c, sizeof c, "\x1b[2m%c\x1b[0m", grid[y][x]);
			else snprintf(c, sizeof c, "%c", grid[y][x]);
			put(c);
		}
		put("|\n");
	}
	put("+");
	for (int x = 0; x < FW; x++) put("-");
	put("+\n");
	char carried = '-';
	for (int i = 0; i < n_pigs; i++)
		if (pigs[i].node == carrying) carried = (char)('a' + i);
	snprintf(line, sizeof line, "selected %c  carrying %c  (tab select, space pick up / drop, hjkl or arrows point and carry, a add, q quit)\n",
		n_pigs ? 'a' + selected : '-', carried);
	put(line);
	for (int i = 0; i < n_pigs; i++) {
		double x, y;
		const char *by;
		pig_value st;
		pig_read(ls_value(pigs[i].node), pigs[i].id, &st);
		int shown = where_is(&pigs[i], &x, &y, &by);
		ls_cost c = ls_cost_of(pigs[i].node);
		snprintf(line, sizeof line, "%c %.8s x=%.2f y=%.2f %5zuB %2zuc %zup%s%s%s%s\n", 'a' + i, pigs[i].id + 9, x, y, c.stored,
			c.commits, c.newest.parents, st.shame ? " shame" : "", shown ? "" : " binned", by ? " held by " : "", by ? by : "");
		put(line);
		// a clash: the items not shown, each where it was dropped and by whom (the first 4 hex of its key)
		ls_item it[MAXITEMS];
		size_t k = ls_values(pigs[i].node, NULL, 0, it, MAXITEMS);
		for (size_t j = 1; j < k; j++) {
			char who[16] = "?";
			if (j < MAXITEMS && it[j].signer != NULL) {
				if (memcmp(it[j].signer, ls_key(dev), LS_KEY_LEN) == 0) snprintf(who, sizeof who, "you");
				else snprintf(who, sizeof who, "%02x%02x", it[j].signer[2], it[j].signer[3]);
			}
			pig_value o;
			if (j >= MAXITEMS || it[j].far) snprintf(line, sizeof line, "  also (kept by name only)\n");
			else if (it[j].value == NULL) snprintf(line, sizeof line, "  also gone, by %s\n", who);
			else {
				pig_read(it[j].value, pigs[i].id, &o);
				snprintf(line, sizeof line, "  also x=%.2f y=%.2f by %s%s\n", o.x, o.y, who, o.binned ? " binned" : "");
			}
			put(line);
		}
	}
	// the others' pointers: name, where, the first 4 hex of their key
	for (size_t i = 0, k = ls_rows(room); i < k; i++) {
		const ls_row *r = ls_row_at(room, i);
		double x, y;
		const char *name;
		if (r->own || !pointer_of(r, &x, &y, &name)) continue;
		snprintf(line, sizeof line, "@ %s x=%.2f y=%.2f %02x%02x\n", name, x, y, r->who[2], r->who[3]);
		put(line);
	}
	ls_cost c = ls_cost_of(room);
	snprintf(line, sizeof line, "room %.8s %5zuB %2zuc %zup, newest seal %zuB (parents %zuB)\n", room_id + 9, c.stored, c.commits,
		c.newest.parents, c.newest.length, c.newest.parents_bytes);
	put(line);
}

static const char *dump_path;
static int is_tty_out;
static void draw(int force) {
	static int64_t last;
	static char before[sizeof screen];
	int64_t now = mono_ms();
	if (!force && now - last < 80) return;
	last = now;
	render(0);
	if (dump_path != NULL && (force || strcmp(before, screen) != 0)) {
		FILE *f = fopen(dump_path, "w");
		if (f != NULL) fputs(screen, f), fclose(f);
		memcpy(before, screen, sizeof screen);
	}
	// on the terminal: only when it changed, over the old screen (each line cleared to its end)
	static char shown[sizeof screen];
	if (is_tty_out) {
		render(1);
		if (!force && strcmp(shown, screen) == 0) return;
		memcpy(shown, screen, sizeof screen);
		fputs("\x1b[H", stdout);
		for (const char *l = screen, *e; (e = strchr(l, '\n')) != NULL; l = e + 1) {
			fwrite(l, 1, (size_t)(e - l), stdout);
			fputs("\x1b[K\r\n", stdout);
		}
		fputs("\x1b[J", stdout);
		fflush(stdout);
	}
}

// ---- actions

static void add_pig(void) {
	uint8_t r[16];
	arc4random_buf(r, 16);
	char id[LS_ID_LEN + 1] = "ermine://";
	for (int i = 0; i < 16; i++) sprintf(id + 9 + 2 * i, "%02x", r[i]);
	strcat(id, "00000000000000000000000000000000");
	ls_node *n = ls_follow(dev, id);
	if (n == NULL) return;
	pig_value p = {(arc4random() % 800) / 1000.0 + 0.1, (arc4random() % 600) / 1000.0 + 0.3, (double)wall_ms(), arc4random(), 0, 0};
	op_value *v = pig_make(&p);
	ls_put(n, v);
	op_free(v);
	v = op_bool(1);
	ls_set(room, id, v);
	op_free(v);
	refresh_pigs();
	for (int i = 0; i < n_pigs; i++)
		if (strcmp(pigs[i].id, id) == 0) selected = i;
}

// my presence row at the room: name, colour, the pointer
static void point(void) {
	op_value *v = op_map(), *p = op_map();
	op_set(p, "x", op_num(carry_x));
	op_set(p, "y", op_num(carry_y));
	op_set(v, "name", op_str(my_name));
	op_set(v, "colour", op_str(my_colour));
	op_set(v, "pointer", p);
	ls_presence(room, v);
	op_free(v);
}

// the pointer moved there, and what it carries with it
static void carry_to(double x, double y) {
	carry_x = fmin(fmax(x, 0), 1), carry_y = fmin(fmax(y, 0), 1);
	point();
	if (carrying == NULL) return;
	op_value *v = pig_make_held(carry_x, carry_y, my_name, my_colour, my_who);
	ls_hold(carrying, v);
	op_free(v);
}

static void space(void) {
	if (n_pigs == 0) return;
	if (carrying == NULL) {
		carrying = pigs[selected].node;
		pig_value st;
		pig_read(ls_value(carrying), pigs[selected].id, &st);
		carry_to(st.x, st.y);
		return;
	}
	// let go: one stored commit, in the corner of shame or the bin if the feet are there. A person
	// putting a pig down means "this is where it is": it replaces every item (ls_pick), ending a clash
	pig_value p = {carry_x, carry_y, (double)wall_ms(), arc4random(), 0, 0};
	p.shame = carry_x > 0.78 && carry_y < 0.45;
	p.binned = carry_x > 0.92 && carry_y > 0.88;
	op_value *v = pig_make(&p);
	ls_pick(carrying, v);
	op_free(v);
	if (p.binned) {
		for (int i = 0; i < n_pigs; i++)
			if (pigs[i].node == carrying) {
				v = op_bool(0);
				ls_set(room, pigs[i].id, v);
				op_free(v);
			}
	}
	carrying = NULL;
	refresh_pigs();
}

// returns 0 to quit
static int key(int c) {
	switch (c) {
	case 'q': return 0;
	case '\t':
		if (n_pigs) selected = (selected + 1) % n_pigs;
		break;
	case ' ': space(); break;
	case 'a': add_pig(); break;
	case 'h': case 'D': carry_to(carry_x - 0.02, carry_y); break;
	case 'l': case 'C': carry_to(carry_x + 0.02, carry_y); break;
	case 'k': case 'A': carry_to(carry_x, carry_y - 0.03); break;
	case 'j': case 'B': carry_to(carry_x, carry_y + 0.03); break;
	}
	return 1;
}

// ---- the gateway over HTTP: one post at a time on a thread; a byte down go starts it, a byte up done
// says it is over (ls_ calls stay on the loop's thread)

static struct {
	void *socket;
	ls_http_request r;
	long length;
	int go[2], done[2], busy;
} web;

static void *poster(void *unused) {
	(void)unused;
	char b;
	while (read(web.go[0], &b, 1) == 1) {
		web.length = ls_http_socket(web.socket, web.r.url, web.r.wait_ms, web.r.body, web.r.pieces, web.r.length, web.r.answer,
			web.r.room);
		if (write(web.done[1], &b, 1) != 1) break;
	}
	return NULL;
}

// ---- the port

static struct termios saved_tty;
static int tty_raw;
static void raw(int fd, struct termios *keep) {
	struct termios t;
	if (tcgetattr(fd, &t) != 0) return;
	if (keep != NULL) *keep = t;
	cfmakeraw(&t);
	t.c_cc[VMIN] = 0, t.c_cc[VTIME] = 0;
	tcsetattr(fd, TCSANOW, &t);
}
static void restore_tty(void) {
	if (tty_raw) tcsetattr(0, TCSANOW, &saved_tty), printf("\x1b[?1049l\x1b[?25h"), fflush(stdout);
	tty_raw = 0;
}

static int open_port(const char *path) {
	int fd = open(path, O_RDWR | O_NOCTTY | O_NONBLOCK);
	if (fd >= 0) raw(fd, NULL);
	return fd;
}

// what the stack has for a stream, written
static void out_to(stream *st) {
	const uint8_t *out;
	size_t n;
	int wfd = st->wfd;
	// a frame a call to ls_next
	while ((n = ls_next(st->link, &out)))
		for (size_t at = 0; at < n;) {
			ssize_t w = write(wfd, out + at, n - at);
			if (w > 0) at += (size_t)w;
			else if (w < 0 && errno == EAGAIN) {
				// a full line: wait a little; the rest of the frame is dropped after a while (the stack resends)
				struct pollfd p = {wfd, POLLOUT, 0};
				if (poll(&p, 1, 50) == 0) return;
			} else return;
		}
}

int main(int argc, char **argv) {
	const char *state = "./.littlesync-state", *logpath = NULL, *keys = "", *pty_file = NULL;
	// the streams asked for, in order: a port's path, "" for a pty, NULL for the pipe
	const char *asked[LS_LINKS];
	int n_asked = 0, use_pipe = 0;
	const char *http_url = NULL;
	long exit_after = 0;
	for (int i = 1; i < argc; i++) {
		const char *a = argv[i], *v = i + 1 < argc ? argv[i + 1] : NULL;
		int is_stream = (strcmp(a, "--port") == 0 && v) || strcmp(a, "--pty") == 0 || strcmp(a, "--pipe") == 0 ||
			(strcmp(a, "--http") == 0 && v);
		if (is_stream && n_asked + (http_url != NULL) == LS_LINKS) return fprintf(stderr, "at most %d streams\n", LS_LINKS), 2;
		if (strcmp(a, "--port") == 0 && v) asked[n_asked++] = v, i++;
		else if (strcmp(a, "--pty") == 0) asked[n_asked++] = "";
		else if (strcmp(a, "--pipe") == 0 && !use_pipe) asked[n_asked++] = NULL, use_pipe = 1;
		else if (strcmp(a, "--http") == 0 && v && http_url == NULL) http_url = v, i++;
		else if (strcmp(a, "--state") == 0 && v) state = v, i++;
		else if (strcmp(a, "--room") == 0 && v) snprintf(room_id, sizeof room_id, "%s", v), i++;
		else if (strcmp(a, "--name") == 0 && v) my_name = v, i++;
		else if (strcmp(a, "--dump") == 0 && v) dump_path = v, i++;
		else if (strcmp(a, "--log") == 0 && v) logpath = v, i++;
		else if (strcmp(a, "--keys") == 0 && v) keys = v, i++;
		else if (strcmp(a, "--exit-after") == 0 && v) exit_after = atol(v), i++;
		else if (strcmp(a, "--pty-file") == 0 && v) pty_file = v, i++;
		else {
			fprintf(stderr, "usage: littlesync-pigs [--port PATH | --pty | --pipe | --http URL]... [--state DIR] [--room ID] [--name NAME]\n"
					"       [--dump FILE] [--log FILE] [--keys KEYS] [--exit-after MS] [--pty-file FILE]\n");
			return 2;
		}
	}
	start_ms = mono_ms();
	if (logpath != NULL && (logfile = fopen(logpath, "w")) == NULL) return perror(logpath), 1;
	signal(SIGINT, on_signal), signal(SIGTERM, on_signal), signal(SIGPIPE, SIG_IGN);

	// the streams: each one's fds now, its link once the device is open
	glob_t g;
	if (n_asked == 0 && http_url == NULL) {
		if (glob("/dev/cu.usbmodem*", 0, NULL, &g) != 0 || g.gl_pathc == 0)
			return fprintf(stderr, "no /dev/cu.usbmodem*: --port PATH, --pty, --pipe or --http URL\n"), 1;
		asked[n_asked++] = g.gl_pathv[0];
	}
	FILE *ptys = pty_file != NULL ? fopen(pty_file, "w") : NULL;
	for (int i = 0; i < n_asked; i++) {
		stream *st = &streams[n_streams++];
		st->keep_open = -1;
		if (asked[i] == NULL) {
			st->rfd = 0, st->wfd = 1, st->pipe = 1;
			fcntl(0, F_SETFL, fcntl(0, F_GETFL) | O_NONBLOCK);
		} else if (asked[i][0] == 0) {
			int m = posix_openpt(O_RDWR | O_NOCTTY);
			if (m < 0 || grantpt(m) != 0 || unlockpt(m) != 0) return perror("pty"), 1;
			const char *slave = ptsname(m);
			st->keep_open = open(slave, O_RDWR | O_NOCTTY | O_NONBLOCK);
			raw(st->keep_open, NULL);
			fcntl(m, F_SETFL, fcntl(m, F_GETFL) | O_NONBLOCK);
			fprintf(stderr, "pty %s\n", slave);
			if (ptys != NULL) fprintf(ptys, "%s\n", slave);
			st->rfd = st->wfd = m;
		} else {
			st->rfd = st->wfd = open_port(asked[i]);
			if (st->rfd < 0) return perror(asked[i]), 1;
		}
	}
	if (ptys != NULL) fclose(ptys);

	ls_options o = {.store = ls_store_file(state), .random = random_bytes, .epoch_ms = wall_ms() - mono_ms(),
		.log = logfile ? log_line : NULL};
	dev = ls_open(&o);
	if (dev == NULL) return fprintf(stderr, "no key in %s\n", state), 1;
	for (int i = 0; i < n_streams; i++) streams[i].link = ls_link(dev);
	if (http_url != NULL) {
		stream *st = &streams[n_streams++];
		st->keep_open = -1, st->wfd = -1;
		st->link = ls_link(dev);
		st->http = ls_http_open(st->link, &(ls_http_options){.url = http_url, .random = random_bytes});
		pthread_t t;
		if (st->http == NULL || pipe(web.go) != 0 || pipe(web.done) != 0 || (web.socket = ls_http_socket_open()) == NULL ||
			pthread_create(&t, NULL, poster, NULL) != 0)
			return fprintf(stderr, "--http %s: not a gateway url\n", http_url), 1;
		pthread_detach(t);
		st->rfd = web.done[0];
		if (logfile) fprintf(logfile, "http %s session %s\n", http_url, ls_http_session(st->http));
	}
	for (int i = 0; i < LS_KEY_LEN; i++) sprintf(my_who + 2 * i, "%02x", ls_key(dev)[i]);
	if (my_name == NULL) my_name = NAMES[ls_key(dev)[5] % 10];
	my_colour = COLOURS[ls_key(dev)[6] % 7];
	room = ls_follow(dev, room_id);
	if (room == NULL) return fprintf(stderr, "not a room id: %s\n", room_id), 1;
	point();
	log_line(NULL, "start");

	int has_tty = !use_pipe && isatty(0);
	is_tty_out = isatty(1) && !use_pipe;
	if (has_tty && is_tty_out) {
		raw(0, &saved_tty);
		tty_raw = 1;
		printf("\x1b[?1049h\x1b[?25l");
		atexit(restore_tty);
	}

	uint32_t room_seen = 0;
	int64_t next_key = start_ms + 700;
	int esc = 0;
	const char *script = keys;
	for (;;) {
		int64_t now = mono_ms();
		if (stop || (exit_after > 0 && now - start_ms >= exit_after)) break;
		// the keyboard first, then each stream
		struct pollfd fds[1 + LS_LINKS] = {{has_tty ? 0 : -1, POLLIN, 0}};
		for (int i = 0; i < n_streams; i++) fds[1 + i] = (struct pollfd){streams[i].rfd, POLLIN, 0};
		poll(fds, (nfds_t)(1 + n_streams), 20);
		uint8_t buf[1024];
		int quit = 0;
		for (int i = 0; i < n_streams; i++)
			if ((fds[1 + i].revents & POLLIN) && streams[i].http != NULL) {
				char b;
				if (read(streams[i].rfd, &b, 1) == 1) web.busy = 0, ls_http_end(streams[i].http, now, web.length);
			} else if (fds[1 + i].revents & POLLIN) {
				ssize_t n = read(streams[i].rfd, buf, sizeof buf);
				if (n > 0) ls_feed(streams[i].link, buf, (size_t)n);
				else if (n == 0 && streams[i].pipe) quit = 1;
			}
		if (has_tty && (fds[0].revents & POLLIN)) {
			ssize_t n = read(0, buf, sizeof buf);
			for (ssize_t i = 0; i < n && !quit; i++) {
				int c = buf[i];
				// arrows come as ESC [ A..D
				if (esc == 0 && c == 27) esc = 1;
				else if (esc == 1 && c == '[') esc = 2;
				else if (esc == 2) esc = 0, quit = !key(c);
				else esc = 0, quit = !key(c);
			}
		}
		if (*script && now >= next_key) {
			if (*script == '.') next_key = now + 500;
			else quit |= !key((unsigned char)*script), next_key = now + 120;
			script++;
		}
		if (quit) break;
		ls_tick(dev, now);
		if (ls_version(room) != room_seen) {
			room_seen = ls_version(room);
			refresh_pigs();
		}
		for (int i = 0; i < n_streams; i++) {
			if (streams[i].http != NULL) {
				if (!web.busy && ls_http_begin(streams[i].http, now, &web.r)) {
					if (write(web.go[1], "p", 1) == 1) web.busy = 1;
					else ls_http_end(streams[i].http, now, -1);
				}
				continue;
			}
			out_to(&streams[i]);
		}
		draw(0);
	}
	draw(1);
	restore_tty();
	log_line(NULL, "stop");
	// my row out now, so the others do not wait for its ttl (not over HTTP: its posts are a thread's)
	ls_presence(room, NULL);
	for (int i = 0; i < n_streams; i++)
		if (streams[i].http == NULL) out_to(&streams[i]);
	ls_close(dev);
	ls_store_file_free(&o.store);
	for (int i = 0; i < n_streams; i++)
		if (streams[i].keep_open >= 0) close(streams[i].keep_open);
	return 0;
}
