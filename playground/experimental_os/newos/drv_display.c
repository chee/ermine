// drv_display.c
// drv_display.c: the compositor (irq 33), as image/drivers/display.js was.
// It holds the two frame buffers the metal shows, and composes what is
// placed in /dev/display/layers into the back one: each layer an ephemeral
// node of the program that placed it, {x, y, w, h, z, draw, title?, owner?,
// over?, collapsed?, hidden?}, draw the draw device's ops (blit.h), played
// into a form of its own when they, the fonts or the selection change; or
// pixels, a uint32 array; or plane, pixels a driver keeps (hostPlane), of
// which dirty says what changed with this serial, so that alone is copied and
// drawn again (drv_vram.c). Where each text run went is written to
// /dev/display/text/<layer>; /dev/display/selection, {layer, ranges, text},
// is drawn under its text on a highlighter. A layer with a title gets its
// chrome, a frame and title bar, as /etc/theme's window says (System 7's by
// default), its own chrome over that; one with none and a shape, {radius,
// shadow?}, is rounded and casts a soft shadow as a window does (a dock, a
// menu, a balloon). Only what changed is
// drawn again, each buffer keeping what changed since it was last drawn
// into; the next vsync flips it, saying what changed since the last flip,
// so the metal copies only that. One frame a refresh: a change that comes
// while a frame waits for its vsync is composed after the flip.
//
// /dev/display/windows/<name>: each layer, hidden ones too, as
// {x, y, w, h, z, title, owner, collapsed, hidden, drags, want, chrome}, what it
// is and where, without what it draws, and on the monitor a titled one's parts,
// where its chrome's frame, bar, boxes and grip are; written only when that changes. So the
// window manager follows windows as they come, go and move, a window
// that draws, as a clock does a dozen times a second, costs it nothing, and
// one moved costs the programs reading only their own nothing.
//
// A layer's "web", {id, x, y, w, h}, is where a page from the web driver
// (drv_web.c) shows: its plane, the page's newest frame (/dev/web/pages'
// frame), drawn there over the layer's ops as any plane is, only its dirty
// rectangle when it says one; so a page is composed as any layer is, in
// every mode. The metal is told each page's size as it shows (webshow, w 0
// for none), so a page draws only while a layer shows it.
//
// In windows mode (mode.windows) each layer with a title is a Mac window of
// its own (a surface, ../mac/METAL.md), and untitled ones (the desktop, the
// bar) are not shown. Each frame, what changed in a window since it was
// last presented, the rectangle its pixels differ in, is packed beside the
// others into the back buffer and presented at the next vsync, so a caret
// blinking presents a caret and a window moved presents nothing. The Mac's
// window server places them: when the person moves one, or makes one key,
// the metal says so, and this writes the layer's x and y, or
// /dev/display/focus, as the hardware's change; the focus written elsewhere
// makes that window key. Their close buttons write /dev/display/close,
// {layer, n}, for the window manager. {"windows": true} written to
// /dev/display/want asks the metal for windows mode ({"windows": false}, for
// the monitor); this takes the wish and clears it.
//
// In layers mode (mode.layers, when the metal says it can) each layer is a
// GPU layer of the metal's, its chrome and content in one form (a tile),
// which the metal stacks by z and casts a soft shadow under, as /etc/theme's
// shadow says. Where each is, its depth and its shadow are told when they
// change, with no pixels, so a window dragged or raised is a command and no
// drawing; what changed in a tile since it was last painted is packed into
// the back buffer and painted at the next vsync, in the same command.
//
// The Mac's menu bar: /dev/display/menus, what it should show after the
// metal's own menus, {n, menus} (the world menu, then the focused window's
// menus, as the window manager writes them), is sent to the metal as it
// changes (menus). An item chosen there (irq 33, event menu) is written to
// /dev/display/chosen, {n, for, menu, item, sub?}: for, the
// menus' n it was chosen from; sub, its place in each submenu down from item; the window manager does what a click on it in
// its own menu bar does.
//
// Not yet here, as display.js has it: the host's console under everything.

#include "drivers.h"
#include "../../../ermine/encoding/c/json_text.h"
#include "drv.h"
#include "blit.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct Page {
	int n;
	BlitPage page;
	Json *value; // the page's value, held: the alpha and info are its
} Page;

typedef struct Face {
	char *role;
	BlitFont font;
	ERM_LIST(Page) pages;
	ERM_LIST(int) wanted;
	struct Display *d;
} Face;

typedef struct Drawn {
	char *name;
	BlitRect rect;
	char *key;      // what it is and where, without when its value last changed (t) or its plane
	char *t;        // when its value last changed
	int64_t serial; // its plane's serial, -1 for none
	bool part;      // this frame: only its plane's dirty rectangle, part, changed
	BlitRect at;    // part, in the layer
} Drawn;

typedef struct Rendered {
	char *name;
	char *key;
	char *rest; // its key but for its ops: the same, and its ops a splice of the last, only where they changed is played again
	BlitForm form;
	char *runs;
	bool seen;
	int64_t n;  // how many times it was played: one not played since it was presented is not compared
	const Json *draw, *pixels; // what it was played from: a value is never changed (json.h), so the same pointer is the same ops; draw held (spliced reads it)
	BlitRect delta; // where its last render changed it (none: nothing); fresh, all of it
	bool fresh;
} Rendered;

/** windows mode: a titled layer's Mac window, as it was last told and shown */
typedef struct Surface {
	char *name;
	char *geo;        // x, y, w, h and title, as the last surface command said
	int w, h;
	uint32_t *shown;  // its pixels as last presented, w × h, to present only what differs
	int64_t n;        // its form's Rendered n when last compared
	bool seen;
} Surface;

/** layers mode: a layer as the metal composites it, its chrome and content in one form */
typedef struct Tile {
	char *name;
	char *geo;      // where, its depth and its shadow, as the last layers command said
	char *key;      // what its form was made from: its content's Rendered n, its chrome's look
	char *rest;     // its key but for its content's n, which was n: only its content changed, where its Rendered delta says
	int64_t n;
	BlitForm form;  // its pixels as last painted
	char *t;        // when its layer's value last changed, and its plane's serial: a plane's next image is only its dirty rectangle
	int64_t serial;
	bool seen;
} Tile;

/** what is to be drawn again: rectangles, which may overlap; past 16, one around them all */
typedef struct Damage {
	BlitRect r[16];
	int n;
} Damage;

typedef struct Display {
	Host *host;
	Blitter *blit;
	int maxw, maxh;
	int front;
	bool waiting;
	int waitBuffer, waitW, waitH;
	ERM_LIST(Drawn) drawn;
	char *whole;
	Damage damage[2];
	bool changed;      // what changed since the last flip, for the metal to copy only that
	BlitRect change;
	bool held;         // a compose that came while a frame waited for its vsync: done after the flip
	int64_t again;     // /dev/display/again, written to compose what was held
	ERM_LIST(Rendered) rendered;
	ERM_LIST(Face *) faces;
	const ErmPartApi *api; // the part running: what fonts' pages are read through
	Json *selection;
	uint32_t mark;
	ErmMap windows;  // a layer's name -> /dev/display/windows/<name> as last written
	ErmMap placed;   // a web page's id -> its size as the metal was last told it shows (webshow)
	ERM_LIST(Surface) surfaces; // windows mode: the Mac windows
	Json *presents;  // windows mode: the pieces packed into the buffer waiting, presented at its vsync
	char *macKey;    // the surface the Mac says is key
	char *asked;     // the surface last asked to be key
	bool layered;    // layers mode (mode.layers): each layer a tile the metal composites
	ERM_LIST(Tile) tiles;
	Json *stack;     // layers mode: the layers command waiting for its vsync
} Display;

typedef struct Theme {
	uint32_t paper, ink, ink2, line, chrome, select;
} Theme;

/** /etc/theme's shadow under every titled layer, in frame buffer pixels: soft, cast by its frame, rounded as its corners are */
typedef struct Shade {
	bool on;
	uint32_t color;
	double opacity, radius, x, y;
	int corner[4]; // top left, top right, bottom right, bottom left
} Shade;

static int64_t whole(const Json *v, int64_t otherwise) {
	int64_t n;
	return jsonIsWhole(v, &n) ? n : otherwise;
}

static uint32_t colour(const Json *theme, const char *key, uint32_t otherwise) {
	Json *v = jsonGet(theme, key);
	return jsonIsNumber(v) ? (uint32_t)v->number : otherwise;
}

static double number(const Json *o, const char *key, double otherwise) {
	Json *v = jsonGet(o, key);
	return jsonIsNumber(v) ? v->number : otherwise;
}

/** the theme's shadow, {color, opacity, radius, x, y} in points, at the screen's unit */
static Shade shadeOf(const Json *theme, int u) {
	Json *s = jsonGet(theme, "shadow");
	if (!jsonIsObject(s)) return (Shade){ 0 };
	Shade sh = { true, colour(s, "color", 0), number(s, "opacity", 0.3), number(s, "radius", 0) * u, number(s, "x", 0) * u, number(s, "y", 0) * u, { 0 } };
	sh.on = sh.opacity > 0;
	return sh;
}

// --- fonts, from /dev/font, read through the part running

static const BlitPage *pageOf(void *data, int n) {
	Face *f = data;
	for (int i = 0; i < f->pages.count; i++) if (f->pages.items[i].n == n) return &f->pages.items[i].page;
	Display *d = f->d;
	if (!d->api) return NULL;
	char p[16];
	snprintf(p, sizeof p, "%d", n);
	Json *v = drvRead(d->api, drvPath("/", "dev", "font", f->role, "pages", p, NULL));
	Json *alpha = jsonGet(v, "alpha"), *info = jsonGet(v, "info");
	if (!v || !alpha || alpha->type != JSON_BYTES || !info || info->type != JSON_TYPED || info->typed.kind != JSON_FLOAT64 || info->typed.count < 1024) {
		// a page not here: asked for once; it draws again when it comes
		for (int i = 0; i < f->wanted.count; i++) if (f->wanted.items[i] == n) return NULL;
		ERM_PUSH(f->wanted, n);
		Json *args = jsonArray();
		jsonPush(args, jsonString(f->role));
		jsonPush(args, jsonInteger(n));
		drvOp(d->api, "call", drvMap("address", drvPath("/", "dev", "font", "driver", "on", "want", NULL), "args", args, NULL));
		return NULL;
	}
	Page page = { n, { (int)whole(jsonGet(v, "w"), 0), alpha->bytes.data, alpha->bytes.length, info->typed.data }, jsonRef(v) };
	ERM_PUSH(f->pages, page);
	return &f->pages.items[f->pages.count - 1].page;
}

static const BlitFont *fontOf(void *data, const char *role) {
	Display *d = data;
	if (!role) return NULL;
	for (int i = 0; i < d->faces.count; i++) if (!strcmp(d->faces.items[i]->role, role)) return &d->faces.items[i]->font;
	if (!d->api) return NULL;
	Json *v = drvRead(d->api, drvPath("/", "dev", "font", role, NULL));
	if (!jsonIsNumber(jsonGet(v, "h")) || !jsonIsNumber(jsonGet(v, "ascent"))) return NULL;
	Face *f = calloc(1, sizeof *f);
	f->role = copyString(role);
	f->d = d;
	f->font = (BlitFont){ (int)jsonGet(v, "h")->number, jsonGet(v, "ascent")->number, f->role, pageOf, f };
	ERM_PUSH(d->faces, f);
	return &f->font;
}

/** the fonts as they now are, a key that changes when one does or a page of one comes; read tracked, in compose's compute */
static char *fontsKey(const ErmPartApi *api) {
	Json *roles = drvNames(api, drvPath("/", "dev", "font", NULL));
	char *key = copyString("");
	for (int i = 0; roles && i < roles->array.count; i++) {
		const char *role = jsonText(roles->array.items[i]);
		Json *v = drvRead(api, drvPath("/", "dev", "font", role, NULL));
		if (!jsonIsNumber(jsonGet(v, "h"))) continue;
		Json *pages = drvNames(api, drvPath("/", "dev", "font", role, "pages", NULL));
		char *list = jsonPrint(pages), *vs = jsonPrint(v);
		char *next = formatString("%s %s %s %s;", key, role, vs, list);
		free(key);
		free(list);
		free(vs);
		key = next;
	}
	return key;
}

// --- the compose compute: everything a frame is made of, read tracked

static ErmErr composeCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	const ErmPartApi *api = g->api;
	Json *layers = jsonArray(), *windows = jsonObject();
	Json *names = drvNames(api, drvPath("/", "dev", "display", "layers", NULL));
	for (int i = 0; names && i < names->array.count; i++) {
		const char *name = jsonText(names->array.items[i]);
		Json *item = drvItem(api, drvPath("/", "dev", "display", "layers", name, NULL));
		Json *l = jsonGet(item, "value");
		// what the layer is and where, for /dev/display/windows
		if (jsonIsObject(l)) {
			Json *window = jsonObject();
			const char *fields[] = { "x", "y", "w", "h", "z", "title", "owner", "collapsed", "hidden", "drags", "want", "chrome" };
			for (size_t k = 0; k < sizeof fields / sizeof *fields; k++)
				if (jsonGet(l, fields[k])) jsonAdd(window, fields[k], jsonShallow(jsonGet(l, fields[k])));
			jsonAdd(windows, name, window);
		}
		Json *hidden = jsonGet(l, "hidden");
		if (!jsonIsObject(l) || whole(jsonGet(l, "w"), 0) <= 0 || whole(jsonGet(l, "h"), 0) <= 0 || (hidden && hidden->type == JSON_BOOLEAN && hidden->boolean)) continue;
		Json *t = jsonGet(jsonGet(item, "change"), "time");
		// a page's newest frame: its plane, at the layer's web, over its ops; a new frame a change of the layer's value
		Json *web = jsonGet(l, "web"), *frame = NULL;
		if (jsonIsObject(web) && jsonText(jsonGet(web, "id")))
			frame = drvRead(api, drvPath("/", "dev", "web", "pages", jsonText(jsonGet(web, "id")), "frame", NULL));
		Json *page = NULL, *when = t ? jsonShallow(t) : jsonInteger(0);
		if (jsonIsObject(frame) && !jsonIsObject(jsonGet(l, "plane"))) {
			page = drvMap("source", jsonString("web"), "id", jsonShallow(jsonGet(frame, "plane")), "serial", jsonShallow(jsonGet(frame, "n")), "x",
			              jsonInteger(whole(jsonGet(web, "x"), 0)), "y", jsonInteger(whole(jsonGet(web, "y"), 0)), "w", jsonInteger(whole(jsonGet(web, "w"), 0)), "h",
			              jsonInteger(whole(jsonGet(web, "h"), 0)), "over", jsonBoolean(true), NULL);
			if (jsonIsObject(jsonGet(frame, "dirty"))) jsonAdd(page, "dirty", jsonShallow(jsonGet(frame, "dirty")));
			Json *both = jsonArray();
			jsonPush(both, when);
			jsonPush(both, jsonShallow(jsonGet(frame, "n")));
			when = both;
		}
		Json *s = drvMap("name", jsonString(name), "t", when, NULL);
		const char *keys[] = { "x", "y", "w", "h", "z", "title", "collapsed", "over", "chrome", "shape", "star" };
		for (size_t k = 0; k < sizeof keys / sizeof *keys; k++)
			if (jsonGet(l, keys[k])) jsonAdd(s, keys[k], jsonShallow(jsonGet(l, keys[k])));
		jsonAdd(s, "draw", jsonBoolean(jsonGet(l, "draw") != NULL));
		if (jsonIsObject(jsonGet(l, "plane"))) jsonAdd(s, "plane", jsonShallow(jsonGet(l, "plane")));
		else if (page) jsonAdd(s, "plane", jsonRef(page));
		if (jsonIsObject(web) && jsonText(jsonGet(web, "id"))) jsonAdd(s, "web", jsonShallow(web));
		jsonPush(layers, jsonRef(s));
	}
	char *fonts = fontsKey(api);
	Json *mode = drvRead(api, drvPath("/", "dev", "display", "mode", NULL));
	Json *focus = drvRead(api, drvPath("/", "dev", "display", "focus", NULL));
	Json *theme = drvRead(api, drvPath("/", "etc", "theme", NULL));
	Json *selection = drvRead(api, drvPath("/", "dev", "display", "selection", NULL));
	(void)drvRead(api, drvPath("/", "dev", "display", "again", NULL)); // read, so a held compose runs after the flip
	*out = drvMap("layers", layers, "windows", windows, "mode", mode ? mode : jsonNull(), "focus", focus ? focus : jsonNull(), "theme", theme ? theme : jsonNull(),
	              "fonts", jsonString(fonts), "selection", selection ? selection : jsonNull(), NULL);
	free(fonts);
	return ermOk();
}

