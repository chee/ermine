// drv_web.c: /drivers/web, the web engine (irq 49), as image/drivers/web.js
// was in the TypeScript OS. A program asks for a page by placing an
// ephemeral node of its own in /dev/web/views, {"url"} or {"html"}, with
// "state" (what the engine said of it, below) to bring it back where it
// was; writing another url there goes there, {"go": "back" | "forward" |
// "reload" | "stop" | "load" (its url, fresh, even the one it had) | a
// number (that far along its list, below), "n"} goes, and {"focus": true | false, "fn"} gives the
// page the keyboard or takes it back. What the engine says comes back in
// /dev/web/pages/<the same name>: title, url, loading, progress, back,
// forward, focused, error, the last message the page posted with
// window.ermine.post(...), "open", the last page it would open beside it
// ({url, behind, n}: a link to a new window, window.open, cmd-click or a
// middle click; the program that placed the view opens it, or not: the
// browser as a tab), "cursor", the pointer's shape the page wants where the
// pointer last was (CSS's name: "default", "pointer", "text", ...), "state",
// its history and where it is scrolled, opaque, the engine's own (said a
// second after it settles), "list", its back and forward list, {urls, at}:
// each item's URL and the current one's index (the engine's, said when it
// changed); and in /dev/web/pages/<name>/frame, {plane, n, w, h, dirty?},
// its newest pixels, in its plane. When a view's node goes, with the program
// that placed it, the page closes.
//
// A page is drawn off screen, by the engine, in the metal's process; its
// pixels are a plane of this driver's, as a Mac window's are (drv_mac.c): a
// file, $TMPDIR/ermine-<pid>.web.<k>, two halves of maxw × maxh u32, rows of
// maxw. The metal writes a whole frame into the half not shown, only when
// it differs from the last, says frame (with dirty, what differs), and
// writes nothing more until webtook; hostPlanes' source "web" gives the half
// the latest frame named. A layer shows a page with "web": {"id", "x", "y",
// "w", "h"}: the compositor (drv_display.c) draws the page's plane there,
// over the layer's ops, and tells the metal its size (webshow), so a page
// no layer shows draws nothing.
//
// Input: the layer's owner hands what wmii gives it on,
// /dev/web/driver/on/input (name, events), irq 34 and 35 records with x
// and y in the page's pixels; the metal gives them to the page as the
// Mac's events (webinput).
//
// The page's document, as nodes: /dev/web/pages/<name>/dom, {count, cut},
// and under it its elements, nested as the DOM nests them, each named
// <tag>-<k> (k the first free among its siblings of that tag, kept while it
// lives), ids web/<name>/<n>, valued {tag, x, y, w, h} and, when it has
// them, role, label, text, href, value, type, checked, placeholder, cut and
// more (cut: "deep", "rows", "budget"; more: the children not sent). A
// script the metal puts in each page walks it, at most 24 deep, 200
// children an element, 2000 in all, text cut at 200, and again at most four
// times a second while it changes (a MutationObserver), sending only what
// changed; a new document starts it again (reset). Acting: a program places
// /dev/web/do/<name> (ephemeral, its own), {at, n, act, value?}, at an
// element's address or id, act "click", "focus", "set" (value: a field's
// value, as typed, input and change sent), "type" (value: text typed at its
// caret) or "scroll" (into view); a new n is a new act, answered in the
// same node, {done: n, error: null | "bad" | "gone"}.
//
// The metal's commands: web, webshow, webtook, webinput, webdo, webpost, webclose.

#include "drivers.h"
#include "../../../ermine/encoding/c/json_text.h"
#include "drv.h"

#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

/** an element of a page's document: its parent's n (0: the document) and its name; here while named */
typedef struct Elem {
	int64_t parent;
	char *name;
} Elem;

typedef struct View {
	char *name;
	char *url, *html; // what it last asked for
	double go, fn;    // the n of its last go, and the fn of its last focus, as asked
	int k;            // its plane's number
	char *path;
	uint32_t *bits;   // two halves of maxw × maxh
	size_t bytes;
	int half, w, h;   // where its latest frame is, and how big
	ERM_LIST(Elem) elems; // its document's elements, by n
	bool seen;
	bool framed, rooted;  // its page's frame and dom nodes made, so a record never reads to know
} View;

