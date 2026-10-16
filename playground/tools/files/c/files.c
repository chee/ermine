// files: a command-line tool over the C store (store.h): a shared document laid out in a folder and kept in step both ways
// (host.h, synced by extensions/sync), or a store on a real folder tried from a terminal, with no sync and no TypeScript.
//
//   files new <folder> [--server wss://…] [--home DIR]
//                                             a new document laid out in the folder; prints its ermine:// id
//   files ermine://… <folder> [--server wss://…] [--home DIR] [--named]
//                                             the document laid out in the folder, kept in step both ways, till C-c;
//                                             --named: every node an ermine:// id inside a value names laid out too
//
// Those two run until SIGINT; the device is home/.ermine/device (home: --home, or HOME); the server
// is wss://galaxy.observer unless --server gives another ("" for none). The rest are one-shot: each opens the store, reads
// it, does its one thing, writes if it changed the graph, and exits; the time of a write is the last time + 1. Changes are
// made by actor "files", each of the node it changes.
//
//   files init <folder>                       a new store in the folder (empty, or not there yet); prints the root's id
//   files put <folder> <path> [value]         the node at the slot path (slots from the root, joined by /) gets the value;
//                                             nodes missing on the way are made with no value. value: text, or
//                                             --file F (F's bytes: text if they are UTF-8, else bytes), or --diag 'TEXT'
//   files rm <folder> <path>                  takes the node out of its slot (the node stays in the store)
//   files mv <folder> <from> <to>             moves a node from one slot to another
//   files ls <folder>                         the graph from the root as a tree (alias: tree)
//   files diff <folder>                       where the folder differs from the layout: edits made in Finder, say
//   files mend <folder> [path...]             lays those paths (every one that differs) out again as the graph has them,
//                                             sending what is there to the Trash
//
// Entries the store leaves out or sends to the Trash are told on stderr as "path: why". Errors: one line on stderr, exit 1;
// a command used wrong: the usage text, exit 2. FILES_HOME names a home folder to use in place of yours (its Trash, its list
// of stores): to try the tool without touching your own.
#include "../../../ermine/encoding/c/json.h"
#include "saved.h"
#include "diag.h"
#include "host.h"
#include "store.h"

#include <errno.h>
#include <limits.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static const char USAGE[] =
	"usage: files <command> <folder> ...\n"
	"  new <folder> [--server URL] [--home DIR]\n"
	"                                   a new shared document laid out in the folder; prints its id\n"
	"  ermine://... <folder> [--server URL] [--home DIR] [--named]\n"
	"                                   the document laid out in the folder, kept in step, till C-c;\n"
	"                                   --named: and every node an ermine:// id in a value names\n"
	"  init <folder>                    a new store in the folder; prints the root's id\n"
	"  put <folder> <path> [value]      the node at the slot path (a/b/c) gets the value: text,\n"
	"                                   or --file F (its bytes), or --diag 'TEXT' (diagnostic notation)\n"
	"  rm <folder> <path>               takes the node out of its slot\n"
	"  mv <folder> <from> <to>          moves a node from one slot to another\n"
	"  ls <folder>                      the graph from the root as a tree (alias: tree)\n"
	"  diff <folder>                    where the folder differs from the layout\n"
	"  mend <folder> [path...]          lays those paths (all that differ) out again as the graph has them\n"
	"FILES_HOME: a home folder to use in place of yours (its Trash, its list of stores)\n";

static void die(const char *format, ...) __attribute__((noreturn, format(printf, 1, 2)));
static void die(const char *format, ...) {
	va_list args;
	va_start(args, format);
	fputs("files: ", stderr);
	vfprintf(stderr, format, args);
	fputc('\n', stderr);
	va_end(args);
	exit(1);
}

static void usage(void) __attribute__((noreturn));
static void usage(void) {
	fputs(USAGE, stderr);
	exit(2);
}

static void *grab(size_t size) {
	void *p = calloc(1, size ? size : 1);
	if (!p) die("out of memory");
	return p;
}

static void told(void *context, const char *path, const char *why) {
	(void)context;
	fprintf(stderr, "%s: %s\n", path, why);
}

