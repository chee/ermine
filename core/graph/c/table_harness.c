// The C table on the line protocol: one JSON request per line in, one answer per line out, in
// order. Same as conformance/table/harness.ts, which documents it. State lasts for the process: one
// table, one object per node name and one per symbol name, their addresses the nodes and the tokens.
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "table.h"

// a parsed JSON value: a string, or an object of values (a request, a symbol); anything else is
// read and dropped
typedef struct value value;
struct value {
	char type; // 's' string, 'o' object, 'x' other
	char *text;
	char **keys;
	value **kids;
	size_t n;
};

static void *pool[1 << 16];
static size_t npool;
static void *alloc(size_t n) {
	void *x = calloc(1, n ? n : 1);
	if (!x || npool == sizeof pool / sizeof *pool) abort();
	return pool[npool++] = x;
}
static void release(void) {
	while (npool) free(pool[--npool]);
}

static const char *p;
static int failed;

static void ws(void) {
	while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
}

static int put8(char *o, unsigned long c) {
	if (c < 0x80) { o[0] = (char)c; return 1; }
	if (c < 0x800) { o[0] = (char)(0xC0 | c >> 6); o[1] = (char)(0x80 | (c & 63)); return 2; }
	o[0] = (char)(0xE0 | c >> 12); o[1] = (char)(0x80 | ((c >> 6) & 63)); o[2] = (char)(0x80 | (c & 63));
	return 3;
}

static char *string(void) {
	if (*p != '"') { failed = 1; return ""; }
	p++;
	const char *s = p;
	size_t len = 0;
	while (*p && *p != '"') {
		if (*p == '\\' && p[1]) p++;
		p++;
		len++;
	}
	char *out = alloc(len * 3 + 1);
	size_t o = 0;
	for (p = s; *p && *p != '"'; p++) {
		if (*p != '\\') { out[o++] = *p; continue; }
		p++;
		switch (*p) {
		case 'n': out[o++] = '\n'; break;
		case 't': out[o++] = '\t'; break;
		case 'r': out[o++] = '\r'; break;
		case 'b': out[o++] = '\b'; break;
		case 'f': out[o++] = '\f'; break;
		case 'u': {
			unsigned long c = 0;
			for (int i = 1; i <= 4; i++) {
				char d = p[i];
				c = c * 16 + (unsigned long)(d >= 'a' ? d - 'a' + 10 : d >= 'A' ? d - 'A' + 10 : d - '0');
			}
			p += 4;
			o += (size_t)put8(out + o, c);
			break;
		}
		default: out[o++] = *p;
		}
	}
	if (*p != '"') failed = 1;
	else p++;
	return out;
}

static value *parse(void) {
	value *v = alloc(sizeof *v);
	ws();
	if (*p == '"') {
		v->type = 's';
		v->text = string();
	} else if (*p == '{') {
		v->type = 'o';
		p++;
		ws();
		size_t cap = 0;
		while (*p && *p != '}' && !failed) {
			if (v->n == cap) {
				cap = cap ? cap * 2 : 4;
				char **k = alloc(cap * sizeof *k);
				value **kids = alloc(cap * sizeof *kids);
				if (v->n) { memcpy(k, v->keys, v->n * sizeof *k); memcpy(kids, v->kids, v->n * sizeof *kids); }
				v->keys = k;
				v->kids = kids;
			}
			ws();
			v->keys[v->n] = string();
			ws();
			if (*p != ':') { failed = 1; break; }
			p++;
			v->kids[v->n++] = parse();
			ws();
			if (*p == ',') p++;
			ws();
		}
		if (*p != '}') failed = 1;
		else p++;
	} else {
		// a number, true, false, null, or an array: skipped to its end
		v->type = 'x';
		int depth = 0;
		while (*p && (depth > 0 || (*p != ',' && *p != '}' && *p != ']'))) {
			if (*p == '[') depth++;
			if (*p == ']') depth--;
			if (*p == '"') { string(); continue; }
			p++;
		}
	}
	return v;
}

static value *field(const value *o, const char *name) {
	for (size_t i = 0; i < o->n; i++) if (!strcmp(o->keys[i], name)) return o->kids[i];
	return NULL;
}

// named things: a node and a symbol are each an object whose address is the identity
typedef struct named named;
struct named {
	named *next;
	char *name;
};
static named *nodes, *symbols;
static named *intern(named **list, const char *name) {
	for (named *n = *list; n; n = n->next) if (!strcmp(n->name, name)) return n;
	named *n = calloc(1, sizeof *n);
	if (!n) abort();
	n->name = strdup(name);
	if (!n->name) abort();
	n->next = *list;
	*list = n;
	return n;
}

static named *node_of(const value *v, int *bad) {
	if (!v || v->type != 's') { *bad = 1; return NULL; }
	return intern(&nodes, v->text);
}
static tb_key key_of(const value *v, int *bad) {
	if (v && v->type == 's') return tb_string(v->text);
	if (v && v->type == 'o') {
		value *s = field(v, "symbol");
		if (s && s->type == 's') return tb_symbol(intern(&symbols, s->text));
	}
	*bad = 1;
	return tb_string("");
}