/** an act sent: its do node's name and n */
typedef struct Ask {
	int64_t req;
	char *name;
	Json *n;
} Ask;

typedef struct Web {
	Host *host;
	int maxw, maxh, next;
	ERM_LIST(View *) views;
	ERM_LIST(Ask) asks;
	int64_t req;
	ErmMap did; // a do node's name -> the n last taken, printed
} Web;

static int64_t whole(const Json *v, int64_t otherwise) {
	int64_t n;
	return jsonIsWhole(v, &n) ? n : otherwise;
}

static Json *at(const char *first, const char *second) {
	return drvPath("/", "dev", "web", first, second, NULL);
}

static View *viewNamed(Web *w, const char *name) {
	for (int i = 0; name && i < w->views.count; i++)
		if (!strcmp(w->views.items[i]->name, name)) return w->views.items[i];
	return NULL;
}

static bool same(const char *a, const char *b) {
	return (!a && !b) || (a && b && !strcmp(a, b));
}

/** hostPlane's: view k's plane, the half its latest frame is in */
static bool planeAt(void *data, int64_t id, HostPlane *out) {
	Web *w = data;
	for (int i = 0; i < w->views.count; i++) {
		View *v = w->views.items[i];
		if (v->k != id) continue;
		if (!v->bits || v->w <= 0 || v->h <= 0) return false;
		*out = (HostPlane){ v->bits + (size_t)v->half * (size_t)w->maxw * (size_t)w->maxh, v->w < w->maxw ? v->w : w->maxw, v->h < w->maxh ? v->h : w->maxh, w->maxw };
		return true;
	}
	return false;
}

