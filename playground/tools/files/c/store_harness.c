// The C store on the line protocol (playground/tools/files/typescript/store_harness.ts, whose header has it): one JSON request per
// line in, one answer per line out, in order. One store at a time, made by open. The harness keeps a temp folder of its own
// (disk_harness.h): it makes the edits a scenario asks for and looks at the folder and the Trash itself, never through the store, and
// shows every answer as the TypeScript harness does (the temp folder "@", each store's uuid "uuid", "uuid2", ...). Nodes are
// in pack's JSON form, each content, change and because a value in its JSON form (ENCODING.tex: "/" for bytes and typed
// arrays); hashes are hex and bytes hex.
#ifdef __linux__
#define _GNU_SOURCE
#endif

#include "../../../../ermine/encoding/c/cbor.h"
#include "../../../../ermine/encoding/c/json.h"
#include "../../../../ermine/encoding/c/json_text.h"
#include "disk_harness.h"
#include "saved_shown_harness.h"
#include "external.h"
#include "foundation.h"
#include "names.h"
#include "store.h"
#include "sys.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// --- reading requests, as the manifest's harness does ---

// the slot of a key in an object, or an index in an array; NULL when there is none
static Json **slot(Json *at, const Json *key) {
	if (jsonIsObject(at) && jsonIsString(key)) {
		for (int i = 0; i < at->object.count; i++)
			if (at->object.members[i].keyLength == key->stringLength && memcmp(at->object.members[i].key, key->string, key->stringLength) == 0) return &at->object.members[i].value;
	} else if (jsonIsArray(at) && jsonIsNumber(key) && key->number >= 0 && key->number < at->array.count) return &at->array.items[(int)key->number];
	return NULL;
}

static Json **member(Json *at, const char *key) {
	return slot(at, &(Json){.type = JSON_STRING, .string = (char *)key, .stringLength = strlen(key)});
}

// a member in its JSON form turned into the value it stands for, once
static Json *decoded(Json *at, const char *key) {
	Json **s = member(at, key);
	if (!s) return NULL;
	if (!jsonDecode(s)) fail("a value not in its form");
	return *s;
}

static const char *text_of(const Json *request, const char *key) {
	const char *s = jsonText(jsonGet(request, key));
	if (!s) fail("a field that is not text");
	return s;
}

// the answer being written: a stream of memory, one JSON value, which the line then wraps, texts and prints
static FILE *out;
// set when the answer written is an error
static bool errored;
static Disk *disk;
// where the store was last opened: an edit's plain paths and the snapshot follow it
static char *folder;

static void say(const char *s) {
	fputs(s, out);
	fputc('\n', out);
}

// a string in JSON, as saved_shown_harness.c's text writes it
static void quote(const char *s) {
	fputc('"', out);
	for (; *s; s++) {
		unsigned char c = (unsigned char)*s;
		if (c == 0xC0 && (unsigned char)s[1] == 0x80) fputs("\\u0000", out), s++;
		else if (c == '"' || c == '\\') fprintf(out, "\\%c", c);
		else if (c < 0x20) fprintf(out, "\\u%04x", c);
		else fputc(c, out);
	}
	fputc('"', out);
}

static uint8_t *unhex(const char *hex, size_t *n) {
	*n = strlen(hex) / 2;
	uint8_t *bytes = take(*n);
	for (size_t i = 0; i < *n; i++) {
		unsigned x;
		if (sscanf(hex + 2 * i, "%2x", &x) != 1) fail("bad hex");
		bytes[i] = (uint8_t)x;
	}
	return bytes;
}

static void hex(const uint8_t *bytes, size_t n) {
	fputc('"', out);
	for (size_t i = 0; i < n; i++) fprintf(out, "%02x", bytes[i]);
	fputc('"', out);
}

static void value(const Json *x) {
	char *s = jsonPrint(x);
	fputs(s, out);
	free(s);
}

// --- nodes, as the manifest's harness shows them, with Json contents ---

static void decode_versions(Json *vs, bool content) {
	for (int i = 0; i < vs->array.count; i++) {
		if (content) decoded(vs->array.items[i], "content");
		decoded(vs->array.items[i], "change");
		decoded(vs->array.items[i], "because");
	}
}

