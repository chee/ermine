// drv_mac.c: /drivers/mac, the Mac's other apps (irq 51): every running
// app's accessibility tree, the whole system's, mirrored as one ephemeral
// tree under /dev/mac, and a Mac window shown as an ermine window. The
// metal walks and watches (mac/metal/Mac.swift, Ax.swift, Capture.swift);
// this driver turns its records into nodes and nodes into its commands.
//
//   /etc/mac                  a document: {on, depth, app, total, rows, text, hz, skip}; the `mac` command
//   /dev/mac/status           {ax, capture, on, apps, elements, cut}
//   /dev/mac/focus            {app, element}: addresses, or null
//   /dev/mac/apps/<pid>       an app: {name, bundle, path, policy, active, hidden, state, electron, elements, cut, order?}
//   /dev/mac/apps/<pid>/<role>-<k>/...   its elements, nested as AX nests them, ids mac/<n>
//   /dev/mac/do/<name>        a program's {at, n, act, to?, key?, id?}; {sent: n} when sent, the answer {done: n, error, value?} after;
//                             or {n, act: "launch", app, show?}: the app started, value its pid; show, its first window shown (shown: its id)
//   /dev/mac/open/<name>      a program's {at, depth?}: the cuts under at lifted while it is here; {n: its id, error} written into it
//   /dev/mac/views/<name>     a program's {window, fps?, input?}: that Mac window shown
//   /dev/mac/windows/<name>   the shown window's owner {window, app, state, input}: on/key, on/pointer, on/hover
//   /dev/display/layers/mac-<name>  {x, y, w, h, z, title, owner, drags, plane}
//
// Only this driver writes the elements, so a read's from always says the
// Mac. It keeps a table, n -> (pid, parent, name, role, frame, has
// AXPress, title), from which it builds addresses, and back to which it
// resolves a do's at, an open's, a view's window and a click. An at may
// also be an element's id, mac/<n>: an address names whatever is there
// now, an id only that element, and a dropped one nothing.
//
// Each tree record is answered with mactook {items}: the metal sends no
// more than a few hundred items ahead of what this has applied, so its
// walk goes at the pace the graph takes it.
//
// A view's pixels are a plane of the driver's: a file, $TMPDIR/ermine-<pid>.mac.<k>,
// two halves of maxw × maxh u32, rows of maxw, as the frame buffer's. The
// metal writes a whole frame into the half not shown, says frame, and
// writes nothing more until took; hostPlanes' source "mac" gives the half
// the latest frame named.

#include "drivers.h"
#include "../../../ermine/encoding/c/json_text.h"
#include "drv.h"

#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#define IRQ 51

typedef struct Elem {
	int64_t n, parent; // parent 0: the app
	int pid;
	char *name, *role, *title;
	double x, y, w, h;
	bool framed, press, cut, dead;
} Elem;

typedef struct App {
	int pid;
	int64_t n;
	char *name;
	Json *value; // the record's keys, as the node has them
	int elements, cut;
	int wrote[2]; // elements and cut as last written into its node
	bool top;     // the app itself cut (budget)
	bool dead;
} App;

/** a macdo sent: its asker's do node, or none (the driver's own: a want, a press) */
typedef struct Ask {
	int64_t req;
	char *name;
	Json *n;
	char *app;  // a launch's app
	bool show;  // and its first window to be shown
} Ask;

/** an app launched with show: its first window not shown yet */
typedef struct Show {
	int pid;
	char *name; // its do node
} Show;

/** a do node's last n sent */
typedef struct Did {
	char *name;
	Json *n;
	bool seen;
} Did;

/** an open node: its at, resolved again whenever the tree changes */
typedef struct Open {
	char *name;
	Json *at;
	int64_t depth;
	char *said; // the id written into it, or "" for bad
	bool seen;
} Open;

/** what the metal was told is open: per element, the deepest of its opens */
typedef struct Lease {
	int pid;
	int64_t n, sent, want;
} Lease;

typedef struct View {
	char *name;
	int k, pid;
	int64_t window; // its n; 0: none
	char *path;
	uint32_t *bits;
	size_t bytes;
	int half, w, h;
	int64_t serial;
	Json *dirty;
	char *input, *state;
	Json *want; // the last sent
	bool made, placed, closed, capturing, seen;
	bool down, dragged; // input "press": a button down, moved since
	double dx, dy;
} View;

typedef struct Mac {
	Host *host;
	const char *self;
	int unit, maxw, maxh;
	ERM_LIST(Elem *) elems; // in the order added: a parent before its children
	Elem **index;           // n -> elem, open addressing
	int cap;
	ERM_LIST(App) apps;
	ERM_LIST(Ask) asks;
	int64_t req;
	ERM_LIST(Show) shows;
	ERM_LIST(Did) dids;
	ERM_LIST(Open) opens;
	ERM_LIST(Lease) leases;
	ERM_LIST(View *) views;
	int ks;
	unsigned cascade;
	bool ax, capture, on;
	bool synced;          // the first mac command sent: it asked for everything
	bool changed;         // this irq added or dropped elements
	bool dropped;         // this irq dropped some: the table purged once, at its end
	int focus;            // /dev/mac/focus's app, 0: none
	int64_t focused;      // and element, 0: none
	char *shown;          // /dev/mac/status's value as last written
} Mac;

typedef struct Handle {
	Mac *mac;
	int k;
} Handle;

static Json *dev(const char *first, const char *second) {
	return drvPath("/", "dev", "mac", first, second, NULL);
}

static char *idOf(int64_t n) {
	return formatString("mac/%lld", (long long)n);
}

static bool truth(const Json *v) {
	return v && v->type == JSON_BOOLEAN && v->boolean;
}

static int64_t whole(const Json *v, int64_t otherwise) {
	int64_t n;
	return jsonIsWhole(v, &n) ? n : otherwise;
}

// --- the table

static unsigned slot(Mac *m, int64_t n) {
	return (unsigned)((uint64_t)n * 0x9e3779b97f4a7c15ull >> 32) & (unsigned)(m->cap - 1);
}

static Elem *elemOf(Mac *m, int64_t n) {
	if (!m->cap) return NULL;
	for (unsigned i = slot(m, n);; i = (i + 1) & (unsigned)(m->cap - 1)) {
		Elem *e = m->index[i];
		if (!e) return NULL;
		if (e->n == n) return e;
	}
}

static void indexPut(Mac *m, Elem *e) {
	unsigned i = slot(m, e->n);
	while (m->index[i]) i = (i + 1) & (unsigned)(m->cap - 1);
	m->index[i] = e;
}

/** the index made again, for the table as it is, room for twice as many */
static void reindex(Mac *m) {
	int cap = 64;
	while (cap < m->elems.count * 2 + 2) cap *= 2;
	free(m->index);
	m->index = calloc((size_t)cap, sizeof *m->index);
	m->cap = cap;
	for (int i = 0; i < m->elems.count; i++) indexPut(m, m->elems.items[i]);
}

static App *appOf(Mac *m, int pid) {
	for (int i = 0; i < m->apps.count; i++)
		if (m->apps.items[i].pid == pid && !m->apps.items[i].dead) return &m->apps.items[i];
	return NULL;
}

