// drv_font.c
// drv_font.c: the font driver (irq 50), as image/drivers/font.js was, with
// fonts as data (../ERMINEOS.md, Fonts). /etc/theme's "fonts" names a font
// for each role, {name, size in points, bold}; this asks the metal's font
// chip for it at the screen's unit, page 0 first, and keeps
// /dev/font/<role>, {font: role, family, size, h, ascent}, with a node
// pages/<n> for each page that has come: {w, h, info (1024 numbers, a
// float64 array), alpha (bytes)}. A page not here is asked for by calling
// on/want with the role and the page, as the blitter does when it meets a
// character from one.
//
// The fonts that come with the OS, beside its image (../fonts, a folder for
// each family, its .ttf or .otf files and their licence), are registered for
// this process as it starts, as an app's own fonts are: so the font chip,
// CoreText in this process, finds them by name, in the app and headless
// alike, and nothing is installed on the Mac.

#include "drivers.h"
#include "drv.h"

#include <CoreText/CoreText.h>
#include <dirent.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

typedef struct Face {
	char *name;
	double size;
	bool bold;
	bool metrics;
	Json *family;
	int h, ascent;
	ERM_LIST(int) asked;
	ERM_LIST(int) pages;
} Face;

typedef struct Fonts {
	Host *host;
	ERM_LIST(Face *) faces;
	ERM_LIST(const char *) roles; // role i is face faces of roleFace[i]
	ERM_LIST(Face *) roleFace;
} Fonts;

static bool has(const int *list, int count, int n) {
	for (int i = 0; i < count; i++) if (list[i] == n) return true;
	return false;
}

static Face *face(Fonts *f, const char *name, double size, bool bold) {
	for (int i = 0; i < f->faces.count; i++) {
		Face *x = f->faces.items[i];
		if (!strcmp(x->name, name) && x->size == size && x->bold == bold) return x;
	}
	Face *x = calloc(1, sizeof *x);
	x->name = copyString(name);
	x->size = size;
	x->bold = bold;
	ERM_PUSH(f->faces, x);
	return x;
}

static void ask(Fonts *f, Face *x, int page) {
	if (has(x->asked.items, x->asked.count, page)) return;
	ERM_PUSH(x->asked, page);
	hostCommand(f->host, drvMap("op", jsonString("glyphs"), "font", jsonString(x->name), "size", jsonNumber(x->size), "bold", jsonBoolean(x->bold),
	                            "page", jsonInteger(page), NULL));
}

/** /dev/font/<role> as its face now is, and every page of it that has come */
static void show(Fonts *f, const ErmPartApi *api, const char *role, Face *x, Json *page, int n) {
	if (!x->metrics) return;
	Json *value = drvMap("font", jsonString(role), "family", x->family, "size", jsonNumber(x->size), "h", jsonInteger(x->h), "ascent", jsonInteger(x->ascent), NULL);
	Json *at = drvPath("/", "dev", "font", role, NULL);
	char *id = formatString("font/%s", role), *pages = formatString("font/%s/pages", role);
	if (drvHas(api, at)) drvSnap(api, at, value);
	else drvMake(api, drvPath("/", "dev", "font", NULL), role, id, value);
	drvMake(api, at, "pages", pages, jsonNull());
	if (page) {
		char p[16];
		snprintf(p, sizeof p, "%d", n);
		char *pid = formatString("font/%s/page/%d", role, n);
		// a page there already is another face's (the role was given another): this one in its place
		Json *there = drvUnder(at, "pages", p, NULL);
		if (drvHas(api, there)) drvSnap(api, there, page);
		else drvMake(api, drvUnder(at, "pages", NULL), p, pid, page);
		free(pid);
	}
	free(id);
	free(pages);
	(void)f;
}

static Json *pageOf(const Json *r) {
	size_t n = 0;
	uint8_t *alpha = drvUnbase64(jsonText(jsonGet(r, "alpha")), &n);
	Json *info = jsonGet(r, "info");
	double numbers[1024] = { 0 };
	for (int i = 0; info && i < info->array.count && i < 1024; i++) numbers[i] = info->array.items[i]->number;
	Json *page = drvMap("w", jsonShallow(jsonGet(r, "w")), "h", jsonShallow(jsonGet(r, "h")), "info", jsonTyped(JSON_FLOAT64, numbers, 1024), "alpha", jsonBytes(alpha, n), NULL);
	free(alpha);
	return page;
}

static ErmErr fontIrq(void *data, const ErmGiven *g, Json **out) {
	Fonts *f = data;
	*out = NULL;
	Json *recs = g->args && g->args->array.count ? g->args->array.items[0] : NULL;
	for (int i = 0; recs && i < recs->array.count; i++) {
		Json *r = recs->array.items[i];
		const char *e = jsonText(jsonGet(r, "event")), *name = jsonText(jsonGet(r, "font"));
		if (!e || strcmp(e, "glyphs") || !name) continue;
		Json *bold = jsonGet(r, "bold");
		Face *x = face(f, name, jsonGet(r, "size") ? jsonGet(r, "size")->number : 0, bold && bold->type == JSON_BOOLEAN && bold->boolean);
		x->metrics = true;
		x->family = jsonShallow(jsonGet(r, "family"));
		int64_t h = 0, ascent = 0, n = 0;
		jsonIsWhole(jsonGet(r, "h"), &h);
		jsonIsWhole(jsonGet(r, "ascent"), &ascent);
		jsonIsWhole(jsonGet(r, "page"), &n);
		x->h = (int)h;
		x->ascent = (int)ascent;
		if (!has(x->pages.items, x->pages.count, (int)n)) ERM_PUSH(x->pages, (int)n);
		Json *page = pageOf(r);
		for (int k = 0; k < f->roles.count; k++)
			if (f->roleFace.items[k] == x) show(f, g->api, f->roles.items[k], x, page, (int)n);
	}
	return ermOk();
}

