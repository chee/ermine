// catclock.h: xclock's cat (X11, cat mode), drawn into a pixel buffer it
// hands its host. Plain C11, no libc: built as wasm for a browser's canvas,
// and natively for ermineOS. It keeps no clock: the host says the time.
//
//   uint32_t *px = cc_init(300, 600, CC_RGBA);   // the buffer, w × h, rows w apart
//   cc_frame(ms, tz);                            // each frame: the cat at that time, drawn into it
//
// The cat is 150 × 300; it is drawn at the largest whole scale that fits,
// in the middle, blue around it.

#ifndef CATCLOCK_H
#define CATCLOCK_H

#include <stdint.h>

/** how a pixel is laid out in the buffer */
enum {
	CC_RGBA = 0, // bytes R, G, B, A in memory (0xAABBGGRR, little-endian): a canvas's ImageData
	CC_XRGB = 1, // words 0x00RRGGBB: an ermineOS plane
};

/** the most pixels a buffer holds */
#define CC_MAX_PIXELS (2048 * 1024)

/** a buffer of w × h pixels, its rows w apart, laid out as format says; NULL when w × h is too many */
uint32_t *cc_init(int w, int h, int format);

/**
 * draws the cat into the buffer: its hands at the local time, its tail and
 * eyes at their step (sixteen steps a swing, a swing there and back every
 * two seconds). ms: milliseconds since 1970 UTC; tz: minutes east of UTC
 * (local = UTC + tz; a browser's -getTimezoneOffset()).
 */
void cc_frame(double ms, int tz);

#endif
