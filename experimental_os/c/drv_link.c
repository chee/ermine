// drv_link.c: /drivers/link, the link (layers/link) as a device, as
// image/drivers/link.js was in the TypeScript OS. A program asks for what a
// channel shares by placing an ephemeral node of its own in /dev/link/views,
// {"channel"}: 64 hex digits, or a name (LINK.tex, The channel). The window
// it mounts (erminex's: one program's, as experimental_hosts/term/c/erminex.c
// shares it) is kept in /dev/link/windows/<that name>: {channel, state, why?,
// owner?}, state "dialing", "mounted" or "gone", and below it "screen", the
// remote screen kept in step. Keys go the other way, in order, by calling
// the handler /dev/link/keys names with the view's name and a list of keys.
// When a view's node goes, with the program that placed it, the window is
// unmounted.
//
// The link is layers/link/c's. Each mount is a link of its own, whose one
// host, the mounter, is named by this device's key, so the owner's frames
// to it need no renaming; its transport is Subduction's ephemeral messages
// on the channel's topic over the device's connection (peer.c), as
// layers/link/typescript/subduction.ts's is: what its wire sends is
// published there (ermLinkTransport), and what is heard on the topic is
// handed to it (ermLinkHear). Host code drives it each turn (linkTurn): its
// clock, and the mount's requests (subscribe to the screen, read it, write
// the keys), as typescript/link.ts did; what it learns goes to the driver
// as a call of its handler, on/net, which writes the windows.

#include "drivers.h"
#include "drv.h"
#include "peer.h"

#include "../../layers/link/c/link.h"
#include "../../layers/subduction/c/blob.h"
#include "../../layers/subduction/c/sha2.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct Mount {
	char *name;    // the view's
	char *channel; // 64 hex digits
	uint8_t topic[32];
	ErmLink *link;
	bool dialing;  // the mounter is made and dials; it waits for the connection first
	bool open, gone;
	int64_t since; // hostNow µs it began dialing
	int64_t clock; // hostNow µs the link's clock was last moved to
	char *owner;
	double seq, subscribing, reading, sub;
	bool ready;    // the screen's read is answered
	double read;   // the time of the screen it read
	Json *early;   // events before that
	Json *keys;    // keys typed before it was open
} Mount;

static ERM_LIST(Mount *) mounts;
static Host *host;
static Json *net;   // what the driver is told at the end of the turn: {id, event, ...}
static Json *netAt; // its handler

static Json *keyed(const char *key, Json *value) {
	Json *m = jsonObject();
	jsonAdd(m, key, value);
	return m;
}

static Mount *named(const char *name) {
	for (int i = 0; name && i < mounts.count; i++)
		if (!strcmp(mounts.items[i]->name, name)) return mounts.items[i];
	return NULL;
}

/** a channel as given: 64 hex digits stand for themselves; anything else is a name, sha256("ermine channel:" name) */
static char *channelOf(const char *given) {
	while (*given == ' ' || *given == '\t' || *given == '\n') given++;
	size_t n = strlen(given);
	while (n && (given[n - 1] == ' ' || given[n - 1] == '\t' || given[n - 1] == '\n')) n--;
	char *text = copyStringOfLength(given, n);
	bool hex = n == 64;
	for (size_t i = 0; hex && i < n; i++) hex = strchr("0123456789abcdefABCDEF", text[i]) != NULL;
	if (hex) {
		for (size_t i = 0; i < n; i++)
			if (text[i] >= 'A' && text[i] <= 'F') text[i] = (char)(text[i] - 'A' + 'a');
		return text;
	}
	char *named = formatString("ermine channel:%s", text);
	unsigned char hash[32];
	ermSha256((const unsigned char *)named, strlen(named), hash);
	free(named);
	free(text);
	return ermHex(hash, 32);
}

