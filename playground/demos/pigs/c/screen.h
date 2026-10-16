// The terminal for ermine-pigs: raw mode, the alternate screen, xterm SGR mouse reports (1006, any
// motion 1003), and a grid of cells drawn by its difference from the last one drawn (only the cells
// that changed are written, in one write a frame). Colours are 24-bit; when COLORTERM says the
// terminal has none, the nearest of the 256
#ifndef PIGS_SCREEN_H
#define PIGS_SCREEN_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
	uint8_t r, g, b;
} rgb;

typedef struct {
	// one character, UTF-8, NUL-ended (" " blank)
	char ch[5];
	rgb fg, bg;
	bool bold;
} cell;

typedef struct {
	int rows, cols;
	cell *now, *was;
	bool full;
	bool truecolour;
	// the output being made, written once a frame
	char *out;
	size_t length, room;
} screen;

// the terminal set up (raw, alternate screen, mouse, no cursor); false when stdin is no terminal
bool screen_open(screen *s);
// as it was before; safe to call twice
void screen_close(screen *s);
// the window's size read again (after SIGWINCH): everything drawn again next
void screen_size(screen *s);
// the cell at row, col (NULL outside)
static inline cell *screen_at(screen *s, int row, int col) {
	return row < 0 || col < 0 || row >= s->rows || col >= s->cols ? NULL : &s->now[row * s->cols + col];
}
// text put from row, col, one cell a code point, cut at the edge; how many cells
int screen_text(screen *s, int row, int col, const char *text, rgb fg, const rgb *bg, bool bold);
// what changed since the last frame written to fd; how many bytes
size_t screen_flush(screen *s, int fd);
// the frame as it would be drawn whole, every cell, into a malloc'd string (for a dump)
char *screen_dump(screen *s, size_t *length);

// --- input

typedef enum { K_NONE, K_CHAR, K_UP, K_DOWN, K_LEFT, K_RIGHT, K_TAB, K_BACKTAB, K_ESC, K_MOUSE } key_kind;
typedef struct {
	key_kind kind;
	// K_CHAR: the byte; shift on an arrow
	int ch;
	bool shift;
	// K_MOUSE: button (0 left, 1 middle, 2 right, 3 none), motion, pressed (else released), wheel, at
	// 0-based col, row
	int button;
	bool motion, press, wheel;
	int col, row;
} key;

// the first key in bytes: how many bytes it took (0: not whole yet, wait for more)
size_t key_read(const char *bytes, size_t n, key *out);

#endif
