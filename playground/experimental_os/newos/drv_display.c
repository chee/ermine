// drv_display.c: the compositor (irq 33). Holds the two frame buffers the metal shows and composes
// /dev/display/layers into the back one; only what changed is drawn and flipped, one frame a vsync.
//
//   /dev/display/layers/<name>   ephemeral, the placing program's: {x, y, w, h, z, draw, title?,
//                                owner?, over?, collapsed?, hidden?, shape?, web?}; draw: blit.h
//                                ops, or pixels (a u32 array), or plane (a driver's: drv_vram.c)
//   /dev/display/text/<layer>    where each text run went
//   /dev/display/selection       {layer, ranges, text}: highlighted under its text
//   /dev/display/windows/<name>  every layer, hidden too, without what it draws: {x, y, w, h, z,
//                                title, owner, collapsed, hidden, drags, want, chrome}; written on
//                                change only, so drawing costs the window manager nothing
//   /dev/display/want            {"windows": true | false}: asks the metal for that mode; cleared
//   /dev/display/focus           the Mac's key window follows it, and moves it
//   /dev/display/close           {layer, n}: a window's close button, for the window manager
//   /dev/display/menus           {n, menus}: shown in the Mac's menu bar after the metal's own
//   /dev/display/chosen          a pick there: {n, for, menu, item, sub?}
//
// a titled layer gets /etc/theme's chrome (System 7's by default); an untitled one with shape
// {radius, shadow?} is rounded and shadowed. web {id, x, y, w, h}: a page's plane (drv_web.c)
// drawn over its ops; the metal is told its size (webshow, w 0 none) so it draws only while shown.
// parts (drvChild), each reading only what it needs: layers (the summary the rest read), fonts,
// compose (draws, tells the metal), windows, pages, focus, want, corner, keys, menus. values are
// compared as the graph's Json (val.h), never printed; a layer replays only when a font it used
// changed or a page it lacked came.
// modes: monitor; windows (each titled layer a Mac window, only its changed rectangle presented);
// layers (each a metal GPU layer: moves and raises sent with no pixels).
// not yet (display.js had it): the host's console under everything.

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
	bool seen;
} Page;

typedef struct Face {
	char *role;
	BlitFont font;
	Json *value; // /dev/font/<role> as last synced, held: its metrics compared by value, as the font driver writes it again with each page
	int gen;     // bumped when its metrics change, or it goes
	bool gone;   // its role is no more: text in it is drawn in the ROM's cells, as with no face
	bool keep;   // the sync's mark
	ERM_LIST(Page) pages;
	ERM_LIST(int) wanted; // pages asked for, until one of its pages comes
	struct Display *d;
} Face;

/** what something drew with: a face's metrics (n -1, as of gen), or page n of it, page its value then (held; NULL: it was missing) */
typedef struct Use {
	Face *face;
	int n, gen;
	Json *page;
} Use;
typedef ERM_LIST(Use) Uses;

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

/** a chrome kept with what it was made from: the theme, the layer's chrome and star, whether focused, the unit, and the faces as they were */
typedef struct ChromeCache {
	bool valid;
	Json *theme, *mine; // held
	bool star, on;
	int u, faces;
	Chrome c;
} ChromeCache;

typedef struct Drawn {
	char *name;
	BlitRect rect;
	Json *l;        // the layer as it was drawn (held): compared but for t and its plane's image
	bool on;        // focused
	Json *sel;      // the selection's ranges on it (held), or NULL
	const op_value *content; // its value as last drawn (held), and its t (a page's frame too)
	Json *t;
	int64_t serial; // its plane's serial, -1 for none
	bool part;      // this frame: only its plane's dirty rectangle, part, changed
	BlitRect at;    // part, in the layer
	Uses chromeUses;
	ChromeCache cc;
} Drawn;

typedef struct Rendered {
	char *name;
	BlitForm form;
	Json *runs; // where its text went, as last written (held)
	bool seen;
	int64_t n;  // how many times it was played: one not played since it was presented is not compared
	// the layer's value as it was when played (held): a node's value is never changed in place (api.c's are
	// copy-on-write), so the same object is the same value, and so are its draw and pixels; a change's time
	// is whole seconds, no mark of one. Json.h's are the same while kept (val.h): drawn with for the splice
	const op_value *content, *drawV, *pixelsV;
	Json *draw, *pixels; // what it was played from (held)
	Json *plane;         // its plane as it was played (held), or NULL
	Json *sel;           // the selection's ranges on it (held), or NULL
	bool over;
	int w, h;
	Uses uses;      // the faces and pages it drew with
	BlitRect delta; // where its last render changed it (none: nothing); fresh, all of it
	bool fresh;
} Rendered;

/** windows mode: a titled layer's Mac window, as it was last told and shown */
typedef struct Surface {
	char *name;
	bool told;          // as the last surface command said: where, how big and its title
	int tx, ty, tw, th;
	char *title;
	int w, h;
	uint32_t *shown;  // its pixels as last presented, w × h, to present only what differs
	int64_t n;        // its form's Rendered n when last compared
	bool seen, fresh; // fresh: made this compose
} Surface;

/** where a tile is, its depth and its shadow, as the last layers command said */
typedef struct Geo {
	int x, y, w, h;
	double z;
	bool shaded;
	uint32_t color;
	double opacity, radius, sx, sy;
	int rad[4], drop;
} Geo;

/** layers mode: a layer as the metal composites it, its chrome and content in one form */
typedef struct Tile {
	char *name;
	bool told;
	Geo geo;
	// what its form was made from: its content's Rendered n, and its chrome's look (the rest)
	bool made;
	int64_t n;
	int bw, bh;
	bool titled, on, collapsed;
	char *title;
	Json *mine, *shape, *theme; // held
	int u;
	Uses chromeUses;
	BlitForm form;  // its pixels as last painted
	const op_value *content; // its layer's value as last composed (held), with its t (a page's frame too) and its plane's serial: a plane's next image is only its dirty rectangle
	Json *t;
	int64_t serial;
	ChromeCache cc;
	bool seen;
} Tile;

/** the windows part: a layer's /dev/display/windows/<name> as last written, and its chrome's parts */
typedef struct Win {
	Json *written, *parts; // held
	ChromeCache cc;
	int pw, ph;
	bool pcollapsed;
} Win;

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
	bool wholeMade;    // the full frame as last drawn whole: its size, unit and theme
	int wholeW, wholeH, wholeU;
	Json *wholeTheme;  // held
	Damage damage[2];
	bool changed;      // what changed since the last flip, for the metal to copy only that
	BlitRect change;
	bool held;         // a compose that came while a frame waited for its vsync: done after the flip
	int64_t again;     // /dev/display/again, written to compose what was held
	ERM_LIST(Rendered) rendered;
	ERM_LIST(Face *) faces;
	int facesGen;      // bumped when any face's metrics change
	Json *fonts;       // the fonts summary the faces were synced from (held)
	Uses *tally;       // where fontOf and pageOf record what is drawn with, while something is
	const ErmPartApi *api; // the part running, to ask the font driver for a page
	Json *here;        // the driver's own node, held
	Json *selection;
	uint32_t mark;
	ErmMap windows;  // a layer's name -> Win, as /dev/display/windows/<name> was last written (NULL: gone)
	Json *winOut;    // the windows part's value as last acted on (held): given again when nothing changed
	ErmMap placed;   // a web page's id -> its size, {w, h}, as the metal was last told it shows (webshow)
	Json *pagesOut;  // the pages part's value as last acted on (held)
	ERM_LIST(Surface) surfaces; // windows mode: the Mac windows
	Json *presents;  // windows mode: the pieces packed into the buffer waiting, presented at its vsync
	char *macKey;    // the surface the Mac says is key
	char *asked;     // the surface last asked to be key
	bool layered;    // layers mode (mode.layers): each layer a tile the metal composites
	ERM_LIST(Tile) tiles;
	Json *stack;     // layers mode: the layers command waiting for its vsync
} Display;

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

static bool truthy(const Json *v) {
	return v && v->type == JSON_BOOLEAN && v->boolean;
}

/** the same value: the same Json (an unchanged value the graph keeps, val.h), or equal */
static bool same(const Json *a, const Json *b) {
	return a == b || jsonEqual(a, b);
}

/** *at holds v: the hold moved to v when it is another Json (an equal one too, so the next compare is the pointer's) */
static void hold(Json **at, const Json *v) {
	if (*at == v) return;
	jsonFree(*at);
	*at = jsonRef((Json *)v);
}

static bool sameText(const char *a, const char *b) {
	return a == b || (a && b && !strcmp(a, b));
}

/** the theme's shadow, {color, opacity, radius, x, y} in points, at the screen's unit */
static Shade shadeOf(const Json *theme, int u) {
	Json *s = jsonGet(theme, "shadow");
	if (!jsonIsObject(s)) return (Shade){ 0 };
	Shade sh = { true, colour(s, "color", 0), number(s, "opacity", 0.3), number(s, "radius", 0) * u, number(s, "x", 0) * u, number(s, "y", 0) * u, { 0 } };
	sh.on = sh.opacity > 0;
	return sh;
}

