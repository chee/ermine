// the Cardputer ADV's screen: ST7789V2, 240x135, drawn a text row at a time (8x8 cells, 30
// columns, 16 rows), each row sent from a small strip; or the framebuffer (fb.h) whole, 4 bits a
// pixel kept, made rgb565 a strip at a time
#ifndef SCREEN_H
#define SCREEN_H

#include <stdint.h>

#define SCREEN_COLUMNS 30
#define SCREEN_ROWS 16

// rgb565 from 8-bit channels
#define RGB(r, g, b) ((uint16_t)((((r) & 0xf8) << 8) | (((g) & 0xfc) << 3) | ((b) >> 3)))

void screen_init(void);
// the edges above and below the rows
void screen_edges(uint16_t color);
// a row: text from the left, cut at the right edge, the rest paper
void screen_line(int row, const char *s, uint16_t ink, uint16_t paper);
// the whole framebuffer (fb.h), all 135 rows, sent 8 rows a strip through the same two strips
void screen_frame(void);

#endif