static void decode_node(Json *n) {
	decode_versions(jsonGet(n, "value"), true);
	Json *info = jsonGet(n, "info"), *children = jsonGet(n, "children"), *h = jsonGet(n, "header");
	for (int i = 0; i < info->array.count; i++) decode_versions(info->array.items[i]->array.items[1], true);
	for (int i = 0; i < children->array.count; i++) decode_versions(children->array.items[i]->array.items[1], false);
	if (h) decoded(h, "actor"), decoded(h, "cause");
}

static const sd_list *list_of(const Json *c) {
	sd_item *is = take((size_t)c->array.count * sizeof *is);
	for (int i = 0; i < c->array.count; i++) {
		const Json *e = c->array.items[i];
		if (jsonIsString(e)) is[i] = (sd_item){jsonText(e), NULL};
		else is[i] = (sd_item){NULL, jsonText(jsonGet(e, "symbol"))};
	}
	sd_list *l = take(sizeof *l);
	*l = (sd_list){is, (size_t)c->array.count};
	return l;
}

static sd_object object_of(const Json *vs, int lists) {
	sd_version *v = take((size_t)vs->array.count * sizeof *v);
	for (int i = 0; i < vs->array.count; i++) {
		const Json *e = vs->array.items[i], *c = jsonGet(e, "content");
		v[i] = (sd_version){lists ? (const void *)list_of(c) : c, jsonGet(e, "change"), jsonGet(e, "because")};
	}
	return (sd_object){v, (size_t)vs->array.count};
}

static size_t entries_of(const Json *es, int lists, const sd_entry **out) {
	sd_entry *e = take((size_t)es->array.count * sizeof *e);
	for (int i = 0; i < es->array.count; i++) {
		const Json *pair = es->array.items[i];
		e[i] = (sd_entry){jsonText(pair->array.items[0]), object_of(pair->array.items[1], lists)};
	}
	*out = e;
	return (size_t)es->array.count;
}

static sd_node *node_of(Json *n) {
	sd_contents c = {0};
	c.value = object_of(jsonGet(n, "value"), 0);
	c.info_length = entries_of(jsonGet(n, "info"), 0, &c.info);
	c.children_length = entries_of(jsonGet(n, "children"), 1, &c.children);
	const Json *h = jsonGet(n, "header"), *t = jsonGet(h, "time"), *s = jsonGet(h, "site");
	sd_header header = {0};
	if (t) header.has_time = 1, header.time = (int64_t)t->number;
	header.actor = jsonGet(h, "actor");
	header.reader = jsonText(jsonGet(h, "reader"));
	if (s) {
		const Json *column = jsonGet(s, "column"), *function = jsonGet(s, "function");
		header.has_site = 1;
		header.site = (sd_site){jsonText(jsonGet(s, "file")), (long)jsonGet(s, "line")->number, column ? (long)column->number : 0, function ? jsonText(function) : NULL, column != NULL};
	}
	header.cause = jsonGet(h, "cause");
	sd_node *made = sd_make(jsonText(jsonGet(n, "id")), &c, &header, NULL);
	if (!made) fail("out of memory");
	return made;
}

static void show_versions(sd_object o, int lists) {
	fputc('[', out);
	for (size_t i = 0; i < o.length; i++) {
		const sd_version *v = &o.versions[i];
		if (i) fputc(',', out);
		fputs("{\"content\":", out);
		if (lists) {
			const sd_list *l = v->content;
			fputc('[', out);
			for (size_t j = 0; j < l->length; j++) {
				if (j) fputc(',', out);
				if (l->items[j].id) quote(l->items[j].id);
				else fputs("{\"symbol\":", out), quote(l->items[j].symbol), fputc('}', out);
			}
			fputc(']', out);
		} else value(v->content);
		if (v->change) fputs(",\"change\":", out), value(v->change);
		if (v->because) fputs(",\"because\":", out), value(v->because);
		fputc('}', out);
	}
	fputc(']', out);
}

static void show_entries(const sd_entry *es, size_t n, int lists) {
	fputc('[', out);
	for (size_t i = 0; i < n; i++) {
		if (i) fputc(',', out);
		fputc('[', out);
		quote(es[i].name);
		fputc(',', out);
		show_versions(es[i].object, lists);
		fputc(']', out);
	}
	fputc(']', out);
}