// what a command made for its graph, let go of all at once at the end: the nodes share their parts
static void **mine_ptrs;
static Json **mine_json;
static sd_node **mine_nodes;
static size_t mine_ptrs_count, mine_ptrs_room, mine_json_count, mine_json_room, mine_nodes_count, mine_nodes_room;

static void *held(void *items, size_t count, size_t *room, size_t size) {
	if (count < *room) return items;
	*room = *room ? *room * 2 : 16;
	items = realloc(items, *room * size);
	if (!items) die("out of memory");
	return items;
}
static void *mine(void *p) {
	mine_ptrs = held(mine_ptrs, mine_ptrs_count, &mine_ptrs_room, sizeof *mine_ptrs);
	return mine_ptrs[mine_ptrs_count++] = p;
}
static Json *mine_value(Json *j) {
	mine_json = held(mine_json, mine_json_count, &mine_json_room, sizeof *mine_json);
	return mine_json[mine_json_count++] = j;
}
static sd_node *mine_node(sd_node *n) {
	if (!n) die("out of memory");
	mine_nodes = held(mine_nodes, mine_nodes_count, &mine_nodes_room, sizeof *mine_nodes);
	return mine_nodes[mine_nodes_count++] = n;
}
static void let_go(void) {
	for (size_t i = 0; i < mine_nodes_count; i++) sd_free(mine_nodes[i]);
	for (size_t i = 0; i < mine_json_count; i++) jsonFree(mine_json[i]);
	for (size_t i = 0; i < mine_ptrs_count; i++) free(mine_ptrs[i]);
	free(mine_nodes), free(mine_json), free(mine_ptrs);
}

// --- the store ---

static st_store *store;
static st_restored restored;
static char *folder;
static const char *rootid; // the root's id
static double now; // the time of this command's changes

// the folder as an absolute path
static char *absolute(const char *given) {
	char *real = realpath(given, NULL);
	if (real) return real;
	if (given[0] == '/') return strdup(given);
	char cwd[PATH_MAX];
	if (!getcwd(cwd, sizeof cwd)) die("cannot find the current folder: %s", strerror(errno));
	size_t room = strlen(cwd) + strlen(given) + 2;
	char *joined = grab(room);
	snprintf(joined, room, "%s/%s", cwd, given);
	return joined;
}

static void check(st_code code) {
	if (code != ST_OK) die("%s", st_message(store));
}

// opens the store in the folder given and reads it; a folder that holds none is an error unless fresh
static void load(const char *given, bool fresh) {
	folder = absolute(given);
	if (!fresh) {
		struct stat st;
		char *manifest = grab(strlen(folder) + 16);
		snprintf(manifest, strlen(folder) + 16, "%s/.ermine", folder);
		if (stat(manifest, &st) == -1 || !S_ISDIR(st.st_mode)) die("%s is not a store", folder);
		free(manifest);
	}
	// a store already there is opened as a host running the files program does: edits made in Finder are kept, to be seen by
	// diff and laid again by mend, not laid again as the store loads. A new store in a folder with others' entries is refused
	st_options options = {.list = told, .home = getenv("FILES_HOME"), .files = !fresh};
	if (options.home && !*options.home) options.home = NULL;
	store = st_open(folder, &options);
	if (!store) die("cannot open %s", folder);
	check(st_read(store, &restored));
	if (fresh && !restored.none) die("%s is a store already", folder);
	if (!fresh && restored.none) die("%s is not a store", folder);
	rootid = restored.root;
	now = restored.none ? 1 : restored.time + 1;
}

// --- the graph, held as nodes in a table; an edit makes a new node and puts it in place of the old ---

static sd_node **table;
static size_t count, capacity;

static void keep(sd_node *node) {
	for (size_t i = 0; i < count; i++)
		if (strcmp(table[i]->id, node->id) == 0) {
			table[i] = node;
			return;
		}
	if (count == capacity) {
		capacity = capacity ? capacity * 2 : 16;
		table = realloc(table, capacity * sizeof *table);
		if (!table) die("out of memory");
	}
	table[count++] = node;
}

static const sd_node *get(void *context, const char *id) {
	(void)context;
	for (size_t i = 0; i < count; i++)
		if (strcmp(table[i]->id, id) == 0) return table[i];
	return NULL;
}