static void out_string(const char *s) {
	putchar('"');
	for (; *s; s++) {
		unsigned char c = (unsigned char)*s;
		if (c == '"' || c == '\\') { putchar('\\'); putchar(c); }
		else if (c < 0x20) printf("\\u%04x", c);
		else putchar(c);
	}
	putchar('"');
}
static void out_key(tb_key k) {
	if (k.symbol == NULL) {
		out_string(k.string);
		return;
	}
	fputs("{\"symbol\":", stdout);
	out_string(((const named *)k.symbol)->name);
	putchar('}');
}

static int error(const char *why) {
	fputs("{\"error\":", stdout);
	out_string(why);
	puts("}");
	return 0;
}
static int result(int code) {
	if (code) {
		fputs("{\"error\":", stdout);
		out_string(tb_code_name(code));
		puts("}");
	} else puts("{}");
	return 0;
}

static tb_table *table;

static int answer(const char *line) {
	p = line;
	failed = 0;
	value *r = parse();
	ws();
	if (failed || *p || r->type != 'o') return error("not an object");
	value *op = field(r, "op");
	if (!op || op->type != 's') return error("unknown op");
	const char *o = op->text;
	value *vpart = field(r, "part"), *vid = field(r, "id"), *vnode = field(r, "node");
	int bad = 0;
	if (!strcmp(o, "add") || !strcmp(o, "sub")) {
		tb_key part = key_of(vpart, &bad), id = key_of(vid, &bad);
		named *n = node_of(vnode, &bad);
		if (bad) return error("bad key or node");
		if (o[0] == 'a') return result(tb_add(table, part, id, n));
		tb_sub(table, part, id, n);
		puts("{}");
	} else if (!strcmp(o, "get")) {
		tb_key part = key_of(vpart, &bad), id = key_of(vid, &bad);
		if (bad) return error("bad key");
		named *n = tb_get(table, part, id);
		if (n == NULL) {
			puts("{}");
			return 0;
		}
		fputs("{\"node\":", stdout);
		out_string(n->name);
		puts("}");
	} else if (!strcmp(o, "ids")) {
		tb_key part = key_of(vpart, &bad);
		named *n = node_of(vnode, &bad);
		if (bad) return error("bad key or node");
		size_t len;
		const tb_key *ids = tb_ids(table, part, n, &len);
		fputs("{\"ids\":[", stdout);
		for (size_t i = 0; i < len; i++) {
			if (i) putchar(',');
			out_key(ids[i]);
		}
		puts("]}");
	} else if (!strcmp(o, "at")) {
		tb_key id = key_of(vid, &bad);
		if (bad) return error("bad key");
		size_t len;
		const tb_entry *es = tb_at(table, id, &len);
		fputs("{\"entries\":[", stdout);
		for (size_t i = 0; i < len; i++) {
			if (i) putchar(',');
			putchar('[');
			out_key(es[i].part);
			putchar(',');
			out_string(((const named *)es[i].node)->name);
			putchar(']');
		}
		puts("]}");
	} else if (!strcmp(o, "who")) {
		named *n = node_of(vnode, &bad);
		if (bad) return error("bad node");
		size_t len;
		const tb_where *ws_ = tb_who(table, n, &len);
		fputs("{\"keys\":[", stdout);
		for (size_t i = 0; i < len; i++) {
			if (i) putchar(',');
			putchar('[');
			out_key(ws_[i].part);
			putchar(',');
			out_key(ws_[i].id);
			putchar(']');
		}
		puts("]}");
	} else if (!strcmp(o, "del")) {
		if (!vpart) {
			named *n = node_of(vnode, &bad);
			if (bad) return error("bad node");
			return result(tb_del_node(table, n));
		}
		tb_key part = key_of(vpart, &bad);
		if (vnode) {
			named *n = node_of(vnode, &bad);
			if (bad) return error("bad key or node");
			return result(tb_del_part(table, part, n));
		}
		tb_key id = key_of(vid, &bad);
		if (bad) return error("bad key");
		result(tb_del(table, part, id));
	} else {
		error("unknown op");
	}
	return 0;
}

int main(void) {
	table = tb_new();
	char *line = NULL;
	size_t cap = 0;
	ssize_t n;
	while ((n = getline(&line, &cap, stdin)) != -1) {
		const char *s = line;
		while (*s == ' ' || *s == '\t' || *s == '\r' || *s == '\n') s++;
		if (!*s) continue;
		answer(line);
		release();
		fflush(stdout);
	}
	free(line);
	tb_free(table);
	while (nodes) { named *n = nodes; nodes = n->next; free(n->name); free(n); }
	while (symbols) { named *n = symbols; symbols = n->next; free(n->name); free(n); }
	return 0;
}