static void show(const sd_node *n) {
	const sd_header *h = &n->header;
	const char *comma = "";
	fputs("{\"id\":", out);
	quote(n->id);
	fputs(",\"value\":", out);
	show_versions(n->value, 0);
	fputs(",\"info\":", out);
	show_entries(n->info, n->info_length, 0);
	fputs(",\"children\":", out);
	show_entries(n->children, n->children_length, 1);
	fputs(",\"header\":{", out);
	if (h->has_time) fprintf(out, "\"time\":%lld", (long long)h->time), comma = ",";
	if (h->actor) fprintf(out, "%s\"actor\":", comma), value(h->actor), comma = ",";
	if (h->reader) fprintf(out, "%s\"reader\":", comma), quote(h->reader), comma = ",";
	if (h->has_site) {
		fprintf(out, "%s\"site\":{\"file\":", comma);
		quote(h->site.file);
		fprintf(out, ",\"line\":%ld", h->site.line);
		if (h->site.has_column) fprintf(out, ",\"column\":%ld", h->site.column);
		if (h->site.function) fputs(",\"function\":", out), quote(h->site.function);
		fputc('}', out);
		comma = ",";
	}
	if (h->cause) fprintf(out, "%s\"cause\":", comma), value(h->cause);
	fputs("}}", out);
}

static void number(double n) {
	char t[32];
	jsonNumberText(n, t);
	fputs(t, out);
}

static void kept(const mf_kept *k) {
	fprintf(out, "[\"%s\",\"%s\"]", k->hash, k->form);
}

// a node's shape, as the reference's graph answer shows it
static void shape(const char *id, const mf_node *s) {
	fputs("{\"id\":", out);
	quote(id);
	fputs(",\"kept\":", out);
	kept(&s->kept);
	if (s->kept.has_head) fputs(",\"head\":", out), hex(s->kept.head, s->kept.head_length);
	fputs(",\"sides\":[", out);
	for (size_t i = 0; i < s->sides_length; i++) {
		const mf_kept *k = &s->sides[i];
		fprintf(out, "%s[\"%s\",\"%s\"", i ? "," : "", k->hash, k->form);
		if (k->has_head) fputc(',', out), hex(k->head, k->head_length);
		fputc(']', out);
	}
	fputs("],\"info\":[", out);
	for (size_t i = 0; i < s->info_length; i++) {
		if (i) fputc(',', out);
		fputc('[', out);
		quote(s->info[i].name);
		fprintf(out, ",\"%s\",\"%s\"]", s->info[i].hash, s->info[i].form);
	}
	fputs("],\"directory\":[", out);
	for (size_t i = 0; i < s->directory_length; i++) {
		if (i) fputc(',', out);
		fputc('[', out);
		quote(s->directory[i].name);
		fputs(",[", out);
		for (size_t j = 0; j < s->directory[i].length; j++) {
			if (j) fputc(',', out);
			quote(s->directory[i].ids[j]);
		}
		fputs("]]", out);
	}
	fputs("]}", out);
}

// --- the store ---

static st_store *store;
static char *trash_dir, *home;
static bool is_mirror;
static char **given;
static size_t given_length;

typedef struct {
	char *path;
	const char *why;
} Listed;
static Listed *listed;
static size_t listed_length, listed_capacity;

// why a store lists an entry, as a code: its own fixed texts, by how they start; anything else is a file system's error
// text, "fault", unless a trash request gave it
static const char *const WHY[][2] = {
	{"left in the store's tmp holding entries", "tmp-held"},
	{"the info ", "info-too-big"},
	{"an entry the store could not lay out held others' work", "others-work"},
	{"another entry is where the store lays one", "taken"},
	{"a folder the store removed held others' entries", "folder-held"},
	{"an edit whose place was taken", "edit-taken"},
	{"not what the store laid", "not-laid"},
	{"what the store was moving here is not where it was", "moved-away"},
	{"laid out by a layout record that did not fit the graph", "unfit"},
	{"not in the graph", "not-in-graph"},
	{"the manifest of the store this folder is a copy of", "copied"},
};

