// drv_link.c: /drivers/link, a window shared between machines, as erminex
// shares one (playground/term: erminex, ermine-term, ermine-look; NOTES.md there). The link is sync:
// a window is a few documents, synced over this machine's connection to /etc/sync's server as every
// document is (net.c, peer/peer.c), and anyone with the window's id sees it and types into it. The old link (layers/link: an owner answering its mounters' WIRE.tex lines over
// Subduction's ephemeral messages on a channel's topic) went with the old core; a channel is now
// the window's id.
//
// A window (playground/term/window.h), every node a document:
//   W  {window: 1, program: [argv...], by: the key of the device running it}; {exited: status} added when it ends
//     screen -> S   the grid: {rows, cols, lines, styles, cursor: {row, col, visible}, title}
//     size   -> Z   {rows, cols}: what the program is given
//     keys   -> K   null; a typer each: <typer> -> T {from, keys}: that typer's last keys, key i number from + i
//
// Seeing one (programs/erminex):
//   /dev/link/views/<name>     a program's, ephemeral: {channel}: a window's id (ermine://, 64 hex digits; or the
//                              digits alone), or a name: the window shared under it (below)
//   /dev/link/windows/<name>   the driver's: {channel: W's id, state, owner?, why?}: state "dialing" till W is here,
//                              "mounted", "gone" once its program exited (why says so); owner W's by
//     screen -> S              W's screen, the document itself, kept in step by sync
//   /dev/link/keys             the handler typing into a window, on/keys: called (view's name, [key...]), keys as
//                              erminex.js gives them ("enter", "up", "C-c", a character; a paste a list of them):
//                              written to this device's typer T in W's keys (made at the first key; t and the key's
//                              first 8 digits, as playground/term's typer)
//
// Sharing one (the shell's erminex <name> <cmd...>):
//   /dev/link/driver/on/share    ({argv, name?, rows?, cols?}): argv run on a pty (/dev/pty, drv_pty.c) and its
//                                window shared: W made, fresh, S kept in step with the session's screen, Z given to
//                                it as its size, each typer's new keys typed into it; with a name, the name's node
//                                pointed at W. When the program exits W says so, and the share ends
//   /dev/link/shares/<name>      the driver's: {window: W's id, program, state}; inside it W, as window, the name's
//                                node, as name, and the pty session drv_pty.c makes there (<name>/<n>)
//   /dev/link/driver/on/unshare  (name): the share ended now, its program hung up
//
// A name's node N: {name, window: W's id, by}, the window last shared under it; its id "ermine://", the first 16
// bytes of BLAKE3("ermine window:" name) as hex, then 16 zero bytes (a fresh id's shape: galaxy.observer keeps
// only those), so a share and a view of one name meet. A view of N follows it to each window shared under the
// name. A name shared before, elsewhere, gives N two versions here once that one's history comes: the sharer
// writes N again, over both, once (two machines sharing one name at once leave N two versions; a view shows
// the first).
//
// What a view or a share reads is brought into memory (peerBring): N, W, and what W's lists name (S, Z, K,
// each typer's T), loaded once the card holds them, followed from the server till then.

#include "drivers.h"
#include "drv.h"
#include "peer/peer.h"

// an address that is a node, by its id (api.h's AP_ID)
#define ID(id) (const char *const[]){ AP_ID, (id) }, 2

#include "../../../ermine/encoding/c/blake3/blake3.h"
#include "../../../extensions/subduction/c/id.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define KEPT 64 // keys a typer's node keeps

/** a window seen: a view's */
typedef struct View {
	char *name;    // the view's
	char *channel; // as asked
	char *asked;   // the id it names: W's, or a name's node's
	char *id;      // W's; while a name's node is not here, the node's
	char *window;  // its node in /dev/link/windows
	char *screen;  // S's id, placed in it; NULL: none yet
	char *keys;    // K's id; NULL: not known yet
	char *shown;   // the window's value as last written
	// this device's typer: its node (NULL: not made), and its last keys, key i number from + i
	char *typer;
	long from;
	char *typed[KEPT];
	int ntyped;
} View;

/** a window shared: a program on a pty, its screen kept in W's */
typedef struct Share {
	char *name;
	char *w, *s, *z, *k; // W, S, Z and K's ids
	char *n;             // the name's node's; NULL: shared with no name
	bool healed;         // written again over the versions of the name's node it found
	Json *program;
	char *at;     // its node in /dev/link/shares
	bool first;   // its effect has not run yet
	int rows, cols;
	char **lines, **styles; // each row as last written to S
	char *cursor, *title;
	int size[2];  // the size last given to the session; 0: none
	ErmMap fed;   // a typer's name -> (void *)(the number of its next key not yet typed + 1)
} Share;

static struct {
	Host *host;
	Peer *peer;
	ERM_LIST(View *) views;
	ERM_LIST(Share *) shares;
	int count; // shares made without a name
	char typer[16];
} L;

// --- small things

static Json *at(const char *first, const char *second) {
	return drvPath("/", "dev", "link", first, second, NULL);
}

