// The C apply on the line protocol (newcore/conformance/apply/session.ts): one JSON request per
// line in, one answer per line out. A blop is in its JSON form (ENCODING.tex: "/" for bytes);
// names are lowercase hex.
//   {op: "create", node}            -> {}; the chains of the node, apply.h's check
//   {op: "add", blop, name}         -> "taken" | "passed" | {waiting: [names]} | {stuck: [names]} | {refused: code}
//   {op: "side", name}              -> {side} | {none: true}
//   {op: "versions", object, times} -> [{content, change, because}]; times: name to the caller's time
// With COMMIT defined (commit_harness.c), also:
//   {op: "commit", change, at, roots, random} -> {blop} | {code}
// A blop added is kept for the chains, so its request is not freed.
#include "apply.h"
#include "../../encoding/c/blop.h"
#ifdef COMMIT
#include "commit.h"
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void hex(const uint8_t *b, size_t n) {
	for (size_t i = 0; i < n; i++) printf("%02x", b[i]);
}

static bool unhex(const char *s, uint8_t *out, size_t n) {
	if (strlen(s) != 2 * n) return false;
	for (size_t i = 0; i < n; i++) {
		unsigned x;
		if (sscanf(s + 2 * i, "%2x", &x) != 1) return false;
		out[i] = (uint8_t)x;
	}
	return true;
}

static void names(uint8_t (*list)[32], size_t count) {
	putchar('[');
	for (size_t i = 0; i < count; i++) {
		if (i) putchar(',');
		putchar('"');
		hex(list[i], 32);
		putchar('"');
	}
	putchar(']');
}

static void print_json(const Json *value) {
	char *s = jsonPrint(value);
	fputs(s, stdout);
	free(s);
}

static void print_text(const char *text) {
	Json *j = jsonString(text);
	print_json(j);
	jsonFree(j);
}

// a side as a json.h value, fresh
static Json *json_of(const nt_value *v) {
	Json *j;
	switch (v->type) {
	case NT_NULL: return jsonNull();
	case NT_BOOL: return jsonBoolean(v->bool_);
	case NT_NUM: return jsonNumber(v->num);
	case NT_STR: return jsonStringOfLength(v->str, v->bytes);
	case NT_BYTES: return jsonBytes(v->data, v->bytes);
	case NT_TYPED: return jsonTyped((JsonKind)v->kind, v->data, nt_length(v));
	case NT_STAND: return jsonStand(json_of(v->items[0]));
	case NT_LIST:
		j = jsonArray();
		for (size_t i = 0; i < v->count; i++) jsonPush(j, json_of(v->items[i]));
		return j;
	default:
		j = jsonObject();
		for (size_t i = 0; i < v->count; i++) jsonAdd(j, v->keys[i], json_of(v->items[i]));
		return j;
	}
}

static void print_value(const nt_value *v) {
	Json *j = json_of(v);
	print_json(j);
	jsonFree(j);
}

static void print_version(const apply_version *v) {
	const ch_header *h = &v->change.header;
	fputs("{\"content\":", stdout);
	print_value(v->content);
	printf(",\"change\":{\"time\":%lld,\"actor\":", (long long)h->time);
	print_json(h->actor);
	if (h->reader) fputs(",\"reader\":", stdout), print_text(h->reader);
	if (h->has_site) {
		fputs(",\"site\":{\"file\":", stdout);
		print_text(h->site.file);
		printf(",\"line\":%ld", h->site.line);
		if (h->site.column) printf(",\"column\":%ld", h->site.column);
		if (h->site.function) fputs(",\"function\":", stdout), print_text(h->site.function);
		putchar('}');
	}
	if (h->cause) fputs(",\"cause\":", stdout), print_json(h->cause);
	fputs(",\"node\":", stdout);
	print_text(v->change.node);
	fputs("},\"because\":{\"layer\":", stdout);
	print_text(v->because.layer);
	const apply_place *p = v->because.place;
	const apply_why *w = v->because.why;
	printf(",\"place\":{\"lamport\":%lld,\"name\":\"%s\"},\"why\":{\"signer\":\"%s\"}}}", (long long)p->lamport, p->name, w->signer);
}

static void row(const chain_row *r) {
	if (r->kind == CHAIN_TAKEN) { fputs("\"taken\"", stdout); return; }
	if (r->kind == CHAIN_PASSED) { fputs("\"passed\"", stdout); return; }
	if (r->kind == CHAIN_REFUSED) printf("{\"refused\":\"%s\"}", chain_refusal_name(r->refusal));
	else {
		fputs(r->kind == CHAIN_WAITING ? "{\"waiting\":" : "{\"stuck\":", stdout);
		names(r->names, r->count);
		putchar('}');
	}
}

static int64_t time_of(void *context, const char *name) {
	const Json *t = jsonGet(context, name);
	return t && t->type == JSON_NUMBER ? (int64_t)t->number : 0;
}

