// The C manifest on the line protocol (playground/tools/files/typescript/manifest_harness.ts, whose header
// has it): one JSON request per line in, one answer per line out. An open given no dir is on
// <temp>/.ermine, <temp> a folder of the harness's own made at the first such open and removed at
// the end. Values are in their JSON form
// (ENCODING.tex: "/" for bytes and typed arrays); bytes and hashes are hex. A node is shown as the
// pack harness shows it, its contents Json values; a "live" path in a save request makes the
// value there one with no encoding (a string with a lone surrogate, which has none).
#ifdef __linux__
#define _GNU_SOURCE
#endif

#include "../../../../ermine/encoding/c/cbor.h"
#include "../../../../ermine/encoding/c/json.h"
#include "../../../../ermine/encoding/c/json_text.h"
#include "saved_shown_harness.h"
#include "manifest.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <ftw.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

// --- reading requests ---

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
	putchar('"');
	for (size_t i = 0; i < n; i++) printf("%02x", bytes[i]);
	putchar('"');
}

static void value(const Json *x) {
	char *s = jsonPrint(x);
	fputs(s, stdout);
	free(s);
}

// --- nodes, as the pack harness shows them, with Json contents ---

// every value of a node in its form, in place
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
	decoded(h, "actor");
	decoded(h, "cause");
}

// a path into the node: the value there becomes one with no encoding
static void live(Json *n, const Json *path) {
	Json *at = n;
	Json **s = NULL;
	for (int i = 0; i < path->array.count; i++) {
		s = slot(at, path->array.items[i]);
		if (!s) fail("a live path that goes nowhere");
		at = *s;
	}
	jsonFree(*s);
	*s = jsonString("\xED\xA0\x80");
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
	putchar('[');
	for (size_t i = 0; i < o.length; i++) {
		const sd_version *v = &o.versions[i];
		if (i) putchar(',');
		fputs("{\"content\":", stdout);
		if (lists) {
			const sd_list *l = v->content;
			putchar('[');
			for (size_t j = 0; j < l->length; j++) {
				if (j) putchar(',');
				if (l->items[j].id) text(l->items[j].id);
				else fputs("{\"symbol\":", stdout), text(l->items[j].symbol), putchar('}');
			}
			putchar(']');
		} else value(v->content);
		if (v->change) fputs(",\"change\":", stdout), value(v->change);
		if (v->because) fputs(",\"because\":", stdout), value(v->because);
		putchar('}');
	}
	putchar(']');
}

static void show_entries(const sd_entry *es, size_t n, int lists) {
	putchar('[');
	for (size_t i = 0; i < n; i++) {
		if (i) putchar(',');
		putchar('[');
		text(es[i].name);
		putchar(',');
		show_versions(es[i].object, lists);
		putchar(']');
	}
	putchar(']');
}

static void show(const sd_node *n) {
	const sd_header *h = &n->header;
	const char *comma = "";
	fputs("{\"id\":", stdout);
	text(n->id);
	fputs(",\"value\":", stdout);
	show_versions(n->value, 0);
	fputs(",\"info\":", stdout);
	show_entries(n->info, n->info_length, 0);
	fputs(",\"children\":", stdout);
	show_entries(n->children, n->children_length, 1);
	fputs(",\"header\":{", stdout);
	if (h->has_time) printf("\"time\":%lld", (long long)h->time), comma = ",";
	if (h->actor) printf("%s\"actor\":", comma), value(h->actor), comma = ",";
	if (h->reader) printf("%s\"reader\":", comma), text(h->reader), comma = ",";
	if (h->has_site) {
		printf("%s\"site\":{\"file\":", comma);
		text(h->site.file);
		printf(",\"line\":%ld", h->site.line);
		if (h->site.has_column) printf(",\"column\":%ld", h->site.column);
		if (h->site.function) fputs(",\"function\":", stdout), text(h->site.function);
		putchar('}');
		comma = ",";
	}
	if (h->cause) printf("%s\"cause\":", comma), value(h->cause);
	fputs("}}", stdout);
}

// --- answers ---

// an error answer; false when the code is none
static bool refused(mf_code c) {
	if (c == MF_OK) return false;
	if (c == MF_STORE) puts("{\"code\":\"store\"}");
	else if (c == MF_FORM) puts("{\"code\":\"form\"}");
	else if (c == MF_WRONG) puts("{\"code\":\"wrong-form\"}");
	else printf("{\"error\":\"io: %s\"}\n", strerror(errno));
	return true;
}

static void kept(const mf_kept *k) {
	printf("[\"%s\",\"%s\"]", k->hash, k->form);
}