/** the plane file, mapped shared: two halves of maxw × maxh; the metal maps it too, and unlinks it */
static bool plane(Web *w, View *v) {
	const char *tmp = getenv("TMPDIR") && *getenv("TMPDIR") ? getenv("TMPDIR") : "/tmp";
	size_t len = strlen(tmp);
	v->path = formatString("%.*s/ermine-%d.web.%d", (int)(len > 1 && tmp[len - 1] == '/' ? len - 1 : len), tmp, (int)getpid(), v->k);
	v->bytes = (size_t)w->maxw * (size_t)w->maxh * 4 * 2;
	int fd = open(v->path, O_RDWR | O_CREAT | O_TRUNC, 0600);
	if (fd < 0 || ftruncate(fd, (off_t)v->bytes) < 0) {
		if (fd >= 0) close(fd);
		hostSay(w->host, "web: no plane %s", v->path);
		return false;
	}
	void *bits = mmap(NULL, v->bytes, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	close(fd);
	if (bits == MAP_FAILED) {
		unlink(v->path);
		return false;
	}
	v->bits = bits;
	return true;
}

// --- a page's document, as nodes

static Json *domAt(const View *v) {
	return drvPath("/", "dev", "web", "pages", v->name, "dom", NULL);
}

static Elem *elemOf(View *v, int64_t n) {
	return n > 0 && n < v->elems.count && v->elems.items[n].name ? &v->elems.items[n] : NULL;
}

static char *elemId(const View *v, int64_t n) {
	return formatString("web/%s/%lld", v->name, (long long)n);
}

/** n's address: dom, then each name down to it; NULL when it is not here */
static Json *addressOf(View *v, int64_t n) {
	int64_t chain[64];
	int depth = 0;
	for (int64_t k = n; k; depth++) {
		Elem *e = elemOf(v, k);
		if (!e || depth == 64) return NULL;
		chain[depth] = k;
		k = e->parent;
	}
	Json *a = domAt(v);
	for (int i = depth - 1; i >= 0; i--) jsonPush(a, jsonString(v->elems.items[chain[i]].name));
	return a;
}

/** n and all under it forgotten: their nodes went with n's */
static void forget(View *v, int64_t n) {
	bool *gone = calloc((size_t)v->elems.count, 1);
	gone[n] = true;
	// a parent is always added before its children, so has the lower n
	for (int64_t k = n + 1; k < v->elems.count; k++) {
		Elem *e = elemOf(v, k);
		if (e && e->parent > 0 && e->parent < v->elems.count && gone[e->parent]) gone[k] = true;
	}
	for (int64_t k = n; k < v->elems.count; k++)
		if (gone[k] && v->elems.items[k].name) {
			free(v->elems.items[k].name);
			v->elems.items[k].name = NULL;
		}
	free(gone);
}

/** every element gone: a new document */
static void reset(const ErmPartApi *api, View *v) {
	for (int64_t k = 1; k < v->elems.count; k++) {
		Elem *e = &v->elems.items[k];
		if (!e->name || e->parent) continue;
		char *id = elemId(v, k);
		drvOp(api, "unplace", drvMap("address", domAt(v), "name", jsonString(e->name), "id", jsonString(id), NULL));
		free(id);
	}
	for (int64_t k = 1; k < v->elems.count; k++) free(v->elems.items[k].name);
	v->elems.count = 0;
}

/** dom {id, reset?, items, count, cut}: each item applied in order, add, set or drop, as the page's script found them */
static void dom(const ErmPartApi *api, View *v, const Json *r) {
	if (!v->rooted) {
		char *id = formatString("web/page/%s/dom", v->name);
		drvMake(api, at("pages", v->name), "dom", id, jsonNull());
		free(id);
		v->rooted = true;
	}
	Json *rs = jsonGet(r, "reset");
	if (rs && rs->type == JSON_BOOLEAN && rs->boolean) reset(api, v);
	Json *items = jsonGet(r, "items");
	int adds = 0;
	for (int i = 0; jsonIsArray(items) && i < items->array.count; i++) {
		Json *it = items->array.items[i];
		int64_t n = 0, parent = 0;
		if (jsonIsWhole(jsonGet(it, "add"), &n) && n > 0 && n < (1 << 24)) {
			const char *name = jsonText(jsonGet(it, "name"));
			jsonIsWhole(jsonGet(it, "parent"), &parent);
			Json *under = parent ? addressOf(v, parent) : domAt(v);
			if (!name || !under || elemOf(v, n)) continue;
			while (v->elems.count <= n) ERM_PUSH(v->elems, ((Elem){ 0, NULL }));
			v->elems.items[n] = (Elem){ parent, copyString(name) };
			char *id = elemId(v, n);
			// the name is free (the script names each element among its siblings): placed without a read
			drvPlace(api, under, name, id, jsonGet(it, "value") ? jsonShallow(jsonGet(it, "value")) : jsonNull());
			free(id);
			adds++;
		} else if (jsonIsWhole(jsonGet(it, "set"), &n)) {
			Json *a = addressOf(v, n);
			if (a) drvSnap(api, a, jsonGet(it, "value") ? jsonShallow(jsonGet(it, "value")) : jsonNull());
		} else if (jsonIsWhole(jsonGet(it, "drop"), &n)) {
			Elem *e = elemOf(v, n);
			Json *a = addressOf(v, n);
			if (!e || !a) continue;
			Json *up = jsonArray();
			for (int k = 0; k < a->array.count - 1; k++) jsonPush(up, jsonRef(a->array.items[k]));
			char *id = elemId(v, n);
			drvOp(api, "unplace", drvMap("address", up, "name", jsonString(e->name), "id", jsonString(id), NULL));
			free(id);
			forget(v, n);
		}
	}
	drvSnap(api, domAt(v), drvMap("count", jsonInteger(whole(jsonGet(r, "count"), 0)), "cut", jsonGet(r, "cut") ? jsonShallow(jsonGet(r, "cut")) : jsonNull(), NULL));
	// a line in the log a new document, not each change
	if (rs && rs->type == JSON_BOOLEAN && rs->boolean) hostSay(NULL, "web: %s: a new document, %d elements", v->name, adds);
}

/** an act's at, an element's address under a page's dom or its id (web/<page>/<n>), to its view and n; false when it names none */
static bool resolve(Web *w, const Json *a, View **out, int64_t *n) {
	const char *text = jsonText(a);
	// an address as text, /dev/web/pages/...: as its list
	if (text && text[0] == '/') {
		Json *list = drvPath("/", NULL);
		char *copy = copyString(text);
		for (char *part = strtok(copy + 1, "/"); part; part = strtok(NULL, "/")) jsonPush(list, jsonString(part));
		free(copy);
		return resolve(w, list, out, n);
	}
	if (text) {
		const char *slash = strrchr(text, '/');
		if (strncmp(text, "web/", 4) || !slash || slash <= text + 4) return false;
		char *name = formatString("%.*s", (int)(slash - text - 4), text + 4);
		View *v = viewNamed(w, name);
		free(name);
		*n = strtoll(slash + 1, NULL, 10);
		*out = v;
		return v && elemOf(v, *n);
	}
	// an address: /, dev, web, pages, <name>, dom, then the names down to it
	if (!jsonIsArray(a) || a->array.count < 7) return false;
	const char *head[] = { "/", "dev", "web", "pages" };
	for (int i = 0; i < 4; i++)
		if (!jsonText(a->array.items[i]) || strcmp(jsonText(a->array.items[i]), head[i])) return false;
	View *v = viewNamed(w, jsonText(a->array.items[4]));
	if (!v || !jsonText(a->array.items[5]) || strcmp(jsonText(a->array.items[5]), "dom")) return false;
	int64_t here = 0;
	for (int i = 6; i < a->array.count; i++) {
		const char *name = jsonText(a->array.items[i]);
		int64_t found = 0;
		for (int64_t k = 1; name && k < v->elems.count && !found; k++)
			if (v->elems.items[k].name && v->elems.items[k].parent == here && !strcmp(v->elems.items[k].name, name)) found = k;
		if (!found) return false;
		here = found;
	}
	*out = v;
	*n = here;
	return true;
}

// --- the views

/** each view, [name, what it asks], read tracked */
static ErmErr viewsCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = jsonArray();
	Json *names = drvNames(g->api, drvPath("/", "dev", "web", "views", NULL));
	for (int i = 0; jsonIsArray(names) && i < names->array.count; i++) {
		const char *name = jsonText(names->array.items[i]);
		Json *v = drvRead(g->api, at("views", name)), *pair = jsonArray();
		jsonPush(pair, jsonString(name));
		jsonPush(pair, jsonIsObject(v) ? jsonShallow(v) : jsonObject());
		jsonPush(*out, pair);
	}
	return ermOk();
}

