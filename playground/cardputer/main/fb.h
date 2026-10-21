// the framebuffer: a strip of the 240x135 screen, FB_STRIP rows from fb_top, 4 bits a pixel (960
// bytes, not the whole screen's 16200), sixteen colours. a picture is a paint function: the platform
// (screen_frame on the Cardputer, a PNG in the sim) moves the strip down the screen, calls it for each
// strip and sends what it drew; what falls outside the strip is not drawn. coordinates are the whole
// screen's. two pixels a byte, the left one in the low nibble
#ifndef CARD_FB_H
#define CARD_FB_H

#include <stdint.h>

#define FB_W 240
#define FB_H 135

enum {
	FB_LEMON, // the page
	FB_INK,
	FB_CHERRY,
	FB_WHITE,
	FB_PIG, // a pig's pink
	FB_PIG_DARK, // its snout and shadow
	FB_MUD,
	FB_GRASS,
	FB_BLUE,
	FB_SKY,
	FB_MINT,
	FB_GREY,
	FB_CREAM,
	FB_WOOD,
	FB_LILAC,
	FB_YELLOW,
};

#define FB_STRIP 8
extern uint8_t fb[FB_W * FB_STRIP / 2];
// the screen row the strip starts at
extern int fb_top;
// a picture: drawn again for each strip, the same each time
typedef void (*fb_paint)(void);

// the strip moved to start at row top (cleared to nothing in particular: a paint clears it)
void fb_strip(int top);
// each colour as rgb565 and as 8-bit rgb
extern const uint16_t fb_565[16];
extern const uint8_t fb_rgb[16][3];

// the strip all c
void fb_clear(int c);
void fb_pixel(int x, int y, int c);
// a pixel of the strip (outside it: 0)
int fb_get(int x, int y);
void fb_rect(int x, int y, int w, int h, int c);
// a line, width pixels wide (a round pen)
void fb_line(int x0, int y0, int x1, int y1, int c, int width);
// text in the 8x8 font, each pixel scale x scale; how wide it is
void fb_text(int x, int y, const char *s, int c, int scale);
int fb_text_width(const char *s, int scale);
// a pig, scale pixels a sprite pixel (18x11 at 1), its top left at x, y
void fb_pig(int x, int y, int scale);
#define FB_PIG_W 18
#define FB_PIG_H 11

#endif