/** whether it and every element above it is still here */
static bool alive(Mac *m, Elem *e) {
	for (int steps = 0; e; steps++) {
		if (e->dead || steps > 4096) return false;
		if (!e->parent) return appOf(m, e->pid) != NULL;
		e = elemOf(m, e->parent);
	}
	return false;
}

/** the table without what was dropped, and every app's counts */
static void purge(Mac *m) {
	for (int i = 0; i < m->apps.count; i++) m->apps.items[i].elements = m->apps.items[i].cut = 0;
	int k = 0;
	for (int i = 0; i < m->elems.count; i++) {
		Elem *e = m->elems.items[i];
		// in the order added, so a parent is decided before its children
		Elem *p = e->parent ? elemOf(m, e->parent) : NULL;
		if (!e->dead && (e->parent ? p && !p->dead : appOf(m, e->pid) != NULL)) {
			App *a = appOf(m, e->pid);
			if (a) a->elements++, a->cut += e->cut;
		} else e->dead = true;
	}
	for (int i = 0; i < m->elems.count; i++) {
		Elem *e = m->elems.items[i];
		if (!e->dead) {
			m->elems.items[k++] = e;
			continue;
		}
		free(e->name);
		free(e->role);
		free(e->title);
		free(e);
	}
	m->elems.count = k;
	reindex(m);
}

/** the element's address, or the app's for n its app element's */
static Json *addressOf(Mac *m, int pid, int64_t n) {
	char p[24];
	snprintf(p, sizeof p, "%d", pid);
	ERM_LIST(const char *) names = { 0 };
	App *a = appOf(m, pid);
	for (Elem *e = n && (!a || n != a->n) ? elemOf(m, n) : NULL; e; e = e->parent ? elemOf(m, e->parent) : NULL) {
		ERM_PUSH(names, e->name);
		if (names.count > 4096) break;
	}
	Json *at = drvPath("/", "dev", "mac", "apps", p, NULL);
	for (int i = names.count - 1; i >= 0; i--) jsonPush(at, jsonString(names.items[i]));
	free(names.items);
	return at;
}

/** the element a child of parent (0: the app) named so */
static Elem *childNamed(Mac *m, int pid, int64_t parent, const char *name) {
	for (int i = 0; i < m->elems.count; i++) {
		Elem *e = m->elems.items[i];
		if (e->pid == pid && e->parent == parent && !e->dead && !strcmp(e->name, name)) return e;
	}
	return NULL;
}

/** an address, a list or a text path, back to (pid, n): /dev/mac is (0, 0); false when it names nothing here */
static bool resolve(Mac *m, const Json *at, int *pid, int64_t *n) {
	// an id, mac/<n>: that element, or that app, while it is here
	if (jsonIsString(at) && !strncmp(jsonText(at), "mac/", 4)) {
		char *end;
		long long k = strtoll(jsonText(at) + 4, &end, 10);
		if (*end || k <= 0) return false;
		for (int i = 0; i < m->apps.count; i++)
			if (!m->apps.items[i].dead && m->apps.items[i].n == k) return *pid = m->apps.items[i].pid, *n = k, true;
		Elem *e = elemOf(m, k);
		if (!e || !alive(m, e)) return false;
		*pid = e->pid, *n = k;
		return true;
	}
	ERM_LIST(char *) parts = { 0 };
	if (jsonIsString(at)) {
		char *text = copyString(jsonText(at));
		for (char *s = strtok(text, "/"); s; s = strtok(NULL, "/")) ERM_PUSH(parts, copyString(s));
		free(text);
	} else if (jsonIsArray(at))
		for (int i = 0; i < at->array.count; i++) {
			const char *s = jsonText(at->array.items[i]);
			if (!s) goto bad;
			if (strcmp(s, "/")) ERM_PUSH(parts, copyString(s));
		}
	else goto bad;
	if (parts.count < 2 || strcmp(parts.items[0], "dev") || strcmp(parts.items[1], "mac")) goto bad;
	if (parts.count == 2) {
		*pid = 0, *n = 0;
		goto good;
	}
	if (parts.count < 4 || strcmp(parts.items[2], "apps")) goto bad;
	char *end;
	long p = strtol(parts.items[3], &end, 10);
	App *a = *end ? NULL : appOf(m, (int)p);
	if (!a) goto bad;
	int64_t cur = 0;
	for (int i = 4; i < parts.count; i++) {
		Elem *e = childNamed(m, a->pid, cur, parts.items[i]);
		if (!e) goto bad;
		cur = e->n;
	}
	*pid = a->pid, *n = cur ? cur : a->n;
good:
	for (int i = 0; i < parts.count; i++) free(parts.items[i]);
	free(parts.items);
	return true;
bad:
	for (int i = 0; i < parts.count; i++) free(parts.items[i]);
	free(parts.items);
	return false;
}

/** what the table keeps of an element's value: its role, title, frame, AXPress and cut */
static void note(Elem *e, const Json *v) {
	Json *role = jsonGet(v, "role"), *title = jsonGet(v, "title"), *actions = jsonGet(v, "actions"), *cut = jsonGet(v, "cut");
	if (role) {
		free(e->role);
		e->role = jsonText(role) ? copyString(jsonText(role)) : NULL;
	}
	if (title) {
		free(e->title);
		e->title = jsonText(title) ? copyString(jsonText(title)) : NULL;
	}
	if (actions) {
		e->press = false;
		for (int i = 0; jsonIsArray(actions) && i < actions->array.count; i++)
			if (jsonText(actions->array.items[i]) && !strcmp(jsonText(actions->array.items[i]), "AXPress")) e->press = true;
	}
	if (cut) e->cut = jsonText(cut) != NULL;
	const char *keys[] = { "x", "y", "w", "h" };
	double *at[] = { &e->x, &e->y, &e->w, &e->h };
	for (int i = 0; i < 4; i++) {
		Json *k = jsonGet(v, keys[i]);
		if (jsonIsNumber(k)) *at[i] = k->number, e->framed = true;
	}
}

// --- writing

/** one write of keys into the node; a null removes its key when drop is true */
static void put(const ErmPartApi *api, Json *address, const Json *keys, bool drop) {
	Json *patches = jsonArray();
	for (int i = 0; jsonIsObject(keys) && i < keys->object.count; i++) {
		JsonMember *k = &keys->object.members[i];
		Json *p = drvMap("type", jsonString("set"), "path", jsonArray(), "key", jsonStringOfLength(k->key, k->keyLength), NULL);
		if (!(drop && k->value->type == JSON_NULL)) jsonAdd(p, "value", jsonRef(k->value));
		jsonPush(patches, jsonRef(p));
	}
	if (patches->array.count) drvOp(api, "write", drvMap("address", address, "patches", patches, NULL));
	else jsonFree(patches);
}

static void unplaceAt(const ErmPartApi *api, Json *address, const char *id) {
	Json *parent = jsonArray();
	for (int i = 0; i < address->array.count - 1; i++) jsonPush(parent, jsonRef(address->array.items[i]));
	drvOp(api, "unplace", drvMap("address", parent, "name", jsonShallow(address->array.items[address->array.count - 1]), "id", jsonString(id), NULL));
}