static const char *code(const char *why) {
	for (size_t i = 0; i < given_length; i++)
		if (strcmp(given[i], why) == 0) return given[i];
	for (size_t i = 0; i < sizeof WHY / sizeof *WHY; i++)
		if (strncmp(why, WHY[i][0], strlen(WHY[i][0])) == 0) return WHY[i][1];
	return "fault";
}

static void told(void *context, const char *path, const char *why) {
	(void)context;
	if (listed_length == listed_capacity) {
		listed_capacity = listed_capacity ? listed_capacity * 2 : 16;
		listed = realloc(listed, listed_capacity * sizeof *listed);
		if (!listed) abort();
	}
	listed[listed_length++] = (Listed){strdup(path), code(why)};
}

static int fake(void *context, const char *path) {
	(void)context;
	return sys_fake(trash_dir, path);
}

static void open_op(Json *request) {
	// the folder is a disk path from the store's folder; the Trash, home and the one outside place are the disk's
	Json *given_folder = jsonGet(request, "folder");
	free(folder);
	folder = jsonIsString(given_folder) ? disk_path(disk, jsonText(given_folder), disk->store) : copyString(disk->store);
	jsonSet(request, "folder", 6, jsonString(folder));
	jsonSet(request, "trash", 5, jsonString(disk->trash));
	jsonSet(request, "home", 4, jsonString(disk->home));
	Json *place = jsonArray();
	jsonPush(place, jsonString(disk->outside));
	jsonSet(request, "outside", 7, place);
	st_options o = {.trash = fake, .list = told};
	const Json *files = jsonGet(request, "files"), *pass = jsonGet(request, "pass"), *slack = jsonGet(request, "slack");
	if (files && files->type == JSON_BOOLEAN) o.files = files->boolean;
	const char **names = NULL;
	if (jsonIsArray(pass)) {
		names = malloc((size_t)(pass->array.count + 1) * sizeof *names);
		if (!names) abort();
		for (int i = 0; i < pass->array.count; i++) names[i] = jsonText(pass->array.items[i]);
		o.pass = names, o.pass_length = (size_t)pass->array.count;
	}
	if (jsonIsNumber(slack)) o.has_slack = true, o.slack = (size_t)slack->number;
	// no Foundation: nothing is in iCloud, there are no bookmarks (a store is found again by its path, if the folder there
	// carries its uuid), nothing is coordinated
	o.foundation = &fd_plain, o.uncoordinated = true;
	const Json *outside = jsonGet(request, "outside");
	const char **places = NULL;
	if (jsonIsArray(outside)) {
		places = malloc((size_t)(outside->array.count + 1) * sizeof *places);
		if (!places) abort();
		for (int i = 0; i < outside->array.count; i++) places[i] = jsonText(outside->array.items[i]);
		o.outside = places, o.outside_length = (size_t)outside->array.count;
	}
	free(home);
	home = strdup(text_of(request, "home"));
	o.home = home;
	is_mirror = jsonGet(request, "mirror") && jsonGet(request, "mirror")->type == JSON_BOOLEAN && jsonGet(request, "mirror")->boolean;
	free(trash_dir);
	trash_dir = strdup(text_of(request, "trash"));
	st_close(store);
	store = is_mirror ? st_open_mirror(text_of(request, "folder"), &o) : st_open(text_of(request, "folder"), &o);
	free(names);
	free(places);
	say("{}");
}

static st_store *it(void) {
	if (!store) fail("no store: open one first");
	return store;
}

// an error answer; false when the code is none
static bool refused(st_code c) {
	if (c == ST_OK) return false;
	errored = true;
	if (c == ST_STORE) say("{\"error\":\"store\"}");
	else {
		fputs("{\"error\":\"other\",\"message\":", out);
		quote(st_message(it()));
		say("}");
	}
	return true;
}

static void mirror_read_op(Json *request);

