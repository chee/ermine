// The C files program on the line protocol (playground/tools/files/typescript/program_harness.ts, whose header has it): one JSON
// request per line in, one answer per line out, in order. A host's view of the program: a store, a graph, the program
// started as the host starts it, and a watcher whose passes the scenario runs itself (no disk events, no timing), on a temp
// folder of the run's own (disk_harness.h): the harness makes the edits and the snapshots itself. Ids are minted "i1", "i2", ...
// through the whole process, and every answer shows them as disk_harness.h does: "id1" for the first met, ...
//
// Memory: each request and its answer are freed once answered; a request that fails part way may leave what it made.
#ifdef __linux__
#define _GNU_SOURCE
#endif

#include "../../../../ermine/encoding/c/json.h"
#include "../../../../ermine/encoding/c/json_text.h"
#include "disk_harness.h"
#include "graph.h"
#include "names.h"
#include "program.h"
#include "sys.h"
#include "watch.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
	st_store *store;
	fg *g;
	fg_api *host;
	fp *program;
	fw *watcher;
	char *root, *folder, *trash, *home;
	int64_t clock;
	size_t told;
	char **refuse;
	size_t refuse_length;
	char **alias_from, **alias_to;
	size_t alias_length;
	pr_policy *may;
} Host;
static Host *at;
static long minted;
static Disk *disk;

static char fault[1024];
static void fail_(const char *format, ...) __attribute__((noreturn, format(printf, 1, 2)));
#include <setjmp.h>
#include <stdarg.h>
#include <time.h>
static jmp_buf jump;
static void fail_(const char *format, ...) {
	va_list ap;
	va_start(ap, format);
	vsnprintf(fault, sizeof fault, format, ap);
	va_end(ap);
	longjmp(jump, 1);
}
static void check(const char *e) {
	if (e) fail_("%s", e);
}

static Host *it(void) {
	if (!at) fail_("no store: open one first");
	return at;
}

static char *mint(void *context) {
	(void)context;
	char text[32];
	snprintf(text, sizeof text, "i%ld", ++minted);
	return strdup(text);
}

// a node of the graph, as the store saves it
static const sd_node *get_out(void *context, const char *id) {
	return fg_get(((Host *)context)->g, id);
}
static bool ephemeral_out(void *context, const char *id) {
	return fg_ephemeral(((Host *)context)->g, id);
}

static int save(void *context) {
	(void)context;
	Host *h = it();
	// a change's time is the wall clock's, in whole seconds: a batch is no earlier than any
	if (h->clock < (int64_t)time(NULL)) h->clock = (int64_t)time(NULL);
	st_saving s = {.root = h->root, .time = (double)h->clock, .get = get_out, .ephemeral = ephemeral_out, .context = h};
	st_code c = st_write(h->store, &s);
	fg_release(h->g);
	if (c != ST_OK) fail_("%s", st_message(h->store));
	return 0;
}

// who may place: the host's policy refuses the slot names given
static pr_answer may_fn(void *context, const pr_ask *ask, const pr_read *read) {
	(void)read;
	const Host *h = context;
	if (strcmp(ask->op, "place") == 0 && ask->target.field && ask->target.field->type == OP_LIST && ask->target.field->count &&
		ask->target.field->items[0]->type == OP_STR)
		for (size_t i = 0; i < h->refuse_length; i++)
			if (strcmp(h->refuse[i], ask->target.field->items[0]->str) == 0) return (pr_answer){PR_NO, "refused", NULL};
	return (pr_answer){PR_YES, "", NULL};
}

static char *alias_of(void *context, const char *path) {
	Host *h = context;
	size_t n = strlen(h->folder);
	if (strncmp(path, h->folder, n) != 0 || path[n] != '/') return NULL;
	for (size_t i = 0; i < h->alias_length; i++)
		if (strcmp(path + n + 1, h->alias_from[i]) == 0) return formatString("%s/%s", h->folder, h->alias_to[i]);
	return NULL;
}

static int bin(void *context, const char *path) {
	return sys_fake(((Host *)context)->trash, path);
}

static void close_(void) {
	if (!at) return;
	fp_free(at->program);
	fw_free(at->watcher);
	fg_free(at->g);
	if (at->may) pr_free(at->may);
	st_close(at->store);
	free(at->root), free(at->folder), free(at->trash), free(at->home);
	for (size_t i = 0; i < at->refuse_length; i++) free(at->refuse[i]);
	free(at->refuse);
	for (size_t i = 0; i < at->alias_length; i++) free(at->alias_from[i]), free(at->alias_to[i]);
	free(at->alias_from), free(at->alias_to);
	free(at);
	at = NULL;
}

static const char *text_of(const Json *request, const char *key) {
	const char *t = jsonText(jsonGet(request, key));
	if (!t) fail_("a field that is not text: %s", key);
	return t;
}