static void shape(const mf_node *s) {
	fputs("{\"kept\":", stdout);
	kept(&s->kept);
	if (s->kept.has_head) fputs(",\"head\":", stdout), hex(s->kept.head, s->kept.head_length);
	fputs(",\"sides\":[", stdout);
	for (size_t i = 0; i < s->sides_length; i++) {
		const mf_kept *k = &s->sides[i];
		printf("%s[\"%s\",\"%s\"", i ? "," : "", k->hash, k->form);
		if (k->has_head) putchar(','), hex(k->head, k->head_length);
		putchar(']');
	}
	fputs("],\"info\":[", stdout);
	for (size_t i = 0; i < s->info_length; i++) {
		if (i) putchar(',');
		putchar('[');
		text(s->info[i].name);
		printf(",\"%s\",\"%s\"]", s->info[i].hash, s->info[i].form);
	}
	fputs("],\"directory\":[", stdout);
	for (size_t i = 0; i < s->directory_length; i++) {
		if (i) putchar(',');
		putchar('[');
		text(s->directory[i].name);
		fputs(",[", stdout);
		for (size_t j = 0; j < s->directory[i].length; j++) {
			if (j) putchar(',');
			text(s->directory[i].ids[j]);
		}
		fputs("]]", stdout);
	}
	fputs("]}", stdout);
}

// a request's skip: the ids it lists
static bool skipping(void *context, const char *id) {
	const Json *ids = context;
	for (int i = 0; ids && i < ids->array.count; i++)
		if (strcmp(jsonText(ids->array.items[i]), id) == 0) return true;
	return false;
}

// what the manifest's codec decoded for an object's versions (each new, the caller's: saved_pack.h): lists are the pack's own
static void free_decoded(const sd_object *o, bool lists) {
	for (size_t i = 0; i < o->length; i++) {
		if (!lists) jsonFree((Json *)o->versions[i].content);
		jsonFree((Json *)o->versions[i].change);
		jsonFree((Json *)o->versions[i].because);
	}
}

// a restored graph, every value decoded into its nodes
static void free_restored(sp_graph *g) {
	for (size_t k = 0; k < g->length; k++) {
		const sd_node *n = g->nodes[k];
		free_decoded(&n->value, false);
		for (size_t e = 0; e < n->info_length; e++) free_decoded(&n->info[e].object, false);
		for (size_t e = 0; e < n->children_length; e++) free_decoded(&n->children[e].object, true);
		jsonFree((Json *)n->header.actor);
		jsonFree((Json *)n->header.cause);
	}
	sp_free(g);
}

static void save_op(Json *request) {
	Json *n = jsonGet(request, "node");
	decode_node(n);
	const Json *lives = jsonGet(request, "live");
	for (int i = 0; lives && i < lives->array.count; i++) live(n, lives->array.items[i]);
	sd_node *made = node_of(n);
	mf_saving s;
	mf_code c = mf_save(made, skipping, jsonGet(request, "without"), &s);
	if (!refused(c)) {
		fputs("{\"record\":", stdout);
		hex(s.record.data, s.record.length);
		fputs(",\"values\":[", stdout);
		for (size_t i = 0; i < s.values_length; i++) {
			printf("%s[\"%s\",", i ? "," : "", s.values[i].hash);
			value(s.values[i].value);
			putchar(']');
		}
		fputs("],\"shape\":", stdout);
		shape(&s.shape);
		puts("}");
		mf_saving_free(&s);
	}
	sd_free(made);
}

static const Json *values_in;

static const Json *lookup(void *context, const char *hash) {
	(void)context;
	for (int i = 0; i < values_in->array.count; i++) {
		const Json *pair = values_in->array.items[i];
		if (strcmp(jsonText(pair->array.items[0]), hash) == 0) return pair->array.items[1];
	}
	return NULL;
}

static bool headed(void *context, const char *hash, const uint8_t **head, size_t *length) {
	(void)context;
	for (int i = 0; i < values_in->array.count; i++) {
		const Json *pair = values_in->array.items[i];
		if (strcmp(jsonText(pair->array.items[0]), hash) != 0) continue;
		size_t n;
		*head = unhex(jsonText(pair->array.items[1]), &n);
		*length = n;
		return true;
	}
	return false;
}

static mf_codec codec_of(const Json *request) {
	const char *name = text_of(request, "codec");
	return strcmp(name, "meta") == 0 ? MF_META : strcmp(name, "shown") == 0 ? MF_SHOWN : strcmp(name, "plan") == 0 ? MF_PLAN : MF_STATE;
}

