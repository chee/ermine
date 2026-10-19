// host.c: files url folder, the device host. See host.h. The folder half is the store's mirror, the files program and its
// watcher on the files graph; the sync half is playground/together over Subduction, told every table event and every write
// (fg_options' event and wrote), and telling the graph what came in on the head shown (fg_landed).
#if defined(__APPLE__)
#define _DARWIN_C_SOURCE
#else
#define _DEFAULT_SOURCE
#endif

#include "host.h"

#include "../../../together/stacks/subduction/c/subduction/platform.h"
#include "../../../together/stacks/subduction/c/subduction/store.h"
#include "../../../together/stacks/subduction/c/subduction/transport.h"
#include "../../../../playground/together/c/sync.h"
#include "graph.h"
#include "program.h"
#include "store.h"
#include "watch.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static void say(const char *format, ...) __attribute__((format(printf, 1, 2)));
static void say(const char *format, ...) {
	va_list args;
	va_start(args, format);
	// FILES_DEBUG: each line with the wall clock's seconds and ms
	if (getenv("FILES_DEBUG")) {
		struct timespec t;
		clock_gettime(CLOCK_REALTIME, &t);
		fprintf(stderr, "[%02ld.%03ld] ", (long)(t.tv_sec % 60), t.tv_nsec / 1000000);
	}
	vfprintf(stderr, format, args);
	fputc('\n', stderr);
	va_end(args);
}

static void *grab(size_t size) {
	void *p = calloc(1, size ? size : 1);
	if (!p) abort();
	return p;
}

static double now(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (double)t.tv_sec * 1000 + (double)t.tv_nsec / 1e6;
}

static void hex(const uint8_t *bytes, size_t n, char *out) {
	static const char digits[] = "0123456789abcdef";
	for (size_t i = 0; i < n; i++) out[2 * i] = digits[bytes[i] >> 4], out[2 * i + 1] = digits[bytes[i] & 15];
	out[2 * n] = 0;
}

static bool unhex(const char *text, size_t n, uint8_t *out) {
	for (size_t i = 0; i < 2 * n; i++) {
		char c = text[i];
		int d = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
		if (d < 0) return false;
		out[i / 2] = (uint8_t)(i % 2 ? out[i / 2] << 4 | d : d);
	}
	return true;
}

// a set of strings, in the order added
typedef struct {
	char **items;
	size_t count, room;
} names;

static bool has(const names *s, const char *id) {
	for (size_t i = 0; i < s->count; i++)
		if (strcmp(s->items[i], id) == 0) return true;
	return false;
}

static bool add(names *s, const char *id) {
	if (has(s, id)) return false;
	if (s->count == s->room) {
		s->room = s->room ? s->room * 2 : 16;
		s->items = realloc(s->items, s->room * sizeof *s->items);
		if (!s->items) abort();
	}
	s->items[s->count++] = copyString(id);
	return true;
}

static void let(names *s) {
	for (size_t i = 0; i < s->count; i++) free(s->items[i]);
	free(s->items);
	*s = (names){0};
}

// --- the host ------------------------------------------------------------------------------------------------------------

typedef struct opening opening;

typedef struct {
	char *doc; // the root's id
	char *folder;
	char *home;
	unsigned quiet;
	bool made, zeros, named;

	uint8_t seed[32];
	ErmStore store;
	fg *g;
	sy_sync *sync;
	int64_t clock;
	names followed;
	bool reach; // a children entry changed: what it names followed, once laid

	// the network
	char *server, *service;
	ErmTransport *ws;
	uint64_t conn;
	double retry, backoff; // when the next try is, and how long after a failure the one after it waits
	bool joined, offline;  // offline: said it is, and not yet that it joined again
	opening *opening;      // a WebSocket being opened, on a thread of its own

	// the folder
	st_store *mirror;
	fp *program;
	fw *watcher;
	bool laid, stopped;
	double batch; // when the next batch is laid out; 0: none due
	// named: the nodes get_out made, and what they refer to, let go of with the graph's (let_out)
	sd_node **outs;
	size_t nouts, outroom;
	void **held;
	size_t nheld, heldroom;
} host;

// the folder --------------------------------------------------------------------------------------------------------------

// named: the ermine:// ids in a value, its keys and strings at any depth, in the order met
static void named_in(const op_value *v, names *out) {
	if (!v) return;
	if (v->type == OP_STR && strncmp(v->str, "ermine://", 9) == 0) add(out, v->str);
	if (v->type != OP_LIST && v->type != OP_MAP) return;
	for (size_t i = 0; i < v->count; i++) {
		if (v->type == OP_MAP && strncmp(v->keys[i], "ermine://", 9) == 0) add(out, v->keys[i]);
		named_in(v->items[i], out);
	}
}