static Json *open_op(const Json *r) {
	close_();
	Host *h = calloc(1, sizeof *h);
	if (!h) abort();
	at = h;
	h->folder = strdup(disk->store);
	h->trash = strdup(disk->trash);
	h->home = strdup(disk->home);
	const Json *refuse = jsonGet(r, "refuse"), *aliases = jsonGet(r, "aliases");
	if (jsonIsArray(refuse)) {
		h->refuse = calloc((size_t)refuse->array.count + 1, sizeof *h->refuse);
		for (int i = 0; i < refuse->array.count; i++) h->refuse[h->refuse_length++] = strdup(jsonText(refuse->array.items[i]));
	}
	if (aliases && aliases->type == JSON_OBJECT) {
		h->alias_from = calloc((size_t)aliases->object.count + 1, sizeof *h->alias_from);
		h->alias_to = calloc((size_t)aliases->object.count + 1, sizeof *h->alias_to);
		for (int i = 0; i < aliases->object.count; i++) {
			h->alias_from[h->alias_length] = strdup(aliases->object.members[i].key);
			h->alias_to[h->alias_length++] = strdup(jsonText(aliases->object.members[i].value));
		}
	}
	// no Foundation: nothing is in iCloud, there are no bookmarks, a coordinated write is just made
	st_options o = {.trash = bin, .trash_context = h, .files = true, .home = h->home, .foundation = &fd_plain, .uncoordinated = true};
	h->store = st_open(h->folder, &o);
	st_restored restored;
	st_code c = st_read(h->store, &restored);
	if (c != ST_OK) fail_("%s", st_message(h->store));
	h->root = strdup(restored.none ? "r" : restored.root);
	h->clock = restored.none ? 0 : (int64_t)restored.time;
	if (h->refuse_length) h->may = pr_call(may_fn, h);
	h->g = fg_new(&(fg_options){.root = h->root, .may = h->may, .mint = mint});
	h->host = fg_actor(h->g, "host");
	if (restored.none) {
		sd_header header = {.has_time = 1, .time = 0};
		sd_node *top = sd_make(h->root, NULL, &header, NULL);
		check(fg_intro(h->g, top));
		sd_free(top);
	} else {
		for (size_t i = 0; i < restored.nodes_length; i++) check(fg_intro(h->g, restored.nodes[i]));
		for (size_t i = 0; i < restored.others_length; i++) check(fg_intro(h->g, restored.others[i]));
		// the graph took each in whole
		st_restored_free(&restored);
	}
	h->program = fp_new(h->store, h->g, (fp_watch){0});
	fw_options w = {.store = h->store, .program = h->program, .actor = "tester", .save = save, .alias = alias_of, .context = h, .events = false};
	h->watcher = fw_new(&w);
	fp_set_watch(h->program, fw_watch(h->watcher));
	Json *a = jsonObject();
	jsonAdd(a, "root", jsonString(h->root));
	return a;
}

// nodes by path ---------------------------------------------------------------------------------------------------------

static const char *find(const Json *path) {
	Host *h = it();
	const char *cur = h->root;
	for (int i = 0; path && i < path->array.count; i++) {
		const Json *e = path->array.items[i];
		const char *name = jsonIsString(e) ? e->string : jsonText(e->array.items[0]);
		long idx = jsonIsString(e) ? 0 : (long)e->array.items[1]->number;
		const char **ids;
		size_t n = fg_ids(h->g, cur, name, &ids);
		const char *next = idx >= 0 && (size_t)idx < n ? ids[idx] : NULL;
		free((void *)ids);
		if (!next) {
			char *p = jsonPrint(path);
			fail_("nothing at %s", p);
		}
		cur = next;
	}
	return cur;
}

static op_value *decoded(const Json *request, const char *key) {
	for (int i = 0; i < request->object.count; i++)
		if (strcmp(request->object.members[i].key, key) == 0) {
			if (!jsonDecode(&request->object.members[i].value)) fail_("a value not in its form");
			return fg_value_of(request->object.members[i].value);
		}
	fail_("no field %s", key);
}

static Json *place_op(const Json *r) {
	Host *h = it();
	const char *holder = find(jsonGet(r, "path"));
	char *id;
	op_value *value = jsonGet(r, "value") ? decoded(r, "value") : NULL;
	check(fg_create(h->host, value, false, &id));
	op_free(value);
	const Json *at_ = jsonGet(r, "at");
	check(fg_insert(h->host, holder, text_of(r, "slot"), id, at_ ? (long)at_->number : -1, -1));
	Json *a = jsonObject();
	jsonAdd(a, "id", jsonString(id));
	free(id);
	return a;
}