// every node the store gave, reachable or not: they stay in the store
static void fill(void) {
	for (size_t i = 0; i < restored.nodes_length; i++) keep((sd_node *)restored.nodes[i]);
	for (size_t i = 0; i < restored.others_length; i++) keep((sd_node *)restored.others[i]);
}

// the change of node id made now: {time, actor, node}
static Json *change(const char *id) {
	Json *c = mine_value(jsonObject());
	jsonAdd(c, "time", jsonNumber(now));
	jsonAdd(c, "actor", jsonString("files"));
	jsonAdd(c, "node", jsonString(id));
	return c;
}

// a node's id, 16 hex digits
static char *newid(void) {
	char *id = mine(grab(17));
	snprintf(id, 17, "%08x%08x", arc4random(), arc4random());
	return id;
}

// a node made now, with no value and no slots
static const sd_node *born(void) {
	char *id = newid();
	sd_header header = {.has_time = 1, .time = (int64_t)now, .actor = mine_value(jsonString("files"))};
	sd_node *node = mine_node(sd_make(id, NULL, &header, NULL));
	keep(node);
	return node;
}

// the node with its value replaced by a single version of content: its later versions (sides) stay. NULL content: no value
static void setvalue(const sd_node *old, Json *content) {
	size_t length = old->value.length ? old->value.length : 1;
	sd_version *versions = mine(grab(length * sizeof *versions));
	size_t n = 0;
	if (content) versions[n++] = (sd_version){content, change(old->id), NULL};
	for (size_t i = 1; i < old->value.length; i++) versions[n++] = old->value.versions[i];
	sd_contents contents = {.value = {versions, n}, .info = old->info, .info_length = old->info_length, .children = old->children, .children_length = old->children_length};
	sd_node *node = mine_node(sd_make(old->id, &contents, &old->header, NULL));
	keep(node);
}

// the ids in a node's slot, the first version's list; NULL: none there
static const sd_list *slotted(const sd_node *node, const char *name) {
	for (size_t i = 0; i < node->children_length; i++)
		if (strcmp(node->children[i].name, name) == 0 && node->children[i].object.length) return node->children[i].object.versions[0].content;
	return NULL;
}

// the node with its slot name holding ids
static void setslot(const sd_node *old, const char *name, const char *const *ids, size_t n) {
	sd_item *items = mine(grab((n + 1) * sizeof *items));
	for (size_t i = 0; i < n; i++) items[i] = (sd_item){ids[i], NULL};
	sd_list *list = mine(grab(sizeof *list));
	*list = (sd_list){items, n};
	sd_version *version = mine(grab(sizeof *version));
	*version = (sd_version){list, change(old->id), NULL};
	sd_entry *entries = grab((old->children_length + 1) * sizeof *entries);
	size_t m = 0;
	bool done = false;
	for (size_t i = 0; i < old->children_length; i++) {
		entries[m] = old->children[i];
		if (strcmp(old->children[i].name, name) == 0) entries[m].object = (sd_object){version, 1}, done = true;
		m++;
	}
	if (!done) entries[m++] = (sd_entry){name, {version, 1}};
	sd_contents contents = {.value = old->value, .info = old->info, .info_length = old->info_length, .children = entries, .children_length = m};
	// the node keeps a copy of the entries
	sd_node *node = mine_node(sd_make(old->id, &contents, &old->header, NULL));
	free(entries);
	keep(node);
}

// --- paths ---

typedef struct {
	char **names;
	size_t count;
} Path;

static Path split(const char *path) {
	Path p = {mine(grab((strlen(path) / 2 + 2) * sizeof(char *))), 0};
	char *copy = mine(strdup(path));
	for (char *at = copy, *end; *at; at = end) {
		while (*at == '/') at++;
		if (!*at) break;
		end = strchr(at, '/');
		if (end) *end++ = 0;
		else end = at + strlen(at);
		p.names[p.count++] = at;
	}
	if (!p.count) die("%s is no path to a node", path);
	return p;
}