static void read_op(Json *request) {
	if (is_mirror) {
		mirror_read_op(request);
		return;
	}
	st_restored r = {.none = true};
	if (refused(st_read(it(), &r))) return;
	if (r.none) {
		say("null");
		return;
	}
	fputs("{\"root\":", out);
	quote(r.root);
	fputs(",\"time\":", out);
	number(r.time);
	fputs(",\"nodes\":[", out);
	for (size_t i = 0; i < r.nodes_length; i++) {
		if (i) fputc(',', out);
		show(r.nodes[i]);
	}
	fputs("],\"others\":[", out);
	for (size_t i = 0; i < r.others_length; i++) {
		if (i) fputc(',', out);
		show(r.others[i]);
	}
	fputs("],\"missing\":[", out);
	for (size_t i = 0; i < r.missing_length; i++) {
		if (i) fputc(',', out);
		quote(r.missing[i]);
	}
	say("]}");
	st_restored_free(&r);
}

// the table of a write: its nodes by id, and the ids that are ephemeral
static struct table {
	sd_node **nodes;
	size_t count;
	const Json *ephemeral;
} table;

static const sd_node *get(void *context, const char *id) {
	const struct table *t = context;
	for (size_t i = 0; i < t->count; i++)
		if (strcmp(t->nodes[i]->id, id) == 0) return t->nodes[i];
	return NULL;
}

static bool ephemeral(void *context, const char *id) {
	const struct table *t = context;
	for (int i = 0; t->ephemeral && i < t->ephemeral->array.count; i++)
		if (strcmp(jsonText(t->ephemeral->array.items[i]), id) == 0) return true;
	return false;
}

// the graph a write or a mirror's read gives: nodes by id, the ids that are ephemeral, the host's records
static void saving_of(Json *request, st_saving *saving, sd_node ***nodes_made, size_t *nodes_count) {
	Json *nodes = jsonGet(request, "nodes");
	size_t count = (size_t)nodes->array.count;
	sd_node **made = take(count * sizeof *made);
	for (size_t i = 0; i < count; i++) {
		decode_node(nodes->array.items[i]);
		made[i] = node_of(nodes->array.items[i]);
	}
	table = (struct table){made, count, jsonGet(request, "ephemeral")};
	*saving = (st_saving){.root = text_of(request, "root"), .time = jsonGet(request, "time")->number, .context = &table, .get = get, .ephemeral = ephemeral};
	*nodes_made = made, *nodes_count = count;
	const Json *records = jsonGet(request, "records");
	if (jsonIsObject(records)) {
		mf_record *rs = take((size_t)records->object.count * sizeof *rs);
		for (int i = 0; i < records->object.count; i++) {
			const JsonMember *m = &records->object.members[i];
			rs[i].key = m->key;
			if (m->value->type == JSON_NULL) rs[i].data = NULL, rs[i].length = 0;
			else rs[i].data = unhex(jsonText(m->value), &rs[i].length);
		}
		saving->records = rs, saving->records_length = (size_t)records->object.count;
	}
}

static void write_op(Json *request) {
	st_saving saving;
	sd_node **made;
	size_t count;
	saving_of(request, &saving, &made, &count);
	st_code c = st_write(it(), &saving);
	if (!refused(c)) say("{}");
	for (size_t i = 0; i < count; i++) sd_free(made[i]);
}

// a mirror's read(saving): the graph the host has now, as write takes it
static void mirror_read_op(Json *request) {
	st_saving saving;
	sd_node **made;
	size_t count;
	saving_of(request, &saving, &made, &count);
	st_code c = st_mirror_read(it(), &saving);
	if (!refused(c)) say("{}");
	for (size_t i = 0; i < count; i++) sd_free(made[i]);
}

static int by_path_of(const void *a, const void *b) {
	return names_bycodepoint(((const ex_stored *)a)->path, ((const ex_stored *)b)->path);
}

// stores(): every store home's list has, by path
static void stores_op(void) {
	ex_where w = {.home = home, .foundation = &fd_plain};
	ex_stored *list;
	size_t n;
	if (ex_stores(&w, &list, &n) != 0) {
		errored = true;
		fputs("{\"error\":\"other\",\"message\":", out);
		quote(strerror(errno));
		say("}");
		return;
	}
	qsort(list, n, sizeof *list, by_path_of);
	fputc('[', out);
	for (size_t i = 0; i < n; i++) {
		if (i) fputc(',', out);
		fputs("{\"uuid\":", out);
		quote(list[i].uuid);
		fputs(",\"path\":", out);
		quote(list[i].path);
		fputc('}', out);
	}
	say("]");
	ex_stores_free(list, n);
}

