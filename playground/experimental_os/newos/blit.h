// blit.h: the machine's 2D engine, as js/blitter.ts is (the model;
// both draw the same pixels): forms, fill, frame, blit by a rule, lines,
// polygons and ellipses as Plan 9's draw(2) has them, and text in the font
// ROM's cells or in a font from the font chip. And the draw device
// (../ERMINEOS.md): its ops, as Json, played into a form, where each text
// run went, and what a drag across them selects.
//
// Coordinates are whole numbers; an op's numbers are taken as their floor.
// Text is json.h's UTF-8 (U+0000 as C0 80). Offsets into text (marks, at,
// selections) are UTF-16 code units, as JavaScript counts them, since
// programs written in it compute them: a character past U+FFFF is two.

#ifndef ERMOS_BLIT_H
#define ERMOS_BLIT_H

#include "../../../ermine/encoding/c/json.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/**
 * A form: w × h pixels, 0x00RRGGBB, each row stride pixels after the last
 * (a frame buffer is one, rows of maxw). A form whose ops is not NULL
 * records instead: what is drawn on it is appended to ops, as ops.
 */
typedef struct BlitForm {
	int w, h, stride;
	uint32_t *bits;
	Json *ops;
} BlitForm;

typedef struct BlitRect {
	int x, y, w, h;
} BlitRect;

/**
 * copy: the source as it is. over: the source, but for its transparent
 * pixels, BLIT_TRANSPARENT. blend: the source mixed by the alpha in its top
 * byte (0 is opaque, as 0x00RRGGBB has it; 0xff transparent).
 */
typedef enum { BLIT_COPY, BLIT_OVER, BLIT_BLEND } BlitRule;

#define BLIT_TRANSPARENT 0xff000000u
/** the highlighter marks are drawn on, as play's default */
#define BLIT_MARK 0xffff88u

/** a page of a font: the glyphs of 256 code points */
typedef struct BlitPage {
	int w;                // the strip's width; it is the font's h high
	const uint8_t *alpha; // coverage, 0 to 255, rows of w
	size_t length;        // alpha's bytes
	const double *info;   // 1024 numbers, four a code point: x in the strip, left edge from the pen, box width, advance (in fractions of a pixel)
} BlitPage;

/** a font from the font chip, as /dev/font/<role> holds it */
typedef struct BlitFont {
	int h;            // pixels a line
	double ascent;    // the baseline, down from a line's top
	const char *role; // what a text op names it by
	const BlitPage *(*page)(void *data, int n); // page n (code points from n × 256), or NULL while it is coming
	void *data;
} BlitFont;

/** the font of a role, or NULL: the font ROM */
typedef const BlitFont *(*BlitFonts)(void *data, const char *role);

/** the firmware's font ROM: a glyph for each character of chars (UTF-8), w × h of coverage each, one after another in alpha */
typedef struct BlitRom {
	int w, h;
	const char *chars;
	const uint8_t *alpha;
} BlitRom;

typedef struct Blitter Blitter;

/** a blitter with this font ROM; it keeps rom's alpha, which must outlive it */
Blitter *blitNew(const BlitRom *rom);
void blitFree(Blitter *blitter);

/** a form w × h of fill; its bits are allocated, for the caller to free */
BlitForm blitForm(int w, int h, uint32_t fill);
/** a form that records ops instead of pixels; with fill, its first op fills it */
BlitForm blitList(int w, int h, const uint32_t *fill);

// Drawing. Each is clipped to the form, and to clip when it is not NULL.

