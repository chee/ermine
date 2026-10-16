// The terminal (screen.h)
#define _DARWIN_C_SOURCE
#include "screen.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

static struct termios saved;
static bool opened;

static void emit(screen *s, const char *bytes, size_t n) {
	if (s->length + n + 1 > s->room) {
		s->room = (s->length + n + 1) * 2;
		s->out = realloc(s->out, s->room);
		if (!s->out) abort();
	}
	memcpy(s->out + s->length, bytes, n);
	s->length += n;
}

static void emits(screen *s, const char *text) { emit(s, text, strlen(text)); }

static void whole(int fd, const char *bytes, size_t n) {
	while (n) {
		ssize_t w = write(fd, bytes, n);
		if (w <= 0) return;
		bytes += w, n -= (size_t)w;
	}
}

static void blank(cell *c) { *c = (cell){.ch = " ", .fg = {0, 0, 0}, .bg = {0, 0, 0}}; }

void screen_size(screen *s) {
	struct winsize ws;
	int rows = 24, cols = 80;
	if (ioctl(1, TIOCGWINSZ, &ws) == 0 && ws.ws_row && ws.ws_col) rows = ws.ws_row, cols = ws.ws_col;
	const char *force = getenv("PIGS_SIZE");
	if (force) sscanf(force, "%dx%d", &rows, &cols);
	if (rows < 4) rows = 4;
	if (cols < 10) cols = 10;
	free(s->now), free(s->was);
	s->rows = rows, s->cols = cols;
	s->now = calloc((size_t)rows * cols, sizeof *s->now);
	s->was = calloc((size_t)rows * cols, sizeof *s->was);
	if (!s->now || !s->was) abort();
	for (int i = 0; i < rows * cols; i++) blank(&s->now[i]), blank(&s->was[i]);
	s->full = true;
}

bool screen_open(screen *s) {
	memset(s, 0, sizeof *s);
	const char *ct = getenv("COLORTERM");
	s->truecolour = ct && (strstr(ct, "truecolor") || strstr(ct, "24bit"));
	if (getenv("PIGS_TRUECOLOR")) s->truecolour = true;
	screen_size(s);
	if (!isatty(0)) return false;
	if (tcgetattr(0, &saved) != 0) return false;
	struct termios raw = saved;
	raw.c_iflag &= ~(tcflag_t)(BRKINT | ICRNL | INPCK | ISTRIP | IXON);
	raw.c_oflag &= ~(tcflag_t)OPOST;
	raw.c_cflag |= CS8;
	raw.c_lflag &= ~(tcflag_t)(ECHO | ICANON | IEXTEN | ISIG);
	raw.c_cc[VMIN] = 0;
	raw.c_cc[VTIME] = 0;
	tcsetattr(0, TCSAFLUSH, &raw);
	opened = true;
	// the alternate screen, no cursor, no wrapping, mouse: buttons, any motion, SGR form
	const char *on = "\033[?1049h\033[?25l\033[?7l\033[?1000h\033[?1002h\033[?1003h\033[?1006h\033[2J";
	whole(1, on, strlen(on));
	return true;
}

void screen_close(screen *s) {
	if (opened) {
		const char *off = "\033[?1006l\033[?1003l\033[?1002l\033[?1000l\033[0m\033[?7h\033[?25h\033[?1049l";
		whole(1, off, strlen(off));
		tcsetattr(0, TCSAFLUSH, &saved);
		opened = false;
	}
	if (s) {
		free(s->now), free(s->was), free(s->out);
		s->now = s->was = NULL, s->out = NULL;
	}
}

// the UTF-8 sequence's length from its first byte
static int utf8_length(unsigned char c) { return c < 0x80 ? 1 : c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1; }

int screen_text(screen *s, int row, int col, const char *text, rgb fg, const rgb *bg, bool bold) {
	int n = 0;
	for (const char *p = text; *p;) {
		int len = utf8_length((unsigned char)*p);
		cell *c = screen_at(s, row, col + n);
		if (c) {
			memset(c->ch, 0, sizeof c->ch);
			for (int i = 0; i < len && p[i]; i++) c->ch[i] = p[i];
			c->fg = fg;
			if (bg) c->bg = *bg;
			c->bold = bold;
		}
		for (int i = 0; i < len && *p; i++) p++;
		n++;
	}
	return n;
}

static bool same_rgb(rgb a, rgb b) { return a.r == b.r && a.g == b.g && a.b == b.b; }

static bool same(const cell *a, const cell *b) {
	return !strcmp(a->ch, b->ch) && same_rgb(a->bg, b->bg) && a->bold == b->bold &&
		(same_rgb(a->fg, b->fg) || !strcmp(a->ch, " "));
}

// the nearest of xterm's 256: the 6x6x6 cube or the grey ramp
static int nearest(rgb c) {
	static const int level[6] = {0, 95, 135, 175, 215, 255};
	int idx[3], v[3] = {c.r, c.g, c.b};
	for (int i = 0; i < 3; i++) {
		int best = 0;
		for (int k = 1; k < 6; k++)
			if (abs(level[k] - v[i]) < abs(level[best] - v[i])) best = k;
		idx[i] = best;
	}
	int cube = 16 + 36 * idx[0] + 6 * idx[1] + idx[2];
	int dc = 0;
	for (int i = 0; i < 3; i++) dc += (level[idx[i]] - v[i]) * (level[idx[i]] - v[i]);
	int grey = (c.r + c.g + c.b) / 3, gi = grey < 8 ? 0 : grey > 238 ? 23 : (grey - 8) / 10, gv = 8 + 10 * gi;
	int dg = 0;
	for (int i = 0; i < 3; i++) dg += (gv - v[i]) * (gv - v[i]);
	return dg < dc ? 232 + gi : cube;
}