// --- drawing

static BlitRect meet(BlitRect a, BlitRect b) {
	int x0 = a.x > b.x ? a.x : b.x, y0 = a.y > b.y ? a.y : b.y;
	int x1 = a.x + a.w < b.x + b.w ? a.x + a.w : b.x + b.w, y1 = a.y + a.h < b.y + b.h ? a.y + a.h : b.y + b.h;
	return (BlitRect){ x0, y0, x1 > x0 ? x1 - x0 : 0, y1 > y0 ? y1 - y0 : 0 };
}

static BlitRect unite(BlitRect a, BlitRect b) {
	int x0 = a.x < b.x ? a.x : b.x, y0 = a.y < b.y ? a.y : b.y;
	int x1 = a.x + a.w > b.x + b.w ? a.x + a.w : b.x + b.w, y1 = a.y + a.h > b.y + b.h ? a.y + a.h : b.y + b.h;
	return (BlitRect){ x0, y0, x1 - x0, y1 - y0 };
}

static bool meets(BlitRect a, BlitRect b) {
	return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// --- a window's chrome, as data: /etc/theme's window, a layer's chrome over it

/** a window's chrome as it is drawn: /etc/theme's window, the layer's own chrome over it, and when it is not focused their inactive over both; in frame buffer pixels */
typedef struct Chrome {
	const BlitFont *font;
	int border, drop, rule, bevel, tb, room, align, pad, inset, grip;
	int radius[4]; // top left, top right, bottom right, bottom left
	uint32_t line, shade, bar, under, hi, lo, ink;
	bool stripes, boxes;
	int sinset, step, width, count;
	uint32_t stripe;
	int box, binset, gap, plate, edge;
	uint32_t boxline;
	char left[4], right[4]; // its boxes on each side, outermost first: c close, m minimize, i inspect
	bool round;             // its boxes round, each a disc of boxfill (as strong as boxalpha) with its mark drawn in boxline, smooth
	bool raised;            // or raised, as Windows 98's: a square of boxfill, lit above and left, in shadow below and right
	bool bevelled;          // its frame raised, as Windows 98's: filled in line, two lines round it, lit and in shadow
	uint32_t flight, fdark, fhi, flo;
	uint32_t boxfill;
	double boxalpha;
	int stops;              // the title bar a gradient, left to right, when it has two stops or more, each at its place across
	uint32_t ramp[6];
	double rampAt[6];
	double gloss;           // and glossy, as XP's: white over its top half, as strong as this
	bool shaded;            // the title's shadow, a point down, this colour, as soft as a text shadow
	uint32_t tshade;
	int unit;               // pixels a point
	Shade shadow;
} Chrome;

/** where a chrome's fields are found, the first that has one: the inactive looks (the layer's, then the theme's) when it is not focused, the layer's chrome, the theme's window */
typedef struct Looks {
	const Json *at[6];
	int n;
} Looks;

static const Json *field(const Looks *k, const char *part, const char *key) {
	for (int i = 0; i < k->n; i++) {
		const Json *p = part ? jsonGet(k->at[i], part) : k->at[i];
		// a part as a boolean is its on: "stripes": false
		if (p && p->type == JSON_BOOLEAN && !strcmp(key, "on")) return p;
		const Json *v = jsonGet(p, key);
		if (v) return v;
	}
	return NULL;
}

static double amount(const Looks *k, const char *part, const char *key, double otherwise) {
	const Json *v = field(k, part, key);
	return jsonIsNumber(v) && v->number >= 0 ? v->number : otherwise;
}

static bool flag(const Looks *k, const char *part, const char *key, bool otherwise) {
	const Json *v = field(k, part, key);
	return v && v->type == JSON_BOOLEAN ? v->boolean : otherwise;
}

/** a colour: 0xRRGGBB, or the name of one of the theme's */
static uint32_t tint(const Looks *k, const Json *theme, const char *part, const char *key, uint32_t otherwise) {
	const Json *v = field(k, part, key);
	if (jsonIsNumber(v)) return (uint32_t)v->number;
	if (jsonIsString(v)) return colour(theme, jsonText(v), otherwise);
	return otherwise;
}

/** the boxes on a side, outermost first, as their initials */
static void sideOf(const Looks *k, const char *side, const char *otherwise, char out[4]) {
	const Json *v = field(k, "boxes", side);
	int n = 0;
	if (!jsonIsArray(v)) {
		snprintf(out, 4, "%s", otherwise);
		return;
	}
	for (int i = 0; i < v->array.count && n < 3; i++) {
		const char *s = jsonIsString(v->array.items[i]) ? jsonText(v->array.items[i]) : "";
		if (!strcmp(s, "close") || !strcmp(s, "minimize") || !strcmp(s, "inspect")) out[n++] = s[0];
	}
	out[n] = 0;
}

/** a window's chrome: with no /etc/theme window, System 7's, as it always was */
static Chrome chromeOf(Display *d, const Json *theme, const Theme *T, const Json *l, bool on, int u) {
	const Json *mine = jsonGet(l, "chrome"), *all = jsonGet(theme, "window");
	// a star (a layer saying star: true, as the cat clock): /etc/theme's star over its window, where it has one
	const Json *starred = jsonGet(l, "star"), *star = starred && starred->type == JSON_BOOLEAN && starred->boolean ? jsonGet(theme, "star") : NULL;
	Looks k = { { 0 }, 0 };
	if (!on && jsonIsObject(jsonGet(mine, "inactive"))) k.at[k.n++] = jsonGet(mine, "inactive");
	if (!on && jsonIsObject(jsonGet(star, "inactive"))) k.at[k.n++] = jsonGet(star, "inactive");
	if (!on && jsonIsObject(jsonGet(all, "inactive"))) k.at[k.n++] = jsonGet(all, "inactive");
	if (jsonIsObject(mine)) k.at[k.n++] = mine;
	if (jsonIsObject(star)) k.at[k.n++] = star;
	if (jsonIsObject(all)) k.at[k.n++] = all;
	Chrome c = { 0 };
	c.unit = u;
	const Json *role = field(&k, "title", "font");
	c.font = fontOf(d, jsonIsString(role) ? jsonText(role) : "title");
	c.border = (int)(amount(&k, "frame", "width", 1) * u);
	c.drop = (int)(amount(&k, "drop", "size", 1) * u);
	c.rule = (int)(amount(&k, "rule", "width", 1) * u);
	c.bevel = (int)(amount(&k, "bevel", "width", 0) * u);
	const Json *bh = field(&k, "bar", "height");
	c.tb = jsonIsNumber(bh) && bh->number >= 0 ? (int)(bh->number * u) : blitHeight(d->blit, c.font) + (int)(amount(&k, "bar", "pad", 6) * u);
	if (c.tb < c.rule) c.tb = c.rule;
	const Json *r = field(&k, NULL, "radius");
	for (int i = 0; i < 4; i++) {
		const Json *ri = jsonIsArray(r) && r->array.count == 4 ? r->array.items[i] : r;
		c.radius[i] = jsonIsNumber(ri) && ri->number > 0 ? (int)(ri->number * u) : 0;
	}
	c.line = tint(&k, theme, "frame", "color", T->line);
	c.shade = tint(&k, theme, "drop", "color", T->line);
	c.under = tint(&k, theme, "rule", "color", T->line);
	c.bar = tint(&k, theme, "bar", "color", T->chrome);
	c.hi = tint(&k, theme, "bevel", "hi", colour(theme, "hi", 0xffffff));
	c.lo = tint(&k, theme, "bevel", "lo", colour(theme, "lo", 0x808080));
	c.ink = tint(&k, theme, "title", "color", on ? T->ink : T->ink2);
	const Json *al = field(&k, "title", "align");
	c.align = jsonIsString(al) && !strcmp(jsonText(al), "left") ? -1 : jsonIsString(al) && !strcmp(jsonText(al), "right") ? 1 : 0;
	c.room = (int)(amount(&k, "title", "room", 80) * u);
	c.pad = (int)(amount(&k, "title", "pad", 6) * u);
	c.inset = (int)(amount(&k, "title", "inset", 1) * u);
	c.stripes = flag(&k, "stripes", "on", on);
	// frame: {style: "line"} a line all round (the default); "bevel", raised, as Windows 98's, its colours light and
	// dark (the outer line), hi and lo (the inner)
	const Json *fs = field(&k, "frame", "style");
	c.bevelled = jsonIsString(fs) && !strcmp(jsonText(fs), "bevel");
	c.flight = tint(&k, theme, "frame", "light", 0xdfdfdf);
	c.fdark = tint(&k, theme, "frame", "dark", 0x000000);
	c.fhi = tint(&k, theme, "frame", "hi", 0xffffff);
	c.flo = tint(&k, theme, "frame", "lo", 0x808080);
	c.count = (int)amount(&k, "stripes", "count", 0);
	c.step = (int)(amount(&k, "stripes", "step", 2) * u);
	if (c.step < 1) c.step = 1;
	c.width = (int)(amount(&k, "stripes", "width", 1) * u);
	c.sinset = (int)(amount(&k, "stripes", "inset", 3) * u);
	c.stripe = tint(&k, theme, "stripes", "color", T->line);
	c.boxes = flag(&k, "boxes", "on", on);
	const Json *bs = field(&k, "boxes", "size");
	c.box = jsonIsNumber(bs) && bs->number > 0 ? (int)(bs->number * u) : c.tb - 10 * u > 7 ? c.tb - 10 * u : 7;
	c.binset = (int)(amount(&k, "boxes", "inset", 8) * u);
	c.gap = (int)(amount(&k, "boxes", "gap", 6) * u);
	c.plate = (int)(amount(&k, "boxes", "plate", 2) * u);
	c.edge = (int)(amount(&k, "boxes", "line", 1) * u);
	c.boxline = tint(&k, theme, "boxes", "color", T->line);
	sideOf(&k, "left", "c", c.left);
	sideOf(&k, "right", "mi", c.right);
	// "style": "round", Cutefish's and elementary's: a soft disc for each, its mark smooth on it, no plate
	const Json *st = field(&k, "boxes", "style");
	c.round = jsonIsString(st) && !strcmp(jsonText(st), "round");
	c.raised = jsonIsString(st) && !strcmp(jsonText(st), "raised");
	c.boxfill = tint(&k, theme, "boxes", "fill", c.bar);
	c.boxalpha = amount(&k, "boxes", "alpha", 1);
	if (c.round) c.plate = 0;
	// "gradient": colours (or the theme's names for them) across the title bar, left to right, evenly; or
	// [at, colour], at its place (0 the left, 1 the right), as CSS's stops
	const Json *gr = field(&k, "bar", "gradient");
	bool placed = false;
	for (int i = 0; jsonIsArray(gr) && i < gr->array.count && c.stops < 6; i++) {
		const Json *v = gr->array.items[i], *at = NULL;
		if (jsonIsArray(v) && v->array.count == 2 && jsonIsNumber(v->array.items[0])) at = v->array.items[0], v = v->array.items[1];
		if (jsonIsNumber(v)) c.ramp[c.stops] = (uint32_t)v->number;
		else if (jsonIsString(v)) c.ramp[c.stops] = colour(theme, jsonText(v), c.bar);
		else continue;
		c.rampAt[c.stops++] = at ? at->number : -1;
		placed = placed || at;
	}
	for (int i = 0; i < c.stops; i++)
		if (!placed || c.rampAt[i] < 0) c.rampAt[i] = c.stops > 1 ? (double)i / (c.stops - 1) : 0;
	c.gloss = amount(&k, "bar", "gloss", 0);
	// bar: {style}, what the title bar is: "flat", its colour; "pinstripes", System 7's; "gradient", across it;
	// "gloss", the gradient glossy, as XP's. None: pinstripes while stripes are on, else a gradient when it has one
	const Json *barred = field(&k, "bar", "style");
	if (jsonIsString(barred)) {
		const char *style = jsonText(barred);
		c.stripes = !strcmp(style, "pinstripes") && c.stripes;
		if (strcmp(style, "gradient") && strcmp(style, "gloss")) c.stops = 0;
		if (strcmp(style, "gloss")) c.gloss = 0;
	}
	const Json *ts = field(&k, "title", "shadow");
	c.shaded = jsonIsNumber(ts) || jsonIsString(ts);
	c.tshade = tint(&k, theme, "title", "shadow", 0);
	c.grip = (int)(amount(&k, NULL, "grip", 12) * u);
	// the soft shadow: the layer's chrome's (null for none), else /etc/theme's
	c.shadow = shadeOf(mine && jsonGet(mine, "shadow") ? mine : theme, u);
	return c;
}

/**
 * an untitled layer's shape, {radius, shadow?} in points: its corners rounded and, with shadow true (the theme's)
 * or one of its own ({color, opacity, radius, x, y}), a soft shadow under it, as a window's: a dock, a menu, a
 * balloon. As a chrome with no frame, bar or boxes; false when it has none
 */
static bool shapeOf(const Json *l, const Json *theme, int u, Chrome *c) {
	const Json *s = jsonGet(l, "shape");
	if (!jsonIsObject(s)) return false;
	*c = (Chrome){ 0 };
	c->unit = u;
	const Json *r = jsonGet(s, "radius");
	for (int i = 0; i < 4; i++) {
		const Json *ri = jsonIsArray(r) && r->array.count == 4 ? r->array.items[i] : r;
		c->radius[i] = jsonIsNumber(ri) && ri->number > 0 ? (int)(ri->number * u) : 0;
	}
	const Json *sh = jsonGet(s, "shadow");
	if (sh && sh->type == JSON_BOOLEAN && sh->boolean) c->shadow = shadeOf(theme, u);
	else if (jsonIsObject(sh)) c->shadow = shadeOf(s, u);
	return true;
}

/** a window's frame, around its content x, y, w × h and its title bar: its tile is this and its hard shadow, drop down and right */
static BlitRect frameOf(const Chrome *c, int x, int y, int w, int h, bool collapsed) {
	return (BlitRect){ x - c->border, y - c->tb - c->border, w + 2 * c->border, (collapsed ? 0 : h) + c->tb + 2 * c->border };
}

/** where a window w wide has the i-th box on a side, from its content's left */
static int boxAt(const Chrome *c, int w, bool left, int i) {
	return left ? c->binset + i * (c->box + c->gap) : w - c->binset - c->box - i * (c->box + c->gap);
}

// --- smooth marks, drawn into a form's pixels: each pixel mixed with the colour by how much of it is covered

static uint32_t blend(uint32_t under, uint32_t over, double a) {
	if (a <= 0) return under & 0xffffff;
	if (a >= 1) return over & 0xffffff;
	uint32_t out = 0;
	for (int k = 16; k >= 0; k -= 8) out |= (uint32_t)(((under >> k) & 255) * (1 - a) + ((over >> k) & 255) * a + 0.5) << k;
	return out;
}

/** a pixel of fb inside clip, or NULL */
static uint32_t *pixelAt(BlitForm *fb, const BlitRect *clip, int x, int y) {
	if (!fb->bits || x < 0 || y < 0 || x >= fb->w || y >= fb->h) return NULL;
	if (clip && (x < clip->x || y < clip->y || x >= clip->x + clip->w || y >= clip->y + clip->h)) return NULL;
	return &fb->bits[(size_t)y * (size_t)fb->stride + (size_t)x];
}

/** a disc of radius r about cx, cy (a pixel's centre is at its corner and a half), its edge smooth, as strong as alpha */
static void disc(BlitForm *fb, const BlitRect *clip, double cx, double cy, double r, uint32_t colour, double alpha) {
	for (int y = (int)floor(cy - r - 1); y <= (int)ceil(cy + r + 1); y++)
		for (int x = (int)floor(cx - r - 1); x <= (int)ceil(cx + r + 1); x++) {
			uint32_t *p = pixelAt(fb, clip, x, y);
			double a = r + 0.5 - hypot(x + 0.5 - cx, y + 0.5 - cy);
			if (p && a > 0) *p = blend(*p, colour, (a > 1 ? 1 : a) * alpha);
		}
}

/** a stroke from x0, y0 to x1, y1, width across, its ends round, smooth */
static void stroke(BlitForm *fb, const BlitRect *clip, double x0, double y0, double x1, double y1, double width, uint32_t colour) {
	double hw = width / 2, dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
	for (int y = (int)floor(fmin(y0, y1) - hw - 1); y <= (int)ceil(fmax(y0, y1) + hw + 1); y++)
		for (int x = (int)floor(fmin(x0, x1) - hw - 1); x <= (int)ceil(fmax(x0, x1) + hw + 1); x++) {
			uint32_t *p = pixelAt(fb, clip, x, y);
			if (!p) continue;
			double px = x + 0.5, py = y + 0.5, t = len2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
			t = t < 0 ? 0 : t > 1 ? 1 : t;
			double a = hw + 0.5 - hypot(px - (x0 + t * dx), py - (y0 + t * dy));
			if (a > 0) *p = blend(*p, colour, a);
		}
}

/** a title bar x, y, w × h in its gradient, left to right, and its gloss, as XP's: white over its top half, fading, and a little at its foot */
static void ramp(BlitForm *fb, const BlitRect *clip, int x, int y, int w, int h, const Chrome *c) {
	for (int i = 0; i < w; i++) {
		double t = w > 1 ? (double)i / (w - 1) : 0;
		int k = 0;
		while (k < c->stops - 2 && t > c->rampAt[k + 1]) k++;
		double span = c->rampAt[k + 1] - c->rampAt[k], f = span > 0 ? (t - c->rampAt[k]) / span : 0;
		uint32_t across = blend(c->ramp[k], c->ramp[k + 1], f < 0 ? 0 : f > 1 ? 1 : f);
		for (int j = 0; j < h; j++) {
			uint32_t *p = pixelAt(fb, clip, x + i, y + j);
			if (!p) continue;
			double v = h > 1 ? (double)j / (h - 1) : 0;
			double g = v < 0.46 ? 0.5 - 0.35 * v / 0.46 : v < 0.52 ? 0.15 * (0.52 - v) / 0.06 : 0.1 * (v - 0.52) / 0.48;
			*p = blend(across, 0xffffff, g * c->gloss / 0.5);
		}
	}
}

/** a title's soft shadow, a point down: its coverage, blurred a point, the colour mixed in by up to a half */
static void soften(Display *d, BlitForm *fb, const BlitRect *clip, int tx, int ty, int tw, const char *title, const Chrome *c, int u) {
	int pad = 2 * u, w = tw + 2 * pad, h = blitHeight(d->blit, c->font) + 2 * pad;
	if (w <= 0 || h <= 0) return;
	BlitForm m = blitForm(w, h, 0);
	BlitRect all = { 0, 0, w, h };
	blitText(d->blit, &m, pad, pad, title, 0xffffff, NULL, &all, c->font);
	for (int y = 0; y < h; y++)
		for (int x = 0; x < w; x++) {
			int sum = 0, n = 0;
			for (int j = -u; j <= u; j++)
				for (int i = -u; i <= u; i++, n++)
					if (x + i >= 0 && y + j >= 0 && x + i < w && y + j < h) sum += (int)(m.bits[(size_t)(y + j) * (size_t)m.stride + (size_t)(x + i)] & 255);
			uint32_t *p = pixelAt(fb, clip, tx - pad + x, ty - pad + y + u);
			if (p && sum) *p = blend(*p, c->tshade, 0.5 * sum / n / 255.0);
		}
	free(m.bits);
}

/** a round box's mark, on its disc about cx, cy of radius r: close a cross, minimize a bar, inspect an i */
static void mark(BlitForm *fb, const BlitRect *clip, char kind, double cx, double cy, double r, double L, uint32_t ink) {
	double k = r * 0.3;
	if (kind == 'c') {
		stroke(fb, clip, cx - k, cy - k, cx + k, cy + k, L, ink);
		stroke(fb, clip, cx + k, cy - k, cx - k, cy + k, L, ink);
	} else if (kind == 'm') stroke(fb, clip, cx - k * 1.15, cy, cx + k * 1.15, cy, L, ink);
	else if (kind == 'i') {
		disc(fb, clip, cx, cy - k * 1.3, L * 0.62, ink, 1);
		stroke(fb, clip, cx, cy - k * 0.25, cx, cy + k * 1.2, L, ink);
	}
}

/** a window's chrome, as /etc/theme's window says (System 7's by default): a frame, its hard shadow, the title bar, pinstriped while focused, its title on a plate, its boxes */
static void chrome(Display *d, BlitForm *fb, const BlitRect *clip, const Chrome *c, const Json *l) {
	int x = (int)whole(jsonGet(l, "x"), 0), y = (int)whole(jsonGet(l, "y"), 0), w = (int)whole(jsonGet(l, "w"), 0), lh = (int)whole(jsonGet(l, "h"), 0);
	Json *col = jsonGet(l, "collapsed");
	bool collapsed = col && col->type == JSON_BOOLEAN && col->boolean;
	const char *title = jsonText(jsonGet(l, "title"));
	int B = c->border, D = c->drop, R = c->rule, tb = c->tb, h = (collapsed ? 0 : lh) + tb + 2 * B;
	Json *over = jsonGet(l, "over");
	if (over && over->type == JSON_BOOLEAN && over->boolean) {
		// what it draws has holes: the frame's line under them
		if (D) blitFill(fb, x - B + D, y - tb - B + D, w + 2 * B, h, c->shade, clip); // the hard shadow, down and right
		blitFill(fb, x - B, y - tb - B, w + 2 * B, h, c->line, clip);                 // the frame
	} else {
		// only their edges: the title bar and what it draws cover the rest
		if (D) {
			blitFill(fb, x + w + B, y - tb - B + D, D, h, c->shade, clip); // the hard shadow, down and right
			blitFill(fb, x - B + D, y - tb - B + h, w + 2 * B, D, c->shade, clip);
		}
		if (B) {
			blitFill(fb, x - B, y - tb - B, w + 2 * B, B, c->line, clip); // the frame
			blitFill(fb, x - B, y - tb - B, B, h, c->line, clip);
			blitFill(fb, x + w, y - tb - B, B, h, c->line, clip);
			blitFill(fb, x - B, y - tb - 2 * B + h, w + 2 * B, B, c->line, clip);
		}
	}
	if (c->bevelled && B) {
		// raised: the frame's line filling it, then a line round it lit above and left and dark below and right,
		// and inside that another, a point each
		BlitRect f = { x - B, y - tb - B, w + 2 * B, h };
		int L = c->unit;
		for (int k = 0; k < 2 && 2 * k * L < B; k++) {
			BlitRect e = { f.x + k * L, f.y + k * L, f.w - 2 * k * L, f.h - 2 * k * L };
			uint32_t lit = k ? c->fhi : c->flight, dark = k ? c->flo : c->fdark;
			blitFill(fb, e.x, e.y, e.w, L, lit, clip);
			blitFill(fb, e.x, e.y, L, e.h, lit, clip);
			blitFill(fb, e.x, e.y + e.h - L, e.w, L, dark, clip);
			blitFill(fb, e.x + e.w - L, e.y, L, e.h, dark, clip);
		}
	}
	if (c->stops >= 2) ramp(fb, clip, x, y - tb, w, tb - R, c);
	else blitFill(fb, x, y - tb, w, tb - R, c->bar, clip);
	if (R) blitFill(fb, x, y - R, w, R, c->under, clip); // under the title bar
	if (c->bevel) {
		int V = c->bevel;
		blitFill(fb, x, y - R - V, w, V, c->lo, clip);
		blitFill(fb, x + w - V, y - tb, V, tb - R, c->lo, clip);
		blitFill(fb, x, y - tb, w, V, c->hi, clip);
		blitFill(fb, x, y - tb, V, tb - R, c->hi, clip);
	}
	// the title between the boxes, a pad from them, and at least room / 2 from either end: in the middle when it
	// fits there, else as near it as it can be, as elementary's are; cut short when even that is too narrow
	int nl = c->boxes ? (int)strlen(c->left) : 0, nr = c->boxes ? (int)strlen(c->right) : 0;
	int lw = nl ? c->binset + nl * c->box + (nl - 1) * c->gap + 2 * c->pad : 0, rw = nr ? c->binset + nr * c->box + (nr - 1) * c->gap + 2 * c->pad : 0;
	int lo = x + (lw > c->room / 2 ? lw : c->room / 2), hi = x + w - (rw > c->room / 2 ? rw : c->room / 2);
	int tw = blitMeasure(d->blit, title ? title : "", c->font);
	if (tw > hi - lo) tw = hi - lo > 0 ? hi - lo : 0;
	int tx = c->align < 0 ? lo : c->align > 0 ? hi - tw : x + (w - tw) / 2;
	if (tx < lo) tx = lo;
	if (tx + tw > hi) tx = hi - tw;
	int ty = y - tb + (tb - R - blitHeight(d->blit, c->font)) / 2;
	if (c->stripes) {
		int n = 0;
		for (int py = y - tb + c->sinset; py < y - c->sinset && (c->count <= 0 || n < c->count); py += c->step, n++)
			blitFill(fb, x + c->sinset, py, w - 2 * c->sinset, c->width, c->stripe, clip);
		blitFill(fb, tx - c->pad, y - tb + c->inset, tw + 2 * c->pad, tb - R - 2 * c->inset, c->bar, clip); // the title's plate
	}
	if (c->boxes) {
		int box = c->box, by = y - tb + (tb - R - box) / 2, P = c->plate, L = c->edge;
		for (int s = 0; s < 2; s++) {
			const char *side = s ? c->right : c->left;
			int n = (int)strlen(side);
			if (!n) continue;
			// one plate under a side's boxes
			int a = boxAt(c, w, !s, s ? n - 1 : 0), b = boxAt(c, w, !s, s ? 0 : n - 1);
			if (P) blitFill(fb, x + a - P, by - P, b - a + box + 2 * P, box + 2 * P, c->bar, clip);
			for (int i = 0; i < n; i++) {
				int bx = x + boxAt(c, w, !s, i);
				if (c->round) {
					disc(fb, clip, bx + box / 2.0, by + box / 2.0, box / 2.0, c->boxfill, c->boxalpha);
					mark(fb, clip, side[i], bx + box / 2.0, by + box / 2.0, box / 2.0, L, c->boxline);
					continue;
				}
				if (c->raised) {
					// a button: its face, lit above and left, dark below and right, a point each, twice; its mark on it
					int U = c->unit;
					blitFill(fb, bx, by, box, box, c->boxfill, clip);
					for (int k = 0; k < 2; k++) {
						int ex = bx + k * U, ey = by + k * U, ew = box - 2 * k * U;
						uint32_t lit = k ? c->flight : c->fhi, dark = k ? c->flo : c->fdark;
						blitFill(fb, ex, ey, ew, U, lit, clip);
						blitFill(fb, ex, ey, U, ew, lit, clip);
						blitFill(fb, ex, ey + ew - U, ew, U, dark, clip);
						blitFill(fb, ex + ew - U, ey, U, ew, dark, clip);
					}
					double cx = bx + box / 2.0 - U / 2.0, cy = by + box / 2.0 - U / 2.0, r = box / 2.0 - 2 * U;
					if (side[i] == 'm') blitFill(fb, (int)(cx - r * 0.55), (int)(cy + r * 0.45), (int)(r * 1.1), 2 * U, c->boxline, clip);
					else mark(fb, clip, side[i], cx, cy, r * 1.25, L, c->boxline);
					continue;
				}
				for (int e = 0; e < L; e++) blitFrame(fb, bx + e, by + e, box - 2 * e, box - 2 * e, c->boxline, clip);
				// minimize, as System 7.5's windowshade box: a bar across it; inspect, Get Info's i (programs/inspect)
				if (side[i] == 'm') blitFill(fb, bx, by + (box - L) / 2, box, L, c->boxline, clip);
				if (side[i] == 'i') {
					blitFill(fb, bx + (box - L) / 2, by + 2 * L, L, L, c->boxline, clip);
					blitFill(fb, bx + (box - L) / 2, by + 4 * L, L, box - 6 * L, c->boxline, clip);
				}
			}
		}
	}
	BlitRect at = meet((BlitRect){ tx, y - tb, tw, tb }, *clip);
	if (c->shaded) {
		BlitRect bar = meet((BlitRect){ x, y - tb, w, tb - R }, *clip);
		soften(d, fb, &bar, tx, ty, tw, title ? title : "", c, c->unit);
	}
	blitText(d->blit, fb, tx, ty, title ? title : "", c->ink, NULL, &at, c->font);
}

static Json *rectJson(int x, int y, int w, int h) {
	return drvMap("x", jsonInteger(x), "y", jsonInteger(y), "w", jsonInteger(w), "h", jsonInteger(h), NULL);
}

/** where a window's chrome is, from its content's top left, for the window manager's clicks: its frame, title bar, each box (on its plate) and grip */
static Json *partsOf(const Chrome *c, int w, int h, bool collapsed) {
	BlitRect f = frameOf(c, 0, 0, w, h, collapsed);
	Json *p = drvMap("frame", rectJson(f.x, f.y, f.w, f.h), "bar", rectJson(0, -c->tb, w, c->tb), NULL);
	int by = -c->tb + (c->tb - c->rule - c->box) / 2;
	for (int s = 0; c->boxes && s < 2; s++) {
		const char *side = s ? c->right : c->left;
		for (int i = 0; side[i]; i++)
			jsonAdd(p, side[i] == 'c' ? "close" : side[i] == 'm' ? "minimize" : "inspect", jsonRef(rectJson(boxAt(c, w, !s, i) - c->plate, by - c->plate, c->box + 2 * c->plate, c->box + 2 * c->plate)));
	}
	jsonAdd(p, "grip", jsonRef(rectJson(w - c->grip, (collapsed ? 0 : h) - c->grip, c->grip, c->grip)));
	return p;
}

// --- rounded corners, stepped: a pixel is in when its centre is

static Json *cornersJson(const int r[4]) {
	Json *a = jsonArray();
	for (int q = 0; q < 4; q++) jsonPush(a, jsonInteger(r[q]));
	return a;
}

/** how many pixels of row k, from a corner's edge, are outside its curve of radius r */
static int notch(int r, int k) {
	if (k < 0 || k >= r) return 0;
	double dy = r - (k + 0.5), n = r - sqrt((double)r * r - dy * dy) - 0.5;
	return n > 0 ? (int)ceil(n) : 0;
}

/** whether pixel x, y is in b with its corners rounded r (top left, top right, bottom right, bottom left) */
static bool rounded(BlitRect b, const int r[4], int x, int y) {
	if (x < b.x || y < b.y || x >= b.x + b.w || y >= b.y + b.h) return false;
	int i = x - b.x, j = y - b.y, ri = b.x + b.w - 1 - x, bj = b.y + b.h - 1 - y;
	return !(i < notch(r[0], j) || ri < notch(r[1], j) || ri < notch(r[2], bj) || i < notch(r[3], bj));
}

/** a chrome's corners on a frame, none past half its side; false when it has none */
static bool radii(const Chrome *c, BlitRect frame, int out[4]) {
	int most = (frame.w < frame.h ? frame.w : frame.h) / 2;
	bool any = false;
	for (int i = 0; i < 4; i++) {
		out[i] = c->radius[i] < most ? c->radius[i] : most > 0 ? most : 0;
		any = any || out[i] > 0;
	}
	return any;
}

/** the pixels about a window's corners before it is drawn: its tile's top and bottom rows, as far as its corners reach */
typedef struct Under {
	BlitRect box;
	int top, bottom;
	uint32_t *bits;
} Under;

static Under underOf(const BlitForm *fb, BlitRect box, const int r[4], int drop) {
	Under s = { box, (r[0] > r[1] ? r[0] : r[1]) + drop, (r[2] > r[3] ? r[2] : r[3]) + drop, NULL };
	if (s.top > box.h) s.top = box.h;
	if (s.bottom > box.h) s.bottom = box.h;
	s.bits = calloc((size_t)box.w * (size_t)(s.top + s.bottom) + 1, 4);
	for (int j = 0; j < s.top + s.bottom; j++) {
		int y = j < s.top ? box.y + j : box.y + box.h - s.bottom + (j - s.top);
		for (int x = box.x; x < box.x + box.w; x++)
			if (x >= 0 && y >= 0 && x < fb->w && y < fb->h) s.bits[(size_t)j * (size_t)box.w + (size_t)(x - box.x)] = fb->bits[(size_t)y * (size_t)fb->stride + (size_t)x];
	}
	return s;
}

static uint32_t underAt(const Under *s, int x, int y) {
	int j = y - s->box.y < s->top ? y - s->box.y : s->top + (y - (s->box.y + s->box.h - s->bottom));
	return s->bits[(size_t)j * (size_t)s->box.w + (size_t)(x - s->box.x)];
}

/**
 * a window's rounded corners, once its chrome and content are drawn: about each corner a pixel outside
 * its frame, rounded, and outside its hard shadow (the frame moved down and right), is what was under it
 * (back), or none in a tile; one in the frame but outside the curve a border in from it, the frame's line;
 * one outside the frame and in the hard shadow, the shadow's colour
 */
static void corners(BlitForm *fb, const BlitRect *clip, BlitRect frame, const int r[4], const Chrome *c, const Under *back) {
	int B = c->border, D = c->drop, ri[4];
	for (int i = 0; i < 4; i++) ri[i] = r[i] > B ? r[i] - B : 0;
	BlitRect box = { frame.x, frame.y, frame.w + D, frame.h + D }, inner = { frame.x + B, frame.y + B, frame.w - 2 * B, frame.h - 2 * B };
	BlitRect drop = { frame.x + D, frame.y + D, frame.w, frame.h }, area = meet(meet(box, *clip), (BlitRect){ 0, 0, fb->w, fb->h });
	for (int q = 0; q < 4; q++) {
		if (!r[q]) continue;
		int k = r[q] + D;
		BlitRect sq = meet((BlitRect){ q == 0 || q == 3 ? box.x : box.x + box.w - k, q < 2 ? box.y : box.y + box.h - k, k, k }, area);
		for (int y = sq.y; y < sq.y + sq.h; y++)
			for (int x = sq.x; x < sq.x + sq.w; x++) {
				uint32_t *p = &fb->bits[(size_t)y * (size_t)fb->stride + (size_t)x];
				if (rounded(frame, r, x, y)) {
					if (B && !rounded(inner, ri, x, y)) *p = c->line;
				} else if (D && rounded(drop, r, x, y)) *p = c->shade;
				else *p = back ? underAt(back, x, y) : BLIT_TRANSPARENT;
			}
	}
}

static bool differs(const uint32_t *shown, const BlitForm *f, int w, int h, BlitRect *out);

/**
 * where two draw lists differ, when the second is a splice of the first (as a window that draws
 * again only what changed writes it): the ops the same at either end are the same values (json.h),
 * so only the ops between, the first's and the second's, drew anything different, and *out is
 * around all of them, inside a w × h form. False when no op is kept, or one's bounds are not known
 */
static bool spliced(Display *d, const Json *was, const Json *now, int w, int h, BlitRect *out) {
	int n0 = was->array.count, n1 = now->array.count, p = 0, q = 0;
	while (p < n0 && p < n1 && was->array.items[p] == now->array.items[p]) p++;
	while (q < n0 - p && q < n1 - p && was->array.items[n0 - 1 - q] == now->array.items[n1 - 1 - q]) q++;
	if (!p && !q) return false;
	BlitRect all = { 0 };
	bool any = false;
	for (int k = 0; k < 2; k++) {
		const Json *ops = k ? now : was;
		for (int i = p; i < ops->array.count - q; i++) {
			BlitRect b;
			if (!blitOpBox(d->blit, ops->array.items[i], fontOf, d, &b)) return false;
			if (b.w <= 0 || b.h <= 0) continue;
			all = any ? unite(all, b) : b;
			any = true;
		}
	}
	*out = any ? meet(all, (BlitRect){ 0, 0, w, h }) : (BlitRect){ 0 };
	return true;
}

/** where a layer's text went, written to /dev/display/text/<name> when it changed */
static void said(Display *d, const ErmPartApi *api, Rendered *r, const char *name, Json *runs) {
	(void)d;
	char *text = jsonPrint(runs);
	if (r->runs && !strcmp(r->runs, text)) {
		free(text);
		jsonFree(runs);
		return;
	}
	free(r->runs);
	r->runs = text;
	Json *at = drvPath("/", "dev", "display", "text", name, NULL);
	if (drvHas(api, at)) drvSnap(api, at, runs);
	else {
		char *id = formatString("display/text/%s", name);
		drvMake(api, drvPath("/", "dev", "display", "text", NULL), name, id, runs);
		free(id);
	}
}

/** a plane's pixels copied into a form, as 0x00RRGGBB: a plane may carry an alpha byte (WebKit's are
 *  0xFF), which a GPU layer's key reads, 0xFF000000 being clear there, so a page's black would vanish */
static void planeCopy(BlitForm *dst, int x, int y, const BlitForm *src, int sx, int sy, int w, int h) {
	blitBlit(dst, x, y, src, sx, sy, w, h, BLIT_COPY, NULL);
	int x0 = x < 0 ? 0 : x, y0 = y < 0 ? 0 : y, x1 = x + w > dst->w ? dst->w : x + w, y1 = y + h > dst->h ? dst->h : y + h;
	for (int j = y0; j < y1; j++)
		for (int i = x0; i < x1; i++) dst->bits[j * dst->stride + i] &= 0x00ffffff;
}

/** a layer's pixels: its ops played into a form of its own, kept until they, the fonts or the selection change; part, when not NULL, the only rectangle of its plane that changed since it was last played, all that is copied */
static BlitForm *render(Display *d, const ErmPartApi *api, const Json *l, const char *look, const BlitRect *part) {
	const char *name = jsonText(jsonGet(l, "name"));
	int w = (int)whole(jsonGet(l, "w"), 0), h = (int)whole(jsonGet(l, "h"), 0);
	Json *v = drvRead(api, drvPath("/", "dev", "display", "layers", name, NULL));
	Rendered *r = NULL;
	for (int i = 0; i < d->rendered.count && !r; i++) if (!strcmp(d->rendered.items[i].name, name)) r = &d->rendered.items[i];
	if (r) r->seen = true;
	if (!v) return r ? &r->form : NULL;
	// what it draws, apart from where it is: the same ops and pixels are the same values, so a layer moved or raised is not played again
	const Json *ops0 = jsonGet(v, "draw"), *pixels0 = jsonGet(v, "pixels"), *ov = jsonGet(v, "over");
	char *pt = jsonGet(l, "plane") ? jsonPrint(jsonGet(l, "plane")) : copyString("");
	char *rest = formatString("%p %s %d %d %d %s", (const void *)pixels0, pt, ov && ov->type == JSON_BOOLEAN && ov->boolean, w, h, look);
	char *key = formatString("%p %s", (const void *)ops0, rest);
	free(pt);
	if (r && !strcmp(r->key, key)) {
		free(key);
		free(rest);
		r->delta = (BlitRect){ 0 }, r->fresh = false;
		return &r->form;
	}
	// only a rectangle of its plane changed: that alone copied into the form it has. A plane is at its
	// x, y in the layer (a page's, at its web), at most w × h, under the ops, or over them (a page's)
	Json *plane = jsonGet(l, "plane"), *po = jsonGet(plane, "over");
	HostPlane hp;
	bool planed = jsonIsObject(plane) && hostPlane(d->host, jsonText(jsonGet(plane, "source")), whole(jsonGet(plane, "id"), -1), &hp) && hp.bits;
	int px = planed ? (int)whole(jsonGet(plane, "x"), 0) : 0, py = planed ? (int)whole(jsonGet(plane, "y"), 0) : 0;
	int pw = planed ? (int)whole(jsonGet(plane, "w"), hp.w) : 0, ph = planed ? (int)whole(jsonGet(plane, "h"), hp.h) : 0;
	if (planed) {
		if (pw > hp.w) pw = hp.w;
		if (ph > hp.h) ph = hp.h;
		if (pw > w - px) pw = w - px;
		if (ph > h - py) ph = h - py;
	}
	bool above = po && po->type == JSON_BOOLEAN && po->boolean;
	if (r && part && planed && r->form.w == w && r->form.h == h && r->draw == ops0 && r->pixels == pixels0) {
		BlitRect c = meet(*part, (BlitRect){ 0, 0, pw, ph });
		BlitForm src = { hp.w, hp.h, hp.stride, (uint32_t *)hp.bits, NULL };
		planeCopy(&r->form, px + c.x, py + c.y, &src, c.x, c.y, c.w, c.h);
		c.x += px, c.y += py;
		free(r->key);
		r->key = key;
		free(r->rest);
		r->rest = rest;
		r->n++;
		r->delta = c, r->fresh = false;
		return &r->form;
	}
	// its ops a splice of the last, all else the same: only where the ops between drew played again, into the form it has
	const char *sl = jsonText(jsonGet(d->selection, "layer"));
	BlitRect damage;
	if (r && r->rest && !strcmp(r->rest, rest) && !pixels0 && !planed && r->form.bits && r->form.w == w && r->form.h == h && !(sl && !strcmp(sl, name)) &&
	    jsonIsArray(ops0) && jsonIsArray(r->draw) && spliced(d, r->draw, ops0, w, h, &damage)) {
		if (damage.w && damage.h) {
			blitFill(&r->form, damage.x, damage.y, damage.w, damage.h, ov && ov->type == JSON_BOOLEAN && ov->boolean ? BLIT_TRANSPARENT : 0, NULL);
			said(d, api, r, name, blitPlayIn(d->blit, &r->form, ops0, fontOf, d, NULL, d->mark, &damage));
		}
		free(r->key);
		r->key = key;
		free(r->rest);
		r->rest = rest;
		r->n++;
		jsonFree((Json *)r->draw);
		r->draw = jsonRef((Json *)ops0);
		r->delta = damage, r->fresh = false;
		return &r->form;
	}
	// played again, it is compared with what it was: where they differ is all that changed
	BlitForm old = { 0 };
	if (!r) {
		ERM_PUSH(d->rendered, ((Rendered){ .name = copyString(name), .key = NULL, .seen = true }));
		r = &d->rendered.items[d->rendered.count - 1];
	} else {
		old = r->form;
		free(r->key);
		free(r->rest);
	}
	r->key = key;
	r->rest = rest;
	r->n++;
	jsonFree((Json *)r->draw);
	r->draw = jsonRef((Json *)ops0), r->pixels = pixels0;
	Json *over = jsonGet(l, "over");
	r->form = blitForm(w, h, over && over->type == JSON_BOOLEAN && over->boolean ? BLIT_TRANSPARENT : 0);
	Json *pixels = jsonGet(v, "pixels");
	if (pixels && pixels->type == JSON_TYPED && (pixels->typed.kind == JSON_UINT32 || pixels->typed.kind == JSON_INT32) && pixels->typed.count >= (size_t)(w * h)) {
		BlitForm src = { w, h, w, pixels->typed.data, NULL };
		blitBlit(&r->form, 0, 0, &src, 0, 0, w, h, BLIT_COPY, NULL);
	}
	// a plane: pixels in a driver's memory (hostPlane), copied here, so the driver may change them once this returns
	BlitForm src = planed ? (BlitForm){ hp.w, hp.h, hp.stride, (uint32_t *)hp.bits, NULL } : (BlitForm){ 0 };
	if (planed && !above && pw > 0 && ph > 0) planeCopy(&r->form, px, py, &src, 0, 0, pw, ph);
	Json *ops = jsonGet(v, "draw");
	if (jsonIsArray(ops)) {
		const char *on = jsonText(jsonGet(d->selection, "layer"));
		const Json *marks = on && !strcmp(on, name) ? jsonGet(d->selection, "ranges") : NULL;
		// where its text went, for whoever reads, selects or speaks it
		said(d, api, r, name, blitPlay(d->blit, &r->form, ops, fontOf, d, marks, d->mark));
	}
	if (planed && above && pw > 0 && ph > 0) planeCopy(&r->form, px, py, &src, 0, 0, pw, ph);
	r->fresh = !old.bits || old.w != w || old.h != h;
	if (!r->fresh && !differs(old.bits, &r->form, w, h, &r->delta)) r->delta = (BlitRect){ 0 };
	free(old.bits);
	return &r->form;
}

static int cmpZ(const void *a, const void *b) {
	double za = jsonGet(*(Json *const *)a, "z") ? jsonGet(*(Json *const *)a, "z")->number : 0;
	double zb = jsonGet(*(Json *const *)b, "z") ? jsonGet(*(Json *const *)b, "z")->number : 0;
	return za < zb ? -1 : za > zb;
}

/** a map's keys, entries and index (its values are not its own) */
static void mapFree(ErmMap *m) {
	for (int i = 0; i < m->count; i++) free((void *)m->entries[i].key);
	free(m->entries);
	free(m->index);
	*m = (ErmMap){ 0 };
}

/**
 * web pages: each one's size, as a layer shows it, told the metal when it
 * changes (webshow), so it draws at that size; w 0 for one no layer shows
 * (hidden, collapsed, in another view, gone), which draws nothing
 */
static void shows(Display *d, Json *layers) {
	ErmMap seen = { 0 };
	for (int i = 0; jsonIsArray(layers) && i < layers->array.count; i++) {
		Json *l = layers->array.items[i], *web = jsonGet(l, "web"), *col = jsonGet(l, "collapsed");
		const char *id = jsonText(jsonGet(web, "id"));
		if (!id || (col && col->type == JSON_BOOLEAN && col->boolean)) continue;
		int w = (int)whole(jsonGet(web, "w"), 0), h = (int)whole(jsonGet(web, "h"), 0);
		if (w <= 0 || h <= 0) continue;
		ermMapPut(&seen, id, (void *)1);
		char *key = formatString("%d %d", w, h), *was = ermMapGet(&d->placed, id);
		if (was && !strcmp(was, key)) {
			free(key);
			continue;
		}
		hostCommand(d->host, drvMap("op", jsonString("webshow"), "id", jsonString(id), "w", jsonInteger(w), "h", jsonInteger(h), NULL));
		free(was);
		ermMapPut(&d->placed, id, key);
	}
	for (int i = 0; i < d->placed.count; i++) {
		const char *id = d->placed.entries[i].key;
		if (!d->placed.entries[i].value || ermMapHas(&seen, id)) continue;
		hostCommand(d->host, drvMap("op", jsonString("webshow"), "id", jsonString(id), "w", jsonInteger(0), "h", jsonInteger(0), NULL));
		free(d->placed.entries[i].value);
		ermMapPut(&d->placed, id, NULL);
	}
	mapFree(&seen);
}


/** layers gone, or in windows mode untitled, out of sight: their forms, and their runs */
static void forget(Display *d, const ErmPartApi *api, Json *layers, bool windows) {
	int n = layers ? layers->array.count : 0;
	int k = 0;
	for (int i = 0; i < d->rendered.count; i++) {
		Rendered *r = &d->rendered.items[i];
		bool still = false;
		for (int j = 0; j < n && !still; j++)
			still = !strcmp(jsonText(jsonGet(layers->array.items[j], "name")), r->name) && (!windows || jsonIsString(jsonGet(layers->array.items[j], "title")));
		if (still) {
			d->rendered.items[k++] = *r;
			continue;
		}
		char *id = formatString("display/text/%s", r->name);
		if (drvHas(api, drvPath("/", "dev", "display", "text", r->name, NULL)))
			drvOp(api, "unplace", drvMap("address", drvPath("/", "dev", "display", "text", NULL), "name", jsonString(r->name), "id", jsonString(id), NULL));
		free(id);
		free(r->form.bits);
		free(r->name);
		free(r->key);
		free(r->rest);
		free(r->runs);
		jsonFree((Json *)r->draw);
	}
	d->rendered.count = k;
}

// --- windows mode: each titled layer a Mac window, presented where it changed

/** the rectangle a w × h form differs in from what was shown; false when it does not */
static bool differs(const uint32_t *shown, const BlitForm *f, int w, int h, BlitRect *out) {
	int y0 = -1, y1 = -1, x0 = w, x1 = 0;
	for (int y = 0; y < h; y++) {
		const uint32_t *a = shown + (size_t)y * (size_t)w, *b = f->bits + (size_t)y * (size_t)f->stride;
		if (!memcmp(a, b, (size_t)w * 4)) continue;
		if (y0 < 0) y0 = y;
		y1 = y;
		int l = 0, r = w - 1;
		while (a[l] == b[l]) l++;
		while (a[r] == b[r]) r--;
		if (l < x0) x0 = l;
		if (r + 1 > x1) x1 = r + 1;
	}
	if (y0 < 0) return false;
	*out = (BlitRect){ x0, y0, x1 - x0, y1 - y0 + 1 };
	return true;
}

static Surface *surfaceOf(Display *d, const char *name) {
	for (int i = 0; i < d->surfaces.count; i++) if (!strcmp(d->surfaces.items[i].name, name)) return &d->surfaces.items[i];
	return NULL;
}

/** what a surface command says of a layer: where, how big and its title, as the metal is told it */
static char *geoOf(Display *d, int x, int y, int w, int h, const char *title) {
	return formatString("%d %d %d %d %s", x, y, w < d->maxw ? w : d->maxw, h < d->maxh ? h : d->maxh, title);
}

static void surfaceCommand(Display *d, const char *name, int x, int y, int w, int h, const char *title, bool key) {
	Json *c = drvMap("op", jsonString("surface"), "id", jsonString(name), "x", jsonInteger(x), "y", jsonInteger(y), "w", jsonInteger(w < d->maxw ? w : d->maxw),
	                 "h", jsonInteger(h < d->maxh ? h : d->maxh), "title", jsonString(title), NULL);
	if (key) jsonAdd(c, "key", jsonBoolean(true));
	hostCommand(d->host, c);
}

static void surfaceFree(Surface *s) {
	free(s->name);
	free(s->geo);
	free(s->shown);
}

/** every surface forgotten, as the metal closes them going back to the monitor; a present waiting is dropped */
static void unsurfaceAll(Display *d) {
	for (int i = 0; i < d->surfaces.count; i++) surfaceFree(&d->surfaces.items[i]);
	d->surfaces.count = 0;
	free(d->macKey);
	free(d->asked);
	d->macKey = d->asked = NULL;
	if (d->presents) {
		jsonFree(d->presents);
		d->presents = NULL;
		d->waiting = false;
		hostCommand(d->host, drvMap("op", jsonString("vsync"), "on", jsonBoolean(false), NULL));
	}
}

/**
 * a frame in windows mode: a surface for each titled layer, told again when
 * it moves, resizes or is retitled; what changed in each since it was last
 * presented, packed side by side into the back buffer, to present at the
 * next vsync; surfaces whose layer went, closed
 */
static void windowsCompose(Display *d, const ErmPartApi *api, Json *layers, const char *focus, const char *fonts) {
	int n = layers ? layers->array.count : 0;
	Json **sorted = malloc(sizeof *sorted * (size_t)(n ? n : 1));
	for (int i = 0; i < n; i++) sorted[i] = layers->array.items[i];
	qsort(sorted, (size_t)n, sizeof *sorted, cmpZ);
	for (int i = 0; i < d->surfaces.count; i++) d->surfaces.items[i].seen = false;
	int back = 1 - d->front;
	BlitForm fb = { d->maxw, d->maxh, d->maxw, hostConfig(d->host)->buffers[back], NULL };
	Json *presents = jsonArray();
	int sx = 0, sy = 0, rowH = 0;
	for (int i = 0; i < n; i++) {
		Json *l = sorted[i];
		const char *title = jsonText(jsonGet(l, "title"));
		if (!jsonIsString(jsonGet(l, "title"))) continue;
		const char *name = jsonText(jsonGet(l, "name"));
		int x = (int)whole(jsonGet(l, "x"), 0), y = (int)whole(jsonGet(l, "y"), 0), w = (int)whole(jsonGet(l, "w"), 0), h = (int)whole(jsonGet(l, "h"), 0);
		Surface *s = surfaceOf(d, name);
		if (!s) {
			ERM_PUSH(d->surfaces, ((Surface){ .name = copyString(name) }));
			s = &d->surfaces.items[d->surfaces.count - 1];
		}
		s->seen = true;
		char *geo = geoOf(d, x, y, w, h, title);
		if (!s->geo || strcmp(s->geo, geo)) {
			surfaceCommand(d, name, x, y, w, h, title, false);
			free(s->geo);
			s->geo = geo;
		} else free(geo);
		const char *on = jsonText(jsonGet(d->selection, "layer"));
		char *sel = on && !strcmp(on, name) ? jsonPrint(jsonGet(d->selection, "ranges")) : copyString("");
		char *look = formatString("%s %s", fonts ? fonts : "", sel);
		free(sel);
		BlitForm *form = render(d, api, l, look, NULL);
		free(look);
		if (!form) continue;
		w = form->w < d->maxw ? form->w : d->maxw;
		h = form->h < d->maxh ? form->h : d->maxh;
		if (s->w != w || s->h != h) {
			free(s->shown);
			s->shown = NULL;
			s->w = w, s->h = h;
		}
		// a form not played again is as it was presented, but for pieces that found no room
		Rendered *made = NULL;
		for (int k = 0; k < d->rendered.count && !made; k++) if (!strcmp(d->rendered.items[k].name, name)) made = &d->rendered.items[k];
		if (s->shown && made->n == s->n) continue;
		BlitRect r = { 0, 0, w, h };
		if (s->shown && !differs(s->shown, form, w, h, &r)) {
			s->n = made->n;
			continue;
		}
		if (sx + r.w > d->maxw) sx = 0, sy += rowH, rowH = 0;
		if (sy + r.h > d->maxh) {
			// no room this frame: presented in the next
			d->held = true;
			continue;
		}
		blitBlit(&fb, sx, sy, form, r.x, r.y, r.w, r.h, BLIT_COPY, NULL);
		s->n = made->n;
		if (!s->shown) s->shown = malloc((size_t)w * (size_t)h * 4);
		for (int row = r.y; row < r.y + r.h; row++)
			memcpy(s->shown + (size_t)row * (size_t)w + r.x, form->bits + (size_t)row * (size_t)form->stride + r.x, (size_t)r.w * 4);
		jsonPush(presents, jsonRef(drvMap("id", jsonString(name), "sx", jsonInteger(sx), "sy", jsonInteger(sy),
		                                  "dirty", drvMap("x", jsonInteger(r.x), "y", jsonInteger(r.y), "w", jsonInteger(r.w), "h", jsonInteger(r.h), NULL), NULL)));
		sx += r.w;
		if (r.h > rowH) rowH = r.h;
	}
	free(sorted);
	// layers gone, hidden or untitled: their Mac windows close
	int k = 0;
	for (int i = 0; i < d->surfaces.count; i++) {
		Surface *s = &d->surfaces.items[i];
		if (s->seen) {
			d->surfaces.items[k++] = *s;
			continue;
		}
		hostCommand(d->host, drvMap("op", jsonString("unsurface"), "id", jsonString(s->name), NULL));
		// closed, it is key no more: one that comes back (minimized, restored) with the focus is made key again
		if (d->macKey && !strcmp(d->macKey, s->name)) {
			free(d->macKey);
			d->macKey = NULL;
		}
		if (d->asked && !strcmp(d->asked, s->name)) {
			free(d->asked);
			d->asked = NULL;
		}
		surfaceFree(s);
	}
	d->surfaces.count = k;
	// the focus moved here (a new window, a key of the window manager's): the Mac's key window follows
	Surface *f = focus ? surfaceOf(d, focus) : NULL;
	if (f && (!d->macKey || strcmp(d->macKey, focus)) && (!d->asked || strcmp(d->asked, focus))) {
		for (int i = 0; i < n; i++) {
			Json *l = layers->array.items[i];
			if (strcmp(jsonText(jsonGet(l, "name")), focus)) continue;
			surfaceCommand(d, focus, (int)whole(jsonGet(l, "x"), 0), (int)whole(jsonGet(l, "y"), 0), (int)whole(jsonGet(l, "w"), 0), (int)whole(jsonGet(l, "h"), 0),
			               jsonText(jsonGet(l, "title")), true);
		}
		free(d->asked);
		d->asked = copyString(focus);
	}
	if (!presents->array.count) {
		jsonFree(presents);
		return;
	}
	d->presents = presents;
	d->waiting = true;
	d->waitBuffer = back;
	hostCommand(d->host, drvMap("op", jsonString("vsync"), "on", jsonBoolean(true), NULL));
}

// --- the full-frame path's soft shadows and damage

/** a Gaussian's share of [a, b], sigma s: how much of a blurred edge covers a point */
static double within(double a, double b, double s) {
	return s <= 0 ? (a <= 0 && b > 0) : 0.5 * (erf(b / (s * sqrt(2))) - erf(a / (s * sqrt(2))));
}

/** where a shadow cast by frame falls: its blur's reach, three sigmas and a pixel, around the frame offset */
static BlitRect shadowRect(BlitRect frame, const Shade *sh) {
	double s = sh->radius / 2, x0 = frame.x + sh->x, y0 = frame.y + sh->y;
	int reach = (int)ceil(3 * s) + 1, xa = (int)floor(x0) - reach, ya = (int)floor(y0) - reach;
	return (BlitRect){ xa, ya, (int)ceil(x0 + frame.w + reach) - xa, (int)ceil(y0 + frame.h + reach) - ya };
}

/**
 * what a frame's rounded corners do not cast, at pixel x, y: each corner's
 * notched rows (notch), blurred as the frame is; x0, y0 where the frame is,
 * offset, w × h its size, s the sigma. headless.c's is the same
 */
static double notched(const int r[4], double x0, double y0, int w, int h, double s, int x, int y) {
	double sum = 0, px = x + 0.5, py = y + 0.5, reach = 3 * s + 1;
	for (int q = 0; q < 4; q++) {
		if (r[q] <= 0) continue;
		bool left = q == 0 || q == 3, top = q < 2;
		double cx = left ? x0 : x0 + w, cy = top ? y0 : y0 + h;
		if (fabs(px - cx) > r[q] + reach || fabs(py - cy) > r[q] + reach) continue;
		for (int k = 0; k < r[q]; k++) {
			int n = notch(r[q], k);
			if (!n) break;
			double ya = top ? y0 + k : y0 + h - 1 - k, xa = left ? x0 : x0 + w - n;
			sum += within(ya - py, ya + 1 - py, s) * within(xa - px, xa + n - px, s);
		}
	}
	return sum;
}

/**
 * a soft shadow cast by frame, blended into what is drawn: the frame offset
 * and blurred (a Gaussian, sigma half the radius), as Core Animation casts a
 * tile's in layers mode and headless.c stacks it, so the two paths show the
 * same. Its mask is two profiles, across and down, one number a column and
 * a row; under frame itself, which what is drawn next covers, nothing is
 * blended unless holes says it has some
 */
static void shadow(BlitForm *fb, const BlitRect *clip, BlitRect frame, const Shade *sh, bool holes) {
	double s = sh->radius / 2, x0 = frame.x + sh->x, y0 = frame.y + sh->y;
	BlitRect r = meet(meet(shadowRect(frame, sh), *clip), (BlitRect){ 0, 0, fb->w, fb->h });
	if (r.w <= 0 || r.h <= 0) return;
	double *across = malloc(sizeof *across * (size_t)r.w);
	for (int x = r.x; x < r.x + r.w; x++) across[x - r.x] = within(x0 - (x + 0.5), x0 + frame.w - (x + 0.5), s);
	uint32_t c = sh->color;
	bool cut = sh->corner[0] || sh->corner[1] || sh->corner[2] || sh->corner[3];
	for (int y = r.y; y < r.y + r.h; y++) {
		double down = sh->opacity * within(y0 - (y + 0.5), y0 + frame.h - (y + 0.5), s);
		uint32_t *row = fb->bits + (size_t)y * (size_t)fb->stride;
		bool under = !holes && y >= frame.y && y < frame.y + frame.h;
		// a rounded frame's corners do not cover what is under them: cast there too
		int ca = 0, cb = 0, t = y - frame.y, bt = frame.y + frame.h - 1 - y;
		if (under) {
			if (t < sh->corner[0]) ca = sh->corner[0];
			if (bt < sh->corner[3] && sh->corner[3] > ca) ca = sh->corner[3];
			if (t < sh->corner[1]) cb = sh->corner[1];
			if (bt < sh->corner[2] && sh->corner[2] > cb) cb = sh->corner[2];
		}
		for (int x = r.x; x < r.x + r.w; x++) {
			if (under && x >= frame.x + ca && x < frame.x + frame.w - cb) {
				x = frame.x + frame.w - cb - 1;
				continue;
			}
			double a = down * across[x - r.x];
			if (cut) {
				a -= sh->opacity * notched(sh->corner, x0, y0, frame.w, frame.h, s, x, y);
				if (a < 0) a = 0;
			}
			uint32_t p = row[x];
			int rr = (int)(((p >> 16) & 255) * (1 - a) + ((c >> 16) & 255) * a + 0.5), g = (int)(((p >> 8) & 255) * (1 - a) + ((c >> 8) & 255) * a + 0.5),
			    b = (int)((p & 255) * (1 - a) + (c & 255) * a + 0.5);
			row[x] = (uint32_t)(rr << 16 | g << 8 | b);
		}
	}
	free(across);
}

static bool inside(BlitRect a, BlitRect b) {
	return a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
}

/** a rectangle to draw again; past 16, one around them all */
static void damageAdd(Damage *dm, BlitRect r) {
	if (r.w <= 0 || r.h <= 0) return;
	for (int i = 0; i < dm->n; i++)
		if (inside(r, dm->r[i])) return;
	if (dm->n == 16) {
		for (int i = 1; i < dm->n; i++) dm->r[0] = unite(dm->r[0], dm->r[i]);
		dm->n = 1;
	}
	dm->r[dm->n++] = r;
}

/** what of a is not in b, as up to four rectangles: where a moved layer was and is no more */
static void damageLess(Damage *dm, BlitRect a, BlitRect b) {
	BlitRect m = meet(a, b);
	if (m.w <= 0 || m.h <= 0) {
		damageAdd(dm, a);
		return;
	}
	damageAdd(dm, (BlitRect){ a.x, a.y, a.w, m.y - a.y });
	damageAdd(dm, (BlitRect){ a.x, m.y + m.h, a.w, a.y + a.h - m.y - m.h });
	damageAdd(dm, (BlitRect){ a.x, m.y, m.x - a.x, m.h });
	damageAdd(dm, (BlitRect){ m.x + m.w, m.y, a.x + a.w - m.x - m.w, m.h });
}

// --- layers mode: each layer a tile, stacked, moved and shadowed by the metal, painted where it changed

static Tile *tileOf(Display *d, const char *name) {
	for (int i = 0; i < d->tiles.count; i++) if (!strcmp(d->tiles.items[i].name, name)) return &d->tiles.items[i];
	return NULL;
}

static void tileFree(Tile *t) {
	free(t->name);
	free(t->geo);
	free(t->key);
	free(t->rest);
	free(t->t);
	free(t->form.bits);
}

/** every tile forgotten, as the metal empties its stack leaving the monitor; a command waiting is dropped */
static void unlayerAll(Display *d) {
	for (int i = 0; i < d->tiles.count; i++) tileFree(&d->tiles.items[i]);
	d->tiles.count = 0;
	if (d->stack) {
		jsonFree(d->stack);
		d->stack = NULL;
		d->waiting = false;
		hostCommand(d->host, drvMap("op", jsonString("vsync"), "on", jsonBoolean(false), NULL));
	}
}

/** a layer as its chrome is drawn into its tile: at x, y there; its other values are the layer's, lent */
static Json *lentAt(const Json *l, int x, int y) {
	Json *m = jsonObject();
	for (int k = 0; k < l->object.count; k++) {
		const char *mk = l->object.members[k].key;
		if (strcmp(mk, "x") && strcmp(mk, "y")) jsonAdd(m, mk, l->object.members[k].value);
	}
	jsonAdd(m, "x", jsonInteger(x));
	jsonAdd(m, "y", jsonInteger(y));
	return m;
}

static void lentFree(Json *m) {
	for (int k = 0; k < m->object.count; k++) {
		if (!strcmp(m->object.members[k].key, "x") || !strcmp(m->object.members[k].key, "y")) jsonFree(m->object.members[k].value);
		free(m->object.members[k].key);
	}
	free(m->object.members);
	free(m);
}

/**
 * a frame in layers mode: each layer a tile, its chrome and content in one
 * form; where it is, its depth and its shadow told when they change, with no
 * pixels; what changed in its form since it was last painted packed beside
 * the others into the back buffer, painted at the next vsync in the same
 * command. So a window dragged is told where, a caret blinking paints a
 * caret, and tiles whose layer went are dropped
 */
static void layersCompose(Display *d, const ErmPartApi *api, Json *layers, const char *focus, const char *fonts, const char *look, const Json *theme, const Theme *T, int u) {
	int n = layers ? layers->array.count : 0;
	Json **sorted = malloc(sizeof *sorted * (size_t)(n ? n : 1));
	for (int i = 0; i < n; i++) sorted[i] = layers->array.items[i];
	qsort(sorted, (size_t)n, sizeof *sorted, cmpZ);
	for (int i = 0; i < d->tiles.count; i++) d->tiles.items[i].seen = false;
	int back = 1 - d->front;
	BlitForm fb = { d->maxw, d->maxh, d->maxw, hostConfig(d->host)->buffers[back], NULL };
	Json *set = jsonArray(), *drop = jsonArray();
	int sx = 0, sy = 0, rowH = 0;
	for (int i = 0; i < n; i++) {
		Json *l = sorted[i];
		const char *name = jsonText(jsonGet(l, "name"));
		int x = (int)whole(jsonGet(l, "x"), 0), y = (int)whole(jsonGet(l, "y"), 0), w = (int)whole(jsonGet(l, "w"), 0), h = (int)whole(jsonGet(l, "h"), 0);
		double z = jsonIsNumber(jsonGet(l, "z")) ? jsonGet(l, "z")->number : 0;
		Json *col = jsonGet(l, "collapsed"), *over = jsonGet(l, "over");
		bool collapsed = col && col->type == JSON_BOOLEAN && col->boolean, titled = jsonIsString(jsonGet(l, "title")), on = focus && !strcmp(focus, name);
		// the tile: a window's frame, title bar and hard shadow (System 7's, a point down and right), around its content, as its chrome says
		Chrome ch = { 0 };
		bool shaped = false;
		if (titled) ch = chromeOf(d, theme, T, l, on, u);
		else shaped = shapeOf(l, theme, u, &ch);
		BlitRect frame = titled ? frameOf(&ch, x, y, w, h, collapsed) : (BlitRect){ x, y, w, h };
		int rad[4] = { 0 };
		bool curved = (titled || shaped) && radii(&ch, frame, rad);
		BlitRect box = { frame.x, frame.y, frame.w + ch.drop, frame.h + ch.drop }, inner = { 0, 0, frame.w, frame.h };
		if (box.w > d->maxw) box.w = d->maxw;
		if (box.h > d->maxh) box.h = d->maxh;
		Tile *t = tileOf(d, name);
		if (!t) {
			ERM_PUSH(d->tiles, ((Tile){ .name = copyString(name), .serial = -1 }));
			t = &d->tiles.items[d->tiles.count - 1];
		}
		t->seen = true;
		// a plane's next image, with dirty: only that rectangle copied into its content
		char *when = jsonPrint(jsonGet(l, "t"));
		Json *plane = jsonGet(l, "plane"), *pd = jsonGet(plane, "dirty");
		int64_t serial = whole(jsonGet(plane, "serial"), -1);
		int64_t dx = whole(jsonGet(pd, "x"), -1), dy = whole(jsonGet(pd, "y"), -1), dw = whole(jsonGet(pd, "w"), -1), dh = whole(jsonGet(pd, "h"), -1);
		bool part = t->t && strcmp(t->t, when) && serial >= 0 && serial == t->serial + 1 && dx >= 0 && dy >= 0 && dw >= 0 && dh >= 0;
		BlitRect at = { (int)dx, (int)dy, (int)dw, (int)dh };
		free(t->t);
		t->t = when;
		t->serial = serial;
		const char *sl = jsonText(jsonGet(d->selection, "layer"));
		char *sel = sl && !strcmp(sl, name) ? jsonPrint(jsonGet(d->selection, "ranges")) : copyString("");
		char *drawn = formatString("%s %s", fonts ? fonts : "", sel);
		free(sel);
		BlitForm *form = render(d, api, l, drawn, part ? &at : NULL);
		free(drawn);
		if (!form) continue;
		Rendered *made = NULL;
		for (int k = 0; k < d->rendered.count && !made; k++) if (!strcmp(d->rendered.items[k].name, name)) made = &d->rendered.items[k];
		char *title = jsonPrint(jsonGet(l, "title")), *own = jsonPrint(jsonGet(l, "chrome")), *shape = jsonPrint(jsonGet(l, "shape"));
		char *rest = formatString("%d %d %d %d %d %s %s %s %s", box.w, box.h, titled, on, collapsed, title, own ? own : "", shape ? shape : "", look);
		free(shape);
		char *key = formatString("%lld %s", (long long)made->n, rest);
		free(title);
		free(own);
		// its form made again when what it holds or its chrome changed: painted where it differs from the last
		bool paint = false, waits = false;
		BlitRect r = { 0, 0, box.w, box.h };
		bool opaque = !(over && over->type == JSON_BOOLEAN && over->boolean);
		if (t->key && strcmp(t->key, key) && t->rest && !strcmp(t->rest, rest) && made->n == t->n + 1 && !made->fresh && opaque && !collapsed && t->form.bits &&
		    t->form.w == box.w && t->form.h == box.h) {
			// only what it holds changed, once, where its render says: that alone copied into the tile it has, and painted
			int cx = titled ? ch.border : 0, cy = titled ? ch.tb + ch.border : 0;
			BlitRect c = made->delta;
			r = meet((BlitRect){ cx + c.x, cy + c.y, c.w, c.h }, meet((BlitRect){ cx, cy, form->w, form->h }, (BlitRect){ 0, 0, box.w, box.h }));
			paint = r.w > 0 && r.h > 0;
			if (paint && sx + r.w > d->maxw) sx = 0, sy += rowH, rowH = 0;
			if (paint && sy + r.h > d->maxh) {
				// no room this frame: painted in the next, the tile as it was
				d->held = true;
				paint = false;
				free(key);
				free(rest);
			} else {
				if (paint) {
					blitBlit(&t->form, r.x, r.y, form, r.x - cx, r.y - cy, r.w, r.h, BLIT_COPY, NULL);
					if (curved) corners(&t->form, &r, inner, rad, &ch, NULL);
					blitBlit(&fb, sx, sy, &t->form, r.x, r.y, r.w, r.h, BLIT_COPY, NULL);
				}
				free(t->key);
				t->key = key;
				free(t->rest);
				t->rest = rest;
				t->n = made->n;
			}
		} else if (!t->key || strcmp(t->key, key)) {
			BlitForm next = blitForm(box.w, box.h, BLIT_TRANSPARENT);
			BlitRect clip = { 0, 0, box.w, box.h };
			int cx = titled ? ch.border : 0, cy = titled ? ch.tb + ch.border : 0;
			if (titled) {
				Json *lent = lentAt(l, cx, cy);
				chrome(d, &next, &clip, &ch, lent);
				lentFree(lent);
			}
			if (!collapsed) blitBlit(&next, cx, cy, form, 0, 0, form->w, form->h, over && over->type == JSON_BOOLEAN && over->boolean ? BLIT_OVER : BLIT_COPY, &clip);
			if (curved) corners(&next, &clip, inner, rad, &ch, NULL);
			paint = !t->form.bits || t->form.w != box.w || t->form.h != box.h || differs(t->form.bits, &next, box.w, box.h, &r);
			if (paint && sx + r.w > d->maxw) sx = 0, sy += rowH, rowH = 0;
			if (paint && sy + r.h > d->maxh) {
				// no room this frame: made again and painted in the next
				d->held = true;
				paint = false;
				waits = t->form.w != box.w || t->form.h != box.h;
				free(next.bits);
				free(key);
				free(rest);
			} else {
				if (paint) blitBlit(&fb, sx, sy, &next, r.x, r.y, r.w, r.h, BLIT_COPY, NULL);
				free(t->form.bits);
				t->form = next;
				free(t->key);
				t->key = key;
				free(t->rest);
				t->rest = rest;
				t->n = made->n;
			}
		} else {
			free(key);
			free(rest);
		}
		Shade S = ch.shadow;
		memcpy(S.corner, rad, sizeof rad);
		char *geo = formatString("%d %d %d %d %g %d %u %g %g %g %g %d %d %d %d %d", box.x, box.y, box.w, box.h, z, (titled || shaped) && S.on, S.color, S.opacity, S.radius, S.x, S.y, rad[0], rad[1],
		                         rad[2], rad[3], ch.drop);
		// resized, it is told so with its new pixels, never before them
		bool moved = !waits && (!t->geo || strcmp(t->geo, geo));
		if (!moved && !paint) {
			free(geo);
			continue;
		}
		Json *item = drvMap("id", jsonString(name), NULL);
		if (moved) {
			jsonAdd(item, "x", jsonInteger(box.x));
			jsonAdd(item, "y", jsonInteger(box.y));
			jsonAdd(item, "w", jsonInteger(box.w));
			jsonAdd(item, "h", jsonInteger(box.h));
			jsonAdd(item, "z", jsonNumber(z));
			// a window's soft shadow, cast by its frame (the tile less the hard shadow), as /etc/theme's shadow says, in points
			if ((titled || shaped) && S.on) {
				Json *sh = drvMap("color", jsonInteger(S.color), "opacity", jsonNumber(S.opacity), "radius", jsonNumber(S.radius), "x", jsonNumber(S.x), "y", jsonNumber(S.y), "box",
				                  drvMap("x", jsonInteger(0), "y", jsonInteger(0), "w", jsonInteger(box.w - ch.drop), "h", jsonInteger(box.h - ch.drop), NULL), NULL);
				if (curved) jsonAdd(sh, "corners", cornersJson(rad));
				jsonAdd(item, "shadow", jsonRef(sh));
			} else jsonAdd(item, "shadow", jsonNull());
			// its rounded corners: only its frame, rounded, and that again drop down and right, is shown
			if (curved)
				jsonAdd(item, "shape", jsonRef(drvMap("box", drvMap("x", jsonInteger(0), "y", jsonInteger(0), "w", jsonInteger(box.w - ch.drop), "h", jsonInteger(box.h - ch.drop), NULL), "corners",
				                                      cornersJson(rad), "drop", jsonInteger(ch.drop), NULL)));
			free(t->geo);
			t->geo = geo;
		} else free(geo);
		if (paint) {
			jsonAdd(item, "paint", jsonRef(drvMap("sx", jsonInteger(sx), "sy", jsonInteger(sy), "x", jsonInteger(r.x), "y", jsonInteger(r.y), "w", jsonInteger(r.w), "h", jsonInteger(r.h), NULL)));
			sx += r.w;
			if (r.h > rowH) rowH = r.h;
		}
		jsonPush(set, jsonRef(item));
	}
	free(sorted);
	// layers gone or hidden: dropped
	int k = 0;
	for (int i = 0; i < d->tiles.count; i++) {
		Tile *t = &d->tiles.items[i];
		if (t->seen) {
			d->tiles.items[k++] = *t;
			continue;
		}
		jsonPush(drop, jsonString(t->name));
		tileFree(t);
	}
	d->tiles.count = k;
	if (!set->array.count && !drop->array.count) {
		jsonFree(set);
		jsonFree(drop);
		return;
	}
	d->stack = jsonRef(drvMap("op", jsonString("layers"), "buffer", jsonInteger(back), "set", set, "drop", drop, NULL));
	d->waiting = true;
	d->waitBuffer = back;
	hostCommand(d->host, drvMap("op", jsonString("vsync"), "on", jsonBoolean(true), NULL));
}

static ErmErr composeEffect(void *data, const ErmGiven *g, Json **out) {
	Display *d = data;
	*out = jsonNull();
	const Json *v = g->value;
	Json *mode = jsonGet(v, "mode");
	if (!jsonIsObject(mode)) return ermOk();
	d->api = g->api;
	// what draws: the fonts and the selection as they are now
	for (int i = 0; i < d->faces.count; i++) {
		Face *f = d->faces.items[i];
		for (int k = 0; k < f->pages.count; k++) jsonFree(f->pages.items[k].value);
		free(f->pages.items), free(f->wanted.items), free(f->role), free(f);
	}
	d->faces.count = 0;
	jsonFree(d->selection);
	d->selection = jsonRef(jsonGet(v, "selection"));
	Json *themeJ = jsonGet(v, "theme");
	Theme T = { colour(themeJ, "paper", 0xfdf8ea), colour(themeJ, "ink", 0x2a2228), colour(themeJ, "ink2", 0x6b5a66),
	            colour(themeJ, "line", 0x1c1a17), colour(themeJ, "chrome", 0xece5d4), colour(themeJ, "select", 0xffff88) };
	d->mark = T.select;
	int u = (int)whole(jsonGet(mode, "unit"), 1);
	if (u < 1) u = 1;
	int W = (int)whole(jsonGet(mode, "w"), d->maxw), H = (int)whole(jsonGet(mode, "h"), d->maxh);
	if (W > d->maxw) W = d->maxw;
	if (H > d->maxh) H = d->maxh;
	BlitRect screen = { 0, 0, W, H };
	const char *focus = jsonText(jsonGet(v, "focus"));
	const char *fonts = jsonText(jsonGet(v, "fonts"));
	Json *layers = jsonGet(v, "layers");
	int n = layers ? layers->array.count : 0;
	Json *wm = jsonGet(mode, "windows"), *lm = jsonGet(mode, "layers");
	bool windowsMode = wm && wm->type == JSON_BOOLEAN && wm->boolean;
	d->layered = !windowsMode && lm && lm->type == JSON_BOOLEAN && lm->boolean;
	shows(d, layers);
	// each window, /dev/display/windows/<name>, as it is, when it changed; on the monitor each titled one with where its chrome's parts are, for clicks
	Json *all = jsonGet(v, "windows");
	ErmMap seen = { 0 };
	for (int i = 0; jsonIsObject(all) && i < all->object.count; i++) {
		const char *name = all->object.members[i].key;
		Json *wl = all->object.members[i].value, *col = jsonGet(wl, "collapsed"), *m = wl;
		bool titled = !windowsMode && jsonIsString(jsonGet(wl, "title"));
		// written as it is (a hold of this turn's) or, titled, a copy with its chrome's parts
		if (!titled) m = jsonRef(wl);
		else {
			Chrome ch = chromeOf(d, themeJ, &T, wl, true, u);
			m = jsonShallow(wl);
			jsonAdd(m, "parts", jsonRef(partsOf(&ch, (int)whole(jsonGet(wl, "w"), 0), (int)whole(jsonGet(wl, "h"), 0), col && col->type == JSON_BOOLEAN && col->boolean)));
		}
		ermMapPut(&seen, name, (void *)1);
		char *text = jsonPrint(m), *was = ermMapGet(&d->windows, name);
		if (was && !strcmp(was, text)) {
			// unchanged: the copy made here is scratch, its values the compute's
			free(text);
			jsonFree(m);
			continue;
		}
		Json *at = drvPath("/", "dev", "display", "windows", name, NULL);
		if (drvHas(g->api, at)) drvSnap(g->api, at, m);
		else {
			char *id = formatString("display/windows/%s", name);
			drvMake(g->api, drvPath("/", "dev", "display", "windows", NULL), name, id, m);
			free(id);
		}
		free(was);
		ermMapPut(&d->windows, name, text);
	}
	// layers gone: their windows
	for (int i = 0; i < d->windows.count; i++) {
		const char *name = d->windows.entries[i].key;
		if (!d->windows.entries[i].value || ermMapHas(&seen, name)) continue;
		char *id = formatString("display/windows/%s", name);
		drvOp(g->api, "unplace", drvMap("address", drvPath("/", "dev", "display", "windows", NULL), "name", jsonString(name), "id", jsonString(id), NULL));
		free(id);
		free(d->windows.entries[i].value);
		ermMapPut(&d->windows, name, NULL);
	}
	mapFree(&seen);
	// one frame a refresh: while one waits for its vsync, this is held, and composed once it is flipped
	if (d->waiting) {
		d->held = true;
		d->api = NULL;
		return ermOk();
	}
	if (windowsMode) {
		windowsCompose(d, g->api, layers, focus, fonts);
		forget(d, g->api, layers, true);
		// the monitor, when it comes back, is drawn whole: the buffers held windows meanwhile
		free(d->whole);
		d->whole = NULL;
		d->api = NULL;
		return ermOk();
	}
	if (d->layered) {
		char *themeText = jsonPrint(themeJ);
		char *look = formatString("%d %s %s", u, themeText, fonts ? fonts : "");
		free(themeText);
		layersCompose(d, g->api, layers, focus, fonts, look, themeJ, &T, u);
		free(look);
		forget(d, g->api, layers, false);
		// the frame buffer, should the metal stop stacking, is drawn whole: the buffers held pieces of tiles meanwhile
		free(d->whole);
		d->whole = NULL;
		d->api = NULL;
		return ermOk();
	}

	// what changed since the last frame: only that is drawn again
	Damage dirty = { 0 };
	char *themeText = jsonPrint(themeJ);
	char *wholeKey = formatString("%d %d %d %s %s", W, H, u, themeText, fonts ? fonts : "");
	free(themeText);
	if (!d->whole || strcmp(d->whole, wholeKey)) damageAdd(&dirty, screen);
	free(d->whole);
	d->whole = wholeKey;
	ERM_LIST(Drawn) now = { 0 };
	for (int i = 0; i < n; i++) {
		Json *l = layers->array.items[i];
		const char *name = jsonText(jsonGet(l, "name"));
		int x = (int)whole(jsonGet(l, "x"), 0), y = (int)whole(jsonGet(l, "y"), 0), w = (int)whole(jsonGet(l, "w"), 0), h = (int)whole(jsonGet(l, "h"), 0);
		Json *col = jsonGet(l, "collapsed");
		bool collapsed = col && col->type == JSON_BOOLEAN && col->boolean;
		bool titled = jsonIsString(jsonGet(l, "title"));
		Chrome ch = titled ? chromeOf(d, themeJ, &T, l, focus && !strcmp(focus, name), u) : (Chrome){ 0 };
		BlitRect frame = titled ? frameOf(&ch, x, y, w, h, collapsed) : (BlitRect){ x, y, w, h };
		BlitRect rect = { frame.x, frame.y, frame.w + ch.drop, frame.h + ch.drop };
		// a titled one's soft shadow is its too
		if (titled && ch.shadow.on) rect = unite(rect, shadowRect(frame, &ch.shadow));
		// what it is and where, apart from when its value changed and its plane's serial
		char *lj = copyString(""), *t = jsonPrint(jsonGet(l, "t"));
		for (int k = 0; k < l->object.count; k++) {
			const char *mk = l->object.members[k].key;
			if (!strcmp(mk, "t") || !strcmp(mk, "plane")) continue;
			char *mv = jsonPrint(l->object.members[k].value), *next = formatString("%s %s=%s", lj, mk, mv);
			free(mv);
			free(lj);
			lj = next;
		}
		Json *plane = jsonGet(l, "plane");
		char *ps = jsonPrint(jsonGet(plane, "source")), *pi = jsonPrint(jsonGet(plane, "id")), *pj = formatString("%s %s", ps ? ps : "", pi ? pi : "");
		free(ps);
		free(pi);
		const char *on = jsonText(jsonGet(d->selection, "layer"));
		char *sel = on && !strcmp(on, name) ? jsonPrint(jsonGet(d->selection, "ranges")) : copyString("");
		char *key = formatString("%s %s %d %s %s", lj, pj, focus && !strcmp(focus, name), sel, fonts ? fonts : "");
		free(lj);
		free(pj);
		free(sel);
		Drawn dn = { copyString(name), rect, key, t, whole(jsonGet(plane, "serial"), -1), false, { 0 } };
		Drawn *was = NULL;
		for (int k = 0; k < d->drawn.count && !was; k++) if (!strcmp(d->drawn.items[k].name, name)) was = &d->drawn.items[k];
		if (!was || strcmp(was->key, key)) {
			// moved, only where it was and is no more beside where it is
			damageAdd(&dirty, rect);
			if (was) damageLess(&dirty, was->rect, rect);
		} else if (strcmp(was->t, t)) {
			// its value changed: a plane's next image, with dirty, is only that rectangle; anything else all of it.
			// A layer with ops too (Paint's) has them played over its plane: one changing them writes no dirty
			Json *pd = jsonGet(plane, "dirty");
			int64_t dx = whole(jsonGet(pd, "x"), -1), dy = whole(jsonGet(pd, "y"), -1), dw = whole(jsonGet(pd, "w"), -1), dh = whole(jsonGet(pd, "h"), -1);
			BlitRect r = collapsed ? (BlitRect){ 0 } : (BlitRect){ x, y, w, h };
			if (dn.serial >= 0 && dn.serial == was->serial + 1 && dx >= 0 && dy >= 0 && dw >= 0 && dh >= 0) {
				dn.part = true;
				dn.at = (BlitRect){ (int)dx, (int)dy, (int)dw, (int)dh };
				// in the layer, at the plane's place
				int px = (int)whole(jsonGet(plane, "x"), 0), py = (int)whole(jsonGet(plane, "y"), 0);
				r = meet((BlitRect){ x + px + (int)dx, y + py + (int)dy, (int)dw, (int)dh }, (BlitRect){ x, y, w, h });
			} else if (!collapsed) {
				// what it draws changed (its chrome is in its key): played now, where it differs from what it was is all
				const char *sl = jsonText(jsonGet(d->selection, "layer"));
				char *ranges = sl && !strcmp(sl, name) ? jsonPrint(jsonGet(d->selection, "ranges")) : copyString("");
				char *drawn = formatString("%s %s", fonts ? fonts : "", ranges);
				free(ranges);
				(void)render(d, g->api, l, drawn, NULL);
				free(drawn);
				Rendered *made = NULL;
				for (int k = 0; k < d->rendered.count && !made; k++) if (!strcmp(d->rendered.items[k].name, name)) made = &d->rendered.items[k];
				if (made && !made->fresh) r = meet((BlitRect){ x + made->delta.x, y + made->delta.y, made->delta.w, made->delta.h }, (BlitRect){ x, y, w, h });
			}
			damageAdd(&dirty, r);
		}
		ERM_PUSH(now, dn);
	}
	for (int k = 0; k < d->drawn.count; k++) {
		bool still = false;
		for (int i = 0; i < now.count && !still; i++) still = !strcmp(now.items[i].name, d->drawn.items[k].name);
		if (!still) damageAdd(&dirty, d->drawn.items[k].rect);
		free(d->drawn.items[k].name);
		free(d->drawn.items[k].key);
		free(d->drawn.items[k].t);
	}
	free(d->drawn.items);
	d->drawn.items = now.items, d->drawn.count = now.count, d->drawn.capacity = now.capacity;
	// each buffer keeps what changed since it was last drawn into; the back one draws that
	for (int i = 0; i < dirty.n; i++) {
		for (int b = 0; b < 2; b++) damageAdd(&d->damage[b], dirty.r[i]);
		d->change = d->changed ? unite(d->change, dirty.r[i]) : dirty.r[i], d->changed = true;
	}
	int back = 1 - d->front;
	if (!d->damage[back].n) {
		d->api = NULL;
		return ermOk();
	}
	Damage todo = d->damage[back];
	d->damage[back].n = 0;
	BlitForm fb = { d->maxw, d->maxh, d->maxw, hostConfig(d->host)->buffers[back], NULL };
	Json **sorted = malloc(sizeof *sorted * (size_t)(n ? n : 1));
	for (int i = 0; i < n; i++) sorted[i] = layers->array.items[i];
	qsort(sorted, (size_t)n, sizeof *sorted, cmpZ);
	for (int t = 0; t < todo.n; t++) {
		BlitRect clip = meet(todo.r[t], screen);
		if (clip.w <= 0 || clip.h <= 0) continue;
		// what is under a layer that covers all of it is not drawn: from the topmost such, up
		int from = -1;
		for (int i = n - 1; i >= 0 && from < 0; i--) {
			Json *l = sorted[i], *over = jsonGet(l, "over"), *col = jsonGet(l, "collapsed");
			if (over && over->type == JSON_BOOLEAN && over->boolean) continue;
			int x = (int)whole(jsonGet(l, "x"), 0), y = (int)whole(jsonGet(l, "y"), 0), w = (int)whole(jsonGet(l, "w"), 0), h = (int)whole(jsonGet(l, "h"), 0);
			const char *name = jsonText(jsonGet(l, "name"));
			if (!jsonIsString(jsonGet(l, "title"))) {
				// shaped, its corners cover nothing
				if (!jsonIsObject(jsonGet(l, "shape")) && inside(clip, (BlitRect){ x, y, w, h })) from = i;
				continue;
			}
			Chrome ch = chromeOf(d, themeJ, &T, l, focus && !strcmp(focus, name), u);
			BlitRect solid = frameOf(&ch, x, y, w, h, col && col->type == JSON_BOOLEAN && col->boolean);
			int rad[4], top, bottom;
			// rounded, its corners cover nothing
			if (radii(&ch, solid, rad)) {
				top = rad[0] > rad[1] ? rad[0] : rad[1], bottom = rad[2] > rad[3] ? rad[2] : rad[3];
				int side = (rad[0] > rad[3] ? rad[0] : rad[3]) > (rad[1] > rad[2] ? rad[1] : rad[2]) ? (rad[0] > rad[3] ? rad[0] : rad[3]) : (rad[1] > rad[2] ? rad[1] : rad[2]);
				if (inside(clip, (BlitRect){ solid.x, solid.y + top, solid.w, solid.h - top - bottom }) || inside(clip, (BlitRect){ solid.x + side, solid.y, solid.w - 2 * side, solid.h }))
					from = i;
			} else if (inside(clip, solid)) from = i;
		}
		if (from < 0) {
			from = 0;
			blitFill(&fb, clip.x, clip.y, clip.w, clip.h, 0x000000, &clip);
		}
		for (int i = from; i < n; i++) {
			Json *l = sorted[i];
			const char *name = jsonText(jsonGet(l, "name"));
			Drawn *dr = NULL;
			for (int k = 0; k < d->drawn.count && !dr; k++) if (!strcmp(d->drawn.items[k].name, name)) dr = &d->drawn.items[k];
			if (!dr || !meets(dr->rect, clip)) continue;
			char *sel = NULL;
			const char *on = jsonText(jsonGet(d->selection, "layer"));
			sel = on && !strcmp(on, name) ? jsonPrint(jsonGet(d->selection, "ranges")) : copyString("");
			char *look = formatString("%s %s", fonts ? fonts : "", sel);
			free(sel);
			BlitForm *form = render(d, g->api, l, look, dr->part ? &dr->at : NULL);
			free(look);
			if (!form) continue;
			Json *col = jsonGet(l, "collapsed"), *ov = jsonGet(l, "over");
			bool collapsed = col && col->type == JSON_BOOLEAN && col->boolean;
			int x = (int)whole(jsonGet(l, "x"), 0), y = (int)whole(jsonGet(l, "y"), 0);
			int rad[4] = { 0 };
			bool curved = false;
			Chrome ch = { 0 };
			BlitRect frame = { 0 };
			Under back = { 0 };
			if (jsonIsString(jsonGet(l, "title"))) {
				ch = chromeOf(d, themeJ, &T, l, focus && !strcmp(focus, name), u);
				frame = frameOf(&ch, x, y, (int)whole(jsonGet(l, "w"), 0), (int)whole(jsonGet(l, "h"), 0), collapsed);
				curved = radii(&ch, frame, rad);
				if (ch.shadow.on) {
					memcpy(ch.shadow.corner, rad, sizeof rad);
					shadow(&fb, &clip, frame, &ch.shadow, ov && ov->type == JSON_BOOLEAN && ov->boolean);
				}
				// rounded: what is about its corners now, shadow and all, to put back outside them
				if (curved) back = underOf(&fb, (BlitRect){ frame.x, frame.y, frame.w + ch.drop, frame.h + ch.drop }, rad, ch.drop);
				chrome(d, &fb, &clip, &ch, l);
			} else if (shapeOf(l, themeJ, u, &ch)) {
				// shaped: its shadow, and its corners rounded, as a window's
				frame = (BlitRect){ x, y, (int)whole(jsonGet(l, "w"), 0), (int)whole(jsonGet(l, "h"), 0) };
				curved = radii(&ch, frame, rad);
				if (ch.shadow.on) {
					memcpy(ch.shadow.corner, rad, sizeof rad);
					shadow(&fb, &clip, frame, &ch.shadow, ov && ov->type == JSON_BOOLEAN && ov->boolean);
				}
				if (curved) back = underOf(&fb, frame, rad, 0);
			}
			Json *over = jsonGet(l, "over");
			if (!collapsed) blitBlit(&fb, x, y, form, 0, 0, form->w, form->h, over && over->type == JSON_BOOLEAN && over->boolean ? BLIT_OVER : BLIT_COPY, &clip);
			if (curved) {
				corners(&fb, &clip, frame, rad, &ch, &back);
				free(back.bits);
			}
		}
	}
	free(sorted);
	forget(d, g->api, layers, false);
	d->waiting = true;
	d->waitBuffer = back;
	d->waitW = W;
	d->waitH = H;
	hostCommand(d->host, drvMap("op", jsonString("vsync"), "on", jsonBoolean(true), NULL));
	d->api = NULL;
	return ermOk();
}

// --- records: the mode, vsync, focus

static ErmErr displayIrq(void *data, const ErmGiven *g, Json **out) {
	Display *d = data;
	*out = NULL;
	Json *recs = g->args && g->args->array.count ? g->args->array.items[0] : NULL;
	for (int i = 0; recs && i < recs->array.count; i++) {
		Json *r = recs->array.items[i];
		const char *e = jsonText(jsonGet(r, "event"));
		if (!e) continue;
		if (!strcmp(e, "mode")) {
			Json *windows = jsonGet(r, "windows"), *layers = jsonGet(r, "layers");
			bool on = windows && windows->type == JSON_BOOLEAN && windows->boolean;
			bool stacked = !on && layers && layers->type == JSON_BOOLEAN && layers->boolean;
			// back on the monitor, the metal has closed every surface; off it, or not stacking, it has emptied its stack; web pages' sizes are told again, in either.
			// Only when that changed: a mode that says only something else (takeover, the screen's name) leaves all as it is
			Json *was = drvRead(g->api, drvPath("/", "dev", "display", "mode", NULL));
			Json *ww = jsonGet(was, "windows"), *wl = jsonGet(was, "layers");
			bool same = jsonIsObject(was) && ww && ww->type == JSON_BOOLEAN && ww->boolean == on && wl && wl->type == JSON_BOOLEAN && wl->boolean == stacked &&
			            whole(jsonGet(was, "w"), -1) == whole(jsonGet(r, "w"), -2) && whole(jsonGet(was, "h"), -1) == whole(jsonGet(r, "h"), -2);
			if (!same) {
				if (!on) unsurfaceAll(d);
				if (!stacked) unlayerAll(d);
				for (int k = 0; k < d->placed.count; k++) {
					free(d->placed.entries[k].value);
					d->placed.entries[k].value = NULL;
				}
			}
			drvSnap(g->api, drvPath("/", "dev", "display", "mode", NULL),
			        drvMap("w", jsonShallow(jsonGet(r, "w")), "h", jsonShallow(jsonGet(r, "h")), "scale", jsonShallow(jsonGet(r, "scale")),
			               "unit", jsonGet(r, "unit") ? jsonShallow(jsonGet(r, "unit")) : jsonInteger(1), "screen", jsonGet(r, "screen") ? jsonShallow(jsonGet(r, "screen")) : jsonNull(),
			               "fullscreen", jsonGet(r, "fullscreen") ? jsonShallow(jsonGet(r, "fullscreen")) : jsonBoolean(false),
			               "windows", jsonBoolean(on), "layers", jsonBoolean(stacked), "focused", jsonBoolean(true),
			               "takeover", jsonBoolean(jsonGet(r, "takeover") && jsonGet(r, "takeover")->type == JSON_BOOLEAN && jsonGet(r, "takeover")->boolean),
			               "keys", jsonIsString(jsonGet(r, "keys")) ? jsonShallow(jsonGet(r, "keys")) : jsonString("off"), NULL));
		} else if (!strcmp(e, "moved")) {
			// the person moved a Mac window: its layer is where the Mac says, as the hardware's change
			const char *id = jsonText(jsonGet(r, "id"));
			Json *at = id ? drvPath("/", "dev", "display", "layers", id, NULL) : NULL;
			Json *l = at ? drvRead(g->api, at) : NULL;
			if (!jsonIsObject(l)) continue;
			int64_t x = whole(jsonGet(r, "x"), 0), y = whole(jsonGet(r, "y"), 0);
			Surface *s = surfaceOf(d, id);
			if (s && jsonIsString(jsonGet(l, "title"))) {
				free(s->geo);
				s->geo = geoOf(d, (int)x, (int)y, (int)whole(jsonGet(l, "w"), 0), (int)whole(jsonGet(l, "h"), 0), jsonText(jsonGet(l, "title")));
			}
			Json *patches = jsonArray();
			jsonPush(patches, jsonRef(drvMap("type", jsonString("set"), "path", jsonArray(), "key", jsonString("x"), "value", jsonInteger(x), NULL)));
			jsonPush(patches, jsonRef(drvMap("type", jsonString("set"), "path", jsonArray(), "key", jsonString("y"), "value", jsonInteger(y), NULL)));
			drvOp(g->api, "write", drvMap("address", at, "patches", patches, NULL));
		} else if (!strcmp(e, "close")) {
			// a Mac window's close button: for the window manager, which closes it or not
			Json *close = drvRead(g->api, drvPath("/", "dev", "display", "close", NULL));
			drvSnap(g->api, drvPath("/", "dev", "display", "close", NULL),
			        drvMap("layer", jsonGet(r, "id") ? jsonShallow(jsonGet(r, "id")) : jsonNull(), "n", jsonInteger(whole(jsonGet(close, "n"), 0) + 1), NULL));
		} else if (!strcmp(e, "menu")) {
			// an item of the Mac's menu bar: for the window manager, as a click in its own
			Json *was = drvRead(g->api, drvPath("/", "dev", "display", "chosen", NULL));
			Json *c = drvMap("n", jsonInteger(whole(jsonGet(was, "n"), 0) + 1), "for", jsonInteger(whole(jsonGet(r, "n"), 0)),
			                 "menu", jsonInteger(whole(jsonGet(r, "menu"), -1)), "item", jsonInteger(whole(jsonGet(r, "item"), -1)), NULL);
			// in a submenu: its place in each submenu down from the item
			if (jsonIsArray(jsonGet(r, "sub"))) jsonAdd(c, "sub", jsonShallow(jsonGet(r, "sub")));
			drvSnap(g->api, drvPath("/", "dev", "display", "chosen", NULL), c);
		} else if (!strcmp(e, "key")) {
			// the Mac's key window, null when none of the OS's is: the focus follows it there
			const char *id = jsonText(jsonGet(r, "id"));
			free(d->macKey);
			free(d->asked);
			d->macKey = id ? copyString(id) : NULL;
			d->asked = NULL;
			const char *focus = jsonText(drvRead(g->api, drvPath("/", "dev", "display", "focus", NULL)));
			if (id && (!focus || strcmp(focus, id))) drvSnap(g->api, drvPath("/", "dev", "display", "focus", NULL), jsonString(id));
		} else if (!strcmp(e, "vsync") && d->waiting && d->stack) {
			// layers mode: where the tiles are, and the pieces packed into the buffer, in one command
			hostCommand(d->host, d->stack);
			jsonFree(d->stack);
			d->stack = NULL;
			d->front = d->waitBuffer;
			d->waiting = false;
			hostCommand(d->host, drvMap("op", jsonString("vsync"), "on", jsonBoolean(false), NULL));
			Json *frames = drvRead(g->api, drvPath("/", "dev", "display", "frames", NULL));
			drvSnap(g->api, drvPath("/", "dev", "display", "frames", NULL), drvMap("flips", jsonInteger(whole(jsonGet(frames, "flips"), 0) + 1), NULL));
			if (d->held) {
				d->held = false;
				drvSnap(g->api, drvPath("/", "dev", "display", "again", NULL), jsonInteger(++d->again));
			}
		} else if (!strcmp(e, "vsync") && d->waiting && d->presents) {
			// windows mode: each piece packed into the buffer, to its surface
			for (int k = 0; k < d->presents->array.count; k++) {
				Json *p = d->presents->array.items[k];
				hostCommand(d->host, drvMap("op", jsonString("present"), "id", jsonShallow(jsonGet(p, "id")), "buffer", jsonInteger(d->waitBuffer),
				                            "sx", jsonShallow(jsonGet(p, "sx")), "sy", jsonShallow(jsonGet(p, "sy")), "dirty", jsonShallow(jsonGet(p, "dirty")), NULL));
			}
			jsonFree(d->presents);
			d->presents = NULL;
			d->front = d->waitBuffer;
			d->waiting = false;
			hostCommand(d->host, drvMap("op", jsonString("vsync"), "on", jsonBoolean(false), NULL));
			if (d->held) {
				d->held = false;
				drvSnap(g->api, drvPath("/", "dev", "display", "again", NULL), jsonInteger(++d->again));
			}
		} else if (!strcmp(e, "focus")) {
			drvSet(g->api, drvPath("/", "dev", "display", "mode", NULL), "focused", jsonShallow(jsonGet(r, "on")));
		} else if (!strcmp(e, "vsync") && d->waiting) {
			// what changed since the last flip, so the metal copies only that
			BlitRect c = meet(d->changed ? d->change : (BlitRect){ 0, 0, 0, 0 }, (BlitRect){ 0, 0, d->waitW, d->waitH });
			d->changed = false;
			hostCommand(d->host, drvMap("op", jsonString("flip"), "buffer", jsonInteger(d->waitBuffer), "w", jsonInteger(d->waitW), "h", jsonInteger(d->waitH),
			                            "dirty", drvMap("x", jsonInteger(c.x), "y", jsonInteger(c.y), "w", jsonInteger(c.w > 0 ? c.w : 0), "h", jsonInteger(c.h > 0 ? c.h : 0), NULL), NULL));
			d->front = d->waitBuffer;
			d->waiting = false;
			hostCommand(d->host, drvMap("op", jsonString("vsync"), "on", jsonBoolean(false), NULL));
			Json *frames = drvRead(g->api, drvPath("/", "dev", "display", "frames", NULL));
			drvSnap(g->api, drvPath("/", "dev", "display", "frames", NULL), drvMap("flips", jsonInteger(whole(jsonGet(frames, "flips"), 0) + 1), NULL));
			if (d->held) {
				d->held = false;
				drvSnap(g->api, drvPath("/", "dev", "display", "again", NULL), jsonInteger(++d->again));
			}
		}
	}
	return ermOk();
}

// --- /dev/display/want: the mode wished for, asked of the metal, then cleared, so the same wish asks again

static ErmErr wantCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	Json *v = drvRead(g->api, drvPath("/", "dev", "display", "want", NULL));
	*out = v ? jsonShallow(v) : jsonNull();
	return ermOk();
}