static char *dup(const char *t) {
	return t ? copyString(t) : NULL;
}

/** a channel as given: a window's id; 64 hex digits, with ermine:// or not; else a name, the id made of it. True: an id given */
static bool idOf(const char *given, char out[ID_LENGTH + 1]) {
	while (*given == ' ' || *given == '\t' || *given == '\n') given++;
	size_t n = strlen(given);
	while (n && (given[n - 1] == ' ' || given[n - 1] == '\t' || given[n - 1] == '\n')) n--;
	const char *hex = n == ID_LENGTH && !strncmp(given, "ermine://", 9) ? given + 9 : n == 64 ? given : NULL;
	bool ok = hex != NULL;
	for (int i = 0; ok && i < 64; i++) ok = strchr("0123456789abcdefABCDEF", hex[i]) != NULL;
	if (ok) {
		memcpy(out, "ermine://", 9);
		for (int i = 0; i < 64; i++) out[9 + i] = (char)(hex[i] >= 'A' && hex[i] <= 'F' ? hex[i] - 'A' + 'a' : hex[i]);
		out[ID_LENGTH] = 0;
		return true;
	}
	blake3_hasher h;
	blake3_hasher_init(&h);
	blake3_hasher_update(&h, "ermine window:", 14);
	blake3_hasher_update(&h, given, n);
	uint8_t hash[32];
	blake3_hasher_finalize(&h, hash, 32);
	memcpy(out, "ermine://", 9);
	for (int i = 0; i < 16; i++) snprintf(out + 9 + 2 * i, 3, "%02x", hash[i]);
	memset(out + 41, '0', 32);
	out[ID_LENGTH] = 0;
	return false;
}

/** the value of the node of an id: its first loaded item's first version; NULL if none */
static const op_value *valueOf(ap_api *api, const char *id) {
	ap_items items = { 0 };
	if (!id || ap_content(api, ID(id), &items)) return NULL;
	for (size_t i = 0; i < items.n; i++)
		if (items.items[i].node && items.items[i].has_versions && items.items[i].nversions) return items.items[i].versions[0].content;
	return NULL;
}

/** the first id a list of the node of an id holds; NULL if none */
static const char *slotOf(ap_api *api, const char *id, const char *name) {
	ap_items items = { 0 };
	if (!id || ap_children(api, ID(id), name, &items) || !items.n) return NULL;
	return items.items[0].id;
}

/** whether the node of an id is loaded */
static bool here(ap_api *api, const char *id) {
	ap_items items = { 0 };
	return id && !ap_look(api, ID(id), &items) && items.n && items.items[0].node;
}

/** the patches, as the kit's write takes them ({path, value}: a path of at most two keys), written to the node of an id */
static const ap_error *writeId(ap_api *api, const char *id, const Json *patches) {
	size_t np = (size_t)patches->array.count;
	op_patch *ps = calloc(np + 1, sizeof *ps);
	op_key *keys = calloc(2 * np + 1, sizeof *keys);
	op_value **values = calloc(np + 1, sizeof *values);
	for (size_t i = 0; i < np; i++) {
		const Json *p = patches->array.items[i], *path = jsonGet(p, "path");
		size_t length = jsonIsArray(path) ? (size_t)path->array.count : 0;
		if (length > 2) length = 2;
		for (size_t k = 0; k < length; k++) {
			int64_t whole;
			const Json *key = path->array.items[k];
			if (jsonIsWhole(key, &whole)) keys[2 * i + k] = (op_key){ .type = OP_NUM_KEY, .n = (long)whole };
			else keys[2 * i + k] = (op_key){ .type = OP_STR_KEY, .s = jsonText(key) ? jsonText(key) : "" };
		}
		values[i] = valOf(jsonGet(p, "value"));
		ps[i] = (op_patch){ .place = { .path = keys + 2 * i, .length = length }, .has_value = 1, .value = values[i] };
	}
	int64_t time;
	const ap_error *e = np ? ap_write(api, ID(id), ps, np, NULL, &time) : NULL;
	for (size_t i = 0; i < np; i++) op_free(values[i]);
	free(values), free(keys), free(ps);
	return e;
}

static const ap_error *wholeId(ap_api *api, const char *id, Json *value) {
	Json *patches = jsonArray();
	jsonPush(patches, drvMap("path", jsonArray(), "value", value, NULL));
	return writeId(api, id, patches);
}

/** a node holding value made (a document; ephemeral: the driver's own) and placed in parent's list name: its id, NULL on an error said */
static const char *put(ap_api *api, const char *parent, const char *name, Json *value, const char *id, bool ephemeral) {
	const char *made = NULL;
	op_value *v = valOf(value);
	const ap_error *e = ap_create(api, v, id, ephemeral, &made);
	op_free(v);
	int64_t time;
	if (!e && parent) e = ap_insert(api, parent, name, made, NULL, &time);
	if (e) {
		hostFailed(L.host, e, "link: making a node");
		return NULL;
	}
	return made;
}