// the id in a slot with one id: NULL if the slot is empty or not there; a union or a pending id is an error
static const char *only(const sd_node *node, const char *name, const char *path) {
	const sd_list *list = slotted(node, name);
	if (!list || !list->length) return NULL;
	if (list->length > 1) die("%s: the slot %s is a union of %zu", path, name, list->length);
	if (!list->items[0].id) die("%s: the slot %s holds a symbol", path, name);
	return list->items[0].id;
}

// walks to the slot the path ends in: *holder is the node whose slot it is, *name the slot; the node there (NULL: none).
// With make: nodes missing on the way are made
static const sd_node *walk(const char *path, bool make, const sd_node **holder, const char **name) {
	Path p = split(path);
	const sd_node *at = get(NULL, rootid);
	if (!at) die("the root %s is not in the store", rootid);
	for (size_t i = 0;; i++) {
		const char *id = only(at, p.names[i], path);
		const sd_node *next = id ? get(NULL, id) : NULL;
		if (id && !next) die("%s: %s is not loaded", path, id);
		if (i + 1 == p.count) {
			*holder = at, *name = p.names[i];
			return next;
		}
		if (!next) {
			if (!make) die("%s: nothing at %s", path, p.names[i]);
			next = born();
			setslot(at, p.names[i], (const char *[]){next->id}, 1);
			at = get(NULL, at->id);
		}
		at = next;
	}
}

// --- values ---

// whether the bytes are UTF-8 text: well formed, no surrogates, no NUL
static bool utf8(const uint8_t *b, size_t n) {
	for (size_t i = 0; i < n;) {
		uint8_t c = b[i];
		size_t more = c < 0x80 ? 0 : c >= 0xc2 && c <= 0xdf ? 1 : c >= 0xe0 && c <= 0xef ? 2 : c >= 0xf0 && c <= 0xf4 ? 3 : (size_t)-1;
		if (c == 0 || more == (size_t)-1 || i + more >= n) return false;
		if (more == 0) {
			i++;
			continue;
		}
		for (size_t k = 1; k <= more; k++)
			if ((b[i + k] & 0xc0) != 0x80) return false;
		if (c == 0xe0 && b[i + 1] < 0xa0) return false;
		if (c == 0xed && b[i + 1] > 0x9f) return false;
		if (c == 0xf0 && b[i + 1] < 0x90) return false;
		if (c == 0xf4 && b[i + 1] > 0x8f) return false;
		i += more + 1;
	}
	return true;
}

static Json *filed(const char *name) {
	FILE *f = fopen(name, "rb");
	if (!f) die("cannot read %s: %s", name, strerror(errno));
	size_t length = 0, room = 4096;
	uint8_t *data = grab(room);
	for (size_t got; (got = fread(data + length, 1, room - length, f)) > 0;) {
		length += got;
		if (length == room) data = realloc(data, room *= 2);
		if (!data) die("out of memory");
	}
	if (ferror(f)) die("cannot read %s: %s", name, strerror(errno));
	fclose(f);
	Json *value = utf8(data, length) ? jsonStringOfLength((char *)data, length) : jsonBytes(data, length);
	free(data);
	return value;
}

static Json *diagnostic(const char *text) {
	diag_error error;
	Json *value = diag_read(text, strlen(text), &error);
	if (!value) die("--diag: %s (line %zu, column %zu)", error.why, error.line, error.column);
	return value;
}

// a node's value as one short line: text quoted and cut, bytes by size, the rest as diagnostic notation, cut
static void cut(const char *s, size_t limit) {
	size_t n = strlen(s), shown = n > limit ? limit : n;
	while (shown < n && shown > 0 && ((unsigned char)s[shown] & 0xc0) == 0x80) shown--;
	fwrite(s, 1, shown, stdout);
	if (shown < n) fputs("...", stdout);
}

static void flat(const char *s, size_t limit) {
	char *one = grab(strlen(s) + 1);
	size_t m = 0;
	for (size_t i = 0; s[i]; i++) {
		if (s[i] == '\n') {
			while (s[i + 1] == ' ') i++;
			if (m && one[m - 1] != '[' && one[m - 1] != '{' && s[i + 1] != ']' && s[i + 1] != '}') one[m++] = ' ';
		} else one[m++] = s[i];
	}
	cut(one, limit);
	free(one);
}

