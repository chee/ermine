// Shown nodes on the line protocol (newcore/conformance/node/harness.ts), for the C harnesses:
// reading JSON as spans of the line, and writing it. Content, change, because, actor and cause are
// kept as their JSON text and written back as is; in a list, {"symbol": name} is a symbol.
#include "shown.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void fail(const char *why) {
	fprintf(stderr, "harness: %s\n", why);
	exit(1);
}

// everything one line allocates, freed when its answer is written
void **arena;
size_t arena_length, arena_capacity;
void *take(size_t size) {
	void *p = malloc(size ? size : 1);
	if (p == NULL) fail("out of memory");
	if (arena_length == arena_capacity) {
		arena_capacity = arena_capacity ? arena_capacity * 2 : 64;
		arena = realloc(arena, arena_capacity * sizeof *arena);
		if (arena == NULL) fail("out of memory");
	}
	return arena[arena_length++] = p;
}
void clear(void) {
	for (size_t i = 0; i < arena_length; i++) free(arena[i]);
	arena_length = 0;
}

void finish(void) {
	clear();
	free(arena);
}

// --- reading JSON: values as spans of the line ---

const char *space(const char *p) {
	while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
	return p;
}

// past one value
const char *skip(const char *p) {
	p = space(p);
	if (*p == '"') {
		for (p++; *p && *p != '"'; p++)
			if (*p == '\\' && p[1]) p++;
		if (*p != '"') fail("bad string");
		return p + 1;
	}
	if (*p == '{' || *p == '[') {
		char close = *p == '{' ? '}' : ']';
		p = space(p + 1);
		if (*p == close) return p + 1;
		for (;;) {
			p = skip(p);
			p = space(p);
			if (close == '}' && *p == ':') p = space(skip(p + 1));
			if (*p == ',') p++;
			else if (*p == close) return p + 1;
			else fail("bad object or array");
		}
	}
	const char *start = p;
	while (*p && !strchr(",:]} \t\r\n", *p)) p++;
	if (p == start) fail("no value");
	return p;
}

void utf8(char **out, unsigned long c) {
	char *o = *out;
	// U+0000 held as C0 80, as json.h holds it
	if (c == 0) *o++ = (char)0xC0, *o++ = (char)0x80;
	else if (c < 0x80) *o++ = (char)c;
	else if (c < 0x800) *o++ = (char)(0xC0 | c >> 6), *o++ = (char)(0x80 | (c & 0x3F));
	else if (c < 0x10000)
		*o++ = (char)(0xE0 | c >> 12), *o++ = (char)(0x80 | (c >> 6 & 0x3F)),
		*o++ = (char)(0x80 | (c & 0x3F));
	else
		*o++ = (char)(0xF0 | c >> 18), *o++ = (char)(0x80 | (c >> 12 & 0x3F)),
		*o++ = (char)(0x80 | (c >> 6 & 0x3F)), *o++ = (char)(0x80 | (c & 0x3F));
	*out = o;
}

// a JSON string at p, decoded
char *string(const char *p) {
	p = space(p);
	if (*p != '"') fail("not a string");
	const char *end = skip(p);
	char *s = take((size_t)(end - p)), *o = s;
	for (p++; *p != '"'; p++) {
		if (*p != '\\') {
			*o++ = *p;
			continue;
		}
		switch (*++p) {
		case 'b': *o++ = '\b'; break;
		case 'f': *o++ = '\f'; break;
		case 'n': *o++ = '\n'; break;
		case 'r': *o++ = '\r'; break;
		case 't': *o++ = '\t'; break;
		case 'u': {
			unsigned long c = strtoul((char[5]){p[1], p[2], p[3], p[4], 0}, NULL, 16);
			p += 4;
			if (c >= 0xD800 && c < 0xDC00 && p[1] == '\\' && p[2] == 'u') {
				unsigned long low = strtoul((char[5]){p[3], p[4], p[5], p[6], 0}, NULL, 16);
				c = 0x10000 + ((c - 0xD800) << 10) + (low - 0xDC00);
				p += 6;
			}
			utf8(&o, c);
			break;
		}
		default: *o++ = *p;
		}
	}
	*o = 0;
	return s;
}

// a value's JSON text, as written
char *raw(const char *p) {
	p = space(p);
	const char *end = skip(p);
	char *s = take((size_t)(end - p) + 1);
	memcpy(s, p, (size_t)(end - p));
	s[end - p] = 0;
	return s;
}

// the value at key in the object at p; NULL when absent
const char *field(const char *p, const char *key) {
	p = space(p);
	if (*p != '{') fail("not an object");
	p = space(p + 1);
	while (*p == '"') {
		char *name = string(p);
		p = space(skip(p));
		if (*p != ':') fail("no colon");
		const char *value = space(p + 1);
		if (strcmp(name, key) == 0) return value;
		p = space(skip(value));
		if (*p == ',') p = space(p + 1);
	}
	return NULL;
}

// the items of the array at p: count, then each start
size_t items(const char *p, const char ***out) {
	p = space(p);
	if (*p != '[') fail("not an array");
	size_t n = 0;
	for (const char *q = space(p + 1); *q != ']'; n++) {
		q = space(skip(q));
		if (*q == ',') q = space(q + 1);
	}
	const char **xs = take(n * sizeof *xs);
	const char *q = space(p + 1);
	for (size_t i = 0; i < n; i++) {
		xs[i] = q;
		q = space(skip(q));
		if (*q == ',') q = space(q + 1);
	}
	*out = xs;
	return n;
}