/** the id at an address (a Json list from the root) */
static const char *idAt(ap_api *api, Json *address) {
	size_t n;
	const char *const *a = hostPathOf(L.host, address, &n);
	const ap_item *it = a ? hostLook(api, a, n) : NULL;
	return it ? it->id : NULL;
}

/** id taken out of parent's list name, wherever it is in it */
static void unplace(ap_api *api, const char *parent, const char *name, const char *id) {
	ap_items items = { 0 };
	if (!parent || ap_children(api, ID(parent), name, &items)) return;
	for (size_t i = 0; i < items.n; i++)
		if (!strcmp(items.items[i].id, id)) {
			int64_t time;
			hostFailed(L.host, ap_remove(api, parent, name, (long)i, &time), "link: unplacing");
			return;
		}
}

// --- seeing a window: the views

static View *viewNamed(const char *name) {
	for (int i = 0; name && i < L.views.count; i++)
		if (!strcmp(L.views.items[i]->name, name)) return L.views.items[i];
	return NULL;
}

/** whether a view other than v asks for, or sees, the node of id */
static bool seen(const View *v, const char *id) {
	for (int i = 0; i < L.views.count; i++)
		if (L.views.items[i] != v && (!strcmp(L.views.items[i]->id, id) || !strcmp(L.views.items[i]->asked, id))) return true;
	return false;
}

/**
 * each view's name and channel, the id it names, the window's (a name's node followed to it), and
 * what is here of that window, read tracked (by id: run again when one is loaded, and as it changes):
 * [[name, channel, asked, W, W's value, S, K], ...]; then the connection: [server, connected]
 */
static ErmErr viewsCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	Json *list = jsonArray();
	Json *names = drvNames(g->api, drvPath("/", "dev", "link", "views", NULL));
	for (int i = 0; jsonIsArray(names) && i < names->array.count; i++) {
		const char *name = jsonText(names->array.items[i]);
		Json *channel = jsonGet(drvRead(g->api, at("views", name)), "channel");
		if (!jsonText(channel) || !*jsonText(channel)) continue;
		char asked[ID_LENGTH + 1];
		idOf(jsonText(channel), asked);
		// a name's node: the window it points at
		const op_value *w = valueOf(g->api, asked), *to = w && w->type == OP_MAP ? op_get(w, "window") : NULL;
		const char *id = to && to->type == OP_STR && id_is(to->str) ? to->str : asked;
		if (id != asked) w = valueOf(g->api, id);
		const char *s = slotOf(g->api, id, "screen"), *k = slotOf(g->api, id, "keys");
		Json *row = jsonArray();
		jsonPush(row, jsonString(name));
		jsonPush(row, jsonString(jsonText(channel)));
		jsonPush(row, jsonString(asked));
		jsonPush(row, jsonString(id));
		jsonPush(row, w && id != asked ? jsonOfVal(w) : w && w->type == OP_MAP && !op_get(w, "name") ? jsonOfVal(w) : jsonNull());
		jsonPush(row, s ? jsonString(s) : jsonNull());
		jsonPush(row, k ? jsonString(k) : jsonNull());
		jsonPush(list, row);
	}
	Json *link = drvRead(g->api, drvPath("/", "dev", "sync", "link", NULL)), *net = jsonArray();
	jsonPush(net, jsonGet(link, "server") ? jsonShallow(jsonGet(link, "server")) : jsonNull());
	jsonPush(net, jsonBoolean(jsonGet(link, "connected") && jsonGet(link, "connected")->type == JSON_BOOLEAN && jsonGet(link, "connected")->boolean));
	*out = drvMap("views", list, "net", net, NULL);
	return ermOk();
}

static void unview(const ErmGiven *g, View *v) {
	unplace(g->api, idAt(g->api, drvPath("/", "dev", "link", "windows", NULL)), v->name, v->window);
	if (!seen(v, v->id)) peerBring(L.peer, v->id, false);
	if (!seen(v, v->asked)) peerBring(L.peer, v->asked, false);
	free(v->name), free(v->channel), free(v->asked), free(v->id), free(v->window), free(v->screen), free(v->keys), free(v->shown), free(v->typer);
	for (int i = 0; i < v->ntyped; i++) free(v->typed[i]);
	free(v);
}

static void typeInto(ap_api *api, View *v);