static void show(const Json *v) {
	if (v->type == JSON_STRING) {
		char *quoted = grab(v->stringLength * 2 + 1);
		size_t m = 0;
		for (size_t i = 0; i < v->stringLength; i++) {
			char c = v->string[i];
			if (c == '\n') quoted[m++] = '\\', quoted[m++] = 'n';
			else if (c == '\t') quoted[m++] = '\\', quoted[m++] = 't';
			else if (c == '"' || c == '\\') quoted[m++] = '\\', quoted[m++] = c;
			else quoted[m++] = c;
		}
		putchar('"');
		cut(quoted, 40);
		putchar('"');
		free(quoted);
	} else if (v->type == JSON_BYTES) printf("<%zu bytes>", v->bytes.length);
	else {
		const char *why;
		char *d = diag_write(v, &why);
		if (d) flat(d, 60), free(d);
		else printf("<no notation: %s>", why);
	}
}

// --- the tree ---

static void tree(const sd_node *node, int depth, const char *const *above, int levels) {
	for (size_t i = 0; i < node->children_length; i++) {
		const sd_list *list = slotted(node, node->children[i].name);
		if (!list || !list->length) continue;
		bool union_ = list->length > 1;
		const char *name = node->children[i].name;
		if (union_) printf("%*s%s/  (a union of %zu)\n", depth * 2, "", name, list->length);
		for (size_t j = 0; j < list->length; j++) {
			const char *id = list->items[j].id;
			printf("%*s", (depth + (union_ ? 1 : 0)) * 2, "");
			if (union_) printf("%zu: ", j + 1);
			else printf("%s  ", name);
			if (!id) {
				printf("(symbol %s)\n", list->items[j].symbol);
				continue;
			}
			const sd_node *child = get(NULL, id);
			printf("%s", id);
			if (!child) {
				puts("  (pending)");
				continue;
			}
			if (child->value.length) {
				fputs("  ", stdout);
				show(child->value.versions[0].content);
				if (child->value.length > 1) printf("  (+%zu sides)", child->value.length - 1);
			}
			bool cycle = false;
			for (int k = 0; k < levels; k++)
				if (strcmp(above[k], id) == 0) cycle = true;
			if (cycle) {
				puts("  (above)");
				continue;
			}
			putchar('\n');
			const char **next = grab((size_t)(levels + 1) * sizeof *next);
			memcpy(next, above, (size_t)levels * sizeof *next);
			next[levels] = id;
			tree(child, depth + 1 + (union_ ? 1 : 0), next, levels + 1);
			free(next);
		}
	}
}

// --- commands ---

static void save(void) {
	st_saving saving = {.root = rootid, .time = now, .get = get};
	check(st_write(store, &saving));
}

static void init(const char *given) {
	load(given, true);
	const sd_node *root = born();
	rootid = root->id;
	save();
	printf("%s\n", root->id);
}

static void put(const char *given, const char *path, Json *value) {
	load(given, false);
	fill();
	const sd_node *holder;
	const char *name;
	const sd_node *at = walk(path, true, &holder, &name);
	if (!at) {
		at = born();
		setslot(holder, name, (const char *[]){at->id}, 1);
	}
	if (value) setvalue(at, value);
	save();
}

static void rm(const char *given, const char *path) {
	load(given, false);
	fill();
	const sd_node *holder;
	const char *name;
	const sd_node *at = walk(path, false, &holder, &name);
	if (!at) die("%s: nothing there", path);
	setslot(holder, name, NULL, 0);
	save();
}

static void mv(const char *given, const char *from, const char *to) {
	load(given, false);
	fill();
	const sd_node *holder;
	const char *name;
	const sd_node *at = walk(from, false, &holder, &name);
	if (!at) die("%s: nothing there", from);
	const char *id = at->id;
	const sd_node *target_holder;
	const char *target_name;
	// nothing is written till the end, so a refusal changes nothing
	setslot(holder, name, NULL, 0);
	const sd_node *taken = walk(to, true, &target_holder, &target_name);
	if (taken) die("%s: the slot is taken", to);
	setslot(target_holder, target_name, (const char *[]){id}, 1);
	save();
}