// find(uuid): where the store is now
static void find_op(const Json *request) {
	ex_where w = {.home = home, .foundation = &fd_plain};
	char *path = ex_find(disk_raw(disk, text_of(request, "uuid")), &w);
	if (path) quote(path), fputc('\n', out);
	else say("null");
	free(path);
}

static int by_id(const void *a, const void *b) {
	return names_bycodepoint(*(const char *const *)a, *(const char *const *)b);
}

static void graph_op(void) {
	st_store *s = it();
	size_t n = st_count(s);
	const char **ids = take((n + 1) * sizeof *ids);
	const mf_node **shapes = take((n + 1) * sizeof *shapes);
	for (size_t i = 0; i < n; i++) ids[i] = st_id(s, i);
	qsort(ids, n, sizeof *ids, by_id);
	for (size_t i = 0; i < n; i++)
		for (size_t j = 0; j < n; j++)
			if (st_id(s, j) == ids[i]) shapes[i] = st_node(s, j);
	fputs("{\"root\":", out);
	quote(st_root(s));
	fputs(",\"nodes\":[", out);
	for (size_t i = 0; i < n; i++) {
		if (i) fputc(',', out);
		shape(ids[i], shapes[i]);
	}
	say("]}");
}

static int by_key(const void *a, const void *b) {
	return names_bycodepoint(((const mf_record *)a)->key, ((const mf_record *)b)->key);
}

static void others_op(void) {
	const mf_record *rs;
	size_t n = st_others(it(), &rs);
	mf_record *sorted = take((n + 1) * sizeof *sorted);
	if (n) memcpy(sorted, rs, n * sizeof *sorted);
	if (n) qsort(sorted, n, sizeof *sorted, by_key);
	fputc('{', out);
	for (size_t i = 0; i < n; i++) {
		if (i) fputc(',', out);
		quote(sorted[i].key);
		fputc(':', out);
		hex(sorted[i].data, sorted[i].length);
	}
	say("}");
}

// --- differences ---

static Json *home_json(const Home *h) {
	Json *a = jsonArray();
	jsonPush(a, jsonString(h->holder)), jsonPush(a, jsonString(h->name)), jsonPush(a, jsonInteger(h->position));
	return a;
}

static Json *info_json(Info info) {
	Json *a = jsonArray();
	for (int i = 0; i < info.count; i++) {
		Json *t = jsonArray();
		jsonPush(t, jsonString(info.items[i].name)), jsonPush(t, jsonString(info.items[i].hash)), jsonPush(t, jsonString(info.items[i].form));
		jsonPush(a, t);
	}
	return a;
}

// what the layout puts at a path, as types.ts's Laid
static Json *laid_json(const Laid *l) {
	Json *o = jsonObject();
	static const char *const kinds[] = {"file", "side", "folder", "union", "link"};
	jsonAdd(o, "kind", jsonString(kinds[l->kind]));
	if (l->kind == LAID_UNION) {
		jsonAdd(o, "holder", jsonString(l->holder)), jsonAdd(o, "name", jsonString(l->name));
		return o;
	}
	jsonAdd(o, "id", jsonString(l->id));
	if (l->home) jsonAdd(o, "home", home_json(l->home));
	if (l->kind == LAID_SIDE) jsonAdd(o, "side", jsonInteger(l->side));
	if (l->kind == LAID_FILE || l->kind == LAID_SIDE) jsonAdd(o, "form", jsonString(l->form)), jsonAdd(o, "hash", jsonString(l->hash));
	if (l->kind == LAID_FILE || l->kind == LAID_FOLDER) jsonAdd(o, "info", info_json(l->info));
	if (l->kind == LAID_LINK) jsonAdd(o, "target", jsonString(l->target)), jsonAdd(o, "half", jsonString(l->half));
	return o;
}