/** the windows asked for made, those no longer asked for let go; each one's state written, its screen placed */
static ErmErr viewsEffect(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = jsonNull();
	Json *list = jsonGet(g->value, "views"), *net = jsonGet(g->value, "net");
	const char *server = net ? jsonText(net->array.items[0]) : NULL;
	bool connected = net && net->array.items[1]->type == JSON_BOOLEAN && net->array.items[1]->boolean;
	// gone, or seeing another window now (a name shared again): out of the list first, then let go
	int k = 0;
	ERM_LIST(View *) gone = { 0 };
	for (int i = 0; i < L.views.count; i++) {
		View *v = L.views.items[i];
		bool kept = false;
		for (int r = 0; jsonIsArray(list) && r < list->array.count && !kept; r++) {
			Json *row = list->array.items[r];
			kept = !strcmp(jsonText(row->array.items[0]), v->name) && !strcmp(jsonText(row->array.items[3]), v->id);
		}
		if (kept) L.views.items[k++] = v;
		else ERM_PUSH(gone, v);
	}
	L.views.count = k;
	for (int i = 0; i < gone.count; i++) unview(g, gone.items[i]);
	free(gone.items);
	const char *windows = idAt(g->api, drvPath("/", "dev", "link", "windows", NULL));
	for (int r = 0; jsonIsArray(list) && r < list->array.count; r++) {
		Json *row = list->array.items[r], *w = row->array.items[4];
		const char *name = jsonText(row->array.items[0]), *asked = jsonText(row->array.items[2]), *id = jsonText(row->array.items[3]);
		const char *s = jsonText(row->array.items[5]), *keys = jsonText(row->array.items[6]);
		View *v = viewNamed(name);
		if (!v) {
			if (!windows) break;
			v = calloc(1, sizeof *v);
			v->name = copyString(name);
			v->channel = copyString(jsonText(row->array.items[1]));
			v->asked = copyString(asked);
			v->id = copyString(id);
			v->window = dup(put(g->api, windows, name, drvMap("channel", jsonString(id), "state", jsonString("dialing"), NULL), NULL, true));
			if (!v->window) {
				free(v->name), free(v->channel), free(v->asked), free(v->id), free(v);
				continue;
			}
			ERM_PUSH(L.views, v);
			peerBring(L.peer, asked, true);
			peerBring(L.peer, id, true);
		}
		// what it is now: here and running, here and ended, or on its way
		Json *value = drvMap("channel", jsonString(id), NULL);
		Json *program = jsonGet(w, "program"), *exited = jsonGet(w, "exited");
		const char *first = jsonIsArray(program) && program->array.count ? jsonText(program->array.items[0]) : NULL;
		if (!jsonIsObject(w)) {
			jsonAdd(value, "state", jsonString("dialing"));
			jsonAdd(value, "why", jsonString(!server ? "no server in /etc/sync: offline" : connected ? formatString("waiting for it to come from %s", server) : formatString("not connected to %s", server)));
		} else if (exited) {
			char *status = jsonPrint(exited);
			jsonAdd(value, "state", jsonString("gone"));
			jsonAdd(value, "why", jsonString(formatString("%s exited %s", first ? first : "its program", status)));
			free(status);
		} else jsonAdd(value, "state", jsonString("mounted"));
		if (jsonText(jsonGet(w, "by"))) jsonAdd(value, "owner", jsonShallow(jsonGet(w, "by")));
		char *printed = jsonPrint(value);
		if (!v->shown || strcmp(printed, v->shown)) {
			hostFailed(L.host, wholeId(g->api, v->window, value), "link: writing a window");
			free(v->shown);
			v->shown = printed;
		} else free(printed);
		// its screen, the document itself, placed in its node
		if (s && (!v->screen || strcmp(s, v->screen))) {
			if (v->screen) unplace(g->api, v->window, "screen", v->screen);
			int64_t time;
			if (!hostFailed(L.host, ap_insert(g->api, v->window, "screen", s, NULL, &time), "link: placing a screen")) {
				free(v->screen);
				v->screen = copyString(s);
			}
		}
		if (keys && (!v->keys || strcmp(keys, v->keys))) {
			free(v->keys);
			v->keys = copyString(keys);
		}
		// keys typed before its keys were here
		if (v->ntyped && !v->typer) typeInto(g->api, v);
	}
	return ermOk();
}

// --- typing into a window: this device's typer

/** the view's typer written: made in K, its keys node, the first time (once K is here) */
static void typeInto(ap_api *api, View *v) {
	if (!v->ntyped) return;
	Json *keys = jsonArray();
	for (int i = 0; i < v->ntyped; i++) jsonPush(keys, jsonString(v->typed[i]));
	Json *t = drvMap("from", jsonInteger(v->from), "keys", keys, NULL);
	if (v->typer) {
		hostFailed(L.host, wholeId(api, v->typer, t), "link: typing");
		return;
	}
	if (!v->keys || !here(api, v->keys)) return;
	v->typer = dup(put(api, v->keys, L.typer, t, NULL, false));
}

static void typed(View *v, const char *key) {
	if (v->ntyped == KEPT) {
		free(v->typed[0]);
		memmove(v->typed, v->typed + 1, sizeof *v->typed * (KEPT - 1));
		v->ntyped--;
		v->from++;
	}
	v->typed[v->ntyped++] = copyString(key);
}

/** on/keys (view's name, [key...]): to the window's keys, in order; a list in the list (a paste) its keys in turn */
static ErmErr onKeys(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = jsonNull();
	const char *name = g->args && g->args->array.count > 1 ? jsonText(g->args->array.items[0]) : NULL;
	Json *keys = name ? g->args->array.items[1] : NULL;
	View *v = viewNamed(name);
	if (!v || !jsonIsArray(keys)) return ermOk();
	for (int i = 0; i < keys->array.count; i++) {
		Json *key = keys->array.items[i];
		if (jsonText(key)) typed(v, jsonText(key));
		for (int k = 0; jsonIsArray(key) && k < key->array.count; k++)
			if (jsonText(key->array.items[k])) typed(v, jsonText(key->array.items[k]));
	}
	typeInto(g->api, v);
	return ermOk();
}

