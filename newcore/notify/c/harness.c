// The C notify on the line protocol (newcore/conformance/notify/harness.ts): one JSON request per
// line in, one answer per line out. Parses and prints the JSON itself.
#include "notify.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void fail(const char *why) {
	fprintf(stderr, "harness: %s\n", why);
	exit(1);
}
static void *grab(size_t n) {
	void *p = malloc(n ? n : 1);
	if (p == NULL) fail("out of memory");
	return p;
}

// json in

typedef struct {
	const char *p;
	const char *why;
} parser;

static void skip(parser *s) {
	while (*s->p == ' ' || *s->p == '\t' || *s->p == '\r' || *s->p == '\n') s->p++;
}
static int hex4(parser *s, unsigned *out) {
	unsigned x = 0;
	for (int i = 0; i < 4; i++) {
		char c = s->p[i];
		x <<= 4;
		if (c >= '0' && c <= '9') x |= (unsigned)(c - '0');
		else if (c >= 'a' && c <= 'f') x |= (unsigned)(c - 'a' + 10);
		else if (c >= 'A' && c <= 'F') x |= (unsigned)(c - 'A' + 10);
		else return 0;
	}
	s->p += 4;
	*out = x;
	return 1;
}
static size_t utf8(char *out, unsigned c) {
	if (c < 0x80) return out[0] = (char)c, 1;
	if (c < 0x800) return out[0] = (char)(0xC0 | c >> 6), out[1] = (char)(0x80 | (c & 63)), 2;
	if (c < 0x10000) {
		out[0] = (char)(0xE0 | c >> 12);
		out[1] = (char)(0x80 | ((c >> 6) & 63));
		out[2] = (char)(0x80 | (c & 63));
		return 3;
	}
	out[0] = (char)(0xF0 | c >> 18);
	out[1] = (char)(0x80 | ((c >> 12) & 63));
	out[2] = (char)(0x80 | ((c >> 6) & 63));
	out[3] = (char)(0x80 | (c & 63));
	return 4;
}
// a string literal, p after the opening quote; malloc'd, or NULL
static char *literal(parser *s) {
	size_t cap = strlen(s->p) + 1, n = 0;
	char *out = grab(cap);
	while (*s->p != '"') {
		unsigned char c = (unsigned char)*s->p;
		if (c == 0 || c < 0x20) goto bad;
		s->p++;
		if (c != '\\') {
			out[n++] = (char)c;
			continue;
		}
		char e = *s->p++;
		switch (e) {
		case '"': case '\\': case '/': out[n++] = e; break;
		case 'b': out[n++] = '\b'; break;
		case 'f': out[n++] = '\f'; break;
		case 'n': out[n++] = '\n'; break;
		case 'r': out[n++] = '\r'; break;
		case 't': out[n++] = '\t'; break;
		case 'u': {
			unsigned u, lo;
			if (!hex4(s, &u)) goto bad;
			if (u >= 0xD800 && u < 0xDC00 && s->p[0] == '\\' && s->p[1] == 'u') {
				s->p += 2;
				if (!hex4(s, &lo)) goto bad;
				u = 0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00);
			}
			n += utf8(out + n, u);
			break;
		}
		default: goto bad;
		}
	}
	s->p++;
	out[n] = 0;
	return out;
bad:
	free(out);
	s->why = "bad string";
	return NULL;
}
static nt_value *value(parser *s) {
	skip(s);
	char c = *s->p;
	if (c == '"') {
		s->p++;
		char *t = literal(s);
		if (t == NULL) return NULL;
		nt_value *v = nt_str(t);
		free(t);
		return v;
	}
	if (c == '[' || c == '{') {
		int map = c == '{';
		nt_value *v = map ? nt_map() : nt_list();
		s->p++;
		skip(s);
		if (*s->p == (map ? '}' : ']')) return s->p++, v;
		for (;;) {
			char *key = NULL;
			if (map) {
				skip(s);
				if (*s->p++ != '"' || (key = literal(s)) == NULL) goto bad;
				skip(s);
				if (*s->p++ != ':') goto bad_key;
			}
			nt_value *item = value(s);
			if (item == NULL) goto bad_key;
			if (map) nt_set(v, key, item);
			else nt_push(v, item);
			free(key);
			skip(s);
			if (*s->p == ',') {
				s->p++;
				continue;
			}
			if (*s->p++ == (map ? '}' : ']')) return v;
			goto bad;
		bad_key:
			free(key);
		bad:
			nt_free(v);
			if (s->why == NULL) s->why = "bad json";
			return NULL;
		}
	}
	if (strncmp(s->p, "null", 4) == 0) return s->p += 4, nt_null();
	if (strncmp(s->p, "true", 4) == 0) return s->p += 4, nt_bool(1);
	if (strncmp(s->p, "false", 5) == 0) return s->p += 5, nt_bool(0);
	char *end;
	double d = strtod(s->p, &end);
	if (end == s->p || c == 'n' || c == 'i' || c == 'I' || c == 'N' || c == '+') {
		s->why = "bad json";
		return NULL;
	}
	s->p = end;
	return nt_num(d);
}

