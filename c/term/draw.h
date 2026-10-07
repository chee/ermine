// draw.h: drawing a screen node's value (the grid, NOTES.md) with ncurses,
// for ermine-term's windows (wm.c) and erminex's one window (erminex.c).

#ifndef TERM_DRAW_H
#define TERM_DRAW_H

#include "../json.h"

#include <stdbool.h>

/** a whole number field of an object in [-1, 100000), or `otherwise` */
int drawNumber(Json *object, const char *key, int otherwise);
/** one row of a screen: its text, a code point a cell, with its style runs, cut at `width` */
void drawLine(int y, int x, int width, Json *line, Json *runs);
/** a screen's lines and styles, from row y, column x, at most `rows` rows and `width` columns */
void drawLines(Json *screen, int y, int x, int rows, int width);
/** where a screen's cursor is on the terminal, drawn at y, x in rows by width; false when it has none, it is hidden, or it is outside */
bool drawCursor(Json *screen, int y, int x, int rows, int width, int *cy, int *cx);

#endif
