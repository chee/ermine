// The C change library on the line protocol: one JSON request per line in, one answer per line
// out, in order. {op: "make", node, header, outside?} -> {change}. Same as harness.ts.
#define _POSIX_C_SOURCE 200809L
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "change.h"

static const char *p; // the scanner's place in the line

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

// at the opening quote: a new unescaped string, p after the closing quote
static char *str(void) {
	const char *s = ++p;
	while (*p && *p != '"') p += *p == '\\' && p[1] ? 2 : 1;
	char *out = malloc((size_t)(p - s) + 1), *o = out;
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
	return out;
}

// past one value
static void skip(void) {
	ws();
	if (*p == '"') { free(str()); return; }
	if (*p == '{' || *p == '[') {
		char close = *p++ == '{' ? '}' : ']';
		for (ws(); *p && *p != close; ws()) {
			skip();
			ws();
			if (*p == ':') { p++; skip(); ws(); }
			if (*p == ',') p++;
		}
		if (*p) p++;
		return;
	}
	while (*p && *p != ',' && *p != '}' && *p != ']' && *p != ' ' && *p != '\r' && *p != '\n') p++;
}

// one value as its raw text
static char *raw(void) {
	ws();
	const char *s = p;
	skip();
	return strndup(s, (size_t)(p - s));
}

// an object's members: next key (new string), p at its value; NULL at the end
static char *key(void) {
	ws();
	if (*p == '{' || *p == ',') p++;
	ws();
	if (*p != '"') return NULL;
	char *k = str();
	ws();
	if (*p == ':') p++;
	ws();
	return k;
}

static char *buf[16];
static int nbuf;
static char *keep(char *s) { return buf[nbuf++] = s; }

static void parse_site(ch_site *s) {
	char *k;
	while ((k = key())) {
		if (!strcmp(k, "file")) s->file = keep(str());
		else if (!strcmp(k, "line")) s->line = strtol(p, NULL, 10), skip();
		else if (!strcmp(k, "column")) s->column = strtol(p, NULL, 10), skip();
		else if (!strcmp(k, "function")) s->function = keep(str());
		else skip();
		free(k);
	}
	if (*p == '}') p++;
}

static void parse_header(ch_header *h) {
	char *k;
	while ((k = key())) {
		if (!strcmp(k, "time")) h->time = strtoll(p, NULL, 10), skip();
		else if (!strcmp(k, "actor")) h->actor = keep(raw());
		else if (!strcmp(k, "cause")) h->cause = keep(raw());
		else if (!strcmp(k, "reader")) h->reader = keep(str());
		else if (!strcmp(k, "site")) { h->has_site = 1; parse_site(&h->site); }
		else skip();
		free(k);
	}
	if (*p == '}') p++;
}

static void out(const char *s) {
	putchar('"');
	for (; *s; s++) {
		unsigned char c = (unsigned char)*s;
		if (c == '"' || c == '\\') printf("\\%c", c);
		else if (c < 0x20) printf("\\u%04x", c);
		else putchar(c);
	}
	putchar('"');
}

static void answer(char *line) {
	nbuf = 0;
	p = line;
	char *op = NULL, *node = NULL, *k;
	ch_header h = {0};
	int outside = 0;
	while ((k = key())) {
		if (!strcmp(k, "op")) op = keep(str());
		else if (!strcmp(k, "node")) node = keep(str());
		else if (!strcmp(k, "header")) parse_header(&h);
		else if (!strcmp(k, "outside")) outside = !strncmp(p, "true", 4), skip();
		else skip();
		free(k);
	}
	if (!op || strcmp(op, "make")) {
		fputs("{\"error\":\"unknown op ", stdout);
		out(op ? op : "");
		puts("\"}");
	} else {
		ch_change c = ch_make(node ? node : "", h, outside ? CH_HERE : NULL);
		printf("{\"change\":{\"time\":%" PRId64 ",\"node\":", c.header.time);
		out(c.node);
		if (c.header.actor) printf(",\"actor\":%s", (const char *)c.header.actor);
		if (c.header.reader) { fputs(",\"reader\":", stdout); out(c.header.reader); }
		if (c.header.has_site) {
			fputs(",\"site\":{\"file\":", stdout);
			out(c.header.site.file ? c.header.site.file : "");
			printf(",\"line\":%ld", c.header.site.line);
			if (c.header.site.column) printf(",\"column\":%ld", c.header.site.column);
			if (c.header.site.function) { fputs(",\"function\":", stdout); out(c.header.site.function); }
			putchar('}');
		}
		if (c.header.cause) printf(",\"cause\":%s", (const char *)c.header.cause);
		puts("}}");
	}
	while (nbuf) free(buf[--nbuf]);
}

int main(void) {
	char *line = NULL;
	size_t cap = 0;
	while (getline(&line, &cap, stdin) > 0) {
		p = line;
		ws();
		if (!*p) continue;
		answer(line);
		fflush(stdout);
	}
	free(line);
	return 0;
}