static mf_record *records_of(const Json *list, size_t *n) {
	*n = (size_t)list->array.count;
	mf_record *rs = take(*n * sizeof *rs);
	for (size_t i = 0; i < *n; i++) {
		const Json *pair = list->array.items[i], *data = pair->array.items[1];
		rs[i].key = jsonText(pair->array.items[0]);
		if (data->type == JSON_NULL) rs[i].data = NULL, rs[i].length = 0;
		else rs[i].data = unhex(jsonText(data), &rs[i].length);
	}
	return rs;
}

// --- the folder ---

static char *dir;
// the run's own temp folder, made at the first open given no dir
static char *temp;

static int unlinked(const char *path, const struct stat *st, int flag, struct FTW *ftw) {
	(void)st, (void)flag, (void)ftw;
	return remove(path);
}
static mf_manifest *man;
static char **synced;
static size_t synced_length;

// the paths sync was given, from dir, and none after
static int record(void *context, const char *path) {
	(void)context;
	const char *from = strcmp(path, dir) == 0 ? "." : path + strlen(dir) + 1;
	synced = realloc(synced, (synced_length + 1) * sizeof *synced);
	synced[synced_length++] = strdup(from);
	return 0;
}

static void took(int print) {
	if (print) {
		putchar('[');
		for (size_t i = 0; i < synced_length; i++) {
			if (i) putchar(',');
			text(synced[i]);
		}
		putchar(']');
	}
	for (size_t i = 0; i < synced_length; i++) free(synced[i]);
	synced_length = 0;
}

static int by_key(const void *a, const void *b) {
	return textCompare(((const mf_record *)a)->key, ((const mf_record *)b)->key);
}

static int by_path(const void *a, const void *b) {
	return strcmp(*(char *const *)a, *(char *const *)b);
}

typedef struct {
	char **folders, **files;
	size_t nfolders, nfiles;
} tree;

static void walk(const char *at, const char *rel, tree *t) {
	DIR *d = opendir(at);
	if (!d) fail("no folder to walk");
	for (struct dirent *e; (e = readdir(d));) {
		if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
		char *p = take(strlen(rel) + strlen(e->d_name) + 2), *full = take(strlen(at) + strlen(e->d_name) + 2);
		snprintf(p, strlen(rel) + strlen(e->d_name) + 2, "%s%s%s", rel, *rel ? "/" : "", e->d_name);
		snprintf(full, strlen(at) + strlen(e->d_name) + 2, "%s/%s", at, e->d_name);
		struct stat st;
		if (lstat(full, &st) == -1) fail("no entry to walk");
		if (S_ISDIR(st.st_mode)) {
			t->folders = realloc(t->folders, (t->nfolders + 1) * sizeof *t->folders);
			t->folders[t->nfolders++] = p;
			walk(full, p, t);
		} else {
			t->files = realloc(t->files, (t->nfiles + 1) * sizeof *t->files);
			t->files[t->nfiles++] = p;
		}
	}
	closedir(d);
}

static void files_op(void) {
	tree t = {0};
	walk(dir, "", &t);
	qsort(t.folders, t.nfolders, sizeof *t.folders, by_path);
	qsort(t.files, t.nfiles, sizeof *t.files, by_path);
	fputs("{\"folders\":[", stdout);
	for (size_t i = 0; i < t.nfolders; i++) {
		if (i) putchar(',');
		text(t.folders[i]);
	}
	fputs("],\"files\":[", stdout);
	for (size_t i = 0; i < t.nfiles; i++) {
		char *full = take(strlen(dir) + strlen(t.files[i]) + 2);
		snprintf(full, strlen(dir) + strlen(t.files[i]) + 2, "%s/%s", dir, t.files[i]);
		FILE *f = fopen(full, "rb");
		if (!f) fail("no file to read");
		printf("%s[", i ? "," : "");
		text(t.files[i]);
		putchar(',');
		putchar('"');
		int c;
		while ((c = fgetc(f)) != EOF) printf("%02x", c);
		fclose(f);
		fputs("\"]", stdout);
	}
	puts("]}");
	free(t.folders), free(t.files);
}

static void write_op(const Json *request) {
	char *path = take(strlen(dir) + strlen(text_of(request, "path")) + 2);
	snprintf(path, strlen(dir) + strlen(text_of(request, "path")) + 2, "%s/%s", dir, text_of(request, "path"));
	// its folders made
	for (char *p = path + 1; *p; p++) {
		if (*p != '/') continue;
		*p = 0;
		if (mkdir(path, 0777) == -1 && errno != EEXIST) fail("no folder made");
		*p = '/';
	}
	size_t n;
	uint8_t *bytes = unhex(text_of(request, "bytes"), &n);
	const Json *append = jsonGet(request, "append");
	FILE *f = fopen(path, append && append->type == JSON_BOOLEAN && append->boolean ? "ab" : "wb");
	if (!f || fwrite(bytes, 1, n, f) != n) fail("no file written");
	fclose(f);
	puts("{}");
}

