// littlesync-pigs: the Mac peer of a littlesync device (littlesync.h). Opens a serial port (the first
// /dev/cu.usbmodem*, or --port PATH), follows lab-pig's room and its pigs, and shows them as letters on
// a plain field in the terminal. Keys: tab selects, space picks up and drops, arrows or hjkl carry
// (ephemeral beats go out while it is carried), a adds a pig, q quits.
//
//   littlesync-pigs [--port PATH | --pty | --pipe] [--state DIR] [--room ID] [--name NAME]
//                   [--dump FILE] [--log FILE] [--keys KEYS] [--exit-after MS] [--pty-file FILE]
// --pty: makes a pty and talks on its master; its slave path is printed on stderr (and written to
//   --pty-file): another littlesync-pigs --port PATH is the other end. --pipe: the protocol is stdin and
//   stdout, no keyboard (for fifos, a pipeline). --state DIR: this peer's key and nodes (default
//   ./.littlesync-state). --dump FILE: the screen as text, written when it changes and at the end. --log
//   FILE: the protocol events. --keys: keys as if typed, 120 ms apart, "." is a pause of 500 ms.
//   --exit-after MS: quits then. Without a terminal there is no drawing: --dump is the screen.
#define _DARWIN_C_SOURCE
#include "../littlesync.h"

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <glob.h>
#include <math.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

enum { FW = 60, FH = 18, MAXPIGS = 26 };
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
static ls_node *room;
static char room_id[LS_ID_LEN + 1] = LS_ROOM;
static const char *my_name, *my_colour;
static char my_who[LS_KEY_LEN * 2 + 1];
static pigslot pigs[MAXPIGS];
static int n_pigs, selected;
static ls_node *carrying; // the pig carried by this peer
static double carry_x, carry_y;

static int cmp_id(const void *a, const void *b) { return strcmp(((const pigslot *)a)->id, ((const pigslot *)b)->id); }