static void *held(host *h, void *p) {
	if (h->nheld == h->heldroom) {
		h->heldroom = h->heldroom ? h->heldroom * 2 : 64;
		h->held = realloc(h->held, h->heldroom * sizeof *h->held);
		if (!h->held) abort();
	}
	return h->held[h->nheld++] = p;
}

static void let_out(host *h) {
	for (size_t i = 0; i < h->nouts; i++) sd_free(h->outs[i]);
	for (size_t i = 0; i < h->nheld; i++) free(h->held[i]);
	h->nouts = h->nheld = 0;
}

static bool taken(const sd_entry *es, size_t n, const char *name) {
	for (size_t i = 0; i < n; i++)
		if (strcmp(es[i].name, name) == 0) return true;
	return false;
}

// a node as the store lays it out: the graph's; named, with a slot more for each id its value names (the id's first 8 hex
// digits, or all 64 when a slot has that name), as if the node held it. Only the layout has those slots: the graph does not
static const sd_node *get_out(void *context, const char *id) {
	host *h = context;
	const sd_node *n = fg_get(h->g, id);
	if (!n || !h->named || !n->value.length) return n;
	names ids = {0};
	named_in(fg_value(h->g, id), &ids);
	sd_entry *es = held(h, grab((n->children_length + ids.count + 1) * sizeof *es));
	memcpy(es, n->children, n->children_length * sizeof *es);
	size_t m = n->children_length;
	for (size_t k = 0; k < ids.count; k++) {
		const char *to = ids.items[k];
		if (strcmp(to, id) == 0 || fg_ephemeral(h->g, to)) continue;
		char name[65];
		snprintf(name, sizeof name, "%.8s", to + 9);
		if (taken(es, m, name)) snprintf(name, sizeof name, "%s", to + 9);
		if (taken(es, m, name)) continue;
		sd_item *item = held(h, grab(sizeof *item));
		item->id = held(h, copyString(to));
		sd_list *list = held(h, grab(sizeof *list));
		*list = (sd_list){item, 1};
		sd_version *version = held(h, grab(sizeof *version));
		*version = (sd_version){list, n->value.versions[0].change, NULL};
		es[m++] = (sd_entry){held(h, copyString(name)), {version, 1}};
	}
	let(&ids);
	if (m == n->children_length) return n;
	sd_contents c = {.value = n->value, .info = n->info, .info_length = n->info_length, .children = es, .children_length = m};
	sd_node *made = sd_make(id, &c, &n->header, NULL);
	if (!made) abort();
	if (h->nouts == h->outroom) {
		h->outroom = h->outroom ? h->outroom * 2 : 16;
		h->outs = realloc(h->outs, h->outroom * sizeof *h->outs);
		if (!h->outs) abort();
	}
	return h->outs[h->nouts++] = made;
}

static bool ephemeral_out(void *context, const char *id) {
	return fg_ephemeral(((host *)context)->g, id);
}

static st_saving saving_of(host *h) {
	// a frame's time counts up, and is no earlier than the wall clock's second
	h->clock = h->clock + 1 > (int64_t)time(NULL) ? h->clock + 1 : (int64_t)time(NULL);
	return (st_saving){.root = h->doc, .time = (double)h->clock, .get = get_out, .ephemeral = ephemeral_out, .context = h};
}

// a batch laid out: what changed since the last
static void flush(host *h) {
	h->batch = 0;
	if (!h->laid) return;
	st_saving saving = saving_of(h);
	if (st_write(h->mirror, &saving) != ST_OK) say("laying out: %s", st_message(h->mirror));
	fg_release(h->g);
	let_out(h);
}

// a batch laid out once the graph has had no change for quiet ms
static void soon(host *h) {
	if (!h->laid || h->stopped || h->batch) return;
	h->batch = now() + h->quiet;
}

static void listed(void *context, const char *path, const char *why) {
	(void)context;
	say("%s: %s", path, why);
}

static int save(void *context) {
	flush(context);
	return 0;
}

// sync ----------------------------------------------------------------------------------------------------------------------

static void follow(host *h, const char *id) {
	if (fg_ephemeral(h->g, id) || !add(&h->followed, id)) return;
	if (!sy_follow(h->sync, id)) say("following %s: not a document", id);
}