/** a command to the metal for a view: web {id, ...} */
static void ask(Web *w, const char *name, const char *key, Json *value) {
	hostCommand(w->host, drvMap("op", jsonString("web"), "id", jsonString(name), key, value, NULL));
}

static void viewFree(View *v) {
	if (v->bits) munmap(v->bits, v->bytes);
	if (v->path) unlink(v->path);
	for (int64_t k = 1; k < v->elems.count; k++) free(v->elems.items[k].name);
	free(v->elems.items);
	free(v->path);
	free(v->name);
	free(v->url);
	free(v->html);
	free(v);
}

static ErmErr viewsEffect(void *data, const ErmGiven *g, Json **out) {
	Web *w = data;
	*out = jsonNull();
	for (int i = 0; i < w->views.count; i++) w->views.items[i]->seen = false;
	for (int i = 0; jsonIsArray(g->value) && i < g->value->array.count; i++) {
		Json *pair = g->value->array.items[i], *v = pair->array.items[1];
		const char *name = jsonText(pair->array.items[0]);
		if (!name) continue;
		View *view = viewNamed(w, name);
		bool fresh = !view;
		const char *url = jsonText(jsonGet(v, "url")), *html = jsonText(jsonGet(v, "html"));
		if (!view) {
			view = calloc(1, sizeof *view);
			*view = (View){ .name = copyString(name), .k = ++w->next, .go = -1, .fn = -1 };
			ERM_PUSH(w->views, view);
			plane(w, view);
			// made with its plane, and brought back where it was when it says
			Json *c = drvMap("op", jsonString("web"), "id", jsonString(name), NULL);
			if (view->bits) {
				jsonAdd(c, "path", jsonString(view->path));
				jsonAdd(c, "maxw", jsonInteger(w->maxw));
				jsonAdd(c, "maxh", jsonInteger(w->maxh));
			}
			if (jsonText(jsonGet(v, "state")) && !html) jsonAdd(c, "state", jsonShallow(jsonGet(v, "state")));
			if (html) jsonAdd(c, "html", jsonString(html));
			else jsonAdd(c, "url", jsonString(url ? url : ""));
			hostCommand(w->host, c);
			view->url = url ? copyString(url) : NULL;
			view->html = html ? copyString(html) : NULL;
		}
		view->seen = true;
		if (!drvHas(g->api, at("pages", name))) {
			char *id = formatString("web/page/%s", name);
			drvMake(g->api, drvPath("/", "dev", "web", "pages", NULL), name, id,
			        drvMap("title", jsonString(""), "url", jsonString(url ? url : ""), "loading", jsonBoolean(false), "progress", jsonInteger(0), NULL));
			free(id);
			view->framed = view->rooted = false;
		} else if (fresh) {
			view->framed = drvHas(g->api, drvUnder(at("pages", name), "frame", NULL));
			view->rooted = drvHas(g->api, domAt(view));
		}
		bool asked = fresh;
		if (!fresh && (!same(url, view->url) || !same(html, view->html))) {
			asked = true;
			if (html) ask(w, name, "html", jsonString(html));
			else ask(w, name, "url", jsonString(url ? url : ""));
			free(view->url);
			free(view->html);
			view->url = url ? copyString(url) : NULL;
			view->html = html ? copyString(html) : NULL;
		}
		Json *go = jsonGet(v, "go"), *n = jsonGet(v, "n"), *focus = jsonGet(v, "focus"), *fn = jsonGet(v, "fn");
		double gn = jsonIsNumber(n) ? n->number : 0, ff = jsonIsNumber(fn) ? fn->number : 0;
		if ((jsonText(go) || jsonIsNumber(go)) && gn != view->go) {
			// load: its url again, from the network, unless it was just asked for
			if (jsonText(go) && !strcmp(jsonText(go), "load")) {
				if (!asked && !html) ask(w, name, "url", jsonString(url ? url : ""));
			} else ask(w, name, "go", jsonShallow(go));
			view->go = gn;
		}
		if (focus && focus->type == JSON_BOOLEAN && ff != view->fn) {
			ask(w, name, "focus", jsonBoolean(focus->boolean));
			view->fn = ff;
		}
	}
	// a view gone: its page closes
	int k = 0;
	for (int i = 0; i < w->views.count; i++) {
		View *view = w->views.items[i];
		if (view->seen) {
			w->views.items[k++] = view;
			continue;
		}
		hostCommand(w->host, drvMap("op", jsonString("webclose"), "id", jsonString(view->name), NULL));
		if (drvHas(g->api, at("pages", view->name))) {
			char *id = formatString("web/page/%s", view->name);
			drvOp(g->api, "unplace", drvMap("address", drvPath("/", "dev", "web", "pages", NULL), "name", jsonString(view->name), "id", jsonString(id), NULL));
			free(id);
		}
		viewFree(view);
	}
	w->views.count = k;
	return ermOk();
}