// --- fonts: the faces, kept, as the fonts part's summary says they are

/** fontOf and pageOf record what is drawn with, while something is; no face (a role with none): the faces as they were, d->facesGen */
static void tally(Display *d, Face *f, int n, Json *page) {
	Uses *u = d->tally;
	if (!u) return;
	int gen = f ? f->gen : d->facesGen;
	for (int i = 0; i < u->count; i++)
		if (u->items[i].face == f && u->items[i].n == n) {
			u->items[i].gen = gen;
			hold(&u->items[i].page, page);
			return;
		}
	ERM_PUSH(*u, ((Use){ f, n, gen, jsonRef(page) }));
}

static void usesReset(Uses *u) {
	for (int i = 0; i < u->count; i++) jsonFree(u->items[i].page);
	u->count = 0;
}

static void usesFree(Uses *u) {
	usesReset(u);
	free(u->items);
	u->items = NULL;
	u->capacity = 0;
}

static Page *pageIn(Face *f, int n) {
	for (int i = 0; i < f->pages.count; i++) if (f->pages.items[i].n == n) return &f->pages.items[i];
	return NULL;
}

/** whether what was drawn with these is not as it was: a face's metrics changed or it went, a page of it is another, one it lacked has come, or a role it lacked may have a face now */
static bool usesStale(const Display *d, const Uses *u) {
	for (int i = 0; i < u->count; i++) {
		const Use *x = &u->items[i];
		if (!x->face) {
			if (x->gen != d->facesGen) return true;
			continue;
		}
		if (x->face->gone || x->face->gen != x->gen) return true;
		if (x->n < 0) continue;
		Page *p = pageIn(x->face, x->n);
		if ((p ? p->value : NULL) != x->page) return true;
	}
	return false;
}

static Face *faceOf(Display *d, const char *role) {
	for (int i = 0; i < d->faces.count; i++) if (!strcmp(d->faces.items[i]->role, role)) return d->faces.items[i];
	return NULL;
}

static const BlitPage *pageOf(void *data, int n) {
	Face *f = data;
	Display *d = f->d;
	Page *p = pageIn(f, n);
	if (p) {
		tally(d, f, n, p->value);
		return &p->page;
	}
	tally(d, f, n, NULL);
	// a page not here: asked for once, until a page of this face comes; what lacked it draws again when it does
	for (int i = 0; i < f->wanted.count; i++) if (f->wanted.items[i] == n) return NULL;
	if (!d->api) return NULL;
	ERM_PUSH(f->wanted, n);
	Json *args = jsonArray();
	jsonPush(args, jsonString(f->role));
	jsonPush(args, jsonInteger(n));
	drvOp(d->api, "call", drvMap("address", drvPath("/", "dev", "font", "driver", "on", "want", NULL), "args", args, NULL));
	return NULL;
}

static const BlitFont *fontOf(void *data, const char *role) {
	Display *d = data;
	if (!role) return NULL;
	Face *f = faceOf(d, role);
	if (!f || f->gone) {
		tally(d, NULL, -1, NULL);
		return NULL;
	}
	tally(d, f, -1, NULL);
	return &f->font;
}

/** a page's value as the font driver writes it: w, info (1024 float64s), alpha (bytes) */
static bool pageValid(const Json *v) {
	const Json *alpha = jsonGet(v, "alpha"), *info = jsonGet(v, "info");
	return jsonIsObject(v) && alpha && alpha->type == JSON_BYTES && info && info->type == JSON_TYPED && info->typed.kind == JSON_FLOAT64 && info->typed.count >= 1024;
}

static void pagesDrop(Face *f) {
	for (int k = 0; k < f->pages.count; k++) jsonFree(f->pages.items[k].value);
	f->pages.count = 0;
	f->wanted.count = 0;
}

/**
 * the faces as the fonts summary says: {role: {font, pages: {n: page}}}, the fonts part's value.
 * A face's metrics are compared by value (the font driver writes the role again with each page);
 * its pages by their values, each the same Json while unchanged: one the same is kept, another
 * made in its place, one gone dropped. A role gone: its face gone (what used it draws again)
 */
static void facesSync(Display *d, Json *fonts) {
	if (fonts == d->fonts) return;
	hold(&d->fonts, fonts);
	for (int i = 0; i < d->faces.count; i++) d->faces.items[i]->keep = false;
	for (int i = 0; jsonIsObject(fonts) && i < fonts->object.count; i++) {
		const char *role = fonts->object.members[i].key;
		Json *e = fonts->object.members[i].value, *fv = jsonGet(e, "font"), *pages = jsonGet(e, "pages");
		if (!jsonIsNumber(jsonGet(fv, "h")) || !jsonIsNumber(jsonGet(fv, "ascent"))) continue;
		Face *f = faceOf(d, role);
		if (!f) {
			f = calloc(1, sizeof *f);
			f->role = copyString(role);
			f->d = d;
			f->gone = true;
			ERM_PUSH(d->faces, f);
		}
		f->keep = true;
		if (f->gone || !f->value || !same(f->value, fv)) {
			f->font = (BlitFont){ (int)jsonGet(fv, "h")->number, jsonGet(fv, "ascent")->number, f->role, pageOf, f };
			f->gen++;
			d->facesGen++;
			f->gone = false;
			hold(&f->value, fv);
		}
		bool changed = false;
		for (int k = 0; k < f->pages.count; k++) f->pages.items[k].seen = false;
		for (int k = 0; jsonIsObject(pages) && k < pages->object.count; k++) {
			int n = atoi(pages->object.members[k].key);
			Json *pv = pages->object.members[k].value;
			Page *p = pageIn(f, n);
			// the same page: the same Json, or (its kept Json let go and made again, val.h) an equal one: kept as it is, its alpha pointed into
			if (p && same(p->value, pv)) {
				p->seen = true;
				continue;
			}
			if (!pageValid(pv)) continue;
			Page page = { n, { (int)whole(jsonGet(pv, "w"), 0), jsonGet(pv, "alpha")->bytes.data, jsonGet(pv, "alpha")->bytes.length, jsonGet(pv, "info")->typed.data }, jsonRef(pv), true };
			if (p) {
				jsonFree(p->value);
				*p = page;
			} else ERM_PUSH(f->pages, page);
			changed = true;
		}
		int kept = 0;
		for (int k = 0; k < f->pages.count; k++) {
			if (f->pages.items[k].seen) f->pages.items[kept++] = f->pages.items[k];
			else {
				jsonFree(f->pages.items[k].value);
				changed = true;
			}
		}
		f->pages.count = kept;
		// a page came (or went): what is still missing is asked for again
		if (changed) f->wanted.count = 0;
	}
	for (int i = 0; i < d->faces.count; i++) {
		Face *f = d->faces.items[i];
		if (f->keep || f->gone) continue;
		f->gone = true;
		f->gen++;
		d->facesGen++;
		pagesDrop(f);
	}
}

/** the fonts part: each /dev/font role's value and the pages of it that have come, {role: {font, pages: {n: page}}}; read tracked */
static ErmErr fontsCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	const ErmPartApi *api = g->api;
	Json *roles = drvNames(api, drvPath("/", "dev", "font", NULL));
	Json *o = jsonObject();
	for (int i = 0; roles && i < roles->array.count; i++) {
		const char *role = jsonText(roles->array.items[i]);
		Json *v = drvRead(api, drvPath("/", "dev", "font", role, NULL));
		if (!jsonIsNumber(jsonGet(v, "h"))) continue;
		Json *names = drvNames(api, drvPath("/", "dev", "font", role, "pages", NULL)), *pm = jsonObject();
		for (int k = 0; names && k < names->array.count; k++) {
			const char *p = jsonText(names->array.items[k]);
			Json *pv = drvRead(api, drvPath("/", "dev", "font", role, "pages", p, NULL));
			if (pageValid(pv)) jsonAdd(pm, p, jsonRef(pv));
		}
		Json *e = jsonObject();
		jsonAdd(e, "font", jsonRef(v));
		jsonAdd(e, "pages", pm);
		jsonAdd(o, role, e);
	}
	*out = o;
	return ermOk();
}

// --- the layers part: what each layer is and where, and each as a window; read tracked