// json out

static void string(const char *s) {
	putchar('"');
	for (; *s; s++) {
		unsigned char c = (unsigned char)*s;
		if (c == '"' || c == '\\') printf("\\%c", c);
		else if (c == '\n') fputs("\\n", stdout);
		else if (c == '\r') fputs("\\r", stdout);
		else if (c == '\t') fputs("\\t", stdout);
		else if (c == '\b') fputs("\\b", stdout);
		else if (c == '\f') fputs("\\f", stdout);
		else if (c < 0x20) printf("\\u%04x", c);
		else putchar(c);
	}
	putchar('"');
}
static void number(double d) {
	if (d == 0) { putchar('0'); return; }
	if (d == floor(d) && fabs(d) < 1e21) { printf("%.0f", d); return; }
	char buf[40];
	for (int p = 1; p <= 17; p++) {
		snprintf(buf, sizeof buf, "%.*g", p, d);
		if (strtod(buf, NULL) == d) break;
	}
	fputs(buf, stdout);
}
static void print(const nt_value *v) {
	switch (v->type) {
	case NT_NULL: fputs("null", stdout); break;
	case NT_BOOL: fputs(v->bool_ ? "true" : "false", stdout); break;
	case NT_NUM: number(v->num); break;
	case NT_STR: string(v->str); break;
	case NT_LIST:
		putchar('[');
		for (size_t i = 0; i < v->count; i++) {
			if (i) putchar(',');
			print(v->items[i]);
		}
		putchar(']');
		break;
	case NT_MAP:
		putchar('{');
		for (size_t i = 0; i < v->count; i++) {
			if (i) putchar(',');
			string(v->keys[i]);
			putchar(':');
			print(v->items[i]);
		}
		putchar('}');
		break;
	}
}
static void error(const char *why) {
	fputs("{\"error\":", stdout);
	string(why);
	puts("}");
}

// the protocol

static const char *names[] = {"value", "keys", "length", "moved", "gone"};

typedef struct {
	char *name;
	nt_read *r;
	nt_kind heard[5];
	int nheard;
	int live;
} entry;

static const nt_value *content;
static nt_notify *notify;
static entry **entries;
static size_t count, capacity;

static const nt_value *get(void *ctx) {
	(void)ctx;
	return content;
}
static void listen(nt_kind kind, void *user) {
	entry *e = user;
	for (int i = 0; i < e->nheard; i++)
		if (e->heard[i] == kind) goto known;
	e->heard[e->nheard++] = kind;
known:
	if (kind == NT_GONE) e->live = 0;
}
// the latest read of this name
static entry *find(const char *name) {
	for (size_t i = count; i-- > 0;)
		if (strcmp(entries[i]->name, name) == 0) return entries[i];
	return NULL;
}
static void restart(nt_value *v) {
	if (notify) nt_destroy(notify);
	for (size_t i = 0; i < count; i++) {
		free(entries[i]->name);
		free(entries[i]);
	}
	count = 0;
	nt_free((nt_value *)content);
	content = v;
	notify = nt_create(get, NULL);
}

// a JSON path to keys; strings are borrowed from it. NULL on a bad one
static nt_key *keys_of(const nt_value *list, size_t *length) {
	if (list == NULL || list->type != NT_LIST) return NULL;
	nt_key *ks = grab((list->count + 1) * sizeof *ks);
	for (size_t i = 0; i < list->count; i++) {
		const nt_value *x = list->items[i];
		if (x->type == NT_NUM) ks[i] = (nt_key){.type = NT_NUM_KEY, .n = (long)x->num};
		else if (x->type == NT_STR) ks[i] = (nt_key){.type = NT_STR_KEY, .s = x->str};
		else if (x->type == NT_LIST && x->count == 2 && x->items[0]->type == NT_NUM &&
				x->items[1]->type == NT_NUM && i + 1 == list->count) {
			ks[i] = (nt_key){.type = NT_SPAN, .a = (long)x->items[0]->num, .b = (long)x->items[1]->num};
		} else {
			free(ks);
			return NULL;
		}
	}
	*length = list->count;
	return ks;
}
// a place: path and maybe range; path to be freed by the caller
static int place_of(const nt_value *m, nt_place *p) {
	memset(p, 0, sizeof *p);
	if (m == NULL || m->type != NT_MAP) return 0;
	p->path = keys_of(nt_get(m, "path"), &p->length);
	if (p->path == NULL) return 0;
	const nt_value *r = nt_get(m, "range");
	if (r != NULL) {
		if (r->type != NT_LIST || r->count != 2 || r->items[0]->type != NT_NUM || r->items[1]->type != NT_NUM) return 0;
		p->has_range = 1;
		p->from = (long)r->items[0]->num;
		p->to = (long)r->items[1]->num;
	}
	return 1;
}