#ifdef COMMIT
// the host's random bytes: the request's, in order
typedef struct {
	uint8_t *data;
	size_t length, used;
} source;
static void take(void *context, size_t n, uint8_t *out) {
	source *s = context;
	if (s->used + n > s->length) fputs("random: none left\n", stderr), exit(1);
	memcpy(out, s->data + s->used, n);
	s->used += n;
}

static bool at_of(const Json *at, commit_at *out) {
	const Json *v = jsonGet(at, "version"), *s = jsonGet(at, "span"), *p = jsonGet(at, "pop");
	int64_t a, b;
	if (v && jsonIsWhole(v, &a)) *out = (commit_at){COMMIT_VERSION, (long)a, (long)a + 1};
	else if (s && s->type == JSON_ARRAY && s->array.count == 2 && jsonIsWhole(s->array.items[0], &a) &&
			jsonIsWhole(s->array.items[1], &b)) {
		*out = (commit_at){COMMIT_SPAN, (long)a, (long)b};
	} else if (p && jsonIsWhole(p, &a)) *out = (commit_at){COMMIT_POP, (long)a, (long)a + 1};
	else if (p && p->type == JSON_ARRAY && p->array.count == 2 && jsonIsWhole(p->array.items[0], &a) &&
			jsonIsWhole(p->array.items[1], &b)) {
		*out = (commit_at){COMMIT_POP, (long)a, (long)b};
	} else return false;
	return true;
}
#endif

static chains *current;

int main(void) {
	char *line = NULL;
	size_t capacity = 0;
	while (getline(&line, &capacity, stdin) != -1) {
		if (strspn(line, " \t\r\n") == strlen(line)) continue;
		char *why = NULL;
		Json *request = jsonParse(line, strlen(line), &why);
		if (request == NULL) fprintf(stderr, "bad request: %s\n", why), exit(1);
		const char *op = jsonText(jsonGet(request, "op"));
		const char *text = jsonText(jsonGet(request, "name"));
		uint8_t name[32];
		// a blop added, or a change committed, is kept: the request lives on
		bool free_request = true;
		if (op == NULL) puts("{\"error\":\"unknown op undefined\"}");
		else if (strcmp(op, "create") == 0) {
			chain_free(current);
			current = chain_create(jsonText(jsonGet(request, "node")), apply_check, NULL);
			chain_release(current, apply_release);
			puts("{}");
		} else if (strcmp(op, "add") == 0 && text && unhex(text, name, 32)) {
			Json **slot = NULL;
			for (int i = 0; i < request->object.count; i++) {
				if (strcmp(request->object.members[i].key, "blop") == 0) slot = &request->object.members[i].value;
			}
			if (slot == NULL || !jsonDecode(slot)) fputs("bad blop\n", stderr), exit(1);
			chain_row r = chain_add(current, *slot, name);
			row(&r);
			putchar('\n');
			chain_row_free(&r);
			free_request = false;
		} else if (strcmp(op, "side") == 0 && text && unhex(text, name, 32)) {
			const nt_value *side = apply_side(current, name);
			if (side == NULL) puts("{\"none\":true}");
			else {
				fputs("{\"side\":", stdout);
				print_value(side);
				puts("}");
			}
		} else if (strcmp(op, "versions") == 0) {
			apply_version *vs;
			size_t n = apply_versions(current, jsonGet(request, "object"), time_of, jsonGet(request, "times"), &vs);
			putchar('[');
			for (size_t i = 0; i < n; i++) {
				if (i) putchar(',');
				print_version(&vs[i]);
			}
			puts("]");
			free(vs);
#ifdef COMMIT
		} else if (strcmp(op, "commit") == 0) {
			Json **slot = NULL;
			for (int i = 0; i < request->object.count; i++) {
				if (strcmp(request->object.members[i].key, "change") == 0) slot = &request->object.members[i].value;
			}
			commit_at at;
			const Json *r = jsonGet(request, "roots");
			const char *random = jsonText(jsonGet(request, "random"));
			if (slot == NULL || !jsonDecode(slot) || !at_of(jsonGet(request, "at"), &at) || r == NULL ||
					r->type != JSON_ARRAY || random == NULL) {
				fputs("bad commit\n", stderr), exit(1);
			}
			const char **roots = calloc((size_t)r->array.count + 1, sizeof *roots);
			for (int i = 0; i < r->array.count; i++) roots[i] = jsonText(r->array.items[i]);
			source bytes = {malloc(strlen(random) / 2 + 1), strlen(random) / 2, 0};
			if (!unhex(random, bytes.data, bytes.length)) fputs("bad random\n", stderr), exit(1);
			commit_code code;
			Json *blop = commit_make(current, *slot, at, roots, (size_t)r->array.count, take, &bytes, &code);
			if (blop) {
				fputs("{\"blop\":", stdout);
				print_json(blop);
				puts("}");
			} else printf("{\"code\":\"%s\"}\n", commit_code_name(code));
			free(roots);
			free(bytes.data);
			free_request = false;
#endif
		} else printf("{\"error\":\"unknown op %s\"}\n", op);
		if (free_request) jsonFree(request);
	}
	fflush(stdout);
	chain_free(current);
	free(line);
	return 0;
}
