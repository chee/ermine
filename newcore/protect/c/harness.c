// The C protect library on the line protocol: one JSON request per line in, one answer per line
// out, in order. Same as harness.ts (its header says the requests and answers). Policies are
// data: "anyone", {rules: id}, {first: [policy, ...]}, {answer}.
#define _POSIX_C_SOURCE 200809L
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "protect.h"

static pr_arena arena;
static const char *p; // the parser's place in the line

static void ws(void) {
	while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
}

static int put8(char *o, unsigned long c) {
	if (c < 0x80) { o[0] = (char)c; return 1; }
	if (c < 0x800) { o[0] = (char)(0xC0 | c >> 6); o[1] = (char)(0x80 | (c & 63)); return 2; }
	if (c < 0x10000) {
		o[0] = (char)(0xE0 | c >> 12); o[1] = (char)(0x80 | ((c >> 6) & 63)); o[2] = (char)(0x80 | (c & 63));
		return 3;
	}
	o[0] = (char)(0xF0 | c >> 18); o[1] = (char)(0x80 | ((c >> 12) & 63));
	o[2] = (char)(0x80 | ((c >> 6) & 63)); o[3] = (char)(0x80 | (c & 63));
	return 4;
}

static unsigned long hex4(const char *s) {
	char b[5] = {s[0], s[1], s[2], s[3], 0};
	return strtoul(b, NULL, 16);
}

// at the opening quote: a string in the arena, p after the closing quote
static pr_value str(void) {
	const char *s = ++p;
	while (*p && *p != '"') p += *p == '\\' && p[1] ? 2 : 1;
	char *out = pr_alloc(&arena, (size_t)(p - s) + 1), *o = out;
	while (s < p) {
		if (*s != '\\') { *o++ = *s++; continue; }
		s++;
		switch (*s) {
		case 'n': *o++ = '\n'; s++; break;
		case 't': *o++ = '\t'; s++; break;
		case 'r': *o++ = '\r'; s++; break;
		case 'b': *o++ = '\b'; s++; break;
		case 'f': *o++ = '\f'; s++; break;
		case 'u': {
			unsigned long c = hex4(s + 1);
			s += 5;
			if (c >= 0xD800 && c < 0xDC00 && s[0] == '\\' && s[1] == 'u') {
				unsigned long d = hex4(s + 2);
				c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00);
				s += 6;
			}
			o += put8(o, c);
			break;
		}
		default: *o++ = *s++; // " \ /
		}
	}
	*o = 0;
	if (*p == '"') p++;
	return (pr_value){.kind = PR_STR, .str = out, .n = (size_t)(o - out)};
}

static pr_value value(void) {
	ws();
	if (*p == '"') return str();
	if (*p == '[') {
		pr_value l = pr_list();
		p++;
		for (ws(); *p && *p != ']'; ws()) {
			pr_push(&arena, &l, value());
			ws();
			if (*p == ',') p++;
		}
		if (*p) p++;
		return l;
	}
	if (*p == '{') {
		pr_value m = pr_map();
		p++;
		for (ws(); *p && *p != '}'; ws()) {
			if (*p != '"') break;
			pr_value k = str();
			ws();
			if (*p == ':') p++;
			pr_put(&arena, &m, k.str, value());
			ws();
			if (*p == ',') p++;
		}
		if (*p) p++;
		return m;
	}
	if (!strncmp(p, "true", 4)) { p += 4; return pr_bool(1); }
	if (!strncmp(p, "false", 5)) { p += 5; return pr_bool(0); }
	if (!strncmp(p, "null", 4)) { p += 4; return pr_null(); }
	char *end;
	double d = strtod(p, &end);
	if (end == p) end = (char *)p + 1; // not json: past it
	p = end;
	return pr_num(d);
}

// writing