/** told to the driver at the end of the turn */
static void tell(Mount *m, const char *event, const char *key, Json *value) {
	Json *r = keyed("id", jsonString(m->name));
	jsonAdd(r, "event", jsonString(event));
	if (key) jsonAdd(r, key, value);
	jsonPush(net, r);
}

/** a link command for the mount; its ok, or NULL with what went wrong said */
static Json *command(Mount *m, Json *request) {
	Json *ok = NULL;
	ErmErr err = ermLinkCommand(m->link, request, &ok);
	if (err.kind) {
		char *why = jsonPrint(err.why), *what = jsonPrint(request);
		hostSay(host, "link %s: %s: %s", m->name, what, why);
		free(why);
		free(what);
		return NULL;
	}
	return ok ? ok : jsonNull();
}

static Json *via(const char *cmd) {
	Json *r = keyed("cmd", jsonString(cmd));
	jsonAdd(r, "via", jsonString(peerKey(host)));
	return r;
}

/** who this side's requests say they act for, as the other side shows it */
static Json *agent(void) {
	const char *user = jsonText(jsonGet(hostTree(host), "user"));
	return keyed("actor", jsonString(user ? user : "person"));
}

/** a request sent over the link: its seq */
static double request(Mount *m, const char *cmd, Json *address, const char *key, Json *value) {
	double seq = ++m->seq;
	Json *line = keyed("seq", jsonNumber(seq));
	jsonAdd(line, "cmd", jsonString(cmd));
	jsonAdd(line, "agent", agent());
	jsonAdd(line, "address", address);
	if (key) jsonAdd(line, key, value);
	// a change from outside any process gives the site it was made at (GRAPH.tex, Changes)
	if (!strcmp(cmd, "write")) jsonAdd(line, "site", drvMap("file", jsonString("experimental_os/c/drv_link.c"), "line", jsonInteger(__LINE__), NULL));
	Json *r = via("send");
	jsonAdd(r, "request", line);
	command(m, r);
	return seq;
}

static Json *screen(void) {
	return drvPath("screen", NULL);
}

static void writeKeys(Mount *m, Json *keys) {
	for (int i = 0; jsonIsArray(keys) && i < keys->array.count; i++) {
		Json *patch = keyed("type", jsonString("snapshot")), *patches = jsonArray();
		jsonAdd(patch, "value", keys->array.items[i]);
		jsonPush(patches, patch);
		request(m, "write", drvPath("keys", NULL), "patches", patches);
	}
}

static void ended(Mount *m, const char *why) {
	if (m->gone) return;
	m->gone = true;
	m->open = false;
	tell(m, "gone", "why", jsonString(why));
	peerTopic(host, m->topic, false);
}

/** an event the owner pushed for the screen's subscription: a change to it as patches; anything else reads it again */
static void pushed(Mount *m, Json *event) {
	Json *change = jsonGet(event, "change");
	double time = jsonIsNumber(jsonGet(change, "time")) ? jsonGet(change, "time")->number : 1e300;
	if (time <= m->read) return;
	Json *patches = jsonGet(change, "patches");
	if (!jsonGet(event, "reaches") && jsonIsArray(patches)) tell(m, "screen", "patches", patches);
	else m->reading = request(m, "read", screen(), NULL, NULL);
}