static void answer(nt_value *q) {
	const nt_value *op = nt_get(q, "op");
	const nt_value *nm = nt_get(q, "name");
	const char *name = nm && nm->type == NT_STR ? nm->str : "undefined";
	if (q->type != NT_MAP || op == NULL || op->type != NT_STR) { error("unknown op undefined"); return; }
	if (strcmp(op->str, "start") == 0) {
		nt_value *v = nt_get(q, "value");
		// the content is kept: taken out of the request
		for (size_t i = 0; v && i < q->count; i++)
			if (q->items[i] == v) q->items[i] = NULL;
		restart(v);
		puts("{}");
	} else if (strcmp(op->str, "read") == 0) {
		size_t n;
		nt_key *path = keys_of(nt_get(q, "path"), &n);
		if (path == NULL) { error("bad path"); return; }
		nt_options o = {0};
		const nt_value *x;
		o.deep = (x = nt_get(q, "deep")) && x->type == NT_BOOL && x->bool_;
		o.chase = (x = nt_get(q, "chase")) && x->type == NT_BOOL && x->bool_;
		if ((x = nt_get(q, "edges")) && x->type == NT_LIST && x->count == 2)
			for (int i = 0; i < 2; i++)
				o.edges[i] = x->items[i]->type == NT_STR && strcmp(x->items[i]->str, "in") == 0 ? NT_IN : NT_OUT;
		o.empty = (x = nt_get(q, "empty")) && x->type == NT_STR && strcmp(x->str, "gone") == 0 ? NT_DROP : NT_KEEP;
		entry *e = grab(sizeof *e);
		*e = (entry){.live = 1};
		e->name = grab(strlen(name) + 1);
		strcpy(e->name, name);
		e->r = nt_open(notify, path, n, &o);
		free(path);
		nt_on(e->r, listen, e);
		if (count == capacity) {
			capacity = capacity ? capacity * 2 : 16;
			entries = realloc(entries, capacity * sizeof *entries);
			if (entries == NULL) fail("out of memory");
		}
		entries[count++] = e;
		puts("{}");
	} else if (strcmp(op->str, "patch") == 0) {
		nt_patch p = {0};
		const nt_value *pm = nt_get(q, "patch");
		if (!place_of(pm, &p.place)) { error("bad patch"); return; }
		p.value = nt_get(pm, "value");
		p.has_value = p.value != NULL;
		const nt_value *mv = nt_get(pm, "move");
		if (mv != NULL) {
			p.has_move = 1;
			if (!place_of(mv, &p.move)) { error("bad patch"); return; }
		}
		const nt_value *before = content;
		nt_value *after = nt_get(q, "value");
		for (size_t i = 0; after && i < q->count; i++)
			if (q->items[i] == after) q->items[i] = NULL;
		content = after;
		nt_patched(notify, &p, before);
		free((void *)p.place.path);
		free((void *)p.move.path);
		nt_free((nt_value *)before);
		fputs("{\"heard\":{", stdout);
		int first = 1;
		for (size_t i = 0; i < count; i++) {
			entry *e = entries[i];
			if (e->nheard == 0 || find(e->name) != e) continue;
			if (!first) putchar(',');
			first = 0;
			string(e->name);
			fputs(":[", stdout);
			for (int j = 0; j < e->nheard; j++) {
				if (j) putchar(',');
				string(names[e->heard[j]]);
			}
			putchar(']');
		}
		puts("}}");
		for (size_t i = 0; i < count; i++) entries[i]->nheard = 0;
	} else if (strcmp(op->str, "where") == 0 || strcmp(op->str, "stop") == 0) {
		entry *e = find(name);
		if (e == NULL) {
			char why[256];
			snprintf(why, sizeof why, "no read %s", name);
			{ error(why); return; }
		}
		if (op->str[0] == 's') {
			nt_stop(e->r);
			e->live = 0;
			puts("{}");
			return;
		}
		size_t n;
		long a, b;
		const nt_key *ks = nt_keys(e->r, &n);
		fputs("{\"path\":[", stdout);
		for (size_t i = 0; i < n; i++) {
			if (i) putchar(',');
			if (ks[i].type == NT_NUM_KEY) printf("%ld", ks[i].n);
			else string(ks[i].s);
		}
		if (nt_span(e->r, &a, &b)) printf("%s[%ld,%ld]", n ? "," : "", a, b);
		putchar(']');
		nt_value *v = nt_value_of(e->r);
		if (v != NULL) {
			fputs(",\"value\":", stdout);
			print(v);
			nt_free(v);
		}
		printf(",\"live\":%s}\n", e->live ? "true" : "false");
	} else {
		char why[256];
		snprintf(why, sizeof why, "unknown op %s", op->str);
		error(why);
	}
}

int main(void) {
	restart(NULL);
	char *line = NULL;
	size_t size = 0;
	while (getline(&line, &size, stdin) > 0) {
		if (strspn(line, " \t\r\n") == strlen(line)) continue;
		parser s = {line, NULL};
		nt_value *q = value(&s);
		if (q != NULL) skip(&s);
		if (q == NULL || *s.p != 0) {
			error(s.why ? s.why : "bad json");
		} else {
			answer(q);
		}
		nt_free(q);
		fflush(stdout);
	}
	free(line);
	restart(NULL);
	for (size_t i = 0; i < count; i++) free(entries[i]);
	nt_destroy(notify);
	free(entries);
	return 0;
}
