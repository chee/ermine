// The C ids (ids.h) on the line protocol of typescript/ids_harness.ts, which documents it
// (conformance/c/harness.h has the loop). JSON's strings hold U+0000 as C0 80 and a lone surrogate
// as WTF-8: a string is handed on as UTF-8, NUL as 00, a surrogate as it is (refused)
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../conformance/c/harness.h"
#include "ids.h"

// the string's UTF-8 and its length, for the line; NULL when v is no string
static const char *utf8(const op_value *v, size_t *length) {
	if (v == NULL || v->type != OP_STR) return NULL;
	char *out = hh_take(v->bytes + 1);
	size_t k = 0;
	for (size_t i = 0; i < v->bytes; i++) {
		if ((unsigned char)v->str[i] == 0xc0 && i + 1 < v->bytes && (unsigned char)v->str[i + 1] == 0x80) {
			out[k++] = 0;
			i++;
		} else out[k++] = v->str[i];
	}
	out[k] = 0;
	*length = k;
	return out;
}

static int value(char c) {
	if (c >= '0' && c <= '9') return c - '0';
	if (c >= 'a' && c <= 'f') return c - 'a' + 10;
	return -1;
}

// lowercase hex's bytes, for the line; NULL when not hex
static uint8_t *unhex(const char *s, size_t *length) {
	if (s == NULL || strlen(s) % 2) return NULL;
	size_t n = strlen(s) / 2;
	uint8_t *out = hh_take(n);
	for (size_t i = 0; i < n; i++) {
		int hi = value(s[2 * i]), lo = value(s[2 * i + 1]);
		if (hi < 0 || lo < 0) return NULL;
		out[i] = (uint8_t)(hi << 4 | lo);
	}
	*length = n;
	return out;
}

static void hex(FILE *out, const uint8_t *b, size_t n) {
	fputc('"', out);
	for (size_t i = 0; i < n; i++) fprintf(out, "%02x", b[i]);
	fputc('"', out);
}

// { key: hex }
static void answer_hex(FILE *out, const char *key, const uint8_t *b, size_t n) {
	fprintf(out, "{\"%s\":", key);
	if (b == NULL) fputs("null", out);
	else hex(out, b, n);
	fputc('}', out);
}

// an input: a string's UTF-8 (checked: utf8 true), or { hex }'s bytes
static bool input(const op_value *v, id_part *p, bool *text) {
	size_t n;
	if (v != NULL && v->type == OP_STR) {
		p->data = (const uint8_t *)utf8(v, &n);
		p->length = n;
		*text = true;
		return true;
	}
	const uint8_t *b = unhex(hh_str(v, "hex"), &n);
	if (b == NULL) return false;
	p->data = b, p->length = n;
	*text = false;
	return true;
}

static const char *kinds[] = {NULL, "fresh", "hashed", "key"};

void hh_answer(const op_value *r, FILE *out) {
	const char *op = hh_str(r, "op");
	if (op == NULL) {
		hh_unknown(out, r);
		return;
	}
	uint8_t id[ID_MAX];
	size_t n;
	if (strcmp(op, "fresh") == 0) {
		uint8_t random[16], a[ID_SHORT], b[ID_SHORT], back[ID_MAX];
		char text[ID_TEXT];
		arc4random_buf(random, 16);
		id_fresh(random, a);
		arc4random_buf(random, 16);
		id_fresh(random, b);
		size_t t = id_text(a, ID_SHORT, text);
		size_t m = t ? id_parse(text, t, back) : 0;
		const char *k = kinds[id_kind_of(a, ID_SHORT)];
		fputs("{\"kind\":", out);
		if (k) op_json_string(out, k);
		else fputs("null", out);
		fprintf(out, ",\"size\":%d,\"head\":", ID_SHORT);
		hex(out, a, 2);
		fprintf(out, ",\"round\":%s,\"differs\":%s}", m == ID_SHORT && memcmp(back, a, m) == 0 ? "true" : "false",
		        memcmp(a, b, ID_SHORT) != 0 ? "true" : "false");
	} else if (strcmp(op, "hashed") == 0) {
		const op_value *inputs = op_get(r, "inputs");
		const op_value *domain = op_get(r, "domain");
		size_t dn;
		const char *d = utf8(domain, &dn);
		if (d == NULL || inputs == NULL || inputs->type != OP_LIST) {
			hh_error(out, "hashed: no domain or inputs");
			return;
		}
		id_part *parts = hh_take(inputs->count * sizeof *parts);
		for (size_t i = 0; i < inputs->count; i++) {
			bool text;
			if (!input(inputs->items[i], &parts[i], &text)) {
				hh_error(out, "hashed: input %zu: not a string or { hex }", i);
				return;
			}
			if (text && !id_utf8(parts[i].data, parts[i].length)) {
				hh_error(out, "hashed: input %zu: not UTF-8", i);
				return;
			}
		}
		if (strlen(d) != dn || !id_hashed(d, parts, inputs->count, id)) {
			hh_error(out, "hashed: the domain is not UTF-8");
			return;
		}
		answer_hex(out, "id", id, ID_SHORT);
	} else if (strcmp(op, "child") == 0) {
		size_t pn;
		const uint8_t *parent = unhex(hh_str(r, "parent"), &pn);
		const char *name = utf8(op_get(r, "name"), &n);
		if (parent == NULL || name == NULL || !id_child(parent, pn, name, n, id)) {
			hh_error(out, "child: the parent is not an ermine id, or no name");
			return;
		}
		answer_hex(out, "id", id, ID_SHORT);
	} else if (strcmp(op, "outside") == 0) {
		id_part p;
		bool text;
		if (!input(op_get(r, "outside"), &p, &text) || !id_outside(p.data, p.length, text, id)) {
			hh_error(out, "outside: not a string or { hex }, or not UTF-8");
			return;
		}
		answer_hex(out, "id", id, ID_SHORT);
	} else if (strcmp(op, "kind") == 0 || strcmp(op, "text") == 0) {
		const uint8_t *b = unhex(hh_str(r, "id"), &n);
		if (b == NULL) {
			hh_error(out, "%s: not hex", op);
			return;
		}
		if (strcmp(op, "kind") == 0) {
			const char *k = kinds[id_kind_of(b, n)];
			fputs("{\"kind\":", out);
			if (k) op_json_string(out, k);
			else fputs("null", out);
			fputc('}', out);
		} else {
			char text[ID_TEXT];
			fputs("{\"text\":", out);
			if (id_text(b, n, text)) op_json_string(out, text);
			else fputs("null", out);
			fputc('}', out);
		}
	} else if (strcmp(op, "parse") == 0) {
		const char *text = utf8(op_get(r, "text"), &n);
		if (text == NULL) {
			hh_error(out, "parse: no text");
			return;
		}
		size_t m = id_parse(text, n, id);
		answer_hex(out, "id", m ? id : NULL, m);
	} else hh_unknown(out, r);
}