static ErmErr wantEffect(void *data, const ErmGiven *g, Json **out) {
	Display *d = data;
	*out = jsonNull();
	// windows: each window a Mac window, or the monitor; takeover: full screen, the Mac's ways out off too
	Json *windows = jsonGet(g->value, "windows"), *take = jsonGet(g->value, "takeover");
	bool w = windows && windows->type == JSON_BOOLEAN, t = take && take->type == JSON_BOOLEAN;
	if (!w && !t) return ermOk();
	Json *c = drvMap("op", jsonString("display"), NULL);
	if (w) jsonAdd(c, "windows", jsonBoolean(windows->boolean));
	if (t) jsonAdd(c, "takeover", jsonBoolean(take->boolean));
	hostCommand(d->host, c);
	drvSnap(g->api, drvPath("/", "dev", "display", "want", NULL), jsonNull());
	return ermOk();
}

// --- /etc/desktop's corner, {top, bottom} in points: the screen's rounded corners, which the metal keeps
// the pointer off (full screen, on the Mac's own display); 10 at the top if it says none

static ErmErr cornerCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	Json *c = jsonGet(drvRead(g->api, drvPath("/", "etc", "desktop", NULL)), "corner");
	*out = jsonIsObject(c) ? jsonShallow(c) : drvMap("top", jsonInteger(10), "bottom", jsonInteger(0), NULL);
	return ermOk();
}