/** /dev/mac/status, written when it changed: ephemeral, as everything the
 * driver mirrors (/dev/mac itself is the image's, a document) */
static void status(Mac *m, const ErmPartApi *api) {
	int apps = 0, elements = 0, cut = 0;
	for (int i = 0; i < m->apps.count; i++)
		if (!m->apps.items[i].dead) apps++, elements += m->apps.items[i].elements, cut += m->apps.items[i].cut + m->apps.items[i].top;
	Json *v = drvMap("ax", jsonBoolean(m->ax), "capture", jsonBoolean(m->capture), "on", jsonBoolean(m->on), "apps", jsonInteger(apps),
	                 "elements", jsonInteger(elements), "cut", jsonInteger(cut), NULL);
	char *text = jsonPrint(v);
	if (m->shown && !strcmp(m->shown, text)) {
		free(text);
		return;
	}
	free(m->shown);
	m->shown = text;
	drvSnap(api, dev("status", NULL), v);
}

static void command(Mac *m, Json *c) {
	hostCommand(m->host, c);
}

/** a macdo, its req kept with its asker */
static void act(Mac *m, const char *asker, Json *n, int pid, int64_t at, const char *what, Json *to, Json *key, Json *point) {
	int64_t req = ++m->req;
	ERM_PUSH(m->asks, ((Ask){ req, asker ? copyString(asker) : NULL, n, NULL, false }));
	Json *c = drvMap("op", jsonString("macdo"), "req", jsonInteger(req), "pid", jsonInteger(pid), "n", jsonInteger(at), "act", jsonString(what), NULL);
	if (to) jsonAdd(c, "to", to);
	if (key) jsonAdd(c, "key", key);
	if (point) jsonAdd(c, "point", point);
	command(m, c);
}

/** a launch: a macdo at /dev/mac itself, the app by name, bundle id or path */
static void launch(Mac *m, const char *asker, Json *n, const char *app, bool show) {
	int64_t req = ++m->req;
	ERM_PUSH(m->asks, ((Ask){ req, copyString(asker), n, copyString(app), show }));
	command(m, drvMap("op", jsonString("macdo"), "req", jsonInteger(req), "pid", jsonInteger(0), "n", jsonInteger(0), "act", jsonString("launch"), "app",
	                  jsonString(app), NULL));
}

// --- views

static View *viewNamed(Mac *m, const char *name) {
	for (int i = 0; i < m->views.count; i++)
		if (!strcmp(m->views.items[i]->name, name)) return m->views.items[i];
	return NULL;
}

static View *viewK(Mac *m, int k) {
	for (int i = 0; i < m->views.count; i++)
		if (m->views.items[i]->k == k) return m->views.items[i];
	return NULL;
}

static char *layerName(const View *v) {
	return formatString("mac-%s", v->name);
}

static Json *layerAt(const View *v) {
	char *name = layerName(v);
	Json *at = drvPath("/", "dev", "display", "layers", name, NULL);
	free(name);
	return at;
}

static void unlayer(const ErmPartApi *api, View *v) {
	if (!v->placed) return;
	char *id = formatString("mac/layer/%d", v->k);
	unplaceAt(api, layerAt(v), id);
	free(id);
	v->placed = false;
}

static void uncapture(Mac *m, View *v) {
	if (!v->capturing) return;
	command(m, drvMap("op", jsonString("uncapture"), "view", jsonString(v->name), NULL));
	v->capturing = false;
}

/** hostPlane's: view k's plane, the half its latest frame is in */
static bool planeAt(void *data, int64_t id, HostPlane *out) {
	Mac *m = data;
	View *v = viewK(m, (int)id);
	if (!v || !v->bits || v->w <= 0 || v->h <= 0) return false;
	*out = (HostPlane){ v->bits + (size_t)v->half * (size_t)m->maxw * (size_t)m->maxh, v->w < m->maxw ? v->w : m->maxw, v->h < m->maxh ? v->h : m->maxh, m->maxw };
	return true;
}

static ErmErr onKey(void *data, const ErmGiven *g, Json **out);
static ErmErr onPointer(void *data, const ErmGiven *g, Json **out);
static ErmErr onHover(void *data, const ErmGiven *g, Json **out);

static void handlerAt(Mac *m, const ErmGiven *g, Json *node, int k, const char *name, ErmErr (*fn)(void *, const ErmGiven *, Json **)) {
	// ids of their own: drvHandler's are the part's, one set for every window
	char *on = formatString("%s.mac.%d.on", m->self, k), *nid = formatString("%s.mac.%d.on.%s", m->self, k, name);
	Handle *h = calloc(1, sizeof *h);
	h->mac = m;
	h->k = k;
	drvMake(g->api, node, "on", on, jsonNull());
	drvMakeLive(g->api, drvUnder(node, "on", NULL), name, nid, ermFunction((ErmFn){ fn, h }));
	free(on);
	free(nid);
}