// what is found, an Entry less its ino and its value, its why as true. The value is the store's, so it is printed after,
// by print_entry, and never part of what is freed
static Json *entry_json(const st_entry *e) {
	Json *o = jsonObject();
	static const char *const kinds[] = {"file", "folder", "link"};
	jsonAdd(o, "kind", jsonString(kinds[e->kind]));
	if (e->id) jsonAdd(o, "id", jsonString(e->id));
	if (e->kind == ST_FILE) {
		jsonAdd(o, "form", jsonString(e->form));
		if (e->hash && e->hash[0]) jsonAdd(o, "hash", jsonString(e->hash));
		if (e->why) jsonAdd(o, "why", jsonBoolean(true));
	} else if (e->kind == ST_FOLDER) {
		if (e->holder) {
			Json *a = jsonArray();
			jsonPush(a, jsonString(e->holder)), jsonPush(a, jsonString(e->name));
			jsonAdd(o, "slot", a);
		}
	} else jsonAdd(o, "target", jsonString(e->target));
	return o;
}

// an entry in its JSON form: entry_json's, then the value (the store's own) in the same object
static void print_entry(const st_entry *e) {
	Json *o = entry_json(e);
	char *s = jsonPrint(o);
	size_t n = strlen(s);
	if (e->kind == ST_FILE && e->value) {
		s[n - 1] = 0;
		fputs(s, out);
		fputs(",\"value\":", out);
		value(e->value);
		fputc('}', out);
	} else fputs(s, out);
	free(s);
	jsonFree(o);
}

static int by_path(const void *a, const void *b) {
	return names_bycodepoint(((const st_difference *)a)->path, ((const st_difference *)b)->path);
}

static void differences_op(const Json *request) {
	const Json *touched = jsonGet(request, "touched");
	const char **paths = NULL;
	size_t n = 0;
	if (jsonIsArray(touched)) {
		n = (size_t)touched->array.count;
		paths = take((n + 1) * sizeof *paths);
		for (size_t i = 0; i < n; i++) paths[i] = jsonText(touched->array.items[i]);
	}
	const st_difference *d;
	size_t length;
	if (refused(st_differences(it(), paths, n, &d, &length))) return;
	st_difference *sorted = take((length + 1) * sizeof *sorted);
	if (length) memcpy(sorted, d, length * sizeof *sorted);
	if (length) qsort(sorted, length, sizeof *sorted, by_path);
	fputc('[', out);
	for (size_t i = 0; i < length; i++) {
		if (i) fputc(',', out);
		fputs("{\"path\":", out);
		quote(sorted[i].path);
		if (sorted[i].was) {
			Json *was = laid_json(sorted[i].was);
			fputs(",\"was\":", out);
			value(was);
			jsonFree(was);
		}
		if (sorted[i].now) fputs(",\"now\":", out), print_entry(sorted[i].now);
		fputc('}', out);
	}
	say("]");
}

static void mend_op(const Json *request) {
	const Json *given_paths = jsonGet(request, "paths");
	const char **paths = NULL;
	size_t n = 0;
	if (jsonIsArray(given_paths)) {
		n = (size_t)given_paths->array.count;
		paths = take((n + 1) * sizeof *paths);
		for (size_t i = 0; i < n; i++) paths[i] = jsonText(given_paths->array.items[i]);
	}
	if (!refused(st_mend(it(), paths, n))) say("{}");
}

static void trash_op(const Json *request) {
	const char *why = text_of(request, "why");
	given = realloc(given, (given_length + 1) * sizeof *given);
	if (!given) abort();
	given[given_length++] = strdup(why);
	if (!refused(st_trash(it(), text_of(request, "path"), why))) say("{}");
}

static void listed_op(void) {
	fputc('[', out);
	for (size_t i = 0; i < listed_length; i++) {
		if (i) fputc(',', out);
		fputs("{\"path\":", out);
		quote(listed[i].path);
		fputs(",\"why\":", out);
		quote(listed[i].why);
		fputc('}', out);
		free(listed[i].path);
	}
	say("]");
	listed_length = 0;
}

// --- the line ---

static char *buffer;
static size_t buffer_length;

static void begin(void) {
	errored = false;
	out = open_memstream(&buffer, &buffer_length);
	if (!out) fail("out of memory");
}