// every ermine:// id a children entry reached from the root names, followed; named, every one a value names too
static void reach(host *h) {
	h->reach = false;
	names seen = {0};
	add(&seen, h->doc);
	for (size_t i = 0; i < seen.count; i++) {
		const char *id = seen.items[i];
		follow(h, id);
		const char **slots;
		size_t n = fg_slots(h->g, id, &slots);
		for (size_t s = 0; s < n; s++) {
			const char **ids;
			size_t m = fg_ids(h->g, id, slots[s], &ids);
			for (size_t k = 0; k < m; k++)
				if (strncmp(ids[k], "ermine://", 9) == 0 && !fg_ephemeral(h->g, ids[k])) add(&seen, ids[k]);
			free((void *)ids);
		}
		free((void *)slots);
		if (!h->named) continue;
		names inside = {0};
		named_in(fg_value(h->g, id), &inside);
		for (size_t k = 0; k < inside.count; k++)
			if (!fg_ephemeral(h->g, inside.items[k])) add(&seen, inside.items[k]);
		let(&inside);
	}
	let(&seen);
}

// the graph's: each table event, sync's own writes too (sync passes over those)
static void event(void *context, tb_key part, tb_key id) {
	host *h = context;
	if (!h->sync) return;
	sy_table_changed(h->sync, part, id);
	if (part.string && (strcmp(part.string, "children") == 0 || (h->named && strcmp(part.string, "value") == 0))) h->reach = true;
	soon(h);
}

// the graph's: a write here changed these entries in place
static void wrote(void *context, nd_entry *const *changed, size_t count) {
	host *h = context;
	cm_code c = sy_wrote(h->sync, changed, count);
	if (c != CM_OK) say("sync: a change could not go out (%d)", (int)c);
	h->reach = true;
	soon(h);
}

// sync's: what came in on the head shown, said written
static void committed(void *context, nd_entry *const *changed, size_t count) {
	host *h = context;
	fg_landed(h->g, changed, count);
	h->reach = true;
	soon(h);
}

// sync's: an entry of the graph's taken out or replaced; the graph lets go of what it made at fg_free
static void dropped(void *context, nd_entry *entry) {
	(void)context, (void)entry;
}

static char *minted(void *context) {
	host *h = context;
	char id[9 + 64 + 1];
	sy_mint(h->sync, id);
	return copyString(id);
}

// a new document's id: 32 random bytes, or for a server with no Keyhive grant for it 16 and then 16 zero bytes
static char *fresh(bool zeros) {
	uint8_t bytes[32] = {0};
	erm_host_random(bytes, zeros ? 16 : 32);
	char text[65];
	hex(bytes, 32, text);
	return formatString("ermine://%s", text);
}

static bool is_doc(const char *id) {
	uint8_t bytes[32];
	return strncmp(id, "ermine://", 9) == 0 && strlen(id) == 9 + 64 && unhex(id + 9, 32, bytes);
}

// the document laid out, and the files program started on it
static void begin(host *h) {
	reach(h);
	st_saving saving = saving_of(h);
	st_code c = st_mirror_read(h->mirror, &saving);
	fg_release(h->g);
	let_out(h);
	if (c != ST_OK) {
		say("files: %s", st_message(h->mirror));
		h->stopped = true;
		return;
	}
	h->laid = true;
	flush(h);
	const char *e = fp_start(h->program);
	if (e) say("files: the files program did not start: %s", e);
	say("%s is laid out in %s", h->doc, st_folder(h->mirror));
}

// the network -------------------------------------------------------------------------------------------------------------

// A WebSocket is opened on a thread of its own (ermTransportOpen waits for the connection, TLS and the handshake), so a
// server that cannot be reached never stalls the loop. The loop takes the socket once it is open; a host that stops first
// leaves it to the thread.
struct opening {
	pthread_mutex_t lock;
	char *url;
	bool done, abandoned;
	ErmTransport *ws;
	char *why;
};

static void opening_free(opening *o) {
	pthread_mutex_destroy(&o->lock);
	free(o->url), free(o->why), free(o);
}

static void *open_thread(void *context) {
	opening *o = context;
	const char *why = "no reason given";
	ErmTransport *ws = ermTransportOpen(o->url, &why);
	pthread_mutex_lock(&o->lock);
	bool abandoned = o->abandoned;
	o->ws = ws, o->why = copyString(why ? why : ""), o->done = true;
	pthread_mutex_unlock(&o->lock);
	if (abandoned) {
		if (ws) ermTransportClose(ws);
		opening_free(o);
	}
	return NULL;
}

