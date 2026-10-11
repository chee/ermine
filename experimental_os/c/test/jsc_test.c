// jsc_test.c: loaders/deno-js in JavaScriptCore (../jsc.c) against a
// stand-in interface, as ../../deno/runner_test.ts tries deno's runner: a
// program loaded, its setup run, its compute and handler made as
// SCHEDULER.tex's starts and placements, each called as the function the
// OS holds, and a read of the blitter's port turned into a Blitter. Then
// what crosses: values beyond JSON both ways, as CBOR over deno's pipe would
// carry them, a map's keys in CBOR's order, what is no value thrown, a
// program's mistake thrown, onCleanup, and a timer. The host is the four
// functions jsc.c uses, here.

#include "../jsc.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static int failures = 0;
#define CHECK(cond, what) do { if (!(cond)) { failures++; fprintf(stderr, "FAIL %s\n", what); } else printf("ok %s\n", what); } while (0)

// --- the host, as jsc.c sees it

static ErmosConfig config;
const ErmosConfig *hostConfig(Host *host) {
	(void)host;
	return &config;
}
int64_t hostNow(Host *host) {
	(void)host;
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (int64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
}
void hostWake(Host *host, int64_t at) {
	(void)host, (void)at;
}
// no vram driver here: no plane is held
uint32_t *vramHold(int64_t id, size_t *bytes, void **ref) {
	(void)id, (void)bytes, (void)ref;
	return NULL;
}
void vramDrop(void *ref) {
	(void)ref;
}
// no loader finding code here: no program's url
char *hostFinding(Host *host) {
	(void)host;
	return NULL;
}
static char said[4096];
void hostSay(Host *host, const char *format, ...) {
	(void)host;
	va_list ap;
	va_start(ap, format);
	vsnprintf(said, sizeof said, format, ap);
	va_end(ap);
	fprintf(stderr, "[say] %s\n", said);
}

// --- the stand-in interface: runner_test.ts's answers, and each operation kept

static struct {
	char op[32];
	Json *fields;
} ops[256];
static int nops;

static Json *parse(const char *text) {
	char *why = NULL;
	Json *v = jsonParse(text, strlen(text), &why);
	if (!v) fprintf(stderr, "bad test json: %s\n", why);
	return v;
}

static bool at(Json *fields, const char *path) {
	char *p = jsonPrint(jsonGet(fields, "address"));
	bool same = strcmp(p, path) == 0;
	free(p);
	return same;
}

static ErmErr op(void *self, const char *name, Json *fields, Json **out) {
	(void)self;
	if (nops < 256) {
		snprintf(ops[nops].op, sizeof ops[nops].op, "%s", name);
		ops[nops++].fields = fields;
	}
	*out = jsonNull();
	if (!strcmp(name, "read") && at(fields, "[\"/\",\"hw\",\"devices\",\"blitter\",\"port\"]")) *out = parse("{\"items\": [{\"value\": {\"live\": \"blitter\"}}]}");
	else if (!strcmp(name, "read") && at(fields, "[\"/\",\"hw\",\"font\"]")) {
		uint8_t alpha[3 * 8 * 16] = { 0 };
		Json *rom = parse("{\"w\": 8, \"h\": 16, \"chars\": \"abc\"}");
		jsonAdd(rom, "alpha", jsonTyped(JSON_UINT8, alpha, sizeof alpha));
		Json *item = jsonObject();
		jsonAdd(item, "value", rom);
		Json *items = jsonArray();
		jsonPush(items, item);
		*out = jsonObject();
		jsonAdd(*out, "items", items);
	} else if (!strcmp(name, "read") && at(fields, "[\"/\",\"dev\",\"clock\",\"wall\"]")) *out = parse("{\"items\": [{\"value\": \"12:00\"}]}");
	else if (!strcmp(name, "read") && at(fields, "[\"@1\",\"data\"]")) *out = parse("{\"items\": [{\"value\": {\"path\": [\"x\"]}}]}");
	else if (!strcmp(name, "read")) *out = parse("{\"items\": []}");
	else if (!strcmp(name, "cwd")) *out = parse("{\"cwd\": [\"home\"]}");
	else if (!strcmp(name, "start")) *out = parse("{\"change\": {\"id\": \"@2\"}}");
	else if (!strcmp(name, "place")) *out = parse("{\"change\": {\"id\": \"@1.p\"}}");
	else if (!strcmp(name, "unplace")) return ermDetail(ermInvalid("not-found"), "text", jsonString("nothing there"));
	return ermOk();
}

static const ErmPartApi api = { NULL, op };

static ErmFn cleaned;
static int ncleaned;
static void onCleanup(void *data, ErmFn f) {
	(void)data;
	cleaned = f;
	ncleaned++;
}

static int find(const char *name, int from) {
	for (int i = from; i < nops; i++) if (!strcmp(ops[i].op, name)) return i;
	return -1;
}

static const char *nameOf(Json *fields) {
	const char *n = jsonText(jsonGet(fields, "name"));
	return n ? n : "";
}

static bool same(Json *a, const char *text) {
	Json *b = parse(text);
	bool eq = jsonEqual(a, b);
	if (!eq) {
		char *p = jsonPrint(a);
		fprintf(stderr, "  got %s\n  not %s\n", p, text);
		free(p);
	}
	return eq;
}

static const char *PROGRAM =
	"export default ({ api, compute, handler, onCleanup, self, name, data, cwd }) => {\n"
	"  const blit = api.read({ address: [\"/\", \"hw\", \"devices\", \"blitter\", \"port\"] })[0].value\n"
	"  const width = blit.measure(\"abc\")\n"
	"  compute(\"status\", ({ api }) => ({ wall: api.read({ address: [\"/\", \"dev\", \"clock\", \"wall\"] })[0]?.value ?? null, width }))\n"
	"  handler(\"hello\", ({ api }, who) => \"hello \" + who + \" from \" + self)\n"
	"  handler(\"echo\", (_, x) => x)\n"
	"  const kind = (x) => x === null ? \"null\" : ArrayBuffer.isView(x) ? x.constructor.name + \":\" + Array.from(x, String).join(\",\") : x instanceof ArrayBuffer ? \"bytes:\" + new Uint8Array(x).join(\",\") : Object.is(x, -0) ? \"-0\" : typeof x === \"string\" ? \"string:\" + Array.from(x, (c) => c.codePointAt(0)).join(\",\") : Array.isArray(x) ? \"list\" : typeof x === \"object\" ? \"map:\" + Object.keys(x).join(\",\") : typeof x\n"
	"  handler(\"kinds\", (_, ...xs) => xs.map(kind))\n"
	"  handler(\"make\", () => ({ bytes: new Uint8Array([1, 2]).buffer, u8: new Uint8Array([3]), f64: new Float64Array([-0, 1.5]), i64: new BigInt64Array([-2n]), sub: new Uint16Array([9, 8, 7]).subarray(1), lone: \"a\\ud800\", nul: \"a\\u0000b\", neg: -0, gone: undefined, list: [1, undefined] }))\n"
	"  handler(\"function\", () => () => 1)\n"
	"  handler(\"date\", () => new Date(0))\n"
	"  handler(\"cycle\", () => { const a = {}; a.a = a; return a })\n"
	"  handler(\"mistake\", () => { throw new Error(\"oops\") })\n"
	"  handler(\"refused\", ({ api }) => api.unplace({ address: [\"x\"] }))\n"
	"  handler(\"caught\", ({ api }) => { try { api.unplace({ address: [\"x\"] }) } catch (e) { return e.message } })\n"
	"  handler(\"text\", (_, bytes) => new TextDecoder().decode(new TextEncoder().encode(\"é😀\")) + \"|\" + new TextDecoder().decode(new Uint8Array(bytes)))\n"
	"  handler(\"later\", ({ api }) => { setTimeout(() => api.write({ address: [\"late\"], patches: [] }), 0); const t = setTimeout(() => api.write({ address: [\"never\"], patches: [] }), 0); clearTimeout(t); return null })\n"
	"  onCleanup(({ killed }) => api.write({ address: [\"cleaned\"], patches: [{ killed }] }))\n"
	"  return { self, name, data: data[0]?.value ?? null, cwd }\n"
	"}\n";

/** calls the handler placed by name with args (a JSON list) */
static ErmErr callHandler(const char *name, const char *args, Json **out) {
	for (int i = 0; i < nops; i++) {
		if (strcmp(ops[i].op, "place") || strcmp(nameOf(ops[i].fields), name)) continue;
		ErmFn f;
		if (!ermFunctionOf(jsonGet(ops[i].fields, "value"), &f)) break;
		ErmGiven g = { .part = ERM_HANDLER, .api = &api, .args = args ? parse(args) : NULL };
		return f.call(f.data, &g, out);
	}
	fprintf(stderr, "no handler %s\n", name);
	return ermInvalid("no-handler");
}

int main(int argc, char **argv) {
	config.runner = argc > 1 ? argv[1] : "experimental_os/deno/runner.ts";
	Host *host = NULL;
	ErmLoader loader = jscLoader(host);
	ErmCode code;
	Json *program = jsonObject();
	jsonAdd(program, "source", jsonString(PROGRAM));
	ErmErr err = loader.load(loader.data, program, &code);
	CHECK(!err.kind && code.shape == ERM_SETUP, "the program loads, as a setup");
	ErmCode again;
	loader.load(loader.data, program, &again);
	CHECK(again.setup.call == code.setup.call, "the same source, the same code");

	Json *out = NULL;
	ErmGiven setup = { .part = ERM_SETUP, .api = &api, .self = jsonString("@1"), .name = jsonString("@1"), .onCleanup = onCleanup };
	err = code.setup.call(code.setup.data, &setup, &out);
	CHECK(!err.kind && same(out, "{\"self\": \"@1\", \"name\": \"@1\", \"data\": {\"path\": [\"x\"]}, \"cwd\": [\"home\"]}"), "the setup runs, given self, name, data and cwd");
	int s = find("start", 0);
	CHECK(s >= 0 && same(jsonGet(ops[s].fields, "name"), "\"status\"") && at(ops[s].fields, "[\"@1\"]"), "compute starts a child inside the program's node");
	ErmFn compute;
	CHECK(s >= 0 && ermFunctionOf(jsonGet(jsonGet(ops[s].fields, "program"), "compute"), &compute), "its compute is a function here");
	int on = find("place", 0);
	CHECK(on >= 0 && same(jsonGet(ops[on].fields, "name"), "\"on\"") && same(jsonGet(ops[on].fields, "id"), "\"@1.1\""), "handler places on/, an ephemeral node given its id");
	CHECK(ncleaned == 1, "onCleanup hands the OS a function");

	ErmGiven c = { .part = ERM_COMPUTE, .api = &api, .self = jsonString("@2"), .name = jsonString("status") };
	err = compute.call(compute.data, &c, &out);
	CHECK(!err.kind && same(out, "{\"wall\": \"12:00\", \"width\": 24}"), "the compute runs, through its own interface, with the blitter the setup made");
	CHECK(!callHandler("hello", "[\"chee\"]", &out).kind && same(out, "\"hello chee from @1\""), "a handler is called with its args");

	// values into the runner: each kind as CBOR would have made it
	Json *args = jsonArray();
	unsigned char bytes[] = { 0, 255 };
	jsonPush(args, jsonBytes(bytes, 2));
	uint8_t u8[] = { 1, 2 };
	jsonPush(args, jsonTyped(JSON_UINT8, u8, 2));
	double f64[] = { 0.5, -1 };
	jsonPush(args, jsonTyped(JSON_FLOAT64, f64, 2));
	int64_t i64[] = { -3 };
	jsonPush(args, jsonTyped(JSON_INT64, i64, 1));
	jsonPush(args, jsonStringOfLength("a\xc0\x80" "b", 4));
	jsonPush(args, jsonNumber(-0.0));
	jsonPush(args, parse("{\"bb\": 1, \"a\": 2, \"10\": 3, \"c\": 4}"));
	jsonPush(args, jsonLive("thing"));
	for (int i = 0; i < nops; i++) {
		if (strcmp(ops[i].op, "place") || strcmp(nameOf(ops[i].fields), "kinds")) continue;
		ErmFn f;
		ermFunctionOf(jsonGet(ops[i].fields, "value"), &f);
		ErmGiven g = { .part = ERM_HANDLER, .api = &api, .args = args };
		err = f.call(f.data, &g, &out);
	}
	CHECK(!err.kind && same(out, "[\"bytes:0,255\", \"Uint8Array:1,2\", \"Float64Array:0.5,-1\", \"BigInt64Array:-3\", \"string:97,0,98\", \"-0\", \"map:10,a,c,bb\", \"map:live\"]"),
	      "values into the runner: bytes, typed arrays, U+0000, -0, keys in CBOR's order, a live value");

	// values from the runner
	err = callHandler("make", NULL, &out);
	Json *want = jsonObject();
	unsigned char b2[] = { 1, 2 };
	jsonAdd(want, "i64", jsonTyped(JSON_INT64, (int64_t[]){ -2 }, 1));
	jsonAdd(want, "nul", jsonStringOfLength("a\xc0\x80" "b", 4));
	jsonAdd(want, "neg", jsonNumber(-0.0));
	jsonAdd(want, "sub", jsonTyped(JSON_UINT16, (uint16_t[]){ 8, 7 }, 2));
	jsonAdd(want, "f64", jsonTyped(JSON_FLOAT64, (double[]){ -0.0, 1.5 }, 2));
	jsonAdd(want, "list", parse("[1, null]"));
	jsonAdd(want, "lone", jsonString("a\xef\xbf\xbd"));
	jsonAdd(want, "bytes", jsonBytes(b2, 2));
	jsonAdd(want, "u8", jsonTyped(JSON_UINT8, (uint8_t[]){ 3 }, 1));
	CHECK(!err.kind && jsonEqual(out, want), "values from the runner: bytes, typed arrays (a view's own part), -0, U+0000, a lone surrogate as U+FFFD, undefined gone");
	char *keys = jsonPrint(out);
	CHECK(strncmp(keys, "{\"u8\":", 6) == 0 && strstr(keys, "\"f64\"") < strstr(keys, "\"i64\"") && strstr(keys, "\"lone\"") < strstr(keys, "\"bytes\""), "a map from the runner has its keys in CBOR's order");
	free(keys);
	CHECK(callHandler("function", NULL, &out).kind == ERM_THROWN, "a function returned is no value: thrown");
	CHECK(callHandler("date", NULL, &out).kind == ERM_THROWN, "a class's object returned is no value: thrown");
	CHECK(callHandler("cycle", NULL, &out).kind == ERM_THROWN, "a value that holds itself: thrown");
	err = callHandler("mistake", NULL, &out);
	CHECK(err.kind == ERM_THROWN && same(err.why, "{\"code\": \"thrown\", \"site\": {\"file\": \"js/js1\", \"line\": 13}, \"text\": \"oops\"}"), "a program's mistake is thrown, with its text and line");
	err = callHandler("refused", NULL, &out);
	CHECK(err.kind == ERM_THROWN && same(err.why, "{\"code\": \"not-found\", \"text\": \"nothing there\", \"kind\": \"invalid\"}"), "an operation's error not caught is the part's, as the OS said it");
	CHECK(!callHandler("caught", NULL, &out).kind && same(out, "\"nothing there\""), "an operation's error is thrown in the program");
	Json *bytesArg = jsonArray();
	jsonPush(bytesArg, jsonBytes("\xc3\xa9\xe2\x82", 4));
	for (int i = 0; i < nops; i++) {
		if (strcmp(ops[i].op, "place") || strcmp(nameOf(ops[i].fields), "text")) continue;
		ErmFn f;
		ermFunctionOf(jsonGet(ops[i].fields, "value"), &f);
		ErmGiven g = { .part = ERM_HANDLER, .api = &api, .args = bytesArg };
		err = f.call(f.data, &g, &out);
	}
	CHECK(!err.kind && same(out, "\"é😀|é\\ufffd\""), "UTF-8 both ways, a cut character U+FFFD");

	// a timer: kept here, called when due; one cleared is not
	int before = nops;
	CHECK(!callHandler("later", NULL, &out).kind && find("timer", before) < 0, "setTimeout asks the OS for nothing it sees as an operation");
	jscTimers(host);
	int late = find("write", before);
	CHECK(late >= 0 && at(ops[late].fields, "[\"late\"]") && find("write", late + 1) < 0, "a timer due is called, through the part that set it; one cleared is not");

	// the cleanup
	ErmGiven k = { .part = ERM_CLEANUP, .killed = jsonBoolean(true) };
	before = nops;
	cleaned.call(cleaned.data, &k, &out);
	int w = find("write", before);
	CHECK(w >= 0 && same(jsonGet(ops[w].fields, "patches"), "[{\"killed\": true}]"), "a cleanup is called, killed, and acts through the setup's interface it holds");

	jscStop(host);
	if (failures) {
		fprintf(stderr, "%d failed\n", failures);
		return 1;
	}
	printf("jsc_test: passed\n");
	return 0;
}