// the answer written since begin, parsed; an answer that is not an error wrapped as {wrap: answer}
static Json *end(const char *wrap) {
	fclose(out);
	out = NULL;
	char *why = NULL;
	Json *a = jsonParse(buffer, buffer_length, &why);
	free(buffer);
	if (!a) fprintf(stderr, "bad answer: %s\n", why), exit(1);
	// the "/" forms read back as the values they stand for, so that printing writes them again as they were
	Json *decoded_answer = a;
	if (jsonDecode(&decoded_answer)) a = decoded_answer;
	if (!wrap || errored) return a;
	Json *o = jsonObject();
	jsonAdd(o, wrap, a);
	return o;
}

static Json *failure(const char *message) {
	Json *o = jsonObject();
	jsonAdd(o, "error", jsonString("other"));
	jsonAdd(o, "message", jsonString(message));
	return o;
}

static Json *listed_json(void) {
	begin();
	listed_op();
	return end(NULL);
}

static Json *run(Json *request) {
	const char *op = text_of(request, "op");
	// the store takes no lock: nothing runs at once
	if (strcmp(op, "lock") == 0) return run(jsonGet(request, "run"));
	if (strcmp(op, "edit") == 0) {
		char why[512];
		if (disk_edit(disk, request, folder, why, sizeof why) != 0) return failure(why);
		return jsonObject();
	}
	if (strcmp(op, "observe") == 0) {
		const Json *shown = jsonGet(request, "folder");
		char *where = jsonIsString(shown) ? disk_path(disk, jsonText(shown), disk->store) : copyString(folder);
		Json *listed_now = listed_json();
		disk_deep(disk, listed_now);
		char why[512];
		Json *snapshot = disk_store_snapshot(disk, where, listed_now, request, why, sizeof why);
		free(where);
		return snapshot ? snapshot : failure(why);
	}
	const char *wrap = NULL;
	begin();
	if (strcmp(op, "open") == 0) open_op(request);
	else if (strcmp(op, "read") == 0) read_op(request), wrap = is_mirror ? NULL : "restored";
	else if (strcmp(op, "stores") == 0) stores_op(), wrap = "stores";
	else if (strcmp(op, "find") == 0) find_op(request), wrap = "path";
	else if (strcmp(op, "write") == 0) write_op(request);
	else if (strcmp(op, "graph") == 0) graph_op();
	else if (strcmp(op, "others") == 0) others_op(), wrap = "others";
	else if (strcmp(op, "differences") == 0) differences_op(request), wrap = "differences";
	else if (strcmp(op, "mend") == 0) mend_op(request);
	else if (strcmp(op, "trash") == 0) trash_op(request);
	else if (strcmp(op, "listed") == 0) listed_op(), wrap = "listed";
	else {
		errored = true;
		fputs("{\"error\":\"other\",\"message\":", out);
		char *message = formatString("unknown op %s", op);
		quote(message);
		free(message);
		say("}");
	}
	return end(wrap);
}

static void answer(Json *request) {
	Json *a = run(request);
	disk_deep(disk, a);
	char *s = jsonPrint(a);
	puts(s);
	free(s);
	jsonFree(a);
}

static void cleanup(void) {
	disk_free(disk);
	disk = NULL;
}

int main(void) {
	disk = disk_make("ermine-store-conf-", DISK_UUIDS);
	if (!disk) fail("no temp folder");
	atexit(cleanup);
	folder = copyString(disk->store);
	char *line = NULL;
	size_t capacity = 0;
	while (getline(&line, &capacity, stdin) != -1) {
		if (strspn(line, " \t\r\n") == strlen(line)) continue;
		char *why = NULL;
		Json *request = jsonParse(line, strlen(line), &why);
		if (request == NULL) fprintf(stderr, "bad request: %s\n", why), exit(1);
		answer(request);
		fflush(stdout);
		jsonFree(request);
		clear();
		if (store) st_release(store);
	}
	free(line);
	st_close(store);
	for (size_t i = 0; i < given_length; i++) free(given[i]);
	free(given);
	free(trash_dir);
	free(home);
	free(folder);
	for (size_t i = 0; i < listed_length; i++) free(listed[i].path);
	free(listed);
	finish();
	cleanup();
	return 0;
}