/** the plane file, mapped shared: two halves of maxw × maxh */
static bool plane(Mac *m, View *v) {
	const char *tmp = getenv("TMPDIR") && *getenv("TMPDIR") ? getenv("TMPDIR") : "/tmp";
	size_t len = strlen(tmp);
	v->path = formatString("%.*s/ermine-%d.mac.%d", (int)(len > 1 && tmp[len - 1] == '/' ? len - 1 : len), tmp, (int)getpid(), v->k);
	v->bytes = (size_t)m->maxw * (size_t)m->maxh * 4 * 2;
	int fd = open(v->path, O_RDWR | O_CREAT | O_TRUNC, 0600);
	if (fd < 0 || ftruncate(fd, (off_t)v->bytes) < 0) {
		if (fd >= 0) close(fd);
		hostSay(m->host, "mac: no plane %s", v->path);
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

static Json *ownerAt(const View *v) {
	return dev("windows", v->name);
}

/** a view placed: its owner, its plane, capture */
static void start(Mac *m, const ErmGiven *g, View *v, const Json *value) {
	const Json *window = jsonGet(value, "window");
	int pid = 0;
	int64_t n = 0;
	bool found = resolve(m, window, &pid, &n) && pid > 0;
	Elem *e = found ? elemOf(m, n) : NULL;
	App *a = found ? appOf(m, pid) : NULL;
	char *id = formatString("mac/window/%d", v->k);
	Json *owner = drvMap("window", window ? jsonShallow(window) : jsonNull(), "app", a ? addressOf(m, pid, a->n) : jsonNull(),
	                     "state", jsonString(found && e ? "starting" : "gone"), "input", jsonString(v->input), NULL);
	if (!(found && e)) jsonAdd(owner, "error", jsonString("bad"));
	drvMake(g->api, dev("windows", NULL), v->name, id, owner);
	free(id);
	v->made = true;
	v->state = copyString(found && e ? "starting" : "gone");
	Json *node = ownerAt(v);
	handlerAt(m, g, node, v->k, "key", onKey);
	handlerAt(m, g, node, v->k, "pointer", onPointer);
	handlerAt(m, g, node, v->k, "hover", onHover);
	if (!(found && e) || !plane(m, v)) return;
	v->pid = pid;
	v->window = n;
	command(m, drvMap("op", jsonString("capture"), "view", jsonString(v->name), "pid", jsonInteger(pid), "window", jsonInteger(n), "path", jsonString(v->path),
	                  "maxw", jsonInteger(m->maxw), "maxh", jsonInteger(m->maxh), "fps", jsonInteger(whole(jsonGet(value, "fps"), 30)), NULL));
	v->capturing = true;
}

/** a view's node gone: uncapture, its layer and owner unplaced, its plane let go */
static void stop(Mac *m, const ErmGiven *g, View *v) {
	uncapture(m, v);
	unlayer(g->api, v);
	if (drvHas(g->api, ownerAt(v))) {
		char *id = formatString("mac/window/%d", v->k);
		unplaceAt(g->api, ownerAt(v), id);
		free(id);
	}
	if (v->bits) munmap(v->bits, v->bytes);
	if (v->path) unlink(v->path);
	free(v->path);
	free(v->name);
	free(v->input);
	free(v->state);
	jsonFree(v->want);
	free(v);
}

/** [[name, view, the layer's want, the owner there], ...], read tracked */
static ErmErr viewsCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = jsonArray();
	// read so an owner, or a layer, placed or unplaced runs this again
	drvNames(g->api, dev("windows", NULL));
	Json *layers = drvNames(g->api, drvPath("/", "dev", "display", "layers", NULL));
	Json *names = drvNames(g->api, dev("views", NULL));
	for (int i = 0; jsonIsArray(names) && i < names->array.count; i++) {
		const char *name = jsonText(names->array.items[i]);
		Json *v = drvRead(g->api, dev("views", name)), *row = jsonArray(), *l = NULL;
		char *layer = formatString("mac-%s", name);
		for (int k = 0; jsonIsArray(layers) && k < layers->array.count && !l; k++)
			if (!strcmp(jsonText(layers->array.items[k]), layer)) l = drvRead(g->api, drvPath("/", "dev", "display", "layers", layer, NULL));
		free(layer);
		jsonPush(row, jsonString(name));
		jsonPush(row, jsonIsObject(v) ? jsonShallow(v) : jsonObject());
		jsonPush(row, jsonGet(l, "want") ? jsonShallow(jsonGet(l, "want")) : jsonNull());
		jsonPush(row, jsonBoolean(drvHas(g->api, dev("windows", name))));
		jsonPush(*out, row);
	}
	return ermOk();
}

static ErmErr viewsEffect(void *data, const ErmGiven *g, Json **out) {
	Mac *m = data;
	*out = jsonNull();
	for (int i = 0; i < m->views.count; i++) m->views.items[i]->seen = false;
	for (int i = 0; jsonIsArray(g->value) && i < g->value->array.count; i++) {
		Json *row = g->value->array.items[i], *value = row->array.items[1], *want = row->array.items[2];
		const char *name = jsonText(row->array.items[0]), *input = jsonText(jsonGet(value, "input"));
		bool there = truth(row->array.items[3]);
		if (!name) continue;
		input = input && !strcmp(input, "press") ? "press" : "events";
		View *v = viewNamed(m, name);
		if (!v) {
			v = calloc(1, sizeof *v);
			v->name = copyString(name);
			v->k = ++m->ks;
			v->input = copyString(input);
			v->want = jsonNull();
			ERM_PUSH(m->views, v);
			start(m, g, v, value);
			v->seen = true;
			continue;
		}
		v->seen = true;
		if (v->closed) continue;
		if (strcmp(v->input, input)) {
			free(v->input);
			v->input = copyString(input);
			if (there) drvSet(g->api, ownerAt(v), "input", jsonString(input));
		}
		// wmii closed it: the owner unplaced
		if (v->made && !there) {
			uncapture(m, v);
			unlayer(g->api, v);
			v->closed = true;
			continue;
		}
		// wmii's size: the window's
		int64_t w, h;
		if (v->window && jsonIsWhole(jsonGet(want, "w"), &w) && jsonIsWhole(jsonGet(want, "h"), &h) && !jsonEqual(want, v->want)) {
			jsonFree(v->want);
			v->want = jsonRef(want);
			act(m, NULL, jsonNull(), v->pid, v->window, "set", jsonRef(drvMap("w", jsonInteger(w), "h", jsonInteger(h), NULL)), NULL, NULL);
		}
	}
	int k = 0;
	for (int i = 0; i < m->views.count; i++) {
		View *v = m->views.items[i];
		if (v->seen) m->views.items[k++] = v;
		else stop(m, g, v);
	}
	m->views.count = k;
	return ermOk();
}

/** frame: the layer placed or brought up to date, then took */
static void frame(Mac *m, const ErmGiven *g, View *v, const Json *r) {
	int64_t n = whole(jsonGet(r, "n"), 0), half = whole(jsonGet(r, "half"), 0), w = whole(jsonGet(r, "w"), 0), h = whole(jsonGet(r, "h"), 0);
	if (!v->closed && strcmp(v->state, "gone") && v->bits && w > 0 && h > 0) {
		v->half = half == 1 ? 1 : 0;
		v->serial = n;
		Json *plane = drvMap("source", jsonString("mac"), "id", jsonInteger(v->k), "serial", jsonInteger(n), NULL);
		if (jsonIsObject(jsonGet(r, "dirty"))) jsonAdd(plane, "dirty", jsonShallow(jsonGet(r, "dirty")));
		Elem *e = elemOf(m, v->window);
		const char *title = e && e->title && *e->title ? e->title : "mac";
		if (!v->placed) {
			// each new window a step down and right of the last, so none hides another
			int c = (int)(m->cascade++ % 8);
			char *name = layerName(v), *id = formatString("mac/layer/%d", v->k);
			drvMake(g->api, drvPath("/", "dev", "display", "layers", NULL), name, id,
			        drvMap("x", jsonInteger((80 + 24 * c) * m->unit), "y", jsonInteger((60 + 24 * c) * m->unit), "w", jsonInteger(w), "h", jsonInteger(h),
			               "title", jsonString(title), "owner", ownerAt(v), "drags", jsonBoolean(true), "plane", plane, NULL));
			free(name);
			free(id);
			v->placed = true;
		} else {
			Json *keys = drvMap("plane", plane, NULL);
			if (w != v->w) jsonAdd(keys, "w", jsonInteger(w));
			if (h != v->h) jsonAdd(keys, "h", jsonInteger(h));
			Json *l = drvRead(g->api, layerAt(v));
			if (!jsonText(jsonGet(l, "title")) || strcmp(jsonText(jsonGet(l, "title")), title)) jsonAdd(keys, "title", jsonString(title));
			put(g->api, layerAt(v), keys, false);
		}
		v->w = (int)w, v->h = (int)h;
	}
	command(m, drvMap("op", jsonString("took"), "view", jsonString(v->name), "n", jsonInteger(n), NULL));
}

/** the owner says why it is not shown: gone, minimized, denied... */
static void state(const ErmGiven *g, View *v, const char *s, const Json *error) {
	free(v->state);
	v->state = copyString(s);
	if (!strcmp(s, "gone")) unlayer(g->api, v);
	if (!v->closed && drvHas(g->api, ownerAt(v))) put(g->api, ownerAt(v), drvMap("state", jsonString(s), "error", error ? jsonShallow(error) : jsonNull(), NULL), true);
}

// --- input, from wmii: the owner's handlers

static Json *recsOf(const ErmGiven *g) {
	return g->args && g->args->array.count ? g->args->array.items[0] : NULL;
}

static void input(Mac *m, View *v, Json *events) {
	if (!v->capturing || !jsonIsArray(events) || !events->array.count) return;
	command(m, drvMap("op", jsonString("macinput"), "view", jsonString(v->name), "events", events, NULL));
}

/** the deepest element of the view's window whose frame holds layer pixel
 * x, y (the frame's pixels, the window's scaled to fit the plane), and
 * that point on the desktop */
static Elem *hit(Mac *m, View *v, double x, double y, double *dx, double *dy) {
	Elem *win = elemOf(m, v->window), *best = NULL;
	if (!win || !win->framed) return NULL;
	double kx = v->w > 0 && win->w > 0 ? win->w / v->w : 1, ky = v->h > 0 && win->h > 0 ? win->h / v->h : 1;
	double px = win->x + x * kx, py = win->y + y * ky;
	*dx = px, *dy = py;
	int deepest = -1;
	for (int i = 0; i < m->elems.count; i++) {
		Elem *e = m->elems.items[i];
		if (e->dead || e->pid != v->pid || !e->framed || px < e->x || py < e->y || px >= e->x + e->w || py >= e->y + e->h) continue;
		int depth = 0;
		Elem *up = e;
		while (up && up != win && up->parent) up = elemOf(m, up->parent), depth++;
		if (up == win && depth >= deepest) best = e, deepest = depth;
	}
	return best;
}

static ErmErr onKey(void *data, const ErmGiven *g, Json **out) {
	Handle *h = data;
	*out = jsonNull();
	View *v = viewK(h->mac, h->k);
	if (v && !v->closed) input(h->mac, v, recsOf(g));
	return ermOk();
}

static ErmErr onPointer(void *data, const ErmGiven *g, Json **out) {
	Handle *h = data;
	Mac *m = h->mac;
	*out = jsonNull();
	View *v = viewK(m, h->k);
	Json *recs = recsOf(g);
	if (!v || v->closed || !jsonIsArray(recs)) return ermOk();
	if (strcmp(v->input, "press")) {
		input(m, v, jsonRef(recs));
		return ermOk();
	}
	// a click, down and up with no drag between, presses what is under it
	Json *rest = jsonArray();
	for (int i = 0; i < recs->array.count; i++) {
		Json *r = recs->array.items[i], *x = jsonGet(r, "x"), *y = jsonGet(r, "y");
		const char *e = jsonText(jsonGet(r, "event"));
		if (!e || !jsonIsNumber(x) || !jsonIsNumber(y)) continue;
		if (!strcmp(e, "down")) v->down = true, v->dragged = false, v->dx = x->number, v->dy = y->number;
		else if (!strcmp(e, "move") && v->down) {
			double ddx = x->number - v->dx, ddy = y->number - v->dy;
			if (ddx * ddx + ddy * ddy >= 16 * m->unit * m->unit) v->dragged = true;
		} else if (!strcmp(e, "up") && v->down) {
			v->down = false;
			double px = 0, py = 0;
			Elem *at = v->dragged ? NULL : hit(m, v, v->dx, v->dy, &px, &py);
			// the point with it: the metal presses only if the element is still there
			if (at)
				act(m, NULL, jsonNull(), at->pid, at->n, at->press ? "AXPress" : "focus", NULL, NULL,
				    jsonRef(drvMap("x", jsonInteger((int64_t)px), "y", jsonInteger((int64_t)py), NULL)));
		} else if (!strcmp(e, "scroll")) jsonPush(rest, jsonRef(r));
	}
	input(m, v, rest);
	return ermOk();
}

static ErmErr onHover(void *data, const ErmGiven *g, Json **out) {
	Handle *h = data;
	*out = jsonNull();
	View *v = viewK(h->mac, h->k);
	Json *recs = recsOf(g), *moves = jsonArray();
	if (!v || v->closed || !strcmp(v->input, "press")) return ermOk();
	for (int i = 0; jsonIsArray(recs) && i < recs->array.count; i++) {
		const char *e = jsonText(jsonGet(recs->array.items[i], "event"));
		if (e && !strcmp(e, "move")) jsonPush(moves, jsonRef(recs->array.items[i]));
	}
	input(h->mac, v, moves);
	return ermOk();
}

// --- records

/** tree: its items in order, then mactook; one line in the log. The
 * app's own n set: its order, cut and more, into the app's node. */
static void tree(Mac *m, const ErmGiven *g, const Json *r) {
	int pid = (int)whole(jsonGet(r, "pid"), 0);
	App *a = appOf(m, pid);
	Json *items = jsonGet(r, "items");
	if (jsonIsArray(items)) command(m, drvMap("op", jsonString("mactook"), "items", jsonInteger(items->array.count), NULL));
	if (!a || !jsonIsArray(items)) return;
	int adds = 0, sets = 0, drops = 0;
	for (int i = 0; i < items->array.count; i++) {
		Json *it = items->array.items[i], *value = jsonGet(it, "value");
		int64_t n;
		if (jsonIsWhole(jsonGet(it, "add"), &n)) {
			int64_t parent = whole(jsonGet(it, "parent"), 0);
			const char *name = jsonText(jsonGet(it, "name"));
			Elem *p = parent ? elemOf(m, parent) : NULL;
			if (!name || elemOf(m, n) || (parent && (!p || p->pid != pid || !alive(m, p)))) continue;
			Elem *e = calloc(1, sizeof *e);
			e->n = n, e->parent = parent, e->pid = pid, e->name = copyString(name);
			note(e, value);
			if (m->elems.count * 2 + 2 > m->cap) {
				ERM_PUSH(m->elems, e);
				reindex(m);
			} else {
				ERM_PUSH(m->elems, e);
				indexPut(m, e);
			}
			char *id = idOf(n);
			// the name is free (the metal names each element among its siblings, role-k): placed without a read
			drvPlace(g->api, addressOf(m, pid, parent), name, id, jsonIsObject(value) ? jsonShallow(value) : jsonObject());
			free(id);
			a->elements++, a->cut += e->cut;
			adds++;
		} else if (jsonIsWhole(jsonGet(it, "set"), &n) && n == a->n) {
			if (!jsonIsObject(value)) continue;
			Json *cut = jsonGet(value, "cut");
			if (cut) a->top = jsonText(cut) != NULL;
			put(g->api, addressOf(m, pid, a->n), value, true);
			sets++;
		} else if (jsonIsWhole(jsonGet(it, "set"), &n)) {
			Elem *e = elemOf(m, n);
			if (!e || !alive(m, e) || !jsonIsObject(value)) continue;
			bool cut = e->cut;
			note(e, value);
			a->cut += e->cut - cut;
			put(g->api, addressOf(m, pid, n), value, true);
			sets++;
		} else if (jsonIsWhole(jsonGet(it, "drop"), &n)) {
			Elem *e = elemOf(m, n);
			if (!e || !alive(m, e)) continue;
			char *id = idOf(n);
			unplaceAt(g->api, addressOf(m, pid, n), id);
			free(id);
			e->dead = true;
			drops++;
		}
	}
	// the table purged, and the counts written, once at the irq's end
	if (drops) m->dropped = true;
	if (adds || drops) m->changed = true;
	hostSay(m->host, "mac: %d %s +%d ~%d -%d", pid, a->name ? a->name : "", adds, sets, drops);
}

static const char *APPKEYS[] = { "name", "bundle", "path", "policy", "active", "hidden", "state", "electron" };

static void app(Mac *m, const ErmGiven *g, const Json *r) {
	int pid = (int)whole(jsonGet(r, "pid"), 0);
	int64_t n = whole(jsonGet(r, "n"), 0);
	if (pid <= 0) return;
	App *a = appOf(m, pid);
	Json *v = jsonObject();
	for (size_t i = 0; i < sizeof APPKEYS / sizeof *APPKEYS; i++) jsonAdd(v, APPKEYS[i], jsonGet(r, APPKEYS[i]) ? jsonShallow(jsonGet(r, APPKEYS[i])) : jsonNull());
	char p[24];
	snprintf(p, sizeof p, "%d", pid);
	if (!a) {
		ERM_PUSH(m->apps, ((App){ .pid = pid, .n = n }));
		a = &m->apps.items[m->apps.count - 1];
		jsonAdd(v, "elements", jsonInteger(0));
		jsonAdd(v, "cut", jsonInteger(0));
		a->wrote[0] = a->wrote[1] = 0;
		char *id = idOf(n);
		drvMake(g->api, dev("apps", NULL), p, id, jsonRef(v));
		free(id);
	} else put(g->api, dev("apps", p), v, false);
	free(a->name);
	a->name = jsonText(jsonGet(r, "name")) ? copyString(jsonText(jsonGet(r, "name"))) : NULL;
	jsonFree(a->value);
	a->value = v;
}

static void quit(Mac *m, const ErmGiven *g, int pid) {
	App *a = appOf(m, pid);
	if (!a) return;
	char p[24], *id = idOf(a->n);
	snprintf(p, sizeof p, "%d", pid);
	unplaceAt(g->api, dev("apps", p), id);
	free(id);
	a->dead = true;
	purge(m);
	m->changed = true;
	if (m->focus == pid) {
		m->focus = 0, m->focused = 0;
		drvSnap(g->api, dev("focus", NULL), drvMap("app", jsonNull(), "element", jsonNull(), NULL));
	}
	// launched with show and quit before a window came: not waited for
	int s = 0;
	for (int i = 0; i < m->shows.count; i++) {
		if (m->shows.items[i].pid != pid) m->shows.items[s++] = m->shows.items[i];
		else free(m->shows.items[i].name);
	}
	m->shows.count = s;
	// its windows shown: gone
	for (int i = 0; i < m->views.count; i++)
		if (m->views.items[i]->pid == pid && m->views.items[i]->window) state(g, m->views.items[i], "gone", NULL);
	// the list without it
	int k = 0;
	for (int i = 0; i < m->apps.count; i++)
		if (!m->apps.items[i].dead) m->apps.items[k++] = m->apps.items[i];
		else free(m->apps.items[i].name), jsonFree(m->apps.items[i].value);
	m->apps.count = k;
}

static void done(Mac *m, const ErmGiven *g, const Json *r) {
	int64_t req = whole(jsonGet(r, "req"), -1);
	for (int i = 0; i < m->asks.count; i++) {
		Ask *ask = &m->asks.items[i];
		if (ask->req != req) continue;
		const Json *error = jsonGet(r, "error");
		if (ask->app) {
			// a launch: its pid, or why not, in the log too; with show, its first window waited for
			int64_t pid = whole(jsonGet(r, "value"), 0);
			if (jsonText(error)) hostSay(m->host, "mac: launch %s: %s", ask->app, jsonText(error));
			else hostSay(m->host, "mac: launch %s: %lld", ask->app, (long long)pid);
			if (ask->show && !jsonText(error) && pid > 0) ERM_PUSH(m->shows, ((Show){ (int)pid, copyString(ask->name) }));
			free(ask->app);
		}
		if (ask->name && drvHas(g->api, dev("do", ask->name))) {
			Json *keys = drvMap("done", ask->n, "error", error ? jsonShallow(error) : jsonNull(), NULL);
			if (jsonGet(r, "value")) jsonAdd(keys, "value", jsonShallow(jsonGet(r, "value")));
			put(g->api, dev("do", ask->name), keys, false);
		} else {
			jsonFree(ask->n);
			if (jsonText(error)) hostSay(m->host, "mac: macdo %lld: %s", (long long)req, jsonText(error));
		}
		free(ask->name);
		m->asks.items[i] = m->asks.items[--m->asks.count];
		return;
	}
}

static void leases(Mac *m, const ErmPartApi *api);

/** a window shown as macapps' Enter shows one: /programs/macview, given its
 * id, started through the window manager's launch (or started, with none) */
static void present(const ErmPartApi *api, int64_t n) {
	char *id = idOf(n);
	Json *op = drvMap("address", drvPath("/", "apps", "macview", NULL), "program", jsonString("programs/macview"), "data", drvMap("window", jsonString(id), NULL), NULL);
	free(id);
	Json *at = drvRead(api, drvPath("/", "dev", "wm", "launch", NULL));
	if (!jsonIsArray(at)) {
		drvOp(api, "start", op);
		return;
	}
	Json *args = jsonArray();
	jsonPush(args, op);
	drvOp(api, "call", drvMap("address", at, "args", args, NULL));
}

/** each app launched with show whose first window is here now: shown, and
 * its id written into the do node (shown) if that is still there */
static void showing(Mac *m, const ErmPartApi *api) {
	int k = 0;
	for (int i = 0; i < m->shows.count; i++) {
		Show *s = &m->shows.items[i];
		Elem *w = NULL;
		for (int j = 0; j < m->elems.count && !w; j++) {
			Elem *e = m->elems.items[j];
			if (e->pid == s->pid && !e->parent && !e->dead && e->role && !strcmp(e->role, "AXWindow")) w = e;
		}
		if (!w) {
			m->shows.items[k++] = *s;
			continue;
		}
		present(api, w->n);
		if (s->name && drvHas(api, dev("do", s->name))) {
			char *id = idOf(w->n);
			put(api, dev("do", s->name), drvMap("shown", jsonString(id), NULL), false);
			free(id);
		}
		free(s->name);
	}
	m->shows.count = k;
}

/** after a batch: the table purged once, the focus let go if its element
 * went, each app's counts written if they changed, the opens resolved again */
static void settle(Mac *m, const ErmPartApi *api) {
	if (m->dropped) {
		purge(m);
		m->dropped = false;
		Elem *e = m->focused ? elemOf(m, m->focused) : NULL;
		if (m->focused && (!e || !alive(m, e))) {
			App *a = appOf(m, m->focus);
			m->focused = 0;
			drvSnap(api, dev("focus", NULL), drvMap("app", a ? addressOf(m, a->pid, a->n) : jsonNull(), "element", jsonNull(), NULL));
		}
	}
	for (int i = 0; i < m->apps.count; i++) {
		App *a = &m->apps.items[i];
		if (a->dead || (a->wrote[0] == a->elements && a->wrote[1] == a->cut + a->top)) continue;
		a->wrote[0] = a->elements, a->wrote[1] = a->cut + a->top;
		put(api, addressOf(m, a->pid, a->n), drvMap("elements", jsonInteger(a->elements), "cut", jsonInteger(a->cut + a->top), NULL), false);
	}
	if (m->changed && m->opens.count) leases(m, api);
	m->changed = false;
	if (m->shows.count) showing(m, api);
}

/** irq 51 */
static ErmErr macIrq(void *data, const ErmGiven *g, Json **out) {
	Mac *m = data;
	*out = jsonNull();
	Json *recs = recsOf(g);
	for (int i = 0; jsonIsArray(recs) && i < recs->array.count; i++) {
		Json *r = recs->array.items[i];
		const char *e = jsonText(jsonGet(r, "event"));
		if (!e) continue;
		if (!strcmp(e, "access")) {
			m->ax = truth(jsonGet(r, "ax"));
			m->capture = truth(jsonGet(r, "capture"));
		} else if (!strcmp(e, "app")) app(m, g, r);
		else if (!strcmp(e, "quit")) quit(m, g, (int)whole(jsonGet(r, "pid"), 0));
		else if (!strcmp(e, "tree")) tree(m, g, r);
		else if (!strcmp(e, "focus")) {
			int pid = (int)whole(jsonGet(r, "pid"), 0);
			int64_t n = whole(jsonGet(r, "n"), 0);
			App *a = appOf(m, pid);
			Elem *el = n ? elemOf(m, n) : NULL;
			bool there = a && el && alive(m, el);
			m->focus = a ? pid : 0, m->focused = there ? n : 0;
			drvSnap(g->api, dev("focus", NULL),
			        drvMap("app", a ? addressOf(m, pid, a->n) : jsonNull(), "element", there ? addressOf(m, pid, n) : jsonNull(), NULL));
		} else if (!strcmp(e, "done")) done(m, g, r);
		else if (!strcmp(e, "view") || !strcmp(e, "frame")) {
			View *v = jsonText(jsonGet(r, "view")) ? viewNamed(m, jsonText(jsonGet(r, "view"))) : NULL;
			if (!v) continue;
			if (!strcmp(e, "frame")) frame(m, g, v, r);
			else if (jsonText(jsonGet(r, "state"))) state(g, v, jsonText(jsonGet(r, "state")), jsonGet(r, "error"));
		}
	}
	settle(m, g->api);
	status(m, g->api);
	return ermOk();
}

// --- the children: /etc/mac, do, open

/** /etc/mac, read tracked */
static ErmErr etcCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	Json *v = drvRead(g->api, drvPath("/", "etc", "mac", NULL));
	*out = jsonIsObject(v) ? jsonShallow(v) : jsonObject();
	return ermOk();
}