// --- sharing a window: a program on a pty

static Share *shareNamed(const char *name) {
	for (int i = 0; name && i < L.shares.count; i++)
		if (!strcmp(L.shares.items[i]->name, name)) return L.shares.items[i];
	return NULL;
}

static void unshare(const ErmGiven *g, Share *s) {
	unplace(g->api, idAt(g->api, drvPath("/", "dev", "link", "shares", NULL)), s->name, s->at);
	peerBring(L.peer, s->w, false);
	if (s->n) peerBring(L.peer, s->n, false);
	for (int r = 0; r < s->rows; r++) free(s->lines[r]), free(s->styles[r]);
	free(s->lines), free(s->styles), free(s->cursor), free(s->title);
	for (int i = 0; i < s->fed.count; i++) free((void *)s->fed.entries[i].key);
	free(s->fed.entries), free(s->fed.index);
	free(s->name), free(s->w), free(s->s), free(s->z), free(s->k), free(s->n), free(s->at);
	free(s);
	int k = 0;
	for (int i = 0; i < L.shares.count; i++)
		if (L.shares.items[i] != s) L.shares.items[k++] = L.shares.items[i];
	L.shares.count = k;
}

/** W written: its program, its device, and how it ended (NULL: running) */
static void windowSays(ap_api *api, Share *s, Json *exited) {
	Json *w = drvMap("window", jsonInteger(1), "program", s->program, "by", jsonString(peerKey(L.peer)), NULL);
	if (exited) jsonAdd(w, "exited", exited);
	hostFailed(L.host, wholeId(api, s->w, w), "link: writing a window");
}

/** the name's node pointed at W, over all the versions it has (versions: how many; a name shared before, elsewhere, has two once that one's history comes) */
static void pointed(ap_api *api, Share *s, long versions) {
	Json *patches = jsonArray();
	jsonPush(patches, drvMap("path", jsonArray(), "value", drvMap("name", jsonString(s->name), "window", jsonString(s->w), "by", jsonString(peerKey(L.peer)), NULL), NULL));
	if (versions <= 1) {
		hostFailed(L.host, writeId(api, s->n, patches), "link: pointing a name");
		return;
	}
	op_value *v = valOf(jsonGet(patches->array.items[0], "value"));
	op_patch p = valWhole(v);
	(void)versions;
	int64_t time;
	hostFailed(L.host, ap_write(api, ID(s->n), &p, 1, NULL, &time), "link: pointing a name");
	op_free(v);
}

static int64_t whole(const Json *v, int64_t otherwise) {
	int64_t n;
	return jsonIsWhole(v, &n) ? n : otherwise;
}

/** on/share ({argv, name?, rows?, cols?}): the program run on a pty, and its window shared */
static ErmErr onShare(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = jsonNull();
	Json *r = g->args && g->args->array.count ? g->args->array.items[0] : NULL, *argv = jsonGet(r, "argv"), *program = jsonArray();
	for (int i = 0; jsonIsArray(argv) && i < argv->array.count; i++) {
		if (!jsonText(argv->array.items[i])) return ermField("wrong-field", "argv");
		jsonPush(program, argv->array.items[i]);
	}
	if (!program->array.count) {
		const char *shell = getenv("SHELL") && *getenv("SHELL") ? getenv("SHELL") : "/bin/zsh";
		jsonPush(program, jsonString(shell)), jsonPush(program, jsonString("-l"));
	}
	const char *named = jsonText(jsonGet(r, "name"));
	char name[64], id[ID_LENGTH + 1];
	// a name, not an id: an id named would write someone's window
	if (named && *named && idOf(named, id)) return ermDetail(ermField("wrong-field", "name"), "text", jsonString("a share's name is a name, not a window's id"));
	if (named && *named) snprintf(name, sizeof name, "%s", named);
	else snprintf(name, sizeof name, "s%d", ++L.count);
	if (shareNamed(name)) return ermDetail(ermField("already-there", "name"), "name", jsonString(name));
	int rows = (int)whole(jsonGet(r, "rows"), 24), cols = (int)whole(jsonGet(r, "cols"), 80);
	if (rows < 1 || rows > 1000) rows = 24;
	if (cols < 1 || cols > 1000) cols = 80;
	const char *shares = idAt(g->api, drvPath("/", "dev", "link", "shares", NULL));
	if (!shares) return ermDetail(ermInvalid("nothing-there"), "text", jsonString("no /dev/link/shares"));
	Share *s = calloc(1, sizeof *s);
	s->name = copyString(name);
	s->program = program;
	s->first = true;
	// W, S, Z and K: fresh, each share
	s->w = dup(put(g->api, NULL, NULL, jsonNull(), NULL, false));
	if (s->w) {
		windowSays(g->api, s, NULL);
		s->s = dup(put(g->api, s->w, "screen", drvMap("rows", jsonInteger(rows), "cols", jsonInteger(cols), "lines", jsonArray(), NULL), NULL, false));
		s->z = dup(put(g->api, s->w, "size", drvMap("rows", jsonInteger(rows), "cols", jsonInteger(cols), NULL), NULL, false));
		s->k = dup(put(g->api, s->w, "keys", jsonNull(), NULL, false));
	}
	// the name's node: made (or, shared under it before on this card, here already), pointed at W
	if (named && *named && s->k) s->n = dup(hostLook(g->api, ID(id)) ? id : put(g->api, NULL, NULL, jsonNull(), id, false));
	if (s->n) pointed(g->api, s, 1);
	s->at = s->w && s->s && s->z && s->k && (s->n || !named || !*named) ? dup(put(g->api, shares, name, drvMap("window", jsonString(s->w), "program", program, "state", jsonString("running"), NULL), NULL, true)) : NULL;
	if (!s->at) {
		free(s->name), free(s->w), free(s->s), free(s->z), free(s->k), free(s->n), free(s);
		return ermDetail(ermInvalid("not-made"), "text", jsonString("the window could not be made"));
	}
	int64_t time;
	hostFailed(L.host, ap_insert(g->api, s->at, "window", s->w, NULL, &time), "link: placing a window");
	if (s->n) hostFailed(L.host, ap_insert(g->api, s->at, "name", s->n, NULL, &time), "link: placing a name");
	ERM_PUSH(L.shares, s);
	peerBring(L.peer, s->w, true);
	if (s->n) peerBring(L.peer, s->n, true);
	// the session, made inside the share's node once this returns (a call from a part waits till then)
	Json *ask = drvMap("argv", program, "rows", jsonInteger(rows), "cols", jsonInteger(cols), "at", at("shares", name), NULL), *args = jsonArray();
	jsonPush(args, ask);
	drvOp(g->api, "call", drvMap("address", drvPath("/", "dev", "pty", "driver", "on", "new", NULL), "args", args, NULL));
	hostSay(L.host, "link: sharing %s as %s (%s)", jsonText(program->array.items[0]), s->w, name);
	return ermOk();
}