static void colour(screen *s, char *buf, size_t room, int which, rgb c) {
	if (s->truecolour) snprintf(buf, room, ";%d;2;%d;%d;%d", which, c.r, c.g, c.b);
	else snprintf(buf, room, ";%d;5;%d", which, nearest(c));
}

// the cells into the output: all of them (all), or only those that differ from what was drawn
static void frame(screen *s, bool all) {
	int at_row = -1, at_col = -1;
	bool styled = false;
	cell style = {0};
	for (int r = 0; r < s->rows; r++) {
		for (int c = 0; c < s->cols; c++) {
			cell *now = &s->now[r * s->cols + c], *was = &s->was[r * s->cols + c];
			if (!all && same(now, was)) continue;
			char buf[96];
			if (r != at_row || c != at_col) {
				snprintf(buf, sizeof buf, "\033[%d;%dH", r + 1, c + 1);
				emits(s, buf);
			}
			bool blankish = !strcmp(now->ch, " ");
			if (!styled || style.bold != now->bold || !same_rgb(style.bg, now->bg) ||
				(!blankish && !same_rgb(style.fg, now->fg))) {
				char fg[32], bg[32];
				colour(s, fg, sizeof fg, 38, now->fg);
				colour(s, bg, sizeof bg, 48, now->bg);
				snprintf(buf, sizeof buf, "\033[%s%s%sm", now->bold ? "0;1" : "0", fg, bg);
				emits(s, buf);
				styled = true;
				style = *now;
			}
			emits(s, now->ch);
			*was = *now;
			at_row = r, at_col = c + 1;
		}
	}
}

size_t screen_flush(screen *s, int fd) {
	s->length = 0;
	if (s->full) emits(s, "\033[0m\033[2J");
	frame(s, s->full);
	s->full = false;
	if (s->length) whole(fd, s->out, s->length);
	return s->length;
}

char *screen_dump(screen *s, size_t *length) {
	s->length = 0;
	emits(s, "\033[0m\033[2J");
	frame(s, true);
	emits(s, "\033[0m\r\n");
	char *copy = malloc(s->length + 1);
	if (!copy) abort();
	memcpy(copy, s->out, s->length);
	copy[s->length] = 0;
	*length = s->length;
	return copy;
}

// --- input

size_t key_read(const char *b, size_t n, key *k) {
	*k = (key){.kind = K_NONE};
	if (!n) return 0;
	unsigned char c = (unsigned char)b[0];
	if (c != 0x1b) {
		if (c == '\t') return k->kind = K_TAB, 1;
		// one UTF-8 character, or a byte
		int len = utf8_length(c);
		if ((size_t)len > n) return 0;
		k->kind = K_CHAR, k->ch = c;
		return (size_t)len;
	}
	if (n == 1) return k->kind = K_ESC, 1;
	if (b[1] != '[' && b[1] != 'O') return k->kind = K_ESC, 1;
	// SGR mouse: ESC [ < b ; x ; y M|m
	if (b[1] == '[' && n >= 3 && b[2] == '<') {
		int v[3] = {0, 0, 0}, i = 0;
		for (size_t p = 3; p < n; p++) {
			char ch = b[p];
			if (ch >= '0' && ch <= '9') v[i] = v[i] * 10 + (ch - '0');
			else if (ch == ';') {
				if (++i > 2) return k->kind = K_ESC, p + 1;
			} else if (ch == 'M' || ch == 'm') {
				k->kind = K_MOUSE;
				k->button = v[0] & 3;
				k->motion = (v[0] & 32) != 0;
				k->wheel = (v[0] & 64) != 0;
				k->shift = (v[0] & 4) != 0;
				k->press = ch == 'M';
				k->col = v[1] - 1, k->row = v[2] - 1;
				return p + 1;
			} else return k->kind = K_ESC, p + 1;
		}
		return 0;
	}
	// CSI or SS3: parameters, then a final byte
	size_t p = 2;
	int param[4] = {0}, count = 0;
	while (p < n && ((b[p] >= '0' && b[p] <= '9') || b[p] == ';')) {
		if (b[p] == ';') count = count < 3 ? count + 1 : count;
		else param[count] = param[count] * 10 + (b[p] - '0');
		p++;
	}
	if (p >= n) return 0;
	char final = b[p++];
	k->shift = count >= 1 && (param[1] - 1) & 1;
	switch (final) {
	case 'A': k->kind = K_UP; break;
	case 'B': k->kind = K_DOWN; break;
	case 'C': k->kind = K_RIGHT; break;
	case 'D': k->kind = K_LEFT; break;
	case 'Z': k->kind = K_BACKTAB; break;
	default: k->kind = K_NONE; break;
	}
	return p;
}