/** the mac command: /etc/mac's bounds, each missing one its default */
static ErmErr etcEffect(void *data, const ErmGiven *g, Json **out) {
	Mac *m = data;
	*out = jsonNull();
	Json *v = g->value;
	Json *c = drvMap("op", jsonString("mac"), "on", jsonBoolean(!jsonGet(v, "on") || truth(jsonGet(v, "on"))), "depth", jsonInteger(whole(jsonGet(v, "depth"), 24)),
	                 "app", jsonInteger(whole(jsonGet(v, "app"), 4000)), "total", jsonInteger(whole(jsonGet(v, "total"), 40000)),
	                 "rows", jsonInteger(whole(jsonGet(v, "rows"), 200)), "text", jsonInteger(whole(jsonGet(v, "text"), 4096)),
	                 "hz", jsonInteger(whole(jsonGet(v, "hz"), 10)), "skip", jsonIsArray(jsonGet(v, "skip")) ? jsonShallow(jsonGet(v, "skip")) : jsonArray(), NULL);
	m->on = truth(jsonGet(c, "on"));
	// the first: this driver is new, everything the metal has wanted again
	if (!m->synced) jsonAdd(c, "sync", jsonBoolean(true));
	m->synced = true;
	command(m, c);
	status(m, g->api);
	return ermOk();
}