static void text(const char *s, size_t n) {
	putchar('"');
	for (size_t i = 0; i < n; i++) {
		unsigned char c = (unsigned char)s[i];
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

static void write_value(const pr_value *v) {
	switch (v->kind) {
	case PR_NULL: fputs("null", stdout); break;
	case PR_BOOL: fputs(v->yes ? "true" : "false", stdout); break;
	case PR_NUM:
		if (v->num == floor(v->num) && fabs(v->num) < 1e21) printf("%.0f", v->num == 0 ? 0.0 : v->num);
		else printf("%.17g", v->num);
		break;
	case PR_STR: text(v->str, v->n); break;
	case PR_LIST:
		putchar('[');
		for (size_t i = 0; i < v->n; i++) {
			if (i) putchar(',');
			write_value(&v->items[i]);
		}
		putchar(']');
		break;
	default:
		putchar('{');
		for (size_t i = 0; i < v->n; i++) {
			if (i) putchar(',');
			text(v->keys[i], strlen(v->keys[i]));
			putchar(':');
			write_value(&v->items[i]);
		}
		putchar('}');
	}
}

static void write_answer(const pr_answer *r) {
	if (r->kind == PR_YES) fputs("{\"yes\":true}", stdout);
	else if (r->kind == PR_PENDING) fputs("{\"pending\":true}", stdout);
	else {
		fputs("{\"no\":", stdout);
		write_value(&r->why);
		putchar('}');
	}
}

static void write_ask(const pr_ask *ask) {
	fputs("{\"op\":", stdout);
	text(ask->op, strlen(ask->op));
	fputs(",\"args\":", stdout);
	write_value(&ask->args);
	putchar('}');
}

static void write_asks(const pr_asks *r) {
	putchar('[');
	for (size_t i = 0; i < r->n; i++) {
		if (i) putchar(',');
		write_ask(&r->items[i]);
	}
	putchar(']');
}

// requests

static const char *sv(const pr_value *v) { return v && v->kind == PR_STR ? v->str : ""; }

static int get(void *ctx, const char *id, const pr_value **out) {
	const pr_value *node = pr_get(ctx, id);
	if (!node) return 0;
	*out = pr_get(node, "value");
	return 1;
}

static pr_answer given(const void *ctx, pr_arena *a, const pr_value *actor, const char *op,
		const pr_value *args, const pr_read *read) {
	(void)a; (void)actor; (void)op; (void)args; (void)read;
	return *(const pr_answer *)ctx;
}

static pr_may policy(const pr_value *v) {
	if (v->kind == PR_STR) return pr_anyone;
	const pr_value *r = pr_get(v, "rules"), *f = pr_get(v, "first"), *a = pr_get(v, "answer");
	if (r) return pr_rules(&arena, sv(r));
	if (f) {
		pr_may *mays = pr_alloc(&arena, (f->n + 1) * sizeof *mays);
		for (size_t i = 0; i < f->n; i++) mays[i] = policy(&f->items[i]);
		return pr_first(&arena, mays, f->n);
	}
	pr_answer *ans = pr_alloc(&arena, sizeof *ans);
	*ans = (pr_answer){.kind = PR_YES};
	if (a && pr_get(a, "pending")) ans->kind = PR_PENDING;
	else if (a && pr_get(a, "no")) *ans = (pr_answer){PR_NO, *pr_get(a, "no")};
	return (pr_may){given, ans};
}

static pr_ask ask_of(const pr_value *v) {
	const pr_value *args = pr_get(v, "args");
	return (pr_ask){sv(pr_get(v, "op")), args ? *args : pr_map()};
}

// the names of a list of [name, value] pairs, each once, in first-seen order
static const char **names(const pr_value *pairs, size_t *n) {
	const char **out = pr_alloc(&arena, (pairs->n + 1) * sizeof *out);
	*n = 0;
	for (size_t i = 0; i < pairs->n; i++) {
		const pr_value *pair = &pairs->items[i];
		const char *name = pair->kind == PR_LIST && pair->n ? sv(&pair->items[0]) : "";
		size_t k = 0;
		while (k < *n && strcmp(out[k], name)) k++;
		if (k == *n) out[(*n)++] = name;
	}
	return out;
}

static void answer(const pr_value *r) {
	const char *op = sv(pr_get(r, "op"));
	const pr_value *nodes = pr_get(r, "nodes"), *none = &(pr_value){.kind = PR_MAP};
	pr_read read = {get, (void *)(nodes ? nodes : none)};
	const pr_value *actor = pr_get(r, "actor"), *null = &(pr_value){.kind = PR_NULL};
	if (!actor) actor = null;
	if (!strcmp(op, "may") || !strcmp(op, "check")) {
		pr_may may = policy(pr_get(r, "policy"));
		if (op[0] == 'm') {
			pr_ask ask = ask_of(pr_get(r, "ask"));
			pr_answer a = pr_ask_may(&may, &arena, actor, ask.op, &ask.args, &read);
			fputs("{\"answer\":", stdout);
			write_answer(&a);
		} else {
			const pr_value *l = pr_get(r, "asks");
			pr_ask *asks = pr_alloc(&arena, (l->n + 1) * sizeof *asks);
			for (size_t i = 0; i < l->n; i++) asks[i] = ask_of(&l->items[i]);
			pr_checked c = pr_check(&may, &arena, actor, asks, l->n, &read);
			fputs("{\"answer\":", stdout);
			write_answer(&c.answer);
			if (c.has_at) printf(",\"at\":%zu", c.at);
		}
		puts("}");
	} else if (!strcmp(op, "pass")) {
		const pr_value *l = pr_get(r, "route");
		pr_step *route = pr_alloc(&arena, (l->n + 1) * sizeof *route);
		for (size_t i = 0; i < l->n; i++) {
			const pr_value *node = pr_get(&l->items[i], "node"), *name = pr_get(&l->items[i], "name");
			route[i] = (pr_step){node && node->kind == PR_STR ? node->str : NULL,
				name && name->kind == PR_STR ? name->str : NULL};
		}
		pr_asks asks = pr_pass(&arena, route, l->n);
		fputs("{\"asks\":", stdout);
		write_asks(&asks);
		puts("}");
	} else if (!strcmp(op, "list")) {
		pr_ask ask = pr_list_ask(&arena, sv(pr_get(r, "node")));
		fputs("{\"ask\":", stdout);
		write_ask(&ask);
		puts("}");
	} else if (!strcmp(op, "read")) {
		const pr_value *node = pr_get(r, "node"), *v = pr_get(node, "value");
		const pr_value *info = pr_get(node, "info"), *children = pr_get(node, "children");
		pr_value none = pr_list();
		size_t ninfo, nchildren;
		const char **in = names(info ? info : &none, &ninfo), **ch = names(children ? children : &none, &nchildren);
		pr_asks asks = pr_read_asks(&arena, sv(pr_get(node, "id")), v ? v->n : 0, in, ninfo, ch, nchildren);
		fputs("{\"asks\":", stdout);
		write_asks(&asks);
		puts("}");
	} else if (!strcmp(op, "edit")) {
		pr_ask ask = pr_edit(&arena, sv(pr_get(r, "edit")), sv(pr_get(r, "node")), pr_get(r, "object"),
			pr_get(r, "at"));
		fputs("{\"ask\":", stdout);
		write_ask(&ask);
		puts("}");
	} else if (!strcmp(op, "placing")) {
		pr_value empty = pr_list();
		const pr_value *before = pr_get(r, "before"), *after = pr_get(r, "after");
		pr_asks asks = pr_placing(&arena, sv(pr_get(r, "node")), sv(pr_get(r, "name")),
			before ? before : &empty, after ? after : &empty);
		fputs("{\"asks\":", stdout);
		write_asks(&asks);
		puts("}");
	} else if (!strcmp(op, "facts")) {
		pr_ask ask = ask_of(pr_get(r, "ask"));
		pr_value f = pr_facts(&arena, actor, ask.op, &ask.args);
		fputs("{\"facts\":", stdout);
		write_value(&f);
		puts("}");
	} else if (!strcmp(op, "matches")) {
		const pr_value *rule = pr_get(r, "rule"), *f = pr_get(r, "facts");
		printf("{\"matches\":%s}\n", pr_matches(rule ? rule : null, f ? f : none) ? "true" : "false");
	} else {
		fputs("{\"error\":", stdout);
		char *msg = pr_alloc(&arena, strlen(op) + 12);
		strcpy(msg, "unknown op ");
		strcat(msg, op);
		text(msg, strlen(msg));
		puts("}");
	}
}

int main(void) {
	char *line = NULL;
	size_t cap = 0;
	while (getline(&line, &cap, stdin) > 0) {
		p = line;
		ws();
		if (!*p) continue;
		pr_value r = value();
		answer(&r);
		pr_free(&arena);
		fflush(stdout);
	}
	free(line);
	return 0;
}