/** on/unshare (name): the share ended, its program hung up */
static ErmErr onUnshare(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = jsonNull();
	Share *s = shareNamed(g->args && g->args->array.count ? jsonText(g->args->array.items[0]) : NULL);
	if (!s) return ermField("nothing-there", "name");
	// hung up: as a shell gives it, 128 + SIGHUP
	windowSays(g->api, s, jsonInteger(129));
	hostSay(L.host, "link: %s unshared", s->name);
	unshare(g, s);
	return ermOk();
}

/**
 * each share's session (its number, screen and status), its window's size and each typer's keys, read
 * tracked, and how many versions its name's node has: [[name, session, screen, status, size, {typer: {from, keys}}, versions], ...]
 */
static ErmErr sharesCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = jsonArray();
	Json *names = drvNames(g->api, drvPath("/", "dev", "link", "shares", NULL));
	for (int i = 0; jsonIsArray(names) && i < names->array.count; i++) {
		Share *s = shareNamed(jsonText(names->array.items[i]));
		if (!s) continue;
		Json *row = jsonArray(), *typers = jsonObject();
		jsonPush(row, jsonString(s->name));
		// the session drv_pty.c made inside it: the name that is a number
		Json *inside = drvNames(g->api, at("shares", s->name)), *session = NULL;
		for (int k = 0; jsonIsArray(inside) && k < inside->array.count && !session; k++) {
			const char *n = jsonText(inside->array.items[k]);
			if (n && *n && strspn(n, "0123456789") == strlen(n)) session = inside->array.items[k];
		}
		Json *where = session ? drvUnder(at("shares", s->name), jsonText(session), NULL) : NULL;
		jsonPush(row, session ? jsonShallow(session) : jsonNull());
		Json *screen = where ? drvRead(g->api, drvUnder(where, "screen", NULL)) : NULL, *status = where ? drvRead(g->api, drvUnder(where, "status", NULL)) : NULL;
		jsonPush(row, screen ? screen : jsonNull());
		jsonPush(row, status ? status : jsonNull());
		const op_value *size = valueOf(g->api, s->z);
		jsonPush(row, size ? jsonOfVal(size) : jsonNull());
		ap_namelist list = { 0 };
		if (!ap_names(g->api, ID(s->k), &list))
			for (size_t k = 0; k < list.n; k++) {
				const op_value *t = valueOf(g->api, slotOf(g->api, s->k, list.names[k]));
				if (t) jsonAdd(typers, list.names[k], jsonOfVal(t));
			}
		jsonPush(row, typers);
		// the name's node: how many versions it has (more than one: written again, over them)
		ap_items items = { 0 };
		long versions = s->n && !ap_content(g->api, ID(s->n), &items) && items.n ? (long)items.items[0].nversions : 0;
		jsonPush(row, jsonInteger(versions));
		jsonPush(*out, row);
	}
	return ermOk();
}