/** [[name, value], ...] of a folder of a program's nodes, read tracked */
static Json *asked(const ErmGiven *g, const char *folder) {
	Json *rows = jsonArray(), *names = drvNames(g->api, dev(folder, NULL));
	for (int i = 0; jsonIsArray(names) && i < names->array.count; i++) {
		const char *name = jsonText(names->array.items[i]);
		Json *v = drvRead(g->api, dev(folder, name)), *row = jsonArray();
		jsonPush(row, jsonString(name));
		jsonPush(row, jsonIsObject(v) ? jsonShallow(v) : jsonObject());
		jsonPush(rows, row);
	}
	return rows;
}

static ErmErr doCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = asked(g, "do");
	return ermOk();
}

/** each do with a new n: macdo, or the answer bad at once */
static ErmErr doEffect(void *data, const ErmGiven *g, Json **out) {
	Mac *m = data;
	*out = jsonNull();
	for (int i = 0; i < m->dids.count; i++) m->dids.items[i].seen = false;
	for (int i = 0; jsonIsArray(g->value) && i < g->value->array.count; i++) {
		Json *row = g->value->array.items[i], *v = row->array.items[1], *n = jsonGet(v, "n");
		const char *name = jsonText(row->array.items[0]), *what = jsonText(jsonGet(v, "act"));
		Did *did = NULL;
		for (int k = 0; k < m->dids.count && !did; k++)
			if (!strcmp(m->dids.items[k].name, name)) did = &m->dids.items[k];
		if (!did) {
			ERM_PUSH(m->dids, ((Did){ .name = copyString(name), .n = NULL }));
			did = &m->dids.items[m->dids.count - 1];
		}
		did->seen = true;
		if (!n || (did->n && jsonEqual(did->n, n))) continue;
		jsonFree(did->n);
		did->n = jsonShallow(n);
		// a launch: at /dev/mac itself (or no at), the app by name, bundle id or path
		if (what && !strcmp(what, "launch")) {
			int pid;
			int64_t at;
			const char *app = jsonText(jsonGet(v, "app"));
			bool here = !jsonGet(v, "at") || (resolve(m, jsonGet(v, "at"), &pid, &at) && !pid && !at);
			if (!here || !app || !*app) put(g->api, dev("do", name), drvMap("done", jsonShallow(n), "error", jsonString("bad"), NULL), false);
			else {
				put(g->api, dev("do", name), drvMap("sent", jsonShallow(n), NULL), false);
				launch(m, name, jsonShallow(n), app, truth(jsonGet(v, "show")));
			}
			continue;
		}
		int pid;
		int64_t at;
		if (!what || !resolve(m, jsonGet(v, "at"), &pid, &at)) {
			put(g->api, dev("do", name), drvMap("done", jsonShallow(n), "error", jsonString("bad"), NULL), false);
			continue;
		}
		// with the id it read: the element at that address now must be that one
		const char *id = jsonText(jsonGet(v, "id"));
		char *now = idOf(at);
		bool same = !id || !strcmp(id, now);
		free(now);
		if (!same) {
			put(g->api, dev("do", name), drvMap("done", jsonShallow(n), "error", jsonString("gone"), NULL), false);
			continue;
		}
		put(g->api, dev("do", name), drvMap("sent", jsonShallow(n), NULL), false);
		act(m, name, jsonShallow(n), pid, at, what, jsonGet(v, "to") ? jsonShallow(jsonGet(v, "to")) : NULL, jsonGet(v, "key") ? jsonShallow(jsonGet(v, "key")) : NULL, NULL);
	}
	int k = 0;
	for (int i = 0; i < m->dids.count; i++) {
		if (m->dids.items[i].seen) m->dids.items[k++] = m->dids.items[i];
		else free(m->dids.items[i].name), jsonFree(m->dids.items[i].n);
	}
	m->dids.count = k;
	return ermOk();
}