static void ls(const char *given) {
	load(given, false);
	fill();
	const sd_node *root = get(NULL, rootid);
	printf("%s", root->id);
	if (root->value.length) fputs("  ", stdout), show(root->value.versions[0].content);
	putchar('\n');
	tree(root, 1, (const char *[]){root->id}, 1);
}

static void was(const Laid *l) {
	static const char *const kinds[] = {"file", "side", "folder", "union", "link"};
	printf("%s", kinds[l->kind]);
	if (l->kind == LAID_UNION) printf(" %s/%s", l->holder, l->name);
	else printf(" %s", l->id);
	if (l->kind == LAID_FILE || l->kind == LAID_SIDE) printf(" (%s %.8s)", l->form, l->hash);
	if (l->kind == LAID_SIDE) printf(" side %d", l->side);
	if (l->kind == LAID_LINK) printf(" -> %s", l->target);
}

static void is(const st_entry *e) {
	if (e->kind == ST_FILE) {
		printf("file");
		if (e->id) printf(" %s", e->id);
		if (e->why) fputs(" (unreadable)", stdout);
		else if (e->form) printf(" (%s %.8s)", e->form, e->hash && e->hash[0] ? e->hash : "-");
		if (e->value) fputs(" ", stdout), show(e->value);
	} else if (e->kind == ST_FOLDER) {
		printf("folder");
		if (e->id) printf(" %s", e->id);
	} else printf("link -> %s", e->target);
}

static void diff(const char *given) {
	load(given, false);
	const st_difference *d;
	size_t length;
	check(st_differences(store, NULL, 0, &d, &length));
	for (size_t i = 0; i < length; i++) {
		printf("%s\n  laid: ", d[i].path);
		if (d[i].was) was(d[i].was);
		else fputs("nothing", stdout);
		fputs("\n  now:  ", stdout);
		if (d[i].now) is(d[i].now);
		else fputs("nothing", stdout);
		putchar('\n');
	}
	if (!length) puts("no differences");
}

static void mend(const char *given, const char *const *paths, size_t n) {
	load(given, false);
	check(st_mend(store, paths, n));
}

// files new|ermine://… <folder> [--server URL] [--home DIR] [--named]
static int host(int argc, char **argv) {
	fh_options o = {.doc = argv[1]};
	const char *folder = NULL;
	for (int i = 2; i < argc; i++) {
		if (strcmp(argv[i], "--server") == 0 && i + 1 < argc) o.server = argv[++i];
		else if (strcmp(argv[i], "--home") == 0 && i + 1 < argc) o.home = argv[++i];
		else if (strcmp(argv[i], "--named") == 0) o.named = true;
		else if (!folder && argv[i][0] != '-') folder = argv[i];
		else usage();
	}
	if (!folder) usage();
	o.folder = folder;
	return fh_run(&o);
}

int main(int argc, char **argv) {
	if (argc < 3) usage();
	const char *command = argv[1], *where = argv[2];
	if (strcmp(command, "new") == 0 || strncmp(command, "ermine://", 9) == 0) return host(argc, argv);
	if (strcmp(command, "init") == 0 && argc == 3) init(where);
	else if (strcmp(command, "put") == 0 && argc >= 4) {
		Json *value = NULL;
		if (argc == 5) value = jsonString(argv[4]);
		else if (argc == 6 && strcmp(argv[4], "--file") == 0) value = filed(argv[5]);
		else if (argc == 6 && strcmp(argv[4], "--diag") == 0) value = diagnostic(argv[5]);
		else if (argc != 4) usage();
		put(where, argv[3], value ? mine_value(value) : NULL);
	} else if (strcmp(command, "rm") == 0 && argc == 4) rm(where, argv[3]);
	else if (strcmp(command, "mv") == 0 && argc == 5) mv(where, argv[3], argv[4]);
	else if ((strcmp(command, "ls") == 0 || strcmp(command, "tree") == 0) && argc == 3) ls(where);
	else if (strcmp(command, "diff") == 0 && argc == 3) diff(where);
	else if (strcmp(command, "mend") == 0) mend(where, argc > 3 ? (const char *const *)argv + 3 : NULL, (size_t)argc - 3);
	else usage();
	st_release(store);
	st_restored_free(&restored);
	st_close(store);
	let_go();
	free(table);
	free(folder);
	return 0;
}
