// The C chain on the line protocol (newcore/conformance/chain/harness.ts): one JSON request per
// line in, one answer per line out. A blop is in its JSON form (ENCODING.tex: "/" for bytes);
// names are lowercase hex.
//   {op: "create", node}    -> {}; the chains of the node, apply.h's check
//   {op: "add", blop, name} -> "taken" | "passed" | {waiting: [names]} | {stuck: [names]} | {refused: code}
//   {op: "heads", object}   -> [{name, blop}], in the agreed order
//   {op: "get", name}       -> {blop} | {}
//   {op: "waiting"}         -> [{name, waiting: [names]}]
//   {op: "refused"}         -> [{name, refused: code} | {name, stuck: [names]}]
//   {op: "checked"}         -> [names]: each blop given to check since the last checked (or create)
// A blop added is kept for the chains, so its request is not freed.
#include "apply.h"
#include "../../encoding/c/blop.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void hex(const uint8_t *b, size_t n) {
	for (size_t i = 0; i < n; i++) printf("%02x", b[i]);
}

static bool unhex(const char *s, uint8_t name[32]) {
	if (strlen(s) != 64) return false;
	for (size_t i = 0; i < 32; i++) {
		unsigned x;
		if (sscanf(s + 2 * i, "%2x", &x) != 1) return false;
		name[i] = (uint8_t)x;
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

static void row(const chain_row *r, bool named) {
	if (r->kind == CHAIN_TAKEN) { fputs("\"taken\"", stdout); return; }
	if (r->kind == CHAIN_PASSED) { fputs("\"passed\"", stdout); return; }
	if (named) {
		fputs("{\"name\":\"", stdout);
		hex(r->name, 32);
		fputs("\",", stdout);
	} else putchar('{');
	if (r->kind == CHAIN_REFUSED) printf("\"refused\":\"%s\"", chain_refusal_name(r->refusal));
	else {
		fputs(r->kind == CHAIN_WAITING ? "\"waiting\":" : "\"stuck\":", stdout);
		names(r->names, r->count);
	}
	putchar('}');
}

static chains *current;
static uint8_t (*checked)[32];
static size_t checks, room;

// check, noting the blop's name
static bool check(void *context, chains *c, const Json *blop) {
	uint8_t *bytes;
	size_t length;
	if (blop_encode(blop, &bytes, &length).code != BLOP_OK) abort();
	if (checks == room) {
		room = room ? room * 2 : 16;
		checked = realloc(checked, room * sizeof *checked);
		if (checked == NULL) abort();
	}
	blop_name(bytes, length, checked[checks++]);
	free(bytes);
	return apply_check(context, c, blop);
}

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
		bool free_request = true;
		if (op == NULL) puts("{\"error\":\"unknown op undefined\"}");
		else if (strcmp(op, "create") == 0) {
			chain_free(current);
			current = chain_create(jsonText(jsonGet(request, "node")), check, NULL);
			chain_release(current, apply_release);
			checks = 0;
			puts("{}");
		} else if (strcmp(op, "add") == 0 && text && unhex(text, name)) {
			Json *blop = jsonGet(request, "blop");
			Json **slot = NULL;
			for (int i = 0; i < request->object.count; i++) {
				if (strcmp(request->object.members[i].key, "blop") == 0) slot = &request->object.members[i].value;
			}
			if (blop == NULL || !jsonDecode(slot)) fputs("bad blop\n", stderr), exit(1);
			chain_row r = chain_add(current, *slot, name);
			row(&r, false);
			putchar('\n');
			chain_row_free(&r);
			free_request = false;
		} else if (strcmp(op, "heads") == 0) {
			Json *object = jsonGet(request, "object");
			chain_head *hs;
			size_t n = chain_heads(current, object, &hs);
			putchar('[');
			for (size_t i = 0; i < n; i++) {
				if (i) putchar(',');
				fputs("{\"name\":\"", stdout);
				hex(hs[i].name, 32);
				fputs("\",\"blop\":", stdout);
				print_json(hs[i].blop);
				putchar('}');
			}
			puts("]");
			free(hs);
		} else if (strcmp(op, "get") == 0 && text && unhex(text, name)) {
			const Json *blop = chain_get(current, name);
			if (blop) {
				fputs("{\"blop\":", stdout);
				print_json(blop);
				puts("}");
			} else puts("{}");
		} else if (strcmp(op, "waiting") == 0 || strcmp(op, "refused") == 0) {
			chain_row *rows;
			size_t n = op[0] == 'w' ? chain_waiting(current, &rows) : chain_refused(current, &rows);
			putchar('[');
			for (size_t i = 0; i < n; i++) {
				if (i) putchar(',');
				row(&rows[i], true);
			}
			puts("]");
			chain_rows_free(rows, n);
		} else if (strcmp(op, "checked") == 0) {
			names(checked, checks);
			putchar('\n');
			checks = 0;
		} else printf("{\"error\":\"unknown op %s\"}\n", op);
		if (free_request) jsonFree(request);
	}
	fflush(stdout);
	chain_free(current);
	free(line);
	return 0;
}