static ErmErr openCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = asked(g, "open");
	return ermOk();
}

static void lift(Mac *m, int pid, int64_t n, int64_t depth) {
	command(m, drvMap("op", jsonString("macopen"), "pid", jsonInteger(pid), "n", jsonInteger(n), "depth", jsonInteger(depth), NULL));
}

/** every open resolved again, its answer written into it when it changed;
 * then per element the deepest of its opens: macopen when that changed,
 * depth 0 when its last open went. Run when the opens change and when the
 * tree does (an element re-made, an open placed before its element came). */
static void leases(Mac *m, const ErmPartApi *api) {
	for (int i = 0; i < m->leases.count; i++) m->leases.items[i].want = 0;
	for (int i = 0; i < m->opens.count; i++) {
		Open *o = &m->opens.items[i];
		int pid;
		int64_t n;
		bool found = resolve(m, o->at, &pid, &n) && pid > 0;
		char *said = found ? idOf(n) : copyString("");
		if (!o->said || strcmp(o->said, said)) {
			if (drvHas(api, dev("open", o->name)))
				put(api, dev("open", o->name), drvMap("n", found ? jsonString(said) : jsonNull(), "error", found ? jsonNull() : jsonString("bad"), NULL), false);
			free(o->said);
			o->said = said;
		} else free(said);
		if (!found) continue;
		Lease *l = NULL;
		for (int k = 0; k < m->leases.count && !l; k++)
			if (m->leases.items[k].pid == pid && m->leases.items[k].n == n) l = &m->leases.items[k];
		if (!l) {
			ERM_PUSH(m->leases, ((Lease){ .pid = pid, .n = n }));
			l = &m->leases.items[m->leases.count - 1];
		}
		if (o->depth > l->want) l->want = o->depth;
	}
	int k = 0;
	for (int i = 0; i < m->leases.count; i++) {
		Lease *l = &m->leases.items[i];
		if (l->want != l->sent) lift(m, l->pid, l->n, l->want);
		l->sent = l->want;
		if (l->want) m->leases.items[k++] = *l;
	}
	m->leases.count = k;
}