static ErmErr cornerEffect(void *data, const ErmGiven *g, Json **out) {
	Display *d = data;
	*out = jsonNull();
	hostCommand(d->host, drvMap("op", jsonString("display"), "corner", jsonShallow(g->value), NULL));
	return ermOk();
}

// --- /etc/keys' chords (those that run a command) and its "system": true: the Mac's own keys (cmd-Tab, cmd-Space…)
// the metal takes for the OS while taking over, of those it keeps for itself (../mac/metal/TapRule.swift)

static ErmErr keysCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	Json *keys = drvRead(g->api, drvPath("/", "etc", "keys", NULL));
	Json *chords = jsonArray();
	bool system = false;
	for (int k = 0; jsonIsObject(keys) && k < keys->object.count; k++) {
		const char *key = keys->object.members[k].key;
		Json *v = keys->object.members[k].value;
		if (!strcmp(key, "system")) system = v && v->type == JSON_BOOLEAN && v->boolean;
		else if (jsonIsString(v)) jsonPush(chords, jsonString(key));
	}
	*out = drvMap("chords", chords, "system", jsonBoolean(system), NULL);
	return ermOk();
}

static ErmErr keysEffect(void *data, const ErmGiven *g, Json **out) {
	Display *d = data;
	*out = jsonNull();
	hostCommand(d->host, drvMap("op", jsonString("display"), "keys", jsonShallow(g->value), NULL));
	return ermOk();
}