static ErmErr layersCompute(void *data, const ErmGiven *g, Json **out) {
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
				if (jsonGet(l, fields[k])) jsonAdd(window, fields[k], jsonRef(jsonGet(l, fields[k])));
			jsonAdd(windows, name, window);
		}
		if (!jsonIsObject(l) || whole(jsonGet(l, "w"), 0) <= 0 || whole(jsonGet(l, "h"), 0) <= 0 || truthy(jsonGet(l, "hidden"))) continue;
		Json *t = jsonGet(jsonGet(item, "change"), "time");
		// a page's newest frame: its plane, at the layer's web, over its ops; a new frame a change of the layer's value
		Json *web = jsonGet(l, "web"), *frame = NULL;
		if (jsonIsObject(web) && jsonText(jsonGet(web, "id")))
			frame = drvRead(api, drvPath("/", "dev", "web", "pages", jsonText(jsonGet(web, "id")), "frame", NULL));
		Json *page = NULL, *when = t ? jsonRef(t) : jsonInteger(0);
		if (jsonIsObject(frame) && !jsonIsObject(jsonGet(l, "plane"))) {
			page = drvMap("source", jsonString("web"), "id", jsonShallow(jsonGet(frame, "plane")), "serial", jsonShallow(jsonGet(frame, "n")), "x",
			              jsonInteger(whole(jsonGet(web, "x"), 0)), "y", jsonInteger(whole(jsonGet(web, "y"), 0)), "w", jsonInteger(whole(jsonGet(web, "w"), 0)), "h",
			              jsonInteger(whole(jsonGet(web, "h"), 0)), "over", jsonBoolean(true), NULL);
			if (jsonIsObject(jsonGet(frame, "dirty"))) jsonAdd(page, "dirty", jsonRef(jsonGet(frame, "dirty")));
			Json *both = jsonArray();
			jsonPush(both, when);
			jsonPush(both, jsonShallow(jsonGet(frame, "n")));
			when = both;
		}
		Json *s = drvMap("name", jsonString(name), "t", when, NULL);
		const char *keys[] = { "x", "y", "w", "h", "z", "title", "collapsed", "over", "chrome", "shape", "star" };
		for (size_t k = 0; k < sizeof keys / sizeof *keys; k++)
			if (jsonGet(l, keys[k])) jsonAdd(s, keys[k], jsonRef(jsonGet(l, keys[k])));
		jsonAdd(s, "draw", jsonBoolean(jsonGet(l, "draw") != NULL));
		if (jsonIsObject(jsonGet(l, "plane"))) jsonAdd(s, "plane", jsonRef(jsonGet(l, "plane")));
		else if (page) jsonAdd(s, "plane", jsonRef(page));
		if (jsonIsObject(web) && jsonText(jsonGet(web, "id"))) jsonAdd(s, "web", jsonRef(web));
		jsonPush(layers, jsonRef(s));
	}
	*out = drvMap("layers", layers, "windows", windows, NULL);
	return ermOk();
}

// --- the compose compute: what a frame is made of, read tracked: the layers and fonts summaries, the mode, focus, theme and selection