// tries again after a wait that doubles from 1 s to 30 s
static void later(host *h) {
	h->retry = now() + h->backoff;
	h->backoff = h->backoff * 2 > 30000 ? 30000 : h->backoff * 2;
}

static void lost(host *h) {
	if (!h->ws) return;
	ermTransportClose(h->ws);
	h->ws = NULL;
	tp_closed(sy_device(h->sync), h->conn);
	if (h->joined && !h->offline) say("lost %s: offline, retrying; edits are kept here till it is back", h->server);
	h->offline = h->offline || h->joined;
	h->joined = false;
	later(h);
}

// a WebSocket begun, or the one begun taken once it is open
static void join(host *h) {
	if (!h->opening) {
		if (now() < h->retry) return;
		opening *o = grab(sizeof *o);
		pthread_mutex_init(&o->lock, NULL);
		o->url = copyString(h->server);
		pthread_t thread;
		if (pthread_create(&thread, NULL, open_thread, o) != 0) {
			opening_free(o);
			later(h);
			return;
		}
		pthread_detach(thread);
		h->opening = o;
		return;
	}
	opening *o = h->opening;
	pthread_mutex_lock(&o->lock);
	bool done = o->done;
	pthread_mutex_unlock(&o->lock);
	if (!done) return;
	h->opening = NULL;
	if (o->ws) {
		h->ws = o->ws;
		h->conn = tp_connect(sy_device(h->sync), h->service);
	} else {
		if (!h->offline) say("offline: cannot reach %s (%s); retrying, edits are kept here till it is reached", h->server, o->why);
		h->offline = true;
		later(h);
	}
	opening_free(o);
}

// a WebSocket still being opened left to its thread, which closes it
static void abandon(host *h) {
	opening *o = h->opening;
	if (!o) return;
	h->opening = NULL;
	pthread_mutex_lock(&o->lock);
	bool done = o->done;
	o->abandoned = true;
	pthread_mutex_unlock(&o->lock);
	if (!done) return;
	if (o->ws) ermTransportClose(o->ws);
	opening_free(o);
}

// what the socket holds given to the device: true if anything was
static bool receive(host *h) {
	bool got_any = false;
	while (h->ws) {
		uint8_t *bytes;
		size_t length;
		int got = ermTransportReceive(h->ws, &bytes, &length);
		if (got == 0) break;
		if (got < 0) {
			lost(h);
			break;
		}
		tp_received(sy_device(h->sync), h->conn, bytes, length);
		erm_host_free(bytes);
		got_any = true;
	}
	return got_any;
}

// sealing, storing, sending, and what came taken in: ms until it must run again (-1: when something comes); *sent: sent any
static int64_t turn(host *h, bool *sent) {
	if (h->server && !h->ws && !h->stopped) join(h);
	tp_device *t = sy_device(h->sync);
	int64_t wait = -1;
	for (int round = 0; round < 16; round++) {
		wait = sy_run(h->sync);
		bool did = false;
		tp_out o;
		while (tp_next(t, &o)) {
			did = true;
			if (o.kind == TP_SEND && h->ws && o.conn == h->conn) {
				if (!ermTransportSend(h->ws, o.bytes, o.length)) lost(h);
				else if (sent) *sent = true;
			} else if (o.kind == TP_CLOSE && h->ws && o.conn == h->conn) lost(h);
			tp_out_free(&o);
		}
		// what came is run in the next round, not left till the next turn
		if (receive(h)) did = true;
		if (!did && wait != 0) break;
	}
	if (h->ws && !h->joined && tp_connected(t, h->conn, NULL)) {
		h->joined = true;
		h->offline = false;
		h->backoff = 1000;
		say("joined %s", h->server);
	}
	return wait;
}

// the loop ----------------------------------------------------------------------------------------------------------------

static volatile sig_atomic_t interrupted;

static void interrupt(int signal) {
	(void)signal;
	if (interrupted) _exit(130);
	interrupted = 1;
}