/** the opens as the folder has them, then leases */
static ErmErr openEffect(void *data, const ErmGiven *g, Json **out) {
	Mac *m = data;
	*out = jsonNull();
	for (int i = 0; i < m->opens.count; i++) m->opens.items[i].seen = false;
	for (int i = 0; jsonIsArray(g->value) && i < g->value->array.count; i++) {
		Json *row = g->value->array.items[i], *v = row->array.items[1];
		const char *name = jsonText(row->array.items[0]);
		Open *o = NULL;
		for (int k = 0; k < m->opens.count && !o; k++)
			if (!strcmp(m->opens.items[k].name, name)) o = &m->opens.items[k];
		if (!o) {
			ERM_PUSH(m->opens, ((Open){ .name = copyString(name) }));
			o = &m->opens.items[m->opens.count - 1];
		}
		o->seen = true;
		jsonFree(o->at);
		o->at = jsonGet(v, "at") ? jsonShallow(jsonGet(v, "at")) : jsonNull();
		o->depth = whole(jsonGet(v, "depth"), 12);
		if (o->depth < 1) o->depth = 1;
	}
	int k = 0;
	for (int i = 0; i < m->opens.count; i++) {
		Open *o = &m->opens.items[i];
		if (o->seen) {
			m->opens.items[k++] = *o;
			continue;
		}
		free(o->name);
		free(o->said);
		jsonFree(o->at);
	}
	m->opens.count = k;
	leases(m, g->api);
	return ermOk();
}

ErmErr driverMac(void *data, const ErmGiven *g, Json **out) {
	*out = jsonNull();
	Mac *m = calloc(1, sizeof *m);
	m->host = data;
	m->self = copyString(jsonText(g->self));
	reindex(m);
	Json *mode = drvRead(g->api, drvPath("/", "dev", "display", "mode", NULL));
	m->unit = (int)whole(jsonGet(mode, "unit"), 1);
	if (m->unit < 1) m->unit = 1;
	Json *fb = jsonGet(hostTree(m->host), "fb");
	m->maxw = (int)whole(jsonGet(fb, "maxw"), 0);
	m->maxh = (int)whole(jsonGet(fb, "maxh"), 0);
	// the device, as the device tree says it at start
	Json *devices = jsonGet(hostTree(m->host), "devices");
	for (int i = 0; jsonIsArray(devices) && i < devices->array.count; i++) {
		Json *d = devices->array.items[i];
		if (whole(jsonGet(d, "irq"), 0) != IRQ) continue;
		m->ax = truth(jsonGet(d, "ax"));
		m->capture = truth(jsonGet(d, "capture"));
	}
	Json *at = drvPath("/", "dev", "mac", NULL);
	drvMake(g->api, at, "status", "mac/status", jsonNull());
	drvMake(g->api, at, "focus", "mac/focus", drvMap("app", jsonNull(), "element", jsonNull(), NULL));
	drvMake(g->api, at, "apps", "mac/apps", jsonNull());
	drvMake(g->api, at, "do", "mac/do", jsonNull());
	drvMake(g->api, at, "open", "mac/open", jsonNull());
	drvMake(g->api, at, "views", "mac/views", jsonNull());
	drvMake(g->api, at, "windows", "mac/windows", jsonNull());
	Json *here = drvHere(g);
	drvHandler(g, here, "irq", (ErmFn){ macIrq, m });
	drvClaim(g, here, IRQ);
	drvChild(g, here, "etc", (ErmFn){ etcCompute, m }, (ErmFn){ etcEffect, m });
	drvChild(g, here, "do", (ErmFn){ doCompute, m }, (ErmFn){ doEffect, m });
	drvChild(g, here, "open", (ErmFn){ openCompute, m }, (ErmFn){ openEffect, m });
	drvChild(g, here, "views", (ErmFn){ viewsCompute, m }, (ErmFn){ viewsEffect, m });
	hostPlanes(m->host, "mac", planeAt, m);
	return ermOk();
}