/** a key as playground/term names it ("enter", "C-c", "M-x", a character, any text), as a key record drv_pty.c types */
static Json *recordOf(const char *key) {
	static const char *const named[][2] = {
		{ "enter", "Enter" }, { "tab", "Tab" }, { "backspace", "Backspace" }, { "escape", "Escape" }, { "up", "ArrowUp" },
		{ "down", "ArrowDown" }, { "left", "ArrowLeft" }, { "right", "ArrowRight" }, { "home", "Home" }, { "end", "End" },
		{ "pageup", "PageUp" }, { "pagedown", "PageDown" }, { "delete", "Delete" }, { "insert", "Insert" },
	};
	for (size_t i = 0; i < sizeof named / sizeof *named; i++)
		if (!strcmp(key, named[i][0])) return drvMap("key", jsonString(named[i][1]), NULL);
	// C-x, M-x: one character with control, or alt
	size_t n = strlen(key);
	if (n > 2 && (key[0] == 'C' || key[0] == 'M') && key[1] == '-' && (n == 3 || ((unsigned char)key[2] >= 0xc0 && n <= 6))) {
		Json *mods = jsonArray();
		jsonPush(mods, jsonString(key[0] == 'C' ? "ctrl" : "alt"));
		return drvMap("key", jsonString(key + 2), "mods", mods, NULL);
	}
	return drvMap("text", jsonString(key), NULL);
}

/** a row of a screen's lines or styles, as a patch's path */
static Json *row(const char *key, int r) {
	Json *path = drvPath(key, NULL);
	jsonPush(path, jsonInteger(r));
	return path;
}

/** the session's screen into S: whole at first and when its size changes, else the rows, cursor and title that changed */
static void mirror(ap_api *api, Share *s, Json *screen) {
	Json *lines = jsonGet(screen, "lines"), *styles = jsonGet(screen, "styles");
	int rows = (int)whole(jsonGet(screen, "rows"), 0), cols = (int)whole(jsonGet(screen, "cols"), 0);
	if (!jsonIsArray(lines) || rows <= 0 || cols <= 0) return;
	char *cursor = jsonPrint(jsonGet(screen, "cursor") ? jsonGet(screen, "cursor") : jsonNull());
	const char *title = jsonText(jsonGet(screen, "title")) ? jsonText(jsonGet(screen, "title")) : "";
	Json *patches = jsonArray();
	bool all = rows != s->rows || cols != s->cols;
	if (all) {
		for (int r = 0; r < s->rows; r++) free(s->lines[r]), free(s->styles[r]);
		free(s->lines), free(s->styles);
		s->rows = rows, s->cols = cols;
		s->lines = calloc((size_t)rows, sizeof *s->lines);
		s->styles = calloc((size_t)rows, sizeof *s->styles);
	}
	for (int r = 0; r < rows; r++) {
		Json *line = r < lines->array.count ? lines->array.items[r] : NULL, *runs = jsonIsArray(styles) && r < styles->array.count ? styles->array.items[r] : NULL;
		char *text = jsonPrint(line ? line : jsonString("")), *style = jsonPrint(runs ? runs : jsonArray());
		if (!all && s->lines[r] && !strcmp(text, s->lines[r])) free(text);
		else {
			free(s->lines[r]);
			s->lines[r] = text;
			if (!all) jsonPush(patches, drvMap("path", row("lines", r), "value", line ? line : jsonString(""), NULL));
		}
		if (!all && s->styles[r] && !strcmp(style, s->styles[r])) free(style);
		else {
			free(s->styles[r]);
			s->styles[r] = style;
			if (!all) jsonPush(patches, drvMap("path", row("styles", r), "value", runs ? runs : jsonArray(), NULL));
		}
	}
	if (all || !s->cursor || strcmp(cursor, s->cursor)) {
		if (!all) jsonPush(patches, drvMap("path", drvPath("cursor", NULL), "value", jsonGet(screen, "cursor") ? jsonGet(screen, "cursor") : jsonNull(), NULL));
		free(s->cursor);
		s->cursor = cursor;
	} else free(cursor);
	if (all || !s->title || strcmp(title, s->title)) {
		if (!all) jsonPush(patches, drvMap("path", drvPath("title", NULL), "value", jsonString(title), NULL));
		free(s->title);
		s->title = copyString(title);
	}
	if (all) {
		Json *grid = drvMap("rows", jsonInteger(rows), "cols", jsonInteger(cols), "lines", lines, "styles", jsonIsArray(styles) ? styles : jsonArray(),
		                    "cursor", jsonGet(screen, "cursor") ? jsonGet(screen, "cursor") : jsonNull(), "title", jsonString(title), NULL);
		hostFailed(L.host, wholeId(api, s->s, grid), "link: writing a screen");
	} else if (patches->array.count) hostFailed(L.host, writeId(api, s->s, patches), "link: writing a screen");
}