// a path made absolute, its links resolved: its own, or its parent's if it is not there yet
static char *real(const char *path) {
	char *abs;
	if (path[0] == '/') abs = copyString(path);
	else {
		char cwd[PATH_MAX];
		if (!getcwd(cwd, sizeof cwd)) return copyString(path);
		abs = formatString("%s/%s", cwd, path);
	}
	size_t n = strlen(abs);
	while (n > 1 && abs[n - 1] == '/') abs[--n] = 0;
	char *resolved = realpath(abs, NULL);
	if (resolved) return free(abs), resolved;
	char *slash = strrchr(abs, '/');
	if (!slash || slash == abs) return abs;
	*slash = 0;
	char *parent = real(abs);
	char *joined = formatString("%s/%s", parent, slash + 1);
	free(parent), free(abs);
	return joined;
}

// mkdir -p
static bool made(const char *path) {
	char *p = copyString(path);
	for (char *at = p + 1;; at++) {
		if (*at && *at != '/') continue;
		char end = *at;
		*at = 0;
		if (mkdir(p, 0755) != 0 && errno != EEXIST) return free(p), false;
		*at = end;
		if (!end) break;
	}
	free(p);
	return true;
}

// the device in home/.ermine/device: its key, made on the first run, and its storage
static bool device(host *h) {
	char *dir = formatString("%s/.ermine/device", h->home), *path = formatString("%s/key", dir);
	bool ok = made(dir);
	if (!ok) say("files: cannot make %s: %s", dir, strerror(errno));
	FILE *f = ok ? fopen(path, "r") : NULL;
	if (f) {
		char text[80] = {0};
		size_t n = fread(text, 1, sizeof text - 1, f);
		fclose(f);
		while (n && (text[n - 1] == '\n' || text[n - 1] == '\r' || text[n - 1] == ' ')) text[--n] = 0;
		if (n != 64 || !unhex(text, 32, h->seed)) say("files: %s is not 64 hex digits", path), ok = false;
	} else if (ok && errno == ENOENT) {
		erm_host_random(h->seed, 32);
		char text[66];
		hex(h->seed, 32, text);
		strcat(text, "\n");
		int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0600);
		ok = fd >= 0 && write(fd, text, 65) == 65;
		if (fd >= 0) close(fd);
		if (!ok) say("files: cannot write %s: %s", path, strerror(errno));
	} else if (ok) say("files: cannot read %s: %s", path, strerror(errno)), ok = false;
	free(path);
	if (ok) {
		char *storage = formatString("%s/sync", dir);
		const char *why = NULL;
		ok = ermStoreFiles(storage, &h->store, &why) == 0;
		if (!ok) say("files: cannot open %s: %s", storage, why ? why : "no reason given");
		free(storage);
	}
	free(dir);
	return ok;
}

// FILES_DEBUG: what each followed document's history holds, on stderr
static void describe(host *h) {
	if (!getenv("FILES_DEBUG")) return;
	tp_device *t = sy_device(h->sync);
	for (size_t i = 0; i < h->followed.count; i++) {
		const char *id = h->followed.items[i];
		hy_history *history = tp_history(t, id, TP_STORED);
		if (!history) continue;
		const hy_kept **list;
		size_t all = hy_all(history, &list);
		free(list);
		size_t heads = hy_heads(history, &list);
		free(list);
		say("%.17s: %zu commits, %zu heads; %s", id, all, heads, fg_loaded(h->g, id) ? "here" : "not here");
	}
}

static void stop(host *h) {
	h->stopped = true;
	if (h->laid) {
		// edits not yet passed, taken in: a pass over every folder
		bool called;
		fw_pass(h->watcher, NULL, 0, &called);
		flush(h);
		st_release(h->mirror);
	}
	fp_stop(h->program);
	// what is left sent: until nothing has gone out for 400 ms, or 3 s
	double end = now() + 3000, quiet = now();
	while (h->ws && now() < end && now() - quiet < 400) {
		bool sent = false;
		int64_t wait = turn(h, &sent);
		if (sent || !sy_idle(h->sync)) quiet = now();
		struct pollfd p = {.fd = h->ws ? ermTransportFd(h->ws) : -1, .events = POLLIN};
		if (p.fd >= 0) poll(&p, 1, wait < 0 || wait > 20 ? 20 : (int)wait);
	}
	if (!h->ws) turn(h, NULL);
}

static bool local(const char *server) {
	return strstr(server, "//localhost") || strstr(server, "//127.0.0.1") || strstr(server, "//[::1]");
}