static void folder(const char *op, Json *request) {
	if (strcmp(op, "open") == 0) {
		mf_close(man);
		free(dir);
		if (jsonGet(request, "dir")) dir = strdup(text_of(request, "dir"));
		else {
			if (!temp) {
				const char *t = getenv("TMPDIR");
				char *pattern = formatString("%s/ermine-manifest-XXXXXX", t && *t ? t : "/tmp");
				if (!mkdtemp(pattern)) fail("no temp folder made");
				temp = realpath(pattern, NULL);
				free(pattern);
				if (!temp) fail("no temp folder made");
			}
			dir = formatString("%s/.ermine", temp);
		}
		const Json *slack = jsonGet(request, "slack");
		man = mf_open(dir, record, NULL, slack ? (size_t)slack->number : MF_SLACK);
		took(0);
		puts("{}");
		return;
	}
	if (!man) fail("no manifest open");
	if (strcmp(op, "write") == 0) {
		write_op(request);
		return;
	}
	if (strcmp(op, "files") == 0) {
		files_op();
		return;
	}
	mf_code c = MF_OK;
	if (strcmp(op, "make") == 0) {
		if (!refused(c = mf_make(man))) puts("{}");
	} else if (strcmp(op, "exists") == 0) {
		bool exists;
		if (!refused(c = mf_exists(man, &exists))) printf("{\"exists\":%s}\n", exists ? "true" : "false");
	} else if (strcmp(op, "read") == 0) {
		mf_record *rs;
		size_t n;
		if (!refused(c = mf_read(man, &rs, &n))) {
			qsort(rs, n, sizeof *rs, by_key);
			fputs("{\"records\":[", stdout);
			for (size_t i = 0; i < n; i++) {
				printf("%s[", i ? "," : "");
				text(rs[i].key);
				putchar(',');
				hex(rs[i].data, rs[i].length);
				putchar(']');
			}
			puts("]}");
			mf_records_free(rs, n);
		}
	} else if (strcmp(op, "append") == 0 || strcmp(op, "fold") == 0) {
		took(0);
		size_t n;
		int appending = strcmp(op, "append") == 0;
		mf_record *rs = records_of(jsonGet(request, appending ? "frame" : "records"), &n);
		c = appending ? mf_append(man, rs, n) : mf_fold(man, rs, n);
		if (!refused(c)) fputs("{\"synced\":", stdout), took(1), puts("}");
	} else if (strcmp(op, "grown") == 0) {
		printf("{\"grown\":%s}\n", mf_grown(man) ? "true" : "false");
	} else if (strcmp(op, "put") == 0) {
		took(0);
		mf_kept k;
		const char *given = jsonText(jsonGet(request, "hash"));
		if (!refused(c = mf_put(man, decoded(request, "value"), given, &k))) {
			fputs("{\"kept\":", stdout), kept(&k), fputs(",\"synced\":", stdout), took(1), puts("}");
		}
	} else if (strcmp(op, "get") == 0) {
		Json *v;
		if (!refused(c = mf_get(man, text_of(request, "hash"), text_of(request, "form"), &v))) {
			fputs("{\"value\":", stdout), value(v), puts("}");
			jsonFree(v);
		}
	}
	if (c != MF_OK) took(0);
}

// --- the line ---