static ErmErr fontWant(void *data, const ErmGiven *g, Json **out) {
	Fonts *f = data;
	*out = NULL;
	const char *role = g->args && g->args->array.count > 0 ? jsonText(g->args->array.items[0]) : NULL;
	int64_t n = -1;
	if (g->args && g->args->array.count > 1) jsonIsWhole(g->args->array.items[1], &n);
	for (int k = 0; role && n >= 0 && k < f->roles.count; k++)
		if (!strcmp(f->roles.items[k], role)) ask(f, f->roleFace.items[k], (int)n);
	return ermOk();
}

static ErmErr rolesCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	Json *theme = drvRead(g->api, drvPath("/", "etc", "theme", NULL));
	Json *mode = drvRead(g->api, drvPath("/", "dev", "display", "mode", NULL));
	Json *fonts = jsonGet(theme, "fonts"), *unit = jsonGet(mode, "unit");
	*out = drvMap("fonts", fonts ? fonts : jsonObject(), "unit", unit ? unit : jsonInteger(1), NULL);
	return ermOk();
}

/** a role given another face: its pages emptied (null), so each reader asks again and gets the new face's */
static void emptied(const ErmPartApi *api, const char *role) {
	Json *pages = drvPath("/", "dev", "font", role, "pages", NULL);
	Json *names = drvNames(api, pages);
	for (int i = 0; names && i < names->array.count; i++) {
		const char *n = jsonText(names->array.items[i]);
		if (n) drvSnap(api, drvUnder(pages, n, NULL), jsonNull());
	}
}

static ErmErr rolesEffect(void *data, const ErmGiven *g, Json **out) {
	Fonts *f = data;
	*out = jsonNull();
	Json *fonts = jsonGet(g->value, "fonts");
	int64_t unit = 1;
	jsonIsWhole(jsonGet(g->value, "unit"), &unit);
	// the faces the roles had, to tell a role given another (a theme chosen)
	int had = f->roles.count;
	const char **was = calloc((size_t)had + 1, sizeof *was);
	Face **wasFace = calloc((size_t)had + 1, sizeof *wasFace);
	for (int i = 0; i < had; i++) was[i] = f->roles.items[i], wasFace[i] = f->roleFace.items[i];
	f->roles.count = 0;
	f->roleFace.count = 0;
	for (int i = 0; fonts && i < fonts->object.count; i++) {
		const char *role = fonts->object.members[i].key;
		Json *spec = fonts->object.members[i].value;
		const char *name = jsonText(jsonGet(spec, "name"));
		Json *size = jsonGet(spec, "size"), *bold = jsonGet(spec, "bold");
		if (!name || !jsonIsNumber(size) || size->number <= 0) continue;
		Face *x = face(f, name, round(size->number * (double)unit), bold && bold->type == JSON_BOOLEAN && bold->boolean);
		for (int k = 0; k < had; k++)
			if (!strcmp(was[k], role) && wasFace[k] != x) {
				// another face: what the role's pages hold is the last one's, and what this one had shown is gone
				emptied(g->api, role);
				x->asked.count = 0;
			}
		ERM_PUSH(f->roles, copyString(role));
		ERM_PUSH(f->roleFace, x);
		ask(f, x, 0);
		show(f, g->api, role, x, NULL, 0);
	}
	for (int i = 0; i < had; i++) free((char *)was[i]);
	free(was);
	free(wasFace);
	return ermOk();
}

/** the fonts beside the image, each family's folder's .ttf and .otf, registered for this process; one registered
 *  already (the driver started again) is left as it is */
static void shipped(Host *host) {
	const char *image = hostConfig(host)->image;
	char dir[1024];
	snprintf(dir, sizeof dir, "%s/../fonts", image ? image : ".");
	DIR *families = image ? opendir(dir) : NULL;
	for (struct dirent *e; families && (e = readdir(families));) {
		if (e->d_name[0] == '.') continue;
		char family[1400];
		snprintf(family, sizeof family, "%s/%s", dir, e->d_name);
		DIR *files = opendir(family);
		for (struct dirent *k; files && (k = readdir(files));) {
			size_t n = strlen(k->d_name);
			if (n < 5 || (strcasecmp(k->d_name + n - 4, ".ttf") && strcasecmp(k->d_name + n - 4, ".otf"))) continue;
			char path[2000];
			snprintf(path, sizeof path, "%s/%s", family, k->d_name);
			CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)path, (CFIndex)strlen(path), false);
			CFErrorRef error = NULL;
			if (url && !CTFontManagerRegisterFontsForURL(url, kCTFontManagerScopeProcess, &error) && error) {
				if (CFErrorGetCode(error) != kCTFontManagerErrorAlreadyRegistered) hostSay(host, "font: %s could not be registered (%ld)", path, (long)CFErrorGetCode(error));
				CFRelease(error);
			}
			if (url) CFRelease(url);
		}
		if (files) closedir(files);
	}
	if (families) closedir(families);
}

ErmErr driverFont(void *data, const ErmGiven *g, Json **out) {
	*out = jsonNull();
	Fonts *f = calloc(1, sizeof *f);
	f->host = data;
	shipped(f->host);
	Json *here = drvHere(g);
	drvHandler(g, here, "irq", (ErmFn){ fontIrq, f });
	drvHandler(g, here, "want", (ErmFn){ fontWant, f });
	drvClaim(g, here, 50);
	drvChild(g, here, "roles", (ErmFn){ rolesCompute, f }, (ErmFn){ rolesEffect, f });
	return ermOk();
}