void blitFill(BlitForm *dst, int x, int y, int w, int h, uint32_t color, const BlitRect *clip);
/** a one-pixel frame */
void blitFrame(BlitForm *dst, int x, int y, int w, int h, uint32_t color, const BlitRect *clip);
/** BitBlt: src's rectangle at sx, sy, w × h, into dst at dx, dy, by rule */
void blitBlit(BlitForm *dst, int dx, int dy, const BlitForm *src, int sx, int sy, int w, int h, BlitRule rule, const BlitRect *clip);
/** a line, both ends drawn, width pixels across in a round pen (1 if less): Plan 9's line, whose thick t is width 1 + 2t */
void blitLine(BlitForm *dst, int x0, int y0, int x1, int y1, int width, uint32_t color, const BlitRect *clip);
/** lines from each of n points (x, y, x, y...) to the next, as blitLine draws them: Plan 9's poly; one point is a dot */
void blitPoly(BlitForm *dst, const int *points, int n, int width, uint32_t color, const BlitRect *clip);
/** n points' polygon filled, the last joined to the first; a pixel is in when its centre is inside, by the odd or the nonzero rule: Plan 9's fillpoly */
void blitFillpoly(BlitForm *dst, const int *points, int n, bool odd, uint32_t color, const BlitRect *clip);
/** an ellipse's outline centred on x, y, rx across and ry down, width pixels across in a round pen (1 if less): Plan 9's ellipse */
void blitEllipse(BlitForm *dst, int x, int y, int rx, int ry, int width, uint32_t color, const BlitRect *clip);
/** an ellipse filled, its outline's pixels with it: Plan 9's fillellipse */
void blitFillellipse(BlitForm *dst, int x, int y, int rx, int ry, uint32_t color, const BlitRect *clip);
/** text, its top left at x, y, on *bg or (bg NULL) over what is there, in font or (NULL) the ROM's cells; gives the x it ended at */
int blitText(const Blitter *blitter, BlitForm *dst, int x, int y, const char *text, uint32_t fg, const uint32_t *bg, const BlitRect *clip, const BlitFont *font);

// Measuring, in font, or in the ROM's cells when font is NULL.

/** how wide text is */
int blitMeasure(const Blitter *blitter, const char *text, const BlitFont *font);
/** how tall a line is */
int blitHeight(const Blitter *blitter, const BlitFont *font);
/** the caret offset (UTF-16) in text nearest dx pixels from its start: for a click */
size_t blitAt(const Blitter *blitter, const char *text, double dx, const BlitFont *font);
/** how many of text's characters (code points) fit in w pixels: for wrapping */
size_t blitFit(const Blitter *blitter, const char *text, double w, const BlitFont *font);
/** text's length in UTF-16 code units, as JavaScript's length */
size_t blitUnits(const char *text);

// The draw device.

/**
 * Plays ops (a Json list of ops) into dst, as the compositor plays a layer's:
 * gives where each text run went, a fresh list of {op, x, y, w, h, text,
 * font}. marks, when not NULL, is a list of [op, from, to], a selection's
 * ranges (the last for an op counts): those UTF-16 offsets of that text op
 * are drawn on mark, a highlighter.
 */
Json *blitPlay(const Blitter *blitter, BlitForm *dst, const Json *ops, BlitFonts fonts, void *data, const Json *marks, uint32_t mark);
/** blitPlay, drawing only inside within (each op's clip met with it), when not NULL; the runs all of them, as blitPlay's */
Json *blitPlayIn(const Blitter *blitter, BlitForm *dst, const Json *ops, BlitFonts fonts, void *data, const Json *marks, uint32_t mark, const BlitRect *within);
/** where an op draws, in the form's coordinates, inside its clip: false for one whose bounds it cannot say */
bool blitOpBox(const Blitter *blitter, const Json *op, BlitFonts fonts, void *data, BlitRect *out);
/**
 * The text between two points over a layer's runs (as play gives them), as a
 * person drags across it: a fresh {ranges: [[op, from, to]...], text}, in
 * reading order; a run on a lower line starts a new line, and a gap on one
 * line is a space.
 */
Json *blitSelect(const Blitter *blitter, const Json *runs, const double from[2], const double to[2], BlitFonts fonts, void *data);

#endif