/** what came for the mount's requests, and the events pushed */
static void answered(Mount *m) {
	Json *a = command(m, via("test-answers"));
	Json *answers = jsonGet(a, "answers"), *events = jsonGet(a, "events");
	for (int i = 0; jsonIsArray(answers) && i < answers->array.count; i++) {
		Json *line = answers->array.items[i], *ok = jsonGet(line, "ok");
		double seq = jsonIsNumber(jsonGet(line, "seq")) ? jsonGet(line, "seq")->number : -1;
		if (seq == m->subscribing && ok) {
			// subscribed: mounted, then the screen read once and kept in step
			m->sub = jsonIsNumber(jsonGet(ok, "sub")) ? jsonGet(ok, "sub")->number : -1;
			tell(m, "mounted", "owner", jsonString(m->owner ? m->owner : ""));
			m->reading = request(m, "read", screen(), NULL, NULL);
			// what was typed while it was dialing
			writeKeys(m, m->keys);
			m->keys = jsonArray();
		} else if (seq == m->reading && ok) {
			Json *items = jsonGet(ok, "items"), *first = jsonIsArray(items) && items->array.count ? items->array.items[0] : NULL;
			Json *time = jsonGet(jsonGet(first, "change"), "time");
			m->read = jsonIsNumber(time) ? time->number : 0;
			tell(m, "screen", "value", first && jsonGet(first, "value") ? jsonGet(first, "value") : jsonNull());
			if (!m->ready) {
				m->ready = true;
				for (int k = 0; k < m->early->array.count; k++) pushed(m, m->early->array.items[k]);
				m->early = jsonArray();
			}
		} else if (!ok) {
			char *text = jsonPrint(line);
			hostSay(host, "link %s: %s", m->name, text);
			free(text);
		}
	}
	for (int i = 0; jsonIsArray(events) && i < events->array.count; i++) {
		Json *e = events->array.items[i];
		if (!jsonIsNumber(jsonGet(e, "sub")) || jsonGet(e, "sub")->number != m->sub) continue;
		if (m->ready) pushed(m, jsonGet(e, "event"));
		else jsonPush(m->early, jsonGet(e, "event"));
	}
}

// the transport: Subduction's ephemeral messages on the channel's topic -------------------------------------

static void out(void *data, const char *from, const char *payload, size_t length) {
	(void)from;
	Mount *m = data;
	peerPublish(host, m->topic, (const uint8_t *)payload, length);
}

static void heard(void *data, const uint8_t topic[32], const char *from, const uint8_t *bytes, size_t length) {
	(void)data;
	for (int i = 0; i < mounts.count; i++) {
		Mount *m = mounts.items[i];
		if (m->dialing && !m->gone && !memcmp(m->topic, topic, 32)) ermLinkHear(m->link, peerKey(host), (const char *)bytes, length, from);
	}
}

// host code: mounts made and ended by the driver, and driven each turn ---------------------------------------

static void mountView(const char *name, const char *given) {
	if (!net) net = jsonArray();
	Mount *m = calloc(1, sizeof *m);
	m->name = copyString(name);
	m->channel = channelOf(given);
	ermUnhex(m->channel, m->topic, 32);
	ErmLinkLimits limits = ermLinkDefaults();
	limits.max = 60000; // Subduction's limit is 65536 bytes of payload; this leaves room, as subduction.ts does
	m->link = ermLink((ErmLinkOwner){ 0 }, limits);
	ermLinkTransport(m->link, out, m);
	m->early = jsonArray();
	m->keys = jsonArray();
	m->read = -1;
	ERM_PUSH(mounts, m);
	peerTopic(host, m->topic, true);
	tell(m, "dialing", "channel", jsonString(m->channel));
}

static void unmountView(const char *name) {
	Mount *m = named(name);
	if (!m) return;
	if (m->open) command(m, via("unmount"));
	if (!m->gone) peerTopic(host, m->topic, false);
	m->gone = true;
	int k = 0;
	for (int i = 0; i < mounts.count; i++)
		if (mounts.items[i] != m) mounts.items[k++] = mounts.items[i];
	mounts.count = k;
}