// --- acts on a page's elements

/** each do node, [name, value], read tracked */
static ErmErr doCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = jsonArray();
	Json *names = drvNames(g->api, drvPath("/", "dev", "web", "do", NULL));
	for (int i = 0; jsonIsArray(names) && i < names->array.count; i++) {
		const char *name = jsonText(names->array.items[i]);
		Json *v = drvRead(g->api, at("do", name)), *pair = jsonArray();
		jsonPush(pair, jsonString(name));
		jsonPush(pair, jsonIsObject(v) ? jsonShallow(v) : jsonObject());
		jsonPush(*out, pair);
	}
	return ermOk();
}

/** the answer, into the do node, while it is there */
static void answer(const ErmPartApi *api, const char *name, Json *n, const char *error) {
	Json *a = at("do", name);
	if (!drvHas(api, a)) return;
	drvSet(api, a, "done", n);
	drvSet(api, a, "error", error ? jsonString(error) : jsonNull());
}

static ErmErr doEffect(void *data, const ErmGiven *g, Json **out) {
	Web *w = data;
	*out = jsonNull();
	for (int i = 0; jsonIsArray(g->value) && i < g->value->array.count; i++) {
		Json *pair = g->value->array.items[i], *v = pair->array.items[1];
		const char *name = jsonText(pair->array.items[0]), *act = jsonText(jsonGet(v, "act"));
		Json *n = jsonGet(v, "n");
		if (!name || !n) continue;
		// one n is one act: taken once
		char *key = jsonPrint(n), *was = ermMapGet(&w->did, name);
		if (was && !strcmp(was, key)) {
			free(key);
			continue;
		}
		free(was);
		ermMapPut(&w->did, name, key);
		View *view = NULL;
		int64_t e = 0;
		bool known = act && (!strcmp(act, "click") || !strcmp(act, "focus") || !strcmp(act, "set") || !strcmp(act, "type") || !strcmp(act, "scroll"));
		if (!known || !resolve(w, jsonGet(v, "at"), &view, &e)) {
			answer(g->api, name, jsonShallow(n), "bad");
			continue;
		}
		ERM_PUSH(w->asks, ((Ask){ ++w->req, copyString(name), jsonShallow(n) }));
		Json *c = drvMap("op", jsonString("webdo"), "id", jsonString(view->name), "req", jsonInteger(w->req), "n", jsonInteger(e), "act", jsonString(act), NULL);
		if (jsonGet(v, "value")) jsonAdd(c, "value", jsonShallow(jsonGet(v, "value")));
		hostCommand(w->host, c);
	}
	return ermOk();
}