// the pigs of the room, followed, sorted by id so every peer has the same letters
static void refresh_pigs(void) {
	const op_value *rv = ls_value(room);
	pigslot found[MAXPIGS];
	int n = 0;
	if (ls_room_has(rv, LS_FIRST)) strcpy(found[n].id, LS_FIRST), n++;
	for (size_t i = 0, k = ls_room_pigs(rv); i < k && n < MAXPIGS; i++) {
		const char *id = ls_room_pig(rv, i);
		if (strcmp(id, LS_FIRST) != 0 && ls_room_has(rv, id)) strcpy(found[n++].id, id);
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
	ls_pig st;
	ls_pig_read(ls_value(p->node), p->id, &st);
	*x = st.x, *y = st.y, *by = NULL;
	if (st.binned) return 0;
	static char who[40];
	for (size_t i = 0, k = ls_helds(p->node); i < k; i++) {
		const ls_held *h = ls_held_at(p->node, i);
		ls_pig_held ph;
		if ((h->own || *by == NULL) && ls_pig_held_read(h->value, &ph)) {
			*x = ph.x, *y = ph.y;
			snprintf(who, sizeof who, "%s", ph.by);
			*by = who;
		}
	}
	return 1;
}

// ---- the screen

static char screen[(FW + 8) * (FH + 8 + MAXPIGS) + 1024];
static size_t screen_len;
static void put(const char *s) {
	size_t n = strlen(s);
	if (screen_len + n < sizeof screen) memcpy(screen + screen_len, s, n), screen_len += n;
	screen[screen_len] = 0;
}

// the screen as text: selected pig in capitals. ansi: the selected in reverse video, instead
static void render(int ansi) {
	screen_len = 0;
	char line[512];
	const uint8_t *peer = ls_peer(dev);
	snprintf(line, sizeof line, "littlesync-pigs  room %.8s  peer %s%s  pigs %d  you %s\n", room_id + 9,
		ls_up(dev) ? "up" : "down", peer ? "" : " (not heard)", n_pigs, my_name);
	put(line);
	char grid[FH][FW];
	memset(grid, ' ', sizeof grid);
	grid[0][FW - 1] = 'S';
	grid[FH - 1][FW - 1] = 'B';
	int cell[FH][FW];
	memset(cell, 0, sizeof cell);
	for (int i = 0; i < n_pigs; i++) {
		double x, y;
		const char *by;
		if (!where_is(&pigs[i], &x, &y, &by)) continue;
		int cx = (int)floor(fmin(fmax(x, 0), 1) * (FW - 1)), cy = (int)floor(fmin(fmax(y, 0), 1) * (FH - 1));
		grid[cy][cx] = (char)(i == selected && !ansi ? 'A' + i : 'a' + i);
		cell[cy][cx] = i == selected ? 2 : 1;
	}
	put("+");
	for (int x = 0; x < FW; x++) put("-");
	put("+\n");
	for (int y = 0; y < FH; y++) {
		put("|");
		for (int x = 0; x < FW; x++) {
			char c[16];
			if (ansi && cell[y][x] == 2) snprintf(c, sizeof c, "\x1b[7m%c\x1b[0m", grid[y][x]);
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
	snprintf(line, sizeof line, "selected %c  carrying %c  (tab select, space pick up / drop, hjkl or arrows carry, a add, q quit)\n",
		n_pigs ? 'a' + selected : '-', carried);
	put(line);
	for (int i = 0; i < n_pigs; i++) {
		double x, y;
		const char *by;
		ls_pig st;
		ls_pig_read(ls_value(pigs[i].node), pigs[i].id, &st);
		int shown = where_is(&pigs[i], &x, &y, &by);
		snprintf(line, sizeof line, "%c %.8s x=%.2f y=%.2f%s%s%s%s\n", 'a' + i, pigs[i].id + 9, x, y, st.shame ? " shame" : "",
			shown ? "" : " binned", by ? " held by " : "", by ? by : "");
		put(line);
	}
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
	ls_pig p = {(arc4random() % 800) / 1000.0 + 0.1, (arc4random() % 600) / 1000.0 + 0.3, (double)wall_ms(), arc4random(), 0, 0};
	op_value *v = ls_pig_make(&p);
	ls_put(n, v);
	op_free(v);
	v = op_bool(1);
	ls_set(room, id, v);
	op_free(v);
	refresh_pigs();
	for (int i = 0; i < n_pigs; i++)
		if (strcmp(pigs[i].id, id) == 0) selected = i;
}

static void carry_to(double x, double y) {
	carry_x = fmin(fmax(x, 0), 1), carry_y = fmin(fmax(y, 0), 1);
	op_value *v = ls_pig_make_held(carry_x, carry_y, my_name, my_colour, my_who);
	ls_hold(carrying, v);
	op_free(v);
}

static void space(void) {
	if (n_pigs == 0) return;
	if (carrying == NULL) {
		carrying = pigs[selected].node;
		ls_pig st;
		ls_pig_read(ls_value(carrying), pigs[selected].id, &st);
		carry_to(st.x, st.y);
		return;
	}
	// let go: one stored commit, in the corner of shame or the bin if the feet are there
	ls_pig p = {carry_x, carry_y, (double)wall_ms(), arc4random(), 0, 0};
	p.shame = carry_x > 0.78 && carry_y < 0.45;
	p.binned = carry_x > 0.92 && carry_y > 0.88;
	op_value *v = ls_pig_make(&p);
	ls_put(carrying, v);
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
	case 'h': case 'D': if (carrying) carry_to(carry_x - 0.02, carry_y); break;
	case 'l': case 'C': if (carrying) carry_to(carry_x + 0.02, carry_y); break;
	case 'k': case 'A': if (carrying) carry_to(carry_x, carry_y - 0.03); break;
	case 'j': case 'B': if (carrying) carry_to(carry_x, carry_y + 0.03); break;
	}
	return 1;
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

int main(int argc, char **argv) {
	const char *port = NULL, *state = "./.littlesync-state", *logpath = NULL, *keys = "", *pty_file = NULL;
	int use_pty = 0, use_pipe = 0;
	long exit_after = 0;
	for (int i = 1; i < argc; i++) {
		const char *a = argv[i], *v = i + 1 < argc ? argv[i + 1] : NULL;
		if (strcmp(a, "--port") == 0 && v) port = v, i++;
		else if (strcmp(a, "--pty") == 0) use_pty = 1;
		else if (strcmp(a, "--pipe") == 0) use_pipe = 1;
		else if (strcmp(a, "--state") == 0 && v) state = v, i++;
		else if (strcmp(a, "--room") == 0 && v) snprintf(room_id, sizeof room_id, "%s", v), i++;
		else if (strcmp(a, "--name") == 0 && v) my_name = v, i++;
		else if (strcmp(a, "--dump") == 0 && v) dump_path = v, i++;
		else if (strcmp(a, "--log") == 0 && v) logpath = v, i++;
		else if (strcmp(a, "--keys") == 0 && v) keys = v, i++;
		else if (strcmp(a, "--exit-after") == 0 && v) exit_after = atol(v), i++;
		else if (strcmp(a, "--pty-file") == 0 && v) pty_file = v, i++;
		else {
			fprintf(stderr, "usage: littlesync-pigs [--port PATH | --pty | --pipe] [--state DIR] [--room ID] [--name NAME]\n"
					"       [--dump FILE] [--log FILE] [--keys KEYS] [--exit-after MS] [--pty-file FILE]\n");
			return 2;
		}
	}
	start_ms = mono_ms();
	if (logpath != NULL && (logfile = fopen(logpath, "w")) == NULL) return perror(logpath), 1;
	signal(SIGINT, on_signal), signal(SIGTERM, on_signal), signal(SIGPIPE, SIG_IGN);

	// the line: read from rfd, written to wfd
	int rfd = -1, wfd = -1, keep_open = -1;
	if (use_pipe) {
		rfd = 0, wfd = 1;
		fcntl(0, F_SETFL, fcntl(0, F_GETFL) | O_NONBLOCK);
	} else if (use_pty) {
		int m = posix_openpt(O_RDWR | O_NOCTTY);
		if (m < 0 || grantpt(m) != 0 || unlockpt(m) != 0) return perror("pty"), 1;
		const char *slave = ptsname(m);
		keep_open = open(slave, O_RDWR | O_NOCTTY | O_NONBLOCK);
		raw(keep_open, NULL);
		fcntl(m, F_SETFL, fcntl(m, F_GETFL) | O_NONBLOCK);
		fprintf(stderr, "pty %s\n", slave);
		if (pty_file != NULL) {
			FILE *f = fopen(pty_file, "w");
			if (f != NULL) fprintf(f, "%s\n", slave), fclose(f);
		}
		rfd = wfd = m;
	} else {
		glob_t g;
		if (port == NULL && glob("/dev/cu.usbmodem*", 0, NULL, &g) == 0 && g.gl_pathc > 0) port = g.gl_pathv[0];
		if (port == NULL) return fprintf(stderr, "no /dev/cu.usbmodem*: --port PATH, --pty or --pipe\n"), 1;
		rfd = wfd = open_port(port);
		if (rfd < 0) return perror(port), 1;
	}

	ls_options o = {.store = ls_store_file(state), .random = random_bytes, .epoch_ms = wall_ms() - mono_ms(),
		.log = logfile ? log_line : NULL};
	dev = ls_open(&o);
	if (dev == NULL) return fprintf(stderr, "no key in %s\n", state), 1;
	for (int i = 0; i < LS_KEY_LEN; i++) sprintf(my_who + 2 * i, "%02x", ls_key(dev)[i]);
	if (my_name == NULL) my_name = NAMES[ls_key(dev)[5] % 10];
	my_colour = COLOURS[ls_key(dev)[6] % 7];
	room = ls_follow(dev, room_id);
	if (room == NULL) return fprintf(stderr, "not a room id: %s\n", room_id), 1;
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
		struct pollfd fds[2] = {{rfd, POLLIN, 0}, {has_tty ? 0 : -1, POLLIN, 0}};
		poll(fds, 2, 20);
		uint8_t buf[1024];
		if (fds[0].revents & POLLIN) {
			ssize_t n = read(rfd, buf, sizeof buf);
			if (n > 0) ls_feed(dev, buf, (size_t)n);
			else if (n == 0 && use_pipe) break;
		}
		int quit = 0;
		if (has_tty && (fds[1].revents & POLLIN)) {
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
		const uint8_t *out;
		size_t n = ls_next(dev, &out);
		for (size_t at = 0; at < n;) {
			ssize_t w = write(wfd, out + at, n - at);
			if (w > 0) at += (size_t)w;
			else if (w < 0 && errno == EAGAIN) {
				// a full line: wait a little; the rest is dropped after a while (the stack resends)
				struct pollfd p = {wfd, POLLOUT, 0};
				if (poll(&p, 1, 50) == 0) break;
			} else break;
		}
		draw(0);
	}
	draw(1);
	restore_tty();
	log_line(NULL, "stop");
	ls_close(dev);
	ls_store_file_free(&o.store);
	if (keep_open >= 0) close(keep_open);
	return 0;
}