/** each typer's keys not yet typed, typed into the session: appended to its keys (the last 64), stats.keys counting them */
static void feed(ap_api *api, Share *s, Json *where, Json *typers) {
	Json *records = jsonArray();
	for (int i = 0; jsonIsObject(typers) && i < typers->object.count; i++) {
		const char *name = typers->object.members[i].key;
		Json *t = typers->object.members[i].value, *keys = jsonGet(t, "keys");
		int64_t from = whole(jsonGet(t, "from"), 0), count = jsonIsArray(keys) ? keys->array.count : 0;
		// a typer's keys from before the share began are not its program's; one that comes later, all of it
		if (!ermMapHas(&s->fed, name)) ermMapPut(&s->fed, name, (void *)(intptr_t)((s->first ? from + count : from) + 1));
		int64_t next = (intptr_t)ermMapGet(&s->fed, name) - 1;
		for (int64_t k = next > from ? next - from : 0; k < count; k++)
			if (jsonText(keys->array.items[k])) jsonPush(records, recordOf(jsonText(keys->array.items[k])));
		if (from + count > next) ermMapPut(&s->fed, name, (void *)(intptr_t)(from + count + 1));
	}
	if (!records->array.count || !where) return;
	Json *kept = drvRead(api, drvUnder(where, "keys", NULL)), *all = jsonArray(), *keys = jsonArray(), *stats = drvRead(api, drvUnder(where, "stats", NULL));
	for (int i = 0; jsonIsArray(kept) && i < kept->array.count; i++) jsonPush(all, kept->array.items[i]);
	for (int i = 0; i < records->array.count; i++) jsonPush(all, records->array.items[i]);
	for (int i = all->array.count > KEPT ? all->array.count - KEPT : 0; i < all->array.count; i++) jsonPush(keys, all->array.items[i]);
	drvSnap(api, drvUnder(where, "keys", NULL), keys);
	drvSet(api, drvUnder(where, "stats", NULL), "keys", jsonInteger(whole(jsonGet(stats, "keys"), 0) + records->array.count));
}

/** each share's screen kept in S, its size given, its typers' keys typed; one whose program exited, ended */
static ErmErr sharesEffect(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = jsonNull();
	for (int i = 0; jsonIsArray(g->value) && i < g->value->array.count; i++) {
		Json *row = g->value->array.items[i];
		Share *s = shareNamed(jsonText(row->array.items[0]));
		if (!s) continue;
		const char *session = jsonText(row->array.items[1]);
		Json *where = session ? drvUnder(at("shares", s->name), session, NULL) : NULL;
		Json *screen = row->array.items[2], *status = row->array.items[3], *size = row->array.items[4];
		if (jsonIsObject(screen)) mirror(g->api, s, screen);
		int r = (int)whole(jsonGet(size, "rows"), 0), c = (int)whole(jsonGet(size, "cols"), 0);
		if (where && r > 0 && c > 0 && r <= 1000 && c <= 1000 && (r != s->size[0] || c != s->size[1])) {
			drvSnap(g->api, drvUnder(where, "size", NULL), drvMap("cols", jsonInteger(c), "rows", jsonInteger(r), NULL));
			s->size[0] = r, s->size[1] = c;
		}
		feed(g->api, s, where, row->array.items[5]);
		// once: two machines sharing one name at once would write over each other for ever
		if (whole(row->array.items[6], 0) > 1 && !s->healed) pointed(g->api, s, (long)whole(row->array.items[6], 0)), s->healed = true;
		s->first = false;
		Json *running = jsonGet(status, "running");
		if (running && running->type == JSON_BOOLEAN && !running->boolean) {
			// ended: W says how, as a shell gives it (128 + the signal), and the share ends
			int64_t code = jsonGet(status, "signal") && whole(jsonGet(status, "signal"), 0) ? 128 + whole(jsonGet(status, "signal"), 0) : whole(jsonGet(status, "exit"), 0);
			windowSays(g->api, s, jsonInteger(code));
			hostSay(L.host, "link: %s: %s exited %lld", s->name, jsonText(s->program->array.items[0]), (long long)code);
			unshare(g, s);
		}
	}
	return ermOk();
}

ErmErr driverLink(void *data, const ErmGiven *g, Json **out) {
	*out = jsonNull();
	L.host = data;
	L.peer = hostPeer(L.host);
	snprintf(L.typer, sizeof L.typer, "t%.8s", peerKey(L.peer));
	Json *here = drvHere(g), *dev = drvPath("/", "dev", "link", NULL);
	drvMake(g->api, dev, "views", "link/views", jsonNull());
	drvMake(g->api, dev, "windows", "link/windows", jsonNull());
	drvMake(g->api, dev, "shares", "link/shares", jsonNull());
	drvMake(g->api, dev, "keys", "link/keys", drvUnder(here, "on", "keys", NULL));
	drvHandler(g, here, "keys", (ErmFn){ onKeys, NULL });
	drvHandler(g, here, "share", (ErmFn){ onShare, NULL });
	drvHandler(g, here, "unshare", (ErmFn){ onUnshare, NULL });
	drvChild(g, here, "views", (ErmFn){ viewsCompute, NULL }, (ErmFn){ viewsEffect, NULL });
	drvChild(g, here, "shares", (ErmFn){ sharesCompute, NULL }, (ErmFn){ sharesEffect, NULL });
	return ermOk();
}