/** on/input (name, events): what the layer's owner was given over the page, to the page */
static ErmErr onInput(void *data, const ErmGiven *g, Json **out) {
	Web *w = data;
	*out = jsonNull();
	const char *name = g->args && g->args->array.count > 0 ? jsonText(g->args->array.items[0]) : NULL;
	Json *events = g->args && g->args->array.count > 1 ? g->args->array.items[1] : NULL;
	if (!viewNamed(w, name)) return ermDetail(ermInvalid("no-view"), "text", jsonString("input takes a view's name and its events"));
	if (!jsonIsArray(events) || !events->array.count) return ermOk();
	hostCommand(w->host, drvMap("op", jsonString("webinput"), "id", jsonString(name), "events", jsonShallow(events), NULL));
	return ermOk();
}

/** irq 49: what the engine said of a page, into its node */
static ErmErr webIrq(void *data, const ErmGiven *g, Json **out) {
	Web *w = data;
	*out = jsonNull();
	Json *recs = g->args && g->args->array.count ? g->args->array.items[0] : NULL;
	for (int i = 0; jsonIsArray(recs) && i < recs->array.count; i++) {
		Json *r = recs->array.items[i];
		const char *id = jsonText(jsonGet(r, "id")), *e = jsonText(jsonGet(r, "event"));
		if (e && !strcmp(e, "done")) {
			// an act done: answered in its node
			int64_t req = whole(jsonGet(r, "req"), 0);
			for (int k = 0; k < w->asks.count; k++) {
				Ask *a = &w->asks.items[k];
				if (a->req != req) continue;
				answer(g->api, a->name, a->n, jsonText(jsonGet(r, "error")));
				free(a->name);
				w->asks.items[k] = w->asks.items[--w->asks.count];
				break;
			}
			continue;
		}
		// a view's page is there while the view is: read for only when there is none
		View *v = id ? viewNamed(w, id) : NULL;
		if (!id || !e || (!v && !drvHas(g->api, at("pages", id)))) continue;
		Json *page = at("pages", id);
		if (!strcmp(e, "title")) drvSet(g->api, page, "title", jsonShallow(jsonGet(r, "title")));
		else if (!strcmp(e, "url")) {
			drvSet(g->api, page, "url", jsonShallow(jsonGet(r, "url")));
			drvSet(g->api, page, "error", jsonNull());
		} else if (!strcmp(e, "loading")) {
			drvSet(g->api, page, "loading", jsonShallow(jsonGet(r, "loading")));
			drvSet(g->api, page, "back", jsonShallow(jsonGet(r, "back")));
			drvSet(g->api, page, "forward", jsonShallow(jsonGet(r, "forward")));
		} else if (!strcmp(e, "progress")) drvSet(g->api, page, "progress", jsonShallow(jsonGet(r, "progress")));
		else if (!strcmp(e, "focus")) drvSet(g->api, page, "focused", jsonShallow(jsonGet(r, "on")));
		else if (!strcmp(e, "error")) drvSet(g->api, page, "error", jsonShallow(jsonGet(r, "error")));
		else if (!strcmp(e, "cursor")) drvSet(g->api, page, "cursor", jsonShallow(jsonGet(r, "cursor")));
		else if (!strcmp(e, "state")) drvSet(g->api, page, "state", jsonShallow(jsonGet(r, "state")));
		else if (!strcmp(e, "list") && jsonIsArray(jsonGet(r, "urls")) && jsonIsNumber(jsonGet(r, "at"))) drvSet(g->api, page, "list", drvMap("urls", jsonShallow(jsonGet(r, "urls")), "at", jsonShallow(jsonGet(r, "at")), NULL));
		else if (!strcmp(e, "dom") && v) dom(g->api, v, r);
		else if (!strcmp(e, "frame") && v) {
			// the newest frame: in that half, then taken, so the metal may write the other
			int64_t n = whole(jsonGet(r, "n"), 0);
			v->half = whole(jsonGet(r, "half"), 0) ? 1 : 0;
			v->w = (int)whole(jsonGet(r, "w"), 0);
			v->h = (int)whole(jsonGet(r, "h"), 0);
			Json *f = drvMap("plane", jsonInteger(v->k), "n", jsonInteger(n), "w", jsonInteger(v->w), "h", jsonInteger(v->h), NULL);
			if (jsonIsObject(jsonGet(r, "dirty"))) jsonAdd(f, "dirty", jsonShallow(jsonGet(r, "dirty")));
			// a node of its own, so a frame wakes the compositor only, never what reads the page
			if (v->framed) drvSnap(g->api, drvUnder(page, "frame", NULL), f);
			else {
				char *fid = formatString("web/page/%s/frame", id);
				drvMake(g->api, page, "frame", fid, f);
				free(fid);
				v->framed = true;
			}
			hostCommand(w->host, drvMap("op", jsonString("webtook"), "id", jsonString(id), "n", jsonInteger(n), NULL));
		} else if (!strcmp(e, "message")) {
			Json *old = jsonGet(drvRead(g->api, page), "message");
			drvSet(g->api, page, "message", drvMap("body", jsonShallow(jsonGet(r, "body")), "n", jsonInteger(whole(jsonGet(old, "n"), 0) + 1), NULL));
		} else if (!strcmp(e, "open") && jsonText(jsonGet(r, "url"))) {
			// counted, so the same page asked for twice is two
			Json *old = jsonGet(drvRead(g->api, page), "open"), *behind = jsonGet(r, "behind");
			drvSet(g->api, page, "open",
			       drvMap("url", jsonShallow(jsonGet(r, "url")), "behind", jsonBoolean(behind && behind->type == JSON_BOOLEAN && behind->boolean), "n",
			              jsonInteger(whole(jsonGet(old, "n"), 0) + 1), NULL));
		}
	}
	return ermOk();
}

ErmErr driverWeb(void *data, const ErmGiven *g, Json **out) {
	*out = jsonNull();
	Web *w = calloc(1, sizeof *w);
	w->host = data;
	Json *fb = jsonGet(hostTree(w->host), "fb");
	w->maxw = (int)whole(jsonGet(fb, "maxw"), 0);
	w->maxh = (int)whole(jsonGet(fb, "maxh"), 0);
	Json *dev = drvPath("/", "dev", "web", NULL);
	drvMake(g->api, dev, "views", "web/views", jsonNull());
	drvMake(g->api, dev, "pages", "web/pages", jsonNull());
	drvMake(g->api, dev, "do", "web/do", jsonNull());
	Json *here = drvHere(g);
	drvHandler(g, here, "irq", (ErmFn){ webIrq, w });
	drvHandler(g, here, "input", (ErmFn){ onInput, w });
	drvClaim(g, here, 49);
	drvChild(g, here, "views", (ErmFn){ viewsCompute, w }, (ErmFn){ viewsEffect, w });
	drvChild(g, here, "do", (ErmFn){ doCompute, w }, (ErmFn){ doEffect, w });
	hostPlanes(w->host, "web", planeAt, w);
	return ermOk();
}
