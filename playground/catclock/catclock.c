/* Copyright 1985 Massachusetts Institute of Technology (COPYING) */

// catclock.c: xclock's cat mode (xclock.c, X11 and Motif, 1988-1991), as
// catclock.js draws it on a canvas: blue, a black cat, white details, a red
// tie and red hands outlined black; the tail and eyes swing sixteen steps
// each way. Drawn at 1 × 1, as X drew the window (draw.h), then scaled into
// the host's buffer.
//
// Plain C11 with no libc, so it builds as freestanding wasm (maths.h has its
// own sin and cos), and it allocates nothing. One file to compile: it
// includes the rest.

#include "catclock.h"

#include "bitmaps.h"
#include "colours.h"
#include "maths.h"
#include "draw.h"
#include "cat.h"

#include <stddef.h>

#define N_TAILS 16 // DEF_N_TAILS: steps a swing
#define PADDING 8  // DEF_ANALOG_PADDING

static uint32_t body[CAT_H][CAT_W]; // what stays: catback, catwhite and cattie, made once
static uint32_t out[CC_MAX_PIXELS];
static int W, H, format, made;

uint32_t *cc_init(int w, int h, int f) {
	if (w < 1 || h < 1 || (int64_t)w * h > CC_MAX_PIXELS) return NULL;
	W = w, H = h, format = f;
	if (!made) {
		// InitializeCat: catback opaque (the cat on the background), then catwhite and cattie over it
		for (int y = 0; y < CAT_H; y++)
			for (int x = 0; x < CAT_W; x++) {
				uint32_t c = bit(catback_bits[y], x) ? CAT : BG;
				if (bit(catwhite_bits[y], x)) c = DETAIL;
				if (bit(cattie_bits[y], x)) c = TIE;
				body[y][x] = c;
			}
		made = 1;
	}
	return out;
}

static uint32_t pixel(uint32_t rgb) {
	if (format == CC_XRGB) return rgb;
	return 0xff000000u | (rgb & 0xff) << 16 | (rgb & 0xff00) | (rgb >> 16 & 0xff);
}

void cc_frame(double ms, int tz) {
	if (!made) return;
	// the time: hours and minutes on the dial, local; the swing's step from the instant, 16 a second
	double local = ms + tz * 60000.0;
	int64_t day = (int64_t)fl(local / 1000) % 86400;
	if (day < 0) day += 86400;
	int hour = (int)(day / 3600 % 12), minute = (int)(day / 60 % 60);
	int64_t step = (int64_t)fl(ms * N_TAILS / 1000) % (2 * N_TAILS);
	if (step < 0) step += 2 * N_TAILS;
	int at = (int)(step <= N_TAILS ? step : 2 * N_TAILS - step);

	for (int y = 0; y < CAT_H; y++)
		for (int x = 0; x < CAT_W; x++) cat[y][x] = body[y][x];
	// the radius as xclock works it out, the hands' lengths and half-width from it
	int radius = round_((CAT_W - 2 * PADDING) / 3.45);
	int width = (7 * radius / 100) * 2;
	hand(70 * radius / 100, width, minute / 60.0);
	hand(40 * radius / 100, width, (hour + minute / 60.0) / 12.0);
	tail(at * PI / N_TAILS);
	eyes(at * PI / N_TAILS);

	// into the buffer, at the largest whole scale that fits, in the middle
	int k = W / CAT_W < H / CAT_H ? W / CAT_W : H / CAT_H;
	if (k < 1) k = 1;
	int ox = (W - CAT_W * k) / 2, oy = (H - CAT_H * k) / 2;
	uint32_t bg = pixel(BG);
	for (int y = 0; y < H; y++) {
		uint32_t *row = out + (size_t)y * W;
		int cy = y - oy;
		if (cy < 0 || cy >= CAT_H * k) {
			for (int x = 0; x < W; x++) row[x] = bg;
			continue;
		}
		const uint32_t *from = cat[cy / k];
		for (int x = 0; x < W; x++) {
			int cx = x - ox;
			row[x] = cx < 0 || cx >= CAT_W * k ? bg : pixel(from[cx / k]);
		}
	}
}