static Json *mount_op(const Json *r) {
	Host *h = it();
	const char *holder = find(jsonGet(r, "path")), *to = find(jsonGet(r, "to"));
	const Json *at_ = jsonGet(r, "at");
	check(fg_insert(h->host, holder, text_of(r, "slot"), to, at_ ? (long)at_->number : -1, -1));
	return jsonObject();
}

static Json *write_op(const Json *r) {
	Host *h = it();
	const Json *path = jsonGet(r, "path");
	op_value *value = decoded(r, "value");
	op_patch p = {.has_value = 1, .value = value};
	const char *id = find(path);
	const char *e = fg_write(h->host, id, &p, 1, 0);
	op_free(value);
	check(e);
	return jsonObject();
}

static Json *remove_op(const Json *r) {
	Host *h = it();
	const Json *path = jsonGet(r, "path");
	const Json *last = path->array.items[path->array.count - 1];
	const char *name = jsonIsString(last) ? last->string : jsonText(last->array.items[0]);
	long i = jsonIsString(last) ? 0 : (long)last->array.items[1]->number;
	Json *parent = jsonArray();
	for (int k = 0; k + 1 < path->array.count; k++) jsonPush(parent, jsonRef(path->array.items[k]));
	const char *holder = find(parent);
	jsonFree(parent);
	check(fg_remove(h->host, holder, name, i, i + 1));
	return jsonObject();
}

static Json *start_op(void) {
	Host *h = it();
	check(fp_start(h->program));
	return jsonObject();
}

static Json *pass_op(const Json *r) {
	Host *h = it();
	const Json *t = jsonGet(r, "touched");
	const char **touched = NULL;
	size_t n = 0;
	if (jsonIsArray(t)) {
		touched = calloc((size_t)t->array.count + 1, sizeof *touched);
		for (int i = 0; i < t->array.count; i++) touched[n++] = jsonText(t->array.items[i]);
	}
	bool called;
	fw_pass(h->watcher, t ? touched : NULL, n, &called);
	free(touched);
	const st_difference *d;
	size_t length;
	st_code c = st_differences(h->store, NULL, 0, &d, &length);
	Json *a = jsonObject();
	jsonAdd(a, "called", jsonBoolean(called));
	jsonAdd(a, "settled", jsonBoolean(c == ST_OK && length == 0));
	return a;
}

// the graph from the root, ephemeral nodes left out
static int by_name(const void *x, const void *y) {
	return names_bycodepoint(*(const char *const *)x, *(const char *const *)y);
}
static Json *show(const char *id, Json *seen) {
	Host *h = it();
	Json *o = jsonObject();
	jsonAdd(o, "id", jsonString(id));
	const sd_node *n = fg_get(h->g, id);
	if (!n) {
		jsonAdd(o, "unloaded", jsonBoolean(true));
		return o;
	}
	for (int i = 0; i < seen->array.count; i++)
		if (strcmp(seen->array.items[i]->string, id) == 0) {
			jsonAdd(o, "again", jsonBoolean(true));
			return o;
		}
	jsonPush(seen, jsonString(id));
	Json *value = jsonArray();
	for (size_t i = 0; i < n->value.length; i++) {
		const sd_version *v = &n->value.versions[i];
		Json *e = jsonObject();
		jsonAdd(e, "content", v->content ? jsonRef((Json *)v->content) : jsonNull());
		const Json *c = v->change;
		const Json *actor = c && c->type == JSON_OBJECT ? jsonGet(c, "actor") : NULL;
		if (actor) jsonAdd(e, "actor", jsonRef((Json *)actor));
		jsonPush(value, e);
	}
	jsonAdd(o, "value", value);
	// visited in the order the node has its slots, then shown by name in code point order
	typedef struct {
		const char *name;
		Json *items;
	} Shown;
	Shown *shown = calloc(n->children_length + 1, sizeof *shown);
	size_t count = 0;
	for (size_t i = 0; i < n->children_length; i++) {
		const sd_object *ob = &n->children[i].object;
		if (!ob->length) continue;
		const sd_list *l = ob->versions[0].content;
		size_t total = 0;
		Json *items = jsonArray();
		for (size_t k = 0; k < l->length; k++) {
			if (!l->items[k].id) continue;
			total++;
			if (!fg_ephemeral(h->g, l->items[k].id)) jsonPush(items, show(l->items[k].id, seen));
		}
		if (total > 0 && items->array.count == 0) {
			jsonFree(items);
			continue;
		}
		shown[count++] = (Shown){n->children[i].name, items};
	}
	qsort(shown, count, sizeof *shown, by_name);
	Json *slots = jsonArray();
	for (size_t k = 0; k < count; k++) {
		Json *pair = jsonArray();
		jsonPush(pair, jsonString(shown[k].name));
		jsonPush(pair, shown[k].items);
		jsonPush(slots, pair);
	}
	free(shown);
	jsonAdd(o, "slots", slots);
	return o;
}
static Json *graph_op(void) {
	Host *h = it();
	Json *seen = jsonArray();
	Json *a = jsonObject();
	jsonAdd(a, "root", jsonString(h->root));
	jsonAdd(a, "nodes", show(h->root, seen));
	jsonFree(seen);
	return a;
}