static ErmErr composeCompute(void *data, const ErmGiven *g, Json **out) {
	Display *d = data;
	const ErmPartApi *api = g->api;
	Json *L = drvRead(api, drvUnder(d->here, "layers", NULL));
	Json *F = drvRead(api, drvUnder(d->here, "fonts", NULL));
	Json *layers = jsonGet(L, "layers");
	Json *mode = drvRead(api, drvPath("/", "dev", "display", "mode", NULL));
	Json *focus = drvRead(api, drvPath("/", "dev", "display", "focus", NULL));
	Json *theme = drvRead(api, drvPath("/", "etc", "theme", NULL));
	Json *selection = drvRead(api, drvPath("/", "dev", "display", "selection", NULL));
	(void)drvRead(api, drvPath("/", "dev", "display", "again", NULL)); // read, so a held compose runs after the flip
	*out = drvMap("layers", jsonIsArray(layers) ? jsonRef(layers) : jsonArray(), "fonts", F ? F : jsonNull(), "mode", mode ? mode : jsonNull(), "focus",
	              focus ? focus : jsonNull(), "theme", theme ? theme : jsonNull(), "selection", selection ? selection : jsonNull(), NULL);
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
	const Json *star = truthy(jsonGet(l, "star")) ? jsonGet(theme, "star") : NULL;
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

/** a layer's chrome, kept with what it was made from and made again only when that changed; *fresh (when given) whether it was */
static const Chrome *chromeAt(Display *d, ChromeCache *cc, const Json *theme, const Theme *T, const Json *l, bool on, int u, bool *fresh) {
	const Json *mine = jsonGet(l, "chrome");
	bool star = truthy(jsonGet(l, "star"));
	if (cc->valid && cc->star == star && cc->on == on && cc->u == u && cc->faces == d->facesGen && same(cc->theme, theme) && same(cc->mine, mine)) {
		hold(&cc->theme, theme);
		hold(&cc->mine, mine);
		if (fresh) *fresh = false;
		return &cc->c;
	}
	cc->c = chromeOf(d, theme, T, l, on, u);
	hold(&cc->theme, theme);
	hold(&cc->mine, mine);
	cc->star = star, cc->on = on, cc->u = u, cc->faces = d->facesGen, cc->valid = true;
	if (fresh) *fresh = true;
	return &cc->c;
}

static void chromeCacheFree(ChromeCache *cc) {
	jsonFree(cc->theme);
	jsonFree(cc->mine);
	*cc = (ChromeCache){ 0 };
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
	if (truthy(sh)) c->shadow = shadeOf(theme, u);
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
	bool collapsed = truthy(jsonGet(l, "collapsed"));
	const char *title = jsonText(jsonGet(l, "title"));
	int B = c->border, D = c->drop, R = c->rule, tb = c->tb, h = (collapsed ? 0 : lh) + tb + 2 * B;
	if (truthy(jsonGet(l, "over"))) {
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

/** the chrome drawn, with what it drew with recorded in uses (the title's face and pages), from nothing */
static void chromeTallied(Display *d, BlitForm *fb, const BlitRect *clip, const Chrome *c, const Json *l, Uses *uses) {
	usesReset(uses);
	d->tally = uses;
	tally(d, c->font ? c->font->data : NULL, -1, NULL);
	chrome(d, fb, clip, c, l);
	d->tally = NULL;
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

/** where a layer's text went, written to /dev/display/text/<name> when it changed; runs is taken */
static void said(const ErmPartApi *api, Rendered *r, const char *name, Json *runs) {
	if (r->runs && jsonEqual(r->runs, runs)) {
		jsonFree(runs);
		return;
	}
	jsonFree(r->runs);
	r->runs = runs;
	Json *at = drvPath("/", "dev", "display", "text", name, NULL);
	if (drvHas(api, at)) drvSnap(api, at, jsonRef(runs));
	else {
		char *id = formatString("display/text/%s", name);
		drvMake(api, drvPath("/", "dev", "display", "text", NULL), name, id, jsonRef(runs));
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

/** *at holds v, an op_value: the hold moved to v when it is another */
static void keepValue(const op_value **at, const op_value *v) {
	if (*at == v) return;
	op_free((op_value *)*at);
	*at = v ? op_ref((op_value *)v) : NULL;
}

/** a layer's value as the graph holds it, the object itself (drvItem's, without its Json): NULL for none */
static const op_value *contentOf(Display *d, const ErmPartApi *api, const char *name) {
	size_t n = 0;
	const char *const *a = hostPathOf(d->host, drvPath("/", "dev", "display", "layers", name, NULL), &n);
	ap_items items = { 0 };
	if (!a || ap_content((ap_api *)api, a, n, &items)) return NULL;
	for (size_t i = 0; i < items.n; i++) {
		const ap_item *it = &items.items[i];
		if (!it->node || !it->has_versions) continue;
		for (size_t k = 0; k < it->nversions; k++)
			if (!it->versions[k].status) return it->versions[k].content;
		return NULL;
	}
	return NULL;
}

static Rendered *renderedOf(Display *d, const char *name) {
	for (int i = 0; i < d->rendered.count; i++) if (!strcmp(d->rendered.items[i].name, name)) return &d->rendered.items[i];
	return NULL;
}

/** the selection's ranges on a layer, or NULL */
static Json *selectionOn(Display *d, const char *name) {
	const char *on = jsonText(jsonGet(d->selection, "layer"));
	return on && !strcmp(on, name) ? jsonGet(d->selection, "ranges") : NULL;
}

/** a plane as a layer's summary says it, compared without its image: its source and id */
static bool samePlace(const Json *a, const Json *b) {
	return same(jsonGet(a, "source"), jsonGet(b, "source")) && same(jsonGet(a, "id"), jsonGet(b, "id"));
}

/**
 * a layer's pixels: its ops played into a form of its own, kept until they, the fonts it drew with or the
 * selection change. content is the layer's value as the graph holds it (contentOf): the same object as
 * when it was played, with the same plane, selection and fonts, nothing more is looked at: the form as it
 * is. Else its draw and pixels are compared with what was played: the same objects are the same values,
 * so a layer moved or raised is not played again. part, when not NULL, is the only rectangle of its plane
 * that changed since it was last played, all that is copied
 */
static BlitForm *render(Display *d, const ErmPartApi *api, const Json *l, const op_value *content, const BlitRect *part) {
	const char *name = jsonText(jsonGet(l, "name"));
	int w = (int)whole(jsonGet(l, "w"), 0), h = (int)whole(jsonGet(l, "h"), 0);
	Rendered *r = renderedOf(d, name);
	if (r) r->seen = true;
	if (!content) return r ? &r->form : NULL;
	Json *sel = selectionOn(d, name), *plane = jsonGet(l, "plane");
	bool over = truthy(jsonGet(l, "over"));
	// what it draws, apart from where it is: the same ops and pixels are the same values
	bool rest = r && same(r->plane, plane) && r->over == over && r->w == w && r->h == h && same(r->sel, sel) && !usesStale(d, &r->uses);
	if (rest && r->content == content) {
		r->delta = (BlitRect){ 0 }, r->fresh = false;
		return &r->form;
	}
	const op_value *drawV = content->type == OP_MAP ? op_get(content, "draw") : NULL, *pixelsV = content->type == OP_MAP ? op_get(content, "pixels") : NULL;
	rest = rest && r->pixelsV == pixelsV;
	if (rest && r->drawV == drawV) {
		keepValue(&r->content, content);
		r->delta = (BlitRect){ 0 }, r->fresh = false;
		return &r->form;
	}
	Json *v = jsonOfValKept(content); // a hold of this call's
	Json *ops0 = jsonGet(v, "draw"), *pixels0 = jsonGet(v, "pixels");
	// only a rectangle of its plane changed: that alone copied into the form it has. A plane is at its
	// x, y in the layer (a page's, at its web), at most w × h, under the ops, or over them (a page's)
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
	bool above = truthy(jsonGet(plane, "over"));
	if (r && part && planed && r->form.w == w && r->form.h == h && r->drawV == drawV && r->pixelsV == pixelsV && r->over == over && same(r->sel, sel) && !usesStale(d, &r->uses)) {
		BlitRect c = meet(*part, (BlitRect){ 0, 0, pw, ph });
		BlitForm src = { hp.w, hp.h, hp.stride, (uint32_t *)hp.bits, NULL };
		planeCopy(&r->form, px + c.x, py + c.y, &src, c.x, c.y, c.w, c.h);
		c.x += px, c.y += py;
		keepValue(&r->content, content);
		hold(&r->plane, plane);
		r->n++;
		r->delta = c, r->fresh = false;
		jsonFree(v);
		return &r->form;
	}
	// its ops a splice of the last, all else the same: only where the ops between drew played again, into the form it has
	BlitRect damage;
	if (rest && !pixels0 && !planed && r->form.bits && !sel && jsonIsArray(ops0) && jsonIsArray(r->draw) && spliced(d, r->draw, ops0, w, h, &damage)) {
		if (damage.w && damage.h) {
			blitFill(&r->form, damage.x, damage.y, damage.w, damage.h, over ? BLIT_TRANSPARENT : 0, NULL);
			d->tally = &r->uses;
			Json *runs = blitPlayIn(d->blit, &r->form, ops0, fontOf, d, NULL, d->mark, &damage);
			d->tally = NULL;
			said(api, r, name, runs);
		}
		keepValue(&r->content, content);
		keepValue(&r->drawV, drawV);
		hold(&r->draw, ops0);
		r->n++;
		r->delta = damage, r->fresh = false;
		jsonFree(v);
		return &r->form;
	}
	// played again, it is compared with what it was: where they differ is all that changed
	BlitForm old = { 0 };
	if (!r) {
		ERM_PUSH(d->rendered, ((Rendered){ .name = copyString(name), .seen = true }));
		r = &d->rendered.items[d->rendered.count - 1];
	} else old = r->form;
	r->n++;
	keepValue(&r->content, content);
	keepValue(&r->drawV, drawV);
	keepValue(&r->pixelsV, pixelsV);
	hold(&r->draw, ops0);
	hold(&r->pixels, pixels0);
	hold(&r->plane, plane);
	hold(&r->sel, sel);
	r->over = over, r->w = w, r->h = h;
	r->form = blitForm(w, h, over ? BLIT_TRANSPARENT : 0);
	if (pixels0 && pixels0->type == JSON_TYPED && (pixels0->typed.kind == JSON_UINT32 || pixels0->typed.kind == JSON_INT32) && pixels0->typed.count >= (size_t)(w * h)) {
		BlitForm src = { w, h, w, pixels0->typed.data, NULL };
		blitBlit(&r->form, 0, 0, &src, 0, 0, w, h, BLIT_COPY, NULL);
	}
	// a plane: pixels in a driver's memory (hostPlane), copied here, so the driver may change them once this returns
	BlitForm src = planed ? (BlitForm){ hp.w, hp.h, hp.stride, (uint32_t *)hp.bits, NULL } : (BlitForm){ 0 };
	if (planed && !above && pw > 0 && ph > 0) planeCopy(&r->form, px, py, &src, 0, 0, pw, ph);
	usesReset(&r->uses);
	if (jsonIsArray(ops0)) {
		// where its text went, for whoever reads, selects or speaks it
		d->tally = &r->uses;
		Json *runs = blitPlay(d->blit, &r->form, ops0, fontOf, d, sel, d->mark);
		d->tally = NULL;
		said(api, r, name, runs);
	}
	if (planed && above && pw > 0 && ph > 0) planeCopy(&r->form, px, py, &src, 0, 0, pw, ph);
	r->fresh = !old.bits || old.w != w || old.h != h;
	if (!r->fresh && !differs(old.bits, &r->form, w, h, &r->delta)) r->delta = (BlitRect){ 0 };
	free(old.bits);
	jsonFree(v);
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

static void renderedFree(Rendered *r) {
	free(r->form.bits);
	free(r->name);
	jsonFree(r->runs);
	op_free((op_value *)r->content);
	op_free((op_value *)r->drawV);
	op_free((op_value *)r->pixelsV);
	jsonFree(r->draw);
	jsonFree(r->pixels);
	jsonFree(r->plane);
	jsonFree(r->sel);
	usesFree(&r->uses);
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
		renderedFree(r);
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

static void surfaceCommand(Display *d, const char *name, int x, int y, int w, int h, const char *title, bool key) {
	Json *c = drvMap("op", jsonString("surface"), "id", jsonString(name), "x", jsonInteger(x), "y", jsonInteger(y), "w", jsonInteger(w < d->maxw ? w : d->maxw),
	                 "h", jsonInteger(h < d->maxh ? h : d->maxh), "title", jsonString(title), NULL);
	if (key) jsonAdd(c, "key", jsonBoolean(true));
	hostCommand(d->host, c);
}

/** a surface told where it is, how big and its title, when that is not as it was last told */
static void surfaceTell(Display *d, Surface *s, int x, int y, int w, int h, const char *title) {
	w = w < d->maxw ? w : d->maxw, h = h < d->maxh ? h : d->maxh;
	if (s->told && s->tx == x && s->ty == y && s->tw == w && s->th == h && sameText(s->title, title)) return;
	surfaceCommand(d, s->name, x, y, w, h, title, false);
	s->told = true, s->tx = x, s->ty = y, s->tw = w, s->th = h;
	free(s->title);
	s->title = copyString(title);
}

/** the Mac's key window follows the focus: the surface told so, unless the Mac says it is key or it was asked already */
static void keyFollows(Display *d, Surface *s) {
	if (!s || !s->told || (d->macKey && !strcmp(d->macKey, s->name)) || (d->asked && !strcmp(d->asked, s->name))) return;
	surfaceCommand(d, s->name, s->tx, s->ty, s->tw, s->th, s->title ? s->title : "", true);
	free(d->asked);
	d->asked = copyString(s->name);
}

static void surfaceFree(Surface *s) {
	free(s->name);
	free(s->title);
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
static void windowsCompose(Display *d, const ErmPartApi *api, Json *layers, const char *focus) {
	int n = layers ? layers->array.count : 0;
	Json **sorted = malloc(sizeof *sorted * (size_t)(n ? n : 1));
	for (int i = 0; i < n; i++) sorted[i] = layers->array.items[i];
	qsort(sorted, (size_t)n, sizeof *sorted, cmpZ);
	for (int i = 0; i < d->surfaces.count; i++) d->surfaces.items[i].seen = d->surfaces.items[i].fresh = false;
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
			ERM_PUSH(d->surfaces, ((Surface){ .name = copyString(name), .fresh = true }));
			s = &d->surfaces.items[d->surfaces.count - 1];
		}
		s->seen = true;
		surfaceTell(d, s, x, y, w, h, title);
		BlitForm *form = render(d, api, l, contentOf(d, api, name), NULL);
		if (!form) continue;
		w = form->w < d->maxw ? form->w : d->maxw;
		h = form->h < d->maxh ? form->h : d->maxh;
		if (s->w != w || s->h != h) {
			free(s->shown);
			s->shown = NULL;
			s->w = w, s->h = h;
		}
		// a form not played again is as it was presented, but for pieces that found no room
		Rendered *made = renderedOf(d, name);
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
	// a window new this frame with the focus: the Mac's key window follows (the focus part does the rest)
	Surface *f = focus ? surfaceOf(d, focus) : NULL;
	if (f && f->fresh) keyFollows(d, f);
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
	free(t->title);
	jsonFree(t->mine);
	jsonFree(t->shape);
	jsonFree(t->theme);
	jsonFree(t->t);
	op_free((op_value *)t->content);
	usesFree(&t->chromeUses);
	chromeCacheFree(&t->cc);
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

/** a plane's next image, with dirty, when its serial is the next after the last: only that rectangle, at, changed */
static bool nextImage(const Json *plane, int64_t last, int64_t serial, BlitRect *at) {
	const Json *pd = jsonGet(plane, "dirty");
	int64_t dx = whole(jsonGet(pd, "x"), -1), dy = whole(jsonGet(pd, "y"), -1), dw = whole(jsonGet(pd, "w"), -1), dh = whole(jsonGet(pd, "h"), -1);
	*at = (BlitRect){ (int)dx, (int)dy, (int)dw, (int)dh };
	return serial >= 0 && serial == last + 1 && dx >= 0 && dy >= 0 && dw >= 0 && dh >= 0;
}

static bool sameGeo(const Geo *a, const Geo *b) {
	return a->x == b->x && a->y == b->y && a->w == b->w && a->h == b->h && a->z == b->z && a->shaded == b->shaded && a->color == b->color && a->opacity == b->opacity &&
	       a->radius == b->radius && a->sx == b->sx && a->sy == b->sy && !memcmp(a->rad, b->rad, sizeof a->rad) && a->drop == b->drop;
}

/**
 * a frame in layers mode: each layer a tile, its chrome and content in one
 * form; where it is, its depth and its shadow told when they change, with no
 * pixels; what changed in its form since it was last painted packed beside
 * the others into the back buffer, painted at the next vsync in the same
 * command. So a window dragged is told where, a caret blinking paints a
 * caret, and tiles whose layer went are dropped
 */
static void layersCompose(Display *d, const ErmPartApi *api, Json *layers, const char *focus, const Json *theme, const Theme *T, int u) {
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
		const char *name = jsonText(jsonGet(l, "name")), *title = jsonText(jsonGet(l, "title"));
		int x = (int)whole(jsonGet(l, "x"), 0), y = (int)whole(jsonGet(l, "y"), 0), w = (int)whole(jsonGet(l, "w"), 0), h = (int)whole(jsonGet(l, "h"), 0);
		double z = jsonIsNumber(jsonGet(l, "z")) ? jsonGet(l, "z")->number : 0;
		bool collapsed = truthy(jsonGet(l, "collapsed")), over = truthy(jsonGet(l, "over")), titled = jsonIsString(jsonGet(l, "title")), on = focus && !strcmp(focus, name);
		Tile *t = tileOf(d, name);
		if (!t) {
			ERM_PUSH(d->tiles, ((Tile){ .name = copyString(name), .serial = -1 }));
			t = &d->tiles.items[d->tiles.count - 1];
		}
		t->seen = true;
		// the tile: a window's frame, title bar and hard shadow (System 7's, a point down and right), around its content, as its chrome says
		Chrome shape = { 0 };
		const Chrome *ch = &shape;
		bool shaped = false;
		if (titled) ch = chromeAt(d, &t->cc, theme, T, l, on, u, NULL);
		else shaped = shapeOf(l, theme, u, &shape);
		BlitRect frame = titled ? frameOf(ch, x, y, w, h, collapsed) : (BlitRect){ x, y, w, h };
		int rad[4] = { 0 };
		bool curved = (titled || shaped) && radii(ch, frame, rad);
		BlitRect box = { frame.x, frame.y, frame.w + ch->drop, frame.h + ch->drop }, inner = { 0, 0, frame.w, frame.h };
		if (box.w > d->maxw) box.w = d->maxw;
		if (box.h > d->maxh) box.h = d->maxh;
		// a plane's next image, with dirty: only that rectangle copied into its content
		Json *when = jsonGet(l, "t"), *plane = jsonGet(l, "plane");
		const op_value *content = contentOf(d, api, name);
		int64_t serial = whole(jsonGet(plane, "serial"), -1);
		BlitRect at;
		bool part = t->content && (t->content != content || !same(t->t, when)) && nextImage(plane, t->serial, serial, &at);
		keepValue(&t->content, content);
		hold(&t->t, when);
		t->serial = serial;
		BlitForm *form = render(d, api, l, content, part ? &at : NULL);
		if (!form) continue;
		Rendered *made = renderedOf(d, name);
		// its form made again when what it holds or its chrome changed: painted where it differs from the last
		const Json *mine = jsonGet(l, "chrome"), *sh = jsonGet(l, "shape");
		bool rest = t->made && t->bw == box.w && t->bh == box.h && t->titled == titled && t->on == on && t->collapsed == collapsed && sameText(t->title, title) && t->u == u &&
		            same(t->mine, mine) && same(t->shape, sh) && same(t->theme, theme) && !usesStale(d, &t->chromeUses);
		bool paint = false, waits = false, keep = rest && t->n == made->n;
		BlitRect r = { 0, 0, box.w, box.h };
		if (!keep && rest && made->n == t->n + 1 && !made->fresh && !over && !collapsed && t->form.bits && t->form.w == box.w && t->form.h == box.h) {
			// only what it holds changed, once, where its render says: that alone copied into the tile it has, and painted
			int cx = titled ? ch->border : 0, cy = titled ? ch->tb + ch->border : 0;
			BlitRect c = made->delta;
			r = meet((BlitRect){ cx + c.x, cy + c.y, c.w, c.h }, meet((BlitRect){ cx, cy, form->w, form->h }, (BlitRect){ 0, 0, box.w, box.h }));
			paint = r.w > 0 && r.h > 0;
			if (paint && sx + r.w > d->maxw) sx = 0, sy += rowH, rowH = 0;
			if (paint && sy + r.h > d->maxh) {
				// no room this frame: painted in the next, the tile as it was
				d->held = true;
				paint = false;
			} else {
				if (paint) {
					blitBlit(&t->form, r.x, r.y, form, r.x - cx, r.y - cy, r.w, r.h, BLIT_COPY, NULL);
					if (curved) corners(&t->form, &r, inner, rad, ch, NULL);
					blitBlit(&fb, sx, sy, &t->form, r.x, r.y, r.w, r.h, BLIT_COPY, NULL);
				}
				t->n = made->n;
			}
		} else if (!keep) {
			BlitForm next = blitForm(box.w, box.h, BLIT_TRANSPARENT);
			BlitRect clip = { 0, 0, box.w, box.h };
			int cx = titled ? ch->border : 0, cy = titled ? ch->tb + ch->border : 0;
			if (titled) {
				Json *lent = lentAt(l, cx, cy);
				chromeTallied(d, &next, &clip, ch, lent, &t->chromeUses);
				lentFree(lent);
			} else usesReset(&t->chromeUses);
			if (!collapsed) blitBlit(&next, cx, cy, form, 0, 0, form->w, form->h, over ? BLIT_OVER : BLIT_COPY, &clip);
			if (curved) corners(&next, &clip, inner, rad, ch, NULL);
			paint = !t->form.bits || t->form.w != box.w || t->form.h != box.h || differs(t->form.bits, &next, box.w, box.h, &r);
			if (paint && sx + r.w > d->maxw) sx = 0, sy += rowH, rowH = 0;
			if (paint && sy + r.h > d->maxh) {
				// no room this frame: made again and painted in the next
				d->held = true;
				paint = false;
				waits = t->form.w != box.w || t->form.h != box.h;
				free(next.bits);
				t->made = false;
			} else {
				if (paint) blitBlit(&fb, sx, sy, &next, r.x, r.y, r.w, r.h, BLIT_COPY, NULL);
				free(t->form.bits);
				t->form = next;
				t->made = true, t->n = made->n, t->bw = box.w, t->bh = box.h, t->titled = titled, t->on = on, t->collapsed = collapsed, t->u = u;
				free(t->title);
				t->title = title ? copyString(title) : NULL;
				hold(&t->mine, mine);
				hold(&t->shape, sh);
				hold(&t->theme, theme);
			}
		}
		Shade S = ch->shadow;
		memcpy(S.corner, rad, sizeof rad);
		Geo geo = { box.x, box.y, box.w, box.h, z, (titled || shaped) && S.on, S.color, S.opacity, S.radius, S.x, S.y, { rad[0], rad[1], rad[2], rad[3] }, ch->drop };
		// resized, it is told so with its new pixels, never before them
		bool moved = !waits && (!t->told || !sameGeo(&t->geo, &geo));
		if (!moved && !paint) continue;
		Json *item = drvMap("id", jsonString(name), NULL);
		if (moved) {
			jsonAdd(item, "x", jsonInteger(box.x));
			jsonAdd(item, "y", jsonInteger(box.y));
			jsonAdd(item, "w", jsonInteger(box.w));
			jsonAdd(item, "h", jsonInteger(box.h));
			jsonAdd(item, "z", jsonNumber(z));
			// a window's soft shadow, cast by its frame (the tile less the hard shadow), as /etc/theme's shadow says, in points
			if ((titled || shaped) && S.on) {
				Json *shj = drvMap("color", jsonInteger(S.color), "opacity", jsonNumber(S.opacity), "radius", jsonNumber(S.radius), "x", jsonNumber(S.x), "y", jsonNumber(S.y), "box",
				                   drvMap("x", jsonInteger(0), "y", jsonInteger(0), "w", jsonInteger(box.w - ch->drop), "h", jsonInteger(box.h - ch->drop), NULL), NULL);
				if (curved) jsonAdd(shj, "corners", cornersJson(rad));
				jsonAdd(item, "shadow", jsonRef(shj));
			} else jsonAdd(item, "shadow", jsonNull());
			// its rounded corners: only its frame, rounded, and that again drop down and right, is shown
			if (curved)
				jsonAdd(item, "shape", jsonRef(drvMap("box", drvMap("x", jsonInteger(0), "y", jsonInteger(0), "w", jsonInteger(box.w - ch->drop), "h", jsonInteger(box.h - ch->drop), NULL), "corners",
				                                      cornersJson(rad), "drop", jsonInteger(ch->drop), NULL)));
			t->told = true;
			t->geo = geo;
		}
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

// --- the full-frame path: the frame buffer, drawn again only where something changed

/** a layer as the summary gives it, the same but for when its value changed and its plane's image */
static bool sameLayer(const Json *a, const Json *b) {
	if (!jsonIsObject(a) || !jsonIsObject(b)) return false;
	int na = 0, nb = 0;
	for (int k = 0; k < a->object.count; k++) {
		const char *key = a->object.members[k].key;
		if (!strcmp(key, "t") || !strcmp(key, "plane")) continue;
		na++;
		const Json *bv = jsonGet(b, key);
		if (!bv || !jsonEqual(bv, a->object.members[k].value)) return false;
	}
	for (int k = 0; k < b->object.count; k++)
		if (strcmp(b->object.members[k].key, "t") && strcmp(b->object.members[k].key, "plane")) nb++;
	return na == nb && samePlace(jsonGet(a, "plane"), jsonGet(b, "plane"));
}

static void drawnFree(Drawn *dr) {
	free(dr->name);
	jsonFree(dr->l);
	jsonFree(dr->sel);
	jsonFree(dr->t);
	op_free((op_value *)dr->content);
	usesFree(&dr->chromeUses);
	chromeCacheFree(&dr->cc);
}

static Drawn *drawnOf(Display *d, const char *name) {
	for (int k = 0; k < d->drawn.count; k++) if (d->drawn.items[k].name && !strcmp(d->drawn.items[k].name, name)) return &d->drawn.items[k];
	return NULL;
}

static void frameCompose(Display *d, const ErmPartApi *api, Json *layers, const char *focus, const Json *theme, const Theme *T, int u, int W, int H) {
	int n = layers ? layers->array.count : 0;
	BlitRect screen = { 0, 0, W, H };
	// what changed since the last frame: only that is drawn again
	Damage dirty = { 0 };
	if (!d->wholeMade || d->wholeW != W || d->wholeH != H || d->wholeU != u || !same(d->wholeTheme, theme)) damageAdd(&dirty, screen);
	d->wholeMade = true, d->wholeW = W, d->wholeH = H, d->wholeU = u;
	hold(&d->wholeTheme, theme);
	ERM_LIST(Drawn) now = { 0 };
	for (int i = 0; i < n; i++) {
		Json *l = layers->array.items[i];
		const char *name = jsonText(jsonGet(l, "name"));
		int x = (int)whole(jsonGet(l, "x"), 0), y = (int)whole(jsonGet(l, "y"), 0), w = (int)whole(jsonGet(l, "w"), 0), h = (int)whole(jsonGet(l, "h"), 0);
		bool collapsed = truthy(jsonGet(l, "collapsed")), titled = jsonIsString(jsonGet(l, "title")), on = focus && !strcmp(focus, name);
		Json *sel = selectionOn(d, name), *t = jsonGet(l, "t"), *plane = jsonGet(l, "plane");
		// carried on from the last frame, or new
		Drawn *was = drawnOf(d, name);
		Drawn dn = { 0 };
		if (was) {
			dn = *was;
			was->name = NULL; // moved
		} else dn.name = copyString(name);
		const Chrome *ch = titled ? chromeAt(d, &dn.cc, theme, T, l, on, u, NULL) : NULL;
		BlitRect frame = titled ? frameOf(ch, x, y, w, h, collapsed) : (BlitRect){ x, y, w, h };
		BlitRect rect = { frame.x, frame.y, frame.w + (ch ? ch->drop : 0), frame.h + (ch ? ch->drop : 0) };
		// a titled one's soft shadow is its too
		if (titled && ch->shadow.on) rect = unite(rect, shadowRect(frame, &ch->shadow));
		// what it is and where, apart from when its value changed and its plane's image: the same, only what it draws can have changed
		bool kept = was && sameLayer(dn.l, l) && dn.on == on && same(dn.sel, sel) && !usesStale(d, &dn.chromeUses);
		const op_value *content = contentOf(d, api, name);
		int64_t serial = whole(jsonGet(plane, "serial"), -1);
		BlitRect at = { 0 };
		bool changed = !dn.content || dn.content != content || !same(dn.t, t);
		bool next = kept && dn.content && changed && nextImage(plane, dn.serial, serial, &at);
		Rendered *made = renderedOf(d, name);
		if (!kept) {
			// moved, only where it was and is no more beside where it is
			damageAdd(&dirty, rect);
			if (was) damageLess(&dirty, was->rect, rect);
			usesReset(&dn.chromeUses);
		} else if (changed || (made && usesStale(d, &made->uses))) {
			// its value changed: a plane's next image, with dirty, is only that rectangle; anything else all of it.
			// A layer with ops too (Paint's) has them played over its plane: one changing them writes no dirty.
			// Or a font it drew with changed: played again, where it differs
			BlitRect r = collapsed ? (BlitRect){ 0 } : (BlitRect){ x, y, w, h };
			if (next) {
				// in the layer, at the plane's place
				int px = (int)whole(jsonGet(plane, "x"), 0), py = (int)whole(jsonGet(plane, "y"), 0);
				r = meet((BlitRect){ x + px + at.x, y + py + at.y, at.w, at.h }, (BlitRect){ x, y, w, h });
			} else if (!collapsed) {
				// what it draws changed (its chrome is in its key): played now, where it differs from what it was is all
				(void)render(d, api, l, content, NULL);
				made = renderedOf(d, name);
				if (made && !made->fresh) r = meet((BlitRect){ x + made->delta.x, y + made->delta.y, made->delta.w, made->delta.h }, (BlitRect){ x, y, w, h });
			}
			damageAdd(&dirty, r);
		}
		dn.rect = rect, dn.on = on, dn.serial = serial, dn.part = next, dn.at = at;
		keepValue(&dn.content, content);
		hold(&dn.l, l);
		hold(&dn.sel, sel);
		hold(&dn.t, t);
		ERM_PUSH(now, dn);
	}
	for (int k = 0; k < d->drawn.count; k++) {
		if (!d->drawn.items[k].name) continue;
		damageAdd(&dirty, d->drawn.items[k].rect);
		drawnFree(&d->drawn.items[k]);
	}
	free(d->drawn.items);
	d->drawn.items = now.items, d->drawn.count = now.count, d->drawn.capacity = now.capacity;
	// each buffer keeps what changed since it was last drawn into; the back one draws that
	for (int i = 0; i < dirty.n; i++) {
		for (int b = 0; b < 2; b++) damageAdd(&d->damage[b], dirty.r[i]);
		d->change = d->changed ? unite(d->change, dirty.r[i]) : dirty.r[i], d->changed = true;
	}
	int back = 1 - d->front;
	if (!d->damage[back].n) return;
	Damage todo = d->damage[back];
	d->damage[back].n = 0;
	BlitForm fb = { d->maxw, d->maxh, d->maxw, hostConfig(d->host)->buffers[back], NULL };
	Json **sorted = malloc(sizeof *sorted * (size_t)(n ? n : 1));
	for (int i = 0; i < n; i++) sorted[i] = layers->array.items[i];
	qsort(sorted, (size_t)n, sizeof *sorted, cmpZ);
	for (int tt = 0; tt < todo.n; tt++) {
		BlitRect clip = meet(todo.r[tt], screen);
		if (clip.w <= 0 || clip.h <= 0) continue;
		// what is under a layer that covers all of it is not drawn: from the topmost such, up
		int from = -1;
		for (int i = n - 1; i >= 0 && from < 0; i--) {
			Json *l = sorted[i];
			if (truthy(jsonGet(l, "over"))) continue;
			int x = (int)whole(jsonGet(l, "x"), 0), y = (int)whole(jsonGet(l, "y"), 0), w = (int)whole(jsonGet(l, "w"), 0), h = (int)whole(jsonGet(l, "h"), 0);
			const char *name = jsonText(jsonGet(l, "name"));
			if (!jsonIsString(jsonGet(l, "title"))) {
				// shaped, its corners cover nothing
				if (!jsonIsObject(jsonGet(l, "shape")) && inside(clip, (BlitRect){ x, y, w, h })) from = i;
				continue;
			}
			Drawn *dr = drawnOf(d, name);
			if (!dr) continue;
			const Chrome *ch = chromeAt(d, &dr->cc, theme, T, l, dr->on, u, NULL);
			BlitRect solid = frameOf(ch, x, y, w, h, truthy(jsonGet(l, "collapsed")));
			int rad[4], top, bottom;
			// rounded, its corners cover nothing
			if (radii(ch, solid, rad)) {
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
			Drawn *dr = drawnOf(d, name);
			if (!dr || !meets(dr->rect, clip)) continue;
			BlitForm *form = render(d, api, l, dr->content, dr->part ? &dr->at : NULL);
			if (!form) continue;
			bool collapsed = truthy(jsonGet(l, "collapsed")), over = truthy(jsonGet(l, "over"));
			int x = (int)whole(jsonGet(l, "x"), 0), y = (int)whole(jsonGet(l, "y"), 0);
			int rad[4] = { 0 };
			bool curved = false;
			Chrome shape = { 0 };
			const Chrome *ch = &shape;
			BlitRect frame = { 0 };
			Under back = { 0 };
			if (jsonIsString(jsonGet(l, "title"))) {
				ch = chromeAt(d, &dr->cc, theme, T, l, dr->on, u, NULL);
				frame = frameOf(ch, x, y, (int)whole(jsonGet(l, "w"), 0), (int)whole(jsonGet(l, "h"), 0), collapsed);
				curved = radii(ch, frame, rad);
				if (ch->shadow.on) {
					Shade S = ch->shadow;
					memcpy(S.corner, rad, sizeof rad);
					shadow(&fb, &clip, frame, &S, over);
				}
				// rounded: what is about its corners now, shadow and all, to put back outside them
				if (curved) back = underOf(&fb, (BlitRect){ frame.x, frame.y, frame.w + ch->drop, frame.h + ch->drop }, rad, ch->drop);
				chromeTallied(d, &fb, &clip, ch, l, &dr->chromeUses);
			} else if (shapeOf(l, theme, u, &shape)) {
				// shaped: its shadow, and its corners rounded, as a window's
				frame = (BlitRect){ x, y, (int)whole(jsonGet(l, "w"), 0), (int)whole(jsonGet(l, "h"), 0) };
				curved = radii(ch, frame, rad);
				if (ch->shadow.on) {
					memcpy(shape.shadow.corner, rad, sizeof rad);
					shadow(&fb, &clip, frame, &shape.shadow, over);
				}
				if (curved) back = underOf(&fb, frame, rad, 0);
			}
			if (!collapsed) blitBlit(&fb, x, y, form, 0, 0, form->w, form->h, over ? BLIT_OVER : BLIT_COPY, &clip);
			if (curved) {
				corners(&fb, &clip, frame, rad, ch, &back);
				free(back.bits);
			}
		}
	}
	free(sorted);
	d->waiting = true;
	d->waitBuffer = back;
	d->waitW = W;
	d->waitH = H;
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
	facesSync(d, jsonGet(v, "fonts"));
	hold(&d->selection, jsonGet(v, "selection"));
	Json *theme = jsonGet(v, "theme");
	Theme T = { colour(theme, "paper", 0xfdf8ea), colour(theme, "ink", 0x2a2228), colour(theme, "ink2", 0x6b5a66),
	            colour(theme, "line", 0x1c1a17), colour(theme, "chrome", 0xece5d4), colour(theme, "select", 0xffff88) };
	d->mark = T.select;
	int u = (int)whole(jsonGet(mode, "unit"), 1);
	if (u < 1) u = 1;
	int W = (int)whole(jsonGet(mode, "w"), d->maxw), H = (int)whole(jsonGet(mode, "h"), d->maxh);
	if (W > d->maxw) W = d->maxw;
	if (H > d->maxh) H = d->maxh;
	const char *focus = jsonText(jsonGet(v, "focus"));
	Json *layers = jsonGet(v, "layers");
	bool windowsMode = truthy(jsonGet(mode, "windows"));
	d->layered = !windowsMode && truthy(jsonGet(mode, "layers"));
	// one frame a refresh: while one waits for its vsync, this is held, and composed once it is flipped
	if (d->waiting) {
		d->held = true;
		d->api = NULL;
		return ermOk();
	}
	if (windowsMode) {
		windowsCompose(d, g->api, layers, focus);
		forget(d, g->api, layers, true);
		// the monitor, when it comes back, is drawn whole: the buffers held windows meanwhile
		d->wholeMade = false;
	} else if (d->layered) {
		layersCompose(d, g->api, layers, focus, theme, &T, u);
		forget(d, g->api, layers, false);
		// the frame buffer, should the metal stop stacking, is drawn whole: the buffers held pieces of tiles meanwhile
		d->wholeMade = false;
	} else {
		frameCompose(d, g->api, layers, focus, theme, &T, u, W, H);
		forget(d, g->api, layers, false);
	}
	d->api = NULL;
	return ermOk();
}

// --- the windows part: /dev/display/windows/<name>, each layer as it is, with a titled one's chrome parts on the monitor

static ErmErr windowsCompute(void *data, const ErmGiven *g, Json **out) {
	Display *d = data;
	const ErmPartApi *api = g->api;
	Json *L = drvRead(api, drvUnder(d->here, "layers", NULL));
	Json *F = drvRead(api, drvUnder(d->here, "fonts", NULL));
	Json *theme = drvRead(api, drvPath("/", "etc", "theme", NULL));
	Json *mode = drvRead(api, drvPath("/", "dev", "display", "mode", NULL));
	Json *W = jsonGet(L, "windows");
	int64_t u = whole(jsonGet(mode, "unit"), 1);
	bool wm = truthy(jsonGet(mode, "windows"));
	// nothing it writes from changed: its value as before, so its effect does not act
	Json *o = d->winOut;
	if (o && same(jsonGet(o, "windows"), W) && jsonGet(o, "theme") == theme && jsonGet(o, "fonts") == F && whole(jsonGet(o, "unit"), 1) == u && truthy(jsonGet(o, "mode")) == wm) {
		*out = jsonRef(o);
		return ermOk();
	}
	*out = drvMap("windows", jsonIsObject(W) ? jsonRef(W) : jsonObject(), "theme", theme ? theme : jsonNull(), "fonts", F ? F : jsonNull(), "unit", jsonInteger(u), "mode",
	              jsonBoolean(wm), NULL);
	return ermOk();
}

static void winFree(Win *w) {
	jsonFree(w->written);
	jsonFree(w->parts);
	chromeCacheFree(&w->cc);
	free(w);
}

static ErmErr windowsEffect(void *data, const ErmGiven *g, Json **out) {
	Display *d = data;
	*out = jsonNull();
	Json *v = g->value;
	hold(&d->winOut, v);
	d->api = g->api;
	facesSync(d, jsonGet(v, "fonts"));
	Json *theme = jsonGet(v, "theme"), *all = jsonGet(v, "windows");
	Theme T = { colour(theme, "paper", 0xfdf8ea), colour(theme, "ink", 0x2a2228), colour(theme, "ink2", 0x6b5a66),
	            colour(theme, "line", 0x1c1a17), colour(theme, "chrome", 0xece5d4), colour(theme, "select", 0xffff88) };
	int u = (int)whole(jsonGet(v, "unit"), 1);
	if (u < 1) u = 1;
	bool windowsMode = truthy(jsonGet(v, "mode"));
	// each window, as it is, when it changed; on the monitor each titled one with where its chrome's parts are, for clicks
	ErmMap seen = { 0 };
	for (int i = 0; jsonIsObject(all) && i < all->object.count; i++) {
		const char *name = all->object.members[i].key;
		Json *wl = all->object.members[i].value, *m = wl;
		bool titled = !windowsMode && jsonIsString(jsonGet(wl, "title"));
		Win *w = ermMapGet(&d->windows, name);
		if (!w) {
			w = calloc(1, sizeof *w);
			ermMapPut(&d->windows, name, w);
		}
		ermMapPut(&seen, name, (void *)1);
		// written as it is or, titled, a copy with its chrome's parts, kept with what they were made from
		if (!titled) m = jsonRef(wl);
		else {
			bool fresh;
			const Chrome *ch = chromeAt(d, &w->cc, theme, &T, wl, true, u, &fresh);
			int ww = (int)whole(jsonGet(wl, "w"), 0), hh = (int)whole(jsonGet(wl, "h"), 0);
			bool collapsed = truthy(jsonGet(wl, "collapsed"));
			if (!w->parts || fresh || w->pw != ww || w->ph != hh || w->pcollapsed != collapsed) {
				jsonFree(w->parts);
				w->parts = jsonRef(partsOf(ch, ww, hh, collapsed));
				w->pw = ww, w->ph = hh, w->pcollapsed = collapsed;
			}
			m = jsonShallow(wl);
			jsonAdd(m, "parts", jsonRef(w->parts));
		}
		if (w->written && jsonEqual(w->written, m)) {
			jsonFree(m);
			continue;
		}
		hold(&w->written, m);
		Json *at = drvPath("/", "dev", "display", "windows", name, NULL);
		if (drvHas(g->api, at)) drvSnap(g->api, at, m);
		else {
			char *id = formatString("display/windows/%s", name);
			drvMake(g->api, drvPath("/", "dev", "display", "windows", NULL), name, id, m);
			free(id);
		}
	}
	// layers gone: their windows
	for (int i = 0; i < d->windows.count; i++) {
		const char *name = d->windows.entries[i].key;
		if (!d->windows.entries[i].value || ermMapHas(&seen, name)) continue;
		char *id = formatString("display/windows/%s", name);
		drvOp(g->api, "unplace", drvMap("address", drvPath("/", "dev", "display", "windows", NULL), "name", jsonString(name), "id", jsonString(id), NULL));
		free(id);
		winFree(d->windows.entries[i].value);
		ermMapPut(&d->windows, name, NULL);
	}
	mapFree(&seen);
	d->api = NULL;
	return ermOk();
}

// --- the pages part: web pages' sizes, each as a layer shows it, told the metal when they change (webshow)

static ErmErr pagesCompute(void *data, const ErmGiven *g, Json **out) {
	Display *d = data;
	const ErmPartApi *api = g->api;
	Json *L = drvRead(api, drvUnder(d->here, "layers", NULL)), *layers = jsonGet(L, "layers");
	Json *mode = drvRead(api, drvPath("/", "dev", "display", "mode", NULL));
	Json *pages = jsonObject();
	for (int i = 0; jsonIsArray(layers) && i < layers->array.count; i++) {
		Json *l = layers->array.items[i], *web = jsonGet(l, "web");
		const char *id = jsonText(jsonGet(web, "id"));
		if (!id || truthy(jsonGet(l, "collapsed"))) continue;
		int w = (int)whole(jsonGet(web, "w"), 0), h = (int)whole(jsonGet(web, "h"), 0);
		if (w <= 0 || h <= 0) continue;
		Json *size = jsonObject();
		jsonAdd(size, "w", jsonInteger(w));
		jsonAdd(size, "h", jsonInteger(h));
		jsonAdd(pages, id, size);
	}
	// the mode too: told again in either mode, and at another size (displayIrq forgets what was told then)
	Json *m = drvMap("pages", pages, "windows", jsonBoolean(truthy(jsonGet(mode, "windows"))), "layers", jsonBoolean(truthy(jsonGet(mode, "layers"))), "w",
	                 jsonInteger(whole(jsonGet(mode, "w"), 0)), "h", jsonInteger(whole(jsonGet(mode, "h"), 0)), NULL);
	if (d->pagesOut && jsonEqual(d->pagesOut, m)) {
		*out = jsonRef(d->pagesOut);
		return ermOk();
	}
	*out = m;
	return ermOk();
}

/**
 * web pages: each one's size, as a layer shows it, told the metal when it
 * changes (webshow), so it draws at that size; w 0 for one no layer shows
 * (hidden, collapsed, in another view, gone), which draws nothing
 */
static ErmErr pagesEffect(void *data, const ErmGiven *g, Json **out) {
	Display *d = data;
	*out = jsonNull();
	hold(&d->pagesOut, g->value);
	Json *pages = jsonGet(g->value, "pages");
	for (int i = 0; jsonIsObject(pages) && i < pages->object.count; i++) {
		const char *id = pages->object.members[i].key;
		Json *size = pages->object.members[i].value, *was = ermMapGet(&d->placed, id);
		if (was && jsonEqual(was, size)) continue;
		hostCommand(d->host, drvMap("op", jsonString("webshow"), "id", jsonString(id), "w", jsonInteger(whole(jsonGet(size, "w"), 0)), "h", jsonInteger(whole(jsonGet(size, "h"), 0)), NULL));
		jsonFree(was);
		ermMapPut(&d->placed, id, jsonRef(size));
	}
	for (int i = 0; i < d->placed.count; i++) {
		const char *id = d->placed.entries[i].key;
		if (!d->placed.entries[i].value || jsonGet(pages, id)) continue;
		hostCommand(d->host, drvMap("op", jsonString("webshow"), "id", jsonString(id), "w", jsonInteger(0), "h", jsonInteger(0), NULL));
		jsonFree(d->placed.entries[i].value);
		ermMapPut(&d->placed, id, NULL);
	}
	return ermOk();
}

// --- the focus part: windows mode, the Mac's key window follows /dev/display/focus

static ErmErr focusCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	Json *focus = drvRead(g->api, drvPath("/", "dev", "display", "focus", NULL));
	Json *mode = drvRead(g->api, drvPath("/", "dev", "display", "mode", NULL));
	*out = drvMap("focus", focus ? focus : jsonNull(), "windows", jsonBoolean(truthy(jsonGet(mode, "windows"))), NULL);
	return ermOk();
}

static ErmErr focusEffect(void *data, const ErmGiven *g, Json **out) {
	Display *d = data;
	*out = jsonNull();
	const char *focus = jsonText(jsonGet(g->value, "focus"));
	if (!truthy(jsonGet(g->value, "windows")) || !focus) return ermOk();
	keyFollows(d, surfaceOf(d, focus));
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
			bool on = truthy(jsonGet(r, "windows"));
			bool stacked = !on && truthy(jsonGet(r, "layers"));
			// back on the monitor, the metal has closed every surface; off it, or not stacking, it has emptied its stack; web pages' sizes are told again, in either.
			// Only when that changed: a mode that says only something else (takeover, the screen's name) leaves all as it is
			Json *was = drvRead(g->api, drvPath("/", "dev", "display", "mode", NULL));
			Json *ww = jsonGet(was, "windows"), *wl = jsonGet(was, "layers");
			bool same_ = jsonIsObject(was) && ww && ww->type == JSON_BOOLEAN && ww->boolean == on && wl && wl->type == JSON_BOOLEAN && wl->boolean == stacked &&
			             whole(jsonGet(was, "w"), -1) == whole(jsonGet(r, "w"), -2) && whole(jsonGet(was, "h"), -1) == whole(jsonGet(r, "h"), -2);
			if (!same_) {
				if (!on) unsurfaceAll(d);
				if (!stacked) unlayerAll(d);
				for (int k = 0; k < d->placed.count; k++) {
					jsonFree(d->placed.entries[k].value);
					d->placed.entries[k].value = NULL;
				}
			}
			drvSnap(g->api, drvPath("/", "dev", "display", "mode", NULL),
			        drvMap("w", jsonShallow(jsonGet(r, "w")), "h", jsonShallow(jsonGet(r, "h")), "scale", jsonShallow(jsonGet(r, "scale")),
			               "unit", jsonGet(r, "unit") ? jsonShallow(jsonGet(r, "unit")) : jsonInteger(1), "screen", jsonGet(r, "screen") ? jsonShallow(jsonGet(r, "screen")) : jsonNull(),
			               "fullscreen", jsonGet(r, "fullscreen") ? jsonShallow(jsonGet(r, "fullscreen")) : jsonBoolean(false),
			               "windows", jsonBoolean(on), "layers", jsonBoolean(stacked), "focused", jsonBoolean(true),
			               "takeover", jsonBoolean(truthy(jsonGet(r, "takeover"))),
			               "keys", jsonIsString(jsonGet(r, "keys")) ? jsonShallow(jsonGet(r, "keys")) : jsonString("off"), NULL));
		} else if (!strcmp(e, "moved")) {
			// the person moved a Mac window: its layer is where the Mac says, as the hardware's change
			const char *id = jsonText(jsonGet(r, "id"));
			Json *at = id ? drvPath("/", "dev", "display", "layers", id, NULL) : NULL;
			Json *l = at ? drvRead(g->api, at) : NULL;
			if (!jsonIsObject(l)) continue;
			int64_t x = whole(jsonGet(r, "x"), 0), y = whole(jsonGet(r, "y"), 0);
			Surface *s = surfaceOf(d, id);
			if (s && s->told) s->tx = (int)x, s->ty = (int)y;
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
	// {on}: whether the focus and a window mid-drag go out with this device's live state (card/drv_sync.c, Live state)
	drvMake(g->api, dev, "live", "display/live", drvMap("on", jsonBoolean(true), NULL));
	Json *here = drvHere(g);
	d->here = jsonRef(here);
	drvHandler(g, here, "irq", (ErmFn){ displayIrq, d });
	drvClaim(g, here, 33);
	// the summaries first, so what reads them finds them
	drvChild(g, here, "fonts", (ErmFn){ fontsCompute, d }, (ErmFn){ 0 });
	drvChild(g, here, "layers", (ErmFn){ layersCompute, d }, (ErmFn){ 0 });
	drvChild(g, here, "compose", (ErmFn){ composeCompute, d }, (ErmFn){ composeEffect, d });
	drvChild(g, here, "windows", (ErmFn){ windowsCompute, d }, (ErmFn){ windowsEffect, d });
	drvChild(g, here, "pages", (ErmFn){ pagesCompute, d }, (ErmFn){ pagesEffect, d });
	drvChild(g, here, "focus", (ErmFn){ focusCompute, d }, (ErmFn){ focusEffect, d });
	drvChild(g, here, "want", (ErmFn){ wantCompute, d }, (ErmFn){ wantEffect, d });
	drvChild(g, here, "corner", (ErmFn){ cornerCompute, d }, (ErmFn){ cornerEffect, d });
	drvChild(g, here, "keys", (ErmFn){ keysCompute, d }, (ErmFn){ keysEffect, d });
	drvChild(g, here, "menus", (ErmFn){ menusCompute, d }, (ErmFn){ menusEffect, d });
	return ermOk();
}