static void answer(Json *request, const char *op) {
	if (strcmp(op, "form") == 0) {
		printf("{\"form\":\"%s\"}\n", mf_form(decoded(request, "value")));
	} else if (strcmp(op, "render") == 0) {
		sp_bytes b = {0};
		if (!refused(mf_render(decoded(request, "value"), text_of(request, "form"), &b))) {
			fputs("{\"bytes\":", stdout), hex(b.data, b.length), puts("}");
		}
		free(b.data);
	} else if (strcmp(op, "parse") == 0) {
		size_t n;
		uint8_t *bytes = unhex(text_of(request, "bytes"), &n);
		Json *v;
		if (!refused(mf_parse(bytes, n, text_of(request, "form"), &v))) {
			fputs("{\"value\":", stdout), value(v), puts("}");
			jsonFree(v);
		}
	} else if (strcmp(op, "hash") == 0) {
		char h[65];
		if (!mf_hash(decoded(request, "value"), h)) puts("{\"error\":\"no encoding\"}");
		else printf("{\"hash\":\"%s\"}\n", h);
	} else if (strcmp(op, "digest") == 0) {
		size_t n;
		uint8_t *bytes = unhex(text_of(request, "bytes"), &n);
		char h[65];
		mf_digest(bytes, n, h);
		printf("{\"hash\":\"%s\"}\n", h);
	} else if (strcmp(op, "null") == 0) {
		char h[65];
		mf_null(h);
		printf("{\"hash\":\"%s\"}\n", h);
	} else if (strcmp(op, "kept") == 0) {
		mf_kept k;
		if (!mf_keptof(decoded(request, "value"), &k)) puts("{\"error\":\"no encoding\"}");
		else fputs("{\"kept\":", stdout), kept(&k), puts("}");
	} else if (strcmp(op, "save") == 0) {
		save_op(request);
	} else if (strcmp(op, "kepts") == 0) {
		size_t n;
		uint8_t *bytes = unhex(text_of(request, "record"), &n);
		mf_kept *ks;
		size_t count;
		if (!refused(mf_kepts(bytes, n, &ks, &count))) {
			fputs("{\"kepts\":[", stdout);
			for (size_t i = 0; i < count; i++) {
				if (i) putchar(',');
				kept(&ks[i]);
			}
			puts("]}");
			free(ks);
		}
	} else if (strcmp(op, "restore") == 0) {
		size_t n;
		uint8_t *bytes = unhex(text_of(request, "record"), &n);
		Json *given = jsonGet(request, "values");
		for (int i = 0; i < given->array.count; i++)
			if (!jsonDecode(&given->array.items[i]->array.items[1])) fail("a value not in its form");
		values_in = given;
		sp_graph g;
		if (!refused(mf_restore(bytes, n, lookup, NULL, &g))) {
			fputs("{\"node\":", stdout), show(g.nodes[0]), puts("}");
			free_restored(&g);
		}
	} else if (strcmp(op, "shape") == 0) {
		size_t n;
		uint8_t *bytes = unhex(text_of(request, "record"), &n);
		values_in = jsonGet(request, "heads");
		mf_node s;
		if (!refused(mf_shape(bytes, n, headed, NULL, &s))) {
			fputs("{\"shape\":", stdout), shape(&s), puts("}");
			mf_shape_free(&s);
		}
	} else if (strcmp(op, "encode") == 0) {
		sp_bytes b = {0};
		if (!refused(mf_encode(codec_of(request), jsonGet(request, "record"), &b))) {
			fputs("{\"bytes\":", stdout), hex(b.data, b.length), puts("}");
		}
		free(b.data);
	} else if (strcmp(op, "decode") == 0) {
		size_t n;
		uint8_t *bytes = unhex(text_of(request, "bytes"), &n);
		Json *r;
		if (!refused(mf_decode(codec_of(request), bytes, n, &r))) {
			fputs("{\"record\":", stdout), value(r), puts("}");
			jsonFree(r);
		}
	} else if (strcmp(op, "named") == 0) {
		size_t n, count;
		mf_record *rs = records_of(jsonGet(request, "records"), &n);
		mf_hex *hashes;
		if (!refused(mf_named(rs, n, &hashes, &count))) {
			fputs("{\"hashes\":[", stdout);
			for (size_t i = 0; i < count; i++) printf("%s\"%s\"", i ? "," : "", hashes[i]);
			puts("]}");
			free(hashes);
		}
	} else if (strcmp(op, "open") == 0 || strcmp(op, "make") == 0 || strcmp(op, "exists") == 0 || strcmp(op, "read") == 0 || strcmp(op, "append") == 0 || strcmp(op, "grown") == 0 || strcmp(op, "fold") == 0 || strcmp(op, "put") == 0 || strcmp(op, "get") == 0 || strcmp(op, "write") == 0 || strcmp(op, "files") == 0) {
		folder(op, request);
	} else printf("{\"error\":\"unknown op %s\"}\n", op);
}

int main(void) {
	char *line = NULL;
	size_t capacity = 0;
	while (getline(&line, &capacity, stdin) != -1) {
		if (strspn(line, " \t\r\n") == strlen(line)) continue;
		char *why = NULL;
		Json *request = jsonParse(line, strlen(line), &why);
		if (request == NULL) fprintf(stderr, "bad request: %s\n", why), exit(1);
		answer(request, text_of(request, "op"));
		jsonFree(request);
		clear();
	}
	fflush(stdout);
	free(line);
	mf_close(man);
	free(dir);
	free(synced);
	if (temp) nftw(temp, unlinked, 16, FTW_DEPTH | FTW_PHYS), free(temp);
	finish();
	return 0;
}