// --- /dev/display/menus: what the Mac's menu bar shows after the metal's own, sent as it changes

static ErmErr menusCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	Json *v = drvRead(g->api, drvPath("/", "dev", "display", "menus", NULL));
	*out = v ? jsonShallow(v) : jsonNull();
	return ermOk();
}

static ErmErr menusEffect(void *data, const ErmGiven *g, Json **out) {
	Display *d = data;
	*out = jsonNull();
	if (!jsonIsObject(g->value)) return ermOk();
	Json *c = drvMap("op", jsonString("menus"), "n", jsonGet(g->value, "n") ? jsonShallow(jsonGet(g->value, "n")) : jsonInteger(0), NULL);
	jsonAdd(c, "menus", jsonIsArray(jsonGet(g->value, "menus")) ? jsonShallow(jsonGet(g->value, "menus")) : jsonArray());
	hostCommand(d->host, c);
	return ermOk();
}

ErmErr driverDisplay(void *data, const ErmGiven *g, Json **out) {
	*out = jsonNull();
	Display *d = calloc(1, sizeof *d);
	d->host = data;
	Json *fb = jsonGet(hostTree(d->host), "fb");
	d->maxw = (int)whole(jsonGet(fb, "maxw"), 0);
	d->maxh = (int)whole(jsonGet(fb, "maxh"), 0);
	int64_t unit = whole(jsonGet(fb, "unit"), 0);
	if (unit < 1) {
		Json *scale = jsonGet(fb, "scale");
		unit = jsonIsNumber(scale) && scale->number > 0 ? (int64_t)(1 / scale->number + 0.5) : 1;
	}
	// the font ROM, for text in cells
	Json *rom = jsonRef(drvRead(g->api, drvPath("/", "hw", "font", NULL))); // held for good: r points into it
	Json *alpha = jsonGet(rom, "alpha");
	static BlitRom r;
	r = (BlitRom){ (int)whole(jsonGet(rom, "w"), 8), (int)whole(jsonGet(rom, "h"), 16), jsonText(jsonGet(rom, "chars")) ? jsonText(jsonGet(rom, "chars")) : " ",
	               alpha && alpha->type == JSON_BYTES ? alpha->bytes.data : NULL };
	d->blit = blitNew(&r);
	Json *dev = drvPath("/", "dev", "display", NULL);
	drvMake(g->api, dev, "mode", "display/mode",
	        drvMap("w", jsonInteger(d->maxw), "h", jsonInteger(d->maxh), "unit", jsonInteger(unit), "focused", jsonBoolean(true), NULL));
	const char *nodes[] = { "layers", "windows", "focus", "close", "want", "text", "selection", "menus", "chosen" };
	for (size_t i = 0; i < sizeof nodes / sizeof *nodes; i++) {
		char *id = formatString("display/%s", nodes[i]);
		drvMake(g->api, dev, nodes[i], id, jsonNull());
		free(id);
	}
	drvMake(g->api, dev, "frames", "display/frames", drvMap("flips", jsonInteger(0), NULL));
	drvMake(g->api, dev, "again", "display/again", jsonInteger(0));
	Json *here = drvHere(g);
	drvHandler(g, here, "irq", (ErmFn){ displayIrq, d });
	drvClaim(g, here, 33);
	drvChild(g, here, "compose", (ErmFn){ composeCompute, d }, (ErmFn){ composeEffect, d });
	drvChild(g, here, "want", (ErmFn){ wantCompute, d }, (ErmFn){ wantEffect, d });
	drvChild(g, here, "corner", (ErmFn){ cornerCompute, d }, (ErmFn){ cornerEffect, d });
	drvChild(g, here, "keys", (ErmFn){ keysCompute, d }, (ErmFn){ keysEffect, d });
	drvChild(g, here, "menus", (ErmFn){ menusCompute, d }, (ErmFn){ menusEffect, d });
	return ermOk();
}