void linkTurn(Host *h) {
	int64_t now = hostNow(h);
	for (int i = 0; i < mounts.count; i++) {
		Mount *m = mounts.items[i];
		if (m->gone) continue;
		if (!m->dialing) {
			// it dials once there is a connection to dial over
			if (!peerConnected(h)) continue;
			Json *r = keyed("cmd", jsonString("mount"));
			jsonAdd(r, "as", jsonString(peerKey(h)));
			if (!command(m, r)) {
				ended(m, "the link could not begin");
				continue;
			}
			m->dialing = true;
			m->since = m->clock = now;
		}
		// its clock: hello again, beats, quiet, gaps, giving up
		int64_t ms = (now - m->clock) / 1000;
		if (ms > 0) {
			Json *r = keyed("cmd", jsonString("test-tick"));
			jsonAdd(r, "ms", jsonInteger(ms));
			command(m, r);
			m->clock += ms * 1000;
		}
		Json *links = command(m, keyed("cmd", jsonString("test-links")));
		Json *mine = jsonGet(jsonGet(links, "mounts"), peerKey(h));
		const char *owner = jsonText(jsonGet(mine, "owner"));
		Json *open = jsonGet(mine, "open");
		bool isOpen = open && open->type == JSON_BOOLEAN && open->boolean;
		if (isOpen && !m->open) {
			m->open = true;
			m->owner = copyString(owner ? owner : "");
			m->subscribing = request(m, "subscribe", screen(), NULL, NULL);
		}
		answered(m);
		if (m->open && !isOpen) ended(m, "the owner went, or was not heard from");
		else if (!m->open && !owner && now - m->since > 11000000) ended(m, "no owner answered on the channel in 10 s");
	}
	// nothing to tell, or no driver to tell it to (a card from before /drivers/link)
	if (!net || !net->array.count || !netAt) return;
	Json *told = net, *args = jsonArray(), *ok = NULL;
	net = jsonArray();
	jsonPush(args, told);
	ErmErr err = hostDo(h, NULL, "call", drvMap("address", netAt, "args", args, NULL), &ok);
	if (err.kind) {
		char *why = jsonPrint(err.why);
		hostSay(h, "link: %s", why);
		free(why);
	}
}

void linkStop(Host *h) {
	(void)h;
	for (int i = 0; i < mounts.count; i++) {
		Mount *m = mounts.items[i];
		if (m->open) command(m, via("unmount"));
	}
}

// the driver ---------------------------------------------------------------------------------------------

static Json *at(const char *first, const char *second) {
	return drvPath("/", "dev", "link", first, second, NULL);
}

/** a view's channel, or NULL */
static ErmErr viewsCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = jsonArray();
	Json *names = drvNames(g->api, drvPath("/", "dev", "link", "views", NULL));
	for (int i = 0; jsonIsArray(names) && i < names->array.count; i++) {
		const char *name = jsonText(names->array.items[i]);
		Json *channel = jsonGet(drvRead(g->api, at("views", name)), "channel");
		Json *pair = jsonArray();
		jsonPush(pair, jsonString(name));
		jsonPush(pair, channel && jsonIsString(channel) ? jsonShallow(channel) : jsonNull());
		jsonPush(*out, pair);
	}
	return ermOk();
}

static ErmMap asked; // a view's name -> the channel it asked for

static ErmErr viewsEffect(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = jsonNull();
	ErmMap seen = { 0 };
	for (int i = 0; jsonIsArray(g->value) && i < g->value->array.count; i++) {
		Json *pair = g->value->array.items[i];
		const char *name = jsonText(pair->array.items[0]), *channel = jsonText(pair->array.items[1]);
		if (!name || !channel || !*channel) continue;
		ermMapPut(&seen, name, (void *)1);
		const char *was = ermMapGet(&asked, name);
		if (was && !strcmp(was, channel)) continue;
		if (was) unmountView(name);
		ermMapPut(&asked, name, copyString(channel));
		Json *value = drvMap("channel", jsonString(channel), "state", jsonString("dialing"), NULL);
		if (drvHas(g->api, at("windows", name))) drvSnap(g->api, at("windows", name), value);
		else drvOp(g->api, "place", drvMap("address", drvPath("/", "dev", "link", "windows", NULL), "name", jsonString(name), "id", jsonString(formatString("link/window/%s", name)),
		                                   "value", value, "ephemeral", jsonBoolean(true), NULL));
		mountView(name, channel);
	}
	for (int i = 0; i < asked.count; i++) {
		const char *name = asked.entries[i].key;
		if (!asked.entries[i].value || ermMapHas(&seen, name)) continue;
		ermMapPut(&asked, name, NULL);
		unmountView(name);
		if (drvHas(g->api, at("windows", name)))
			drvOp(g->api, "unplace", drvMap("address", drvPath("/", "dev", "link", "windows", NULL), "name", jsonString(name), "id", jsonString(formatString("link/window/%s", name)), NULL));
	}
	return ermOk();
}

