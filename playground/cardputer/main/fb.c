// the framebuffer (fb.h)
#include "fb.h"

#include <string.h>

#include "font8x8.h"

uint8_t fb[FB_W * FB_STRIP / 2];
int fb_top;

void fb_strip(int top) { fb_top = top; }

// whether rows y0..y1 (both in) touch the strip
static int touches(int y0, int y1) { return y1 >= fb_top && y0 < fb_top + FB_STRIP; }

#define C(r, g, b) {r, g, b}
const uint8_t fb_rgb[16][3] = {
	C(0xff, 0xf6, 0x8f), // lemon
	C(0x10, 0x10, 0x10), // ink
	C(0xd2, 0x04, 0x2d), // cherry
	C(0xff, 0xff, 0xff), // white
	C(0xf6, 0xa9, 0xc4), // pig
	C(0xe2, 0x7a, 0xa0), // pig, dark
	C(0xb9, 0x84, 0x4f), // mud
	C(0xd8, 0xe3, 0x8a), // grass
	C(0x22, 0x69, 0xff), // blue
	C(0xdc, 0xe6, 0xff), // sky
	C(0xcc, 0xf5, 0xe8), // mint
	C(0x99, 0x99, 0x99), // grey
	C(0xfd, 0xfa, 0xf2), // cream
	C(0x7a, 0x52, 0x30), // wood
	C(0xec, 0xe2, 0xff), // lilac
	C(0xff, 0xd8, 0x3a), // yellow
};
#undef C

#define RGB(r, g, b) ((uint16_t)((((r) & 0xf8) << 8) | (((g) & 0xfc) << 3) | ((b) >> 3)))
const uint16_t fb_565[16] = {
	RGB(0xff, 0xf6, 0x8f), RGB(0x10, 0x10, 0x10), RGB(0xd2, 0x04, 0x2d), RGB(0xff, 0xff, 0xff),
	RGB(0xf6, 0xa9, 0xc4), RGB(0xe2, 0x7a, 0xa0), RGB(0xb9, 0x84, 0x4f), RGB(0xd8, 0xe3, 0x8a),
	RGB(0x22, 0x69, 0xff), RGB(0xdc, 0xe6, 0xff), RGB(0xcc, 0xf5, 0xe8), RGB(0x99, 0x99, 0x99),
	RGB(0xfd, 0xfa, 0xf2), RGB(0x7a, 0x52, 0x30), RGB(0xec, 0xe2, 0xff), RGB(0xff, 0xd8, 0x3a),
};

void fb_clear(int c) { memset(fb, (c & 15) | (c & 15) << 4, sizeof fb); }

void fb_pixel(int x, int y, int c) {
	if (x < 0 || x >= FB_W || y < fb_top || y >= fb_top + FB_STRIP || y >= FB_H) return;
	uint8_t *b = &fb[((y - fb_top) * FB_W + x) >> 1];
	if (x & 1) *b = (uint8_t)((*b & 0x0f) | (c & 15) << 4);
	else *b = (uint8_t)((*b & 0xf0) | (c & 15));
}

int fb_get(int x, int y) {
	if (x < 0 || x >= FB_W || y < fb_top || y >= fb_top + FB_STRIP || y >= FB_H) return 0;
	uint8_t b = fb[((y - fb_top) * FB_W + x) >> 1];
	return x & 1 ? b >> 4 : b & 15;
}

void fb_rect(int x, int y, int w, int h, int c) {
	// only the rows in the strip
	int from = y > fb_top ? y : fb_top, to = y + h < fb_top + FB_STRIP ? y + h : fb_top + FB_STRIP;
	for (int j = from; j < to; j++)
		for (int i = x; i < x + w; i++) fb_pixel(i, j, c);
}

static void dot(int x, int y, int c, int width) {
	if (width <= 1) {
		fb_pixel(x, y, c);
		return;
	}
	int r = width / 2, r2 = (width * width) / 4;
	for (int j = -r; j <= r; j++)
		for (int i = -r; i <= r; i++)
			if (i * i + j * j <= r2) fb_pixel(x + i, y + j, c);
}

void fb_line(int x0, int y0, int x1, int y1, int c, int width) {
	int lo = (y0 < y1 ? y0 : y1) - width, hi = (y0 > y1 ? y0 : y1) + width;
	if (!touches(lo, hi)) return;
	int dx = x1 > x0 ? x1 - x0 : x0 - x1, sx = x0 < x1 ? 1 : -1;
	int dy = y1 > y0 ? y0 - y1 : y1 - y0, sy = y0 < y1 ? 1 : -1;
	int err = dx + dy;
	for (int guard = 0; guard < 4 * (FB_W + FB_H) + 4096; guard++) {
		dot(x0, y0, c, width);
		if (x0 == x1 && y0 == y1) break;
		int e2 = 2 * err;
		if (e2 >= dy) err += dy, x0 += sx;
		if (e2 <= dx) err += dx, y0 += sy;
	}
}

void fb_text(int x, int y, const char *s, int c, int scale) {
	if (scale < 1) scale = 1;
	if (!touches(y, y + 8 * scale - 1)) return;
	for (; *s; s++, x += 8 * scale) {
		unsigned char ch = (unsigned char)*s;
		const unsigned char *glyph = font8x8_basic[ch < 128 ? ch : '?'];
		for (int row = 0; row < 8; row++)
			for (int b = 0; b < 8; b++)
				if (glyph[row] >> b & 1) fb_rect(x + b * scale, y + row * scale, scale, scale, c);
	}
}

int fb_text_width(const char *s, int scale) { return (int)strlen(s) * 8 * (scale < 1 ? 1 : scale); }

// book/kit/sprites.ts' pig: K ink, p pink, q dark pink
static const char *const PIG[FB_PIG_H] = {
	"..KK.........KK...",
	".KppK.......KppK..",
	".KpppKKKKKKKKpppK.",
	"KppppppppppppppppK",
	"KpppKppKppppppppqK",
	"KqqqqppppppppppppK",
	"KqKqKppppppppppppK",
	"KqqqqppppppppppppK",
	".KpppppppppppppqK.",
	"..KKpKKKKKKKKpKK..",
	"...KK........KK...",
};

void fb_pig(int x, int y, int scale) {
	if (scale < 1) scale = 1;
	if (!touches(y, y + FB_PIG_H * scale - 1)) return;
	for (int j = 0; j < FB_PIG_H; j++)
		for (int i = 0; i < FB_PIG_W; i++) {
			char p = PIG[j][i];
			int c = p == 'K' ? FB_INK : p == 'p' ? FB_PIG : p == 'q' ? FB_PIG_DARK : -1;
			if (c >= 0) fb_rect(x + i * scale, y + j * scale, scale, scale, c);
		}
}