int fh_run(const fh_options *o) {
	host *h = grab(sizeof *h);
	const char *home = o->home ? o->home : getenv("HOME");
	if (!home || !*home) return say("files: no home: give --home, or set HOME"), 1;
	const char *server = o->server ? o->server : FH_SERVER;
	// a server on this machine stores any id; any other only ids ending in zeros (until Keyhive)
	h->zeros = *server && !local(server);
	h->home = real(home);
	h->made = strcmp(o->doc, "new") == 0;
	h->doc = h->made ? fresh(h->zeros) : copyString(o->doc);
	if (!is_doc(h->doc)) return say("files: %s is no document id (ermine:// and 64 hex digits)", o->doc), 1;
	h->quiet = o->quiet ? o->quiet : 20;
	h->named = o->named;
	// the folder as the system has it, as the watcher's events name it (/var is /private/var)
	h->folder = real(o->folder);
	if (!device(h)) return 1;

	h->g = fg_new(&(fg_options){.root = h->doc, .mint = minted, .event = event, .wrote = wrote, .context = h});
	sy_options so = {.table = fg_table(h->g), .store = &h->store, .zeros = h->zeros, .commit = committed, .drop = dropped,
		.context = h};
	memcpy(so.seed, h->seed, 32);
	h->sync = sy_create(&so);
	if (!h->sync) return say("files: Subduction would not make a device"), 1;

	// a new document: its root, with no slots yet
	if (h->made) {
		sd_header header = {.has_time = 1, .time = (int64_t)time(NULL)};
		sd_node *top = sd_make(h->doc, NULL, &header, NULL);
		const char *e = fg_intro(h->g, top);
		sd_free(top);
		if (e) return say("files: %s", e), 1;
	}

	// the folder
	st_options options = {.files = true, .home = h->home, .list = listed};
	h->mirror = st_open_mirror(h->folder, &options);
	if (!h->mirror) return say("files: cannot open %s", h->folder), 1;
	h->program = fp_new(h->mirror, h->g, (fp_watch){0});
	fw_options wopts = {.store = h->mirror, .program = h->program, .save = save, .list = listed, .context = h, .events = true};
	h->watcher = fw_new(&wopts);
	fp_set_watch(h->program, fw_watch(h->watcher));

	// starting again: the device takes in what its storage holds before it touches the network
	follow(h, h->doc);
	turn(h, NULL);
	if (*server) {
		h->server = copyString(server);
		char service[256];
		tp_service(server, service, sizeof service);
		h->service = copyString(service);
		h->backoff = 1000;
	}
	if (h->made) printf("%s\n", h->doc), fflush(stdout);

	struct sigaction sa = {0};
	sa.sa_handler = interrupt;
	sigaction(SIGINT, &sa, NULL);
	sigaction(SIGTERM, &sa, NULL);
	signal(SIGPIPE, SIG_IGN);

	if (!fg_loaded(h->g, h->doc)) say("waiting for %s to arrive", h->doc);
	while (!interrupted && !(h->stopped && !h->laid)) {
		int64_t wait = turn(h, NULL);
		if (!h->laid && !h->stopped && fg_loaded(h->g, h->doc)) begin(h);
		if (h->reach && h->laid) reach(h);
		bool called;
		if (h->laid) fw_poll(h->watcher, &called);
		if (h->batch && now() >= h->batch) flush(h);
		// what the pass and the batch were given back let go of (fw_poll lets go of the layout's arena alone)
		if (h->laid) st_release(h->mirror);
		// what to wait for: the transport, the next batch, the watcher's events
		double t = now();
		double until = wait < 0 ? 1000 : (double)wait;
		if (h->batch) until = until < h->batch - t ? until : h->batch - t;
		if (h->laid && until > 20) until = 20;
		// a WebSocket being opened is looked at every 50 ms
		if (h->server && !h->ws && until > (h->opening ? 50 : h->retry - t)) until = h->opening ? 50 : h->retry - t;
		if (until < 0) until = 0;
		struct pollfd p = {.fd = h->ws ? ermTransportFd(h->ws) : -1, .events = POLLIN};
		if (p.fd >= 0) poll(&p, 1, (int)until);
		else poll(NULL, 0, (int)until);
	}
	bool failed = h->stopped && !h->laid && !interrupted;
	stop(h);
	describe(h);

	fw_free(h->watcher);
	fp_free(h->program);
	st_close(h->mirror);
	abandon(h);
	if (h->ws) ermTransportClose(h->ws);
	// sync's entries go with it; then the graph's, then the table
	sy_free(h->sync);
	h->sync = NULL;
	fg_free(h->g);
	let_out(h);
	free(h->outs), free(h->held);
	let(&h->followed);
	free(h->doc), free(h->folder), free(h->home), free(h->server), free(h->service);
	free(h);
	return failed ? 1 : 0;
}