// why the program lists an entry, as a code: its own fixed texts, by how they start
static const char *const WHY[][2] = {
	{"refused: ", "refused"},
	{"an edit to the root's file met a change", "root-met"},
	{"an edit to a side whose version changed since it was laid", "side-changed"},
	{"a side renamed: the store lays it again", "side-renamed"},
	{"a side removed: the store lays it again", "side-removed"},
	{"a link that leads nowhere in the store", "link-nowhere"},
	{"does not read: ", "unread"},
};
static const char *why_code(const char *why) {
	for (size_t i = 0; i < sizeof WHY / sizeof *WHY; i++)
		if (strncmp(why, WHY[i][0], strlen(WHY[i][0])) == 0) return WHY[i][1];
	return "other";
}

// what the program listed since last asked
static Json *listed(void) {
	Host *h = it();
	Json *out = jsonArray();
	const char *id = fp_listing(h->program);
	const op_value *all = id ? fg_value(h->g, id) : NULL;
	size_t count = all && all->type == OP_LIST ? all->count : 0;
	for (size_t k = h->told; k < count; k++) {
		const op_value *x = all->items[k];
		Json *o = jsonObject();
		jsonAdd(o, "path", jsonString(op_get(x, "path")->str));
		jsonAdd(o, "why", jsonString(why_code(op_get(x, "why")->str)));
		jsonPush(out, o);
	}
	h->told = count;
	return out;
}

static Json *listed_op(void) {
	Json *a = jsonObject();
	jsonAdd(a, "listed", listed());
	return a;
}

static Json *edit_op(const Json *r) {
	char why[1024];
	if (disk_edit(disk, r, disk->store, why, sizeof why) != 0) fail_("%s", why);
	return jsonObject();
}

// the snapshot, what was listed shown first
static Json *observe_op(void) {
	Json *l = listed();
	disk_deep(disk, l);
	return disk_program_snapshot(disk, l);
}

static Json *answer(const Json *r) {
	const char *op = text_of(r, "op");
	if (strcmp(op, "open") == 0) return open_op(r);
	if (strcmp(op, "edit") == 0) return edit_op(r);
	if (!at || !at->watcher) fail_("no store: open one first");
	if (strcmp(op, "place") == 0) return place_op(r);
	if (strcmp(op, "mount") == 0) return mount_op(r);
	if (strcmp(op, "write") == 0) return write_op(r);
	if (strcmp(op, "remove") == 0) return remove_op(r);
	if (strcmp(op, "save") == 0) return save(NULL), jsonObject();
	if (strcmp(op, "start") == 0) return start_op();
	if (strcmp(op, "pass") == 0) return pass_op(r);
	if (strcmp(op, "graph") == 0) return graph_op();
	if (strcmp(op, "listed") == 0) return listed_op();
	if (strcmp(op, "observe") == 0) return observe_op();
	Json *e = jsonObject();
	jsonAdd(e, "error", jsonStringOfLength(fault, (size_t)snprintf(fault, sizeof fault, "unknown op %s", op)));
	return e;
}

int main(void) {
	disk = disk_make("ermine-program-conf-", DISK_IDS);
	if (!disk) fputs("no temp folder made\n", stderr), exit(1);
	char *line = NULL;
	size_t capacity = 0;
	while (getline(&line, &capacity, stdin) != -1) {
		if (strspn(line, " \t\r\n") == strlen(line)) continue;
		char *why = NULL;
		Json *request = jsonParse(line, strlen(line), &why);
		if (!request) fprintf(stderr, "bad request: %s\n", why), exit(1);
		Json *a;
		if (setjmp(jump) == 0) a = answer(request);
		else {
			a = jsonObject();
			jsonAdd(a, "error", jsonString(fault));
		}
		// shown as disk_harness.h shows it, on a copy: the answer may share the graph's own values
		char *text = jsonPrint(a);
		Json *shown = jsonParse(text, strlen(text), &why);
		free(text);
		// values back from their JSON form, so they print as they were (a plain {"/": ...} would print as a map)
		Json *decoded = shown;
		if (jsonDecode(&decoded)) shown = decoded;
		disk_deep(disk, shown);
		text = jsonPrint(shown);
		jsonFree(shown);
		puts(text);
		fflush(stdout);
		free(text);
		jsonFree(a);
		jsonFree(request);
		if (at && at->store) st_release(at->store);
	}
	free(line);
	close_();
	disk_free(disk);
	return 0;
}