/** on/net: what the link learned this turn, written into the windows */
static ErmErr onNet(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = jsonNull();
	Json *told = g->args && g->args->array.count ? g->args->array.items[0] : NULL;
	for (int i = 0; jsonIsArray(told) && i < told->array.count; i++) {
		Json *r = told->array.items[i];
		const char *id = jsonText(jsonGet(r, "id")), *event = jsonText(jsonGet(r, "event"));
		if (!id || !event || !ermMapGet(&asked, id) || !drvHas(g->api, at("windows", id))) continue;
		Json *window = at("windows", id);
		if (!strcmp(event, "dialing")) drvSet(g->api, window, "channel", jsonShallow(jsonGet(r, "channel")));
		else if (!strcmp(event, "mounted")) {
			drvSet(g->api, window, "state", jsonString("mounted"));
			drvSet(g->api, window, "owner", jsonShallow(jsonGet(r, "owner")));
		} else if (!strcmp(event, "gone")) {
			drvSet(g->api, window, "state", jsonString("gone"));
			drvSet(g->api, window, "why", jsonShallow(jsonGet(r, "why")));
		} else if (!strcmp(event, "screen")) {
			Json *screenAt = drvUnder(window, "screen", NULL), *value = jsonGet(r, "value");
			if (value) {
				if (drvHas(g->api, screenAt)) drvSnap(g->api, screenAt, jsonShallow(value));
				else drvOp(g->api, "place", drvMap("address", window, "name", jsonString("screen"), "id", jsonString(formatString("link/window/%s/screen", id)), "value", jsonShallow(value),
				                                   "ephemeral", jsonBoolean(true), NULL));
			} else if (drvHas(g->api, screenAt)) {
				// patches that do not fit what is here wait for the next whole screen
				Json *ok = NULL;
				g->api->op(g->api->self, "write", drvMap("address", screenAt, "patches", jsonShallow(jsonGet(r, "patches")), NULL), &ok);
			}
		}
	}
	return ermOk();
}

/** on/keys (view's name, [key]): to the remote window's keys, in order */
static ErmErr onKeys(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = jsonNull();
	const char *name = g->args && g->args->array.count > 1 ? jsonText(g->args->array.items[0]) : NULL;
	Json *keys = name ? g->args->array.items[1] : NULL;
	Mount *m = named(name);
	if (!m || m->gone || !jsonIsArray(keys)) return ermOk();
	if (m->open && m->sub) writeKeys(m, keys);
	else
		for (int i = 0; i < keys->array.count; i++) jsonPush(m->keys, keys->array.items[i]);
	return ermOk();
}

ErmErr driverLink(void *data, const ErmGiven *g, Json **out) {
	*out = jsonNull();
	host = data;
	if (!net) net = jsonArray();
	Json *here = drvHere(g);
	netAt = drvUnder(here, "on", "net", NULL);
	Json *dev = drvPath("/", "dev", "link", NULL);
	drvMake(g->api, dev, "views", "link/views", jsonNull());
	drvMake(g->api, dev, "windows", "link/windows", jsonNull());
	drvMake(g->api, dev, "keys", "link/keys", drvUnder(here, "on", "keys", NULL));
	drvHandler(g, here, "keys", (ErmFn){ onKeys, NULL });
	drvHandler(g, here, "net", (ErmFn){ onNet, NULL });
	peerListen(host, heard, NULL);
	drvChild(g, here, "views", (ErmFn){ viewsCompute, NULL }, (ErmFn){ viewsEffect, NULL });
	return ermOk();
}