nd_list *list(const char *p) {
	const char **xs;
	size_t n = items(p, &xs);
	nd_item *is = take(n * sizeof *is);
	for (size_t i = 0; i < n; i++) {
		if (*xs[i] == '"') is[i] = (nd_item){string(xs[i]), NULL};
		else is[i] = (nd_item){NULL, string(field(xs[i], "symbol"))};
	}
	nd_list *l = take(sizeof *l);
	*l = (nd_list){is, n};
	return l;
}

nd_object object(const char *p, int lists) {
	const char **xs;
	size_t n = items(p, &xs);
	nd_version *vs = take(n * sizeof *vs);
	for (size_t i = 0; i < n; i++) {
		const char *content = field(xs[i], "content"), *because = field(xs[i], "because");
		const char *change = field(xs[i], "change");
		vs[i] = (nd_version){
			lists ? (const void *)list(content) : raw(content),
			change ? raw(change) : NULL,
			because ? raw(because) : NULL,
		};
	}
	return (nd_object){vs, n};
}

size_t named(const char *p, int lists, const nd_entry **out) {
	const char **xs;
	size_t n = items(p, &xs);
	nd_entry *es = take(n * sizeof *es);
	for (size_t i = 0; i < n; i++) {
		const char **pair;
		if (items(xs[i], &pair) != 2) fail("an entry is a name and versions");
		es[i] = (nd_entry){string(pair[0]), object(pair[1], lists)};
	}
	*out = es;
	return n;
}

nd_site site(const char *p) {
	const char *column = field(p, "column"), *function = field(p, "function");
	return (nd_site){
		string(field(p, "file")),
		strtol(field(p, "line"), NULL, 10),
		column ? strtol(column, NULL, 10) : 0,
		function ? string(function) : NULL,
		column != NULL,
	};
}

// --- writing JSON ---

void text(const char *s) {
	putchar('"');
	for (; *s; s++) {
		unsigned char c = (unsigned char)*s;
		if (c == 0xC0 && (unsigned char)s[1] == 0x80) fputs("\\u0000", stdout), s++;
		else if (c == '"' || c == '\\') printf("\\%c", c);
		else if (c < 0x20) printf("\\u%04x", c);
		else putchar(c);
	}
	putchar('"');
}

void versions(nd_object o, int lists) {
	putchar('[');
	for (size_t i = 0; i < o.length; i++) {
		const nd_version *v = &o.versions[i];
		if (i) putchar(',');
		fputs("{\"content\":", stdout);
		if (lists) {
			const nd_list *l = v->content;
			putchar('[');
			for (size_t j = 0; l && j < l->length; j++) {
				if (j) putchar(',');
				if (l->items[j].id) text(l->items[j].id);
				else fputs("{\"symbol\":", stdout), text(l->items[j].symbol), putchar('}');
			}
			putchar(']');
		} else fputs(v->content, stdout);
		if (v->change) printf(",\"change\":%s", (const char *)v->change);
		if (v->because) printf(",\"because\":%s", (const char *)v->because);
		putchar('}');
	}
	putchar(']');
}

void entries(const nd_entry *es, size_t n, int lists) {
	putchar('[');
	for (size_t i = 0; i < n; i++) {
		if (i) putchar(',');
		putchar('[');
		text(es[i].name);
		putchar(',');
		versions(es[i].object, lists);
		putchar(']');
	}
	putchar(']');
}

void header(const nd_header *h) {
	const char *comma = "";
	putchar('{');
	if (h->has_time) printf("\"time\":%lld", (long long)h->time), comma = ",";
	if (h->actor) printf("%s\"actor\":%s", comma, (const char *)h->actor), comma = ",";
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
	if (h->cause) printf("%s\"cause\":%s", comma, (const char *)h->cause), comma = ",";
	if (h->has_wallclock) printf("%s\"wallclock\":%lld", comma, (long long)h->wallclock), comma = ",";
	if (h->message) printf("%s\"message\":", comma), text(h->message);
	putchar('}');
}

nd_header parse_header(const char *p) {
	nd_header h = {0};
	const char *time = field(p, "time"), *actor = field(p, "actor"), *reader = field(p, "reader"),
		   *at = field(p, "site"), *cause = field(p, "cause"), *wallclock = field(p, "wallclock"),
		   *message = field(p, "message");
	if (time) h.has_time = 1, h.time = strtoll(time, NULL, 10);
	if (actor) h.actor = raw(actor);
	if (reader) h.reader = string(reader);
	if (at) h.has_site = 1, h.site = site(at);
	if (cause) h.cause = raw(cause);
	if (wallclock) h.has_wallclock = 1, h.wallclock = strtoll(wallclock, NULL, 10);
	if (message) h.message = string(message);
	return h;
}

nd_node *parse_node(const char *p) {
	nd_contents c = {0};
	const char *value = field(p, "value"), *info = field(p, "info"), *children = field(p, "children"),
		   *given = field(p, "header");
	if (value) c.value = object(value, 0);
	if (info) c.info_length = named(info, 0, &c.info);
	if (children) c.children_length = named(children, 1, &c.children);
	nd_header h = given ? parse_header(given) : (nd_header){0};
	nd_node *n = nd_make(string(field(p, "id")), &c, &h, NULL);
	if (n == NULL) fail("out of memory");
	return n;
}

void show_node(const nd_node *n) {
	fputs("{\"id\":", stdout);
	text(n->id);
	fputs(",\"value\":", stdout);
	versions(n->value, 0);
	fputs(",\"info\":", stdout);
	entries(n->info, n->info_length, 0);
	fputs(",\"children\":", stdout);
	entries(n->children, n->children_length, 1);
	fputs(",\"header\":", stdout);
	header(&n->header);
	putchar('}');
}
