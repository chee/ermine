// jsc.c: JavaScript programs, in macOS's JavaScriptCore, in the OS (jsc.h).
// The runner is js/runner.js (runner.ts bundled), evaluated once. A program is
// a module whose default export is its setup; it is given what newOS's API
// gives a part (api.h; PORT.md, Programs in JS), and imports any helpers it
// wants ("ermine:kit"). A wasm module (jscWasm: C, by the C runner) is loaded
// by the runner's ermine:wasm (js/wasm.ts) instead, and runs as parts the
// same way.
//
// Each part the API runs is a call into the runner's run(f, info), which
// builds the part's map and calls f. Meanwhile the part's operations come back
// here through __ermineOp(handle, op, ...), handle naming the part's interface
// while the part runs (a map works until its part returns): each is a word of
// the API's, done by the one dispatch (words.h) once its arguments are values.
// Values cross as JavaScript values made from op_value here, and back: bytes a
// Uint8Array, a typed array its class, a stand-in the runner's Stand, a
// function a live value (ap_live) that calls it, and a live value of the
// program's own back as its function.

#include "jsc.h"

#include "drivers.h"
#include "words.h"

#include <JavaScriptCore/JavaScriptCore.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/** a part running: its given, while it runs */
typedef struct Frame {
	ap_given *g;
	int64_t id; // never given twice: a map kept past its part names no frame
	bool alive;
} Frame;

typedef struct Jsc {
	Host *host;
	JSGlobalContextRef ctx;
	JSObjectRef run, load, wasm, stand, isStand; // the runner's
	JSValueRef pending;                    // the runner's PENDING
	JSObjectRef object;                    // Object.prototype
	JSObjectRef big64, bigu64;
	bool up, gone;
	Frame *frames;
	int nframes, room;
	int64_t ids; // the last frame id given
} Jsc;

static Jsc js;

/** a JavaScript function as the scheduler's: a program's setup (its source, or a wasm module's bytes, loaded once) or a function of a program's */
typedef struct JsFn {
	ap_fn base;
	JSObjectRef f;  // NULL until a module is loaded
	char *source, *url;
	unsigned char *wasm; // a module's bytes, for ermine:wasm (jscWasm); NULL: source is JavaScript
	size_t nwasm;
} JsFn;

static const ap_error *callJs(ap_fn *self, ap_given *g, op_value **out, int *pending);

// --- strings: UTF-8 (U+0000 as C0 80) and JavaScript's UTF-16

static JSStringRef jsText(const char *s, size_t n) {
	JSChar small[256], *u = n <= 256 ? small : malloc(n * sizeof *u);
	size_t k = 0;
	const unsigned char *b = (const unsigned char *)s;
	for (size_t i = 0; i < n;) {
		unsigned x = b[i];
		uint32_t c;
		int more;
		if (x < 0x80) c = x, more = 0;
		else if ((x & 0xe0) == 0xc0) c = x & 0x1f, more = 1;
		else if ((x & 0xf0) == 0xe0) c = x & 0x0f, more = 2;
		else if ((x & 0xf8) == 0xf0) c = x & 0x07, more = 3;
		else c = 0xfffd, more = 0;
		if (i + (size_t)more >= n) {
			c = 0xfffd;
			i = n;
		} else {
			for (int j = 1; j <= more; j++) c = c << 6 | (b[i + j] & 0x3f);
			i += 1 + (size_t)more;
		}
		if (c >= 0x10000) {
			u[k++] = (JSChar)(0xd800 + ((c - 0x10000) >> 10));
			u[k++] = (JSChar)(0xdc00 + ((c - 0x10000) & 0x3ff));
		} else u[k++] = (JSChar)c;
	}
	JSStringRef out = JSStringCreateWithCharacters(u, k);
	if (u != small) free(u);
	return out;
}

static char *cText(JSStringRef s, size_t *n) {
	size_t len = JSStringGetLength(s);
	const JSChar *u = JSStringGetCharactersPtr(s);
	char *out = malloc(len * 3 + 1);
	size_t k = 0;
	for (size_t i = 0; i < len; i++) {
		uint32_t c = u[i];
		if (c >= 0xd800 && c < 0xdc00 && i + 1 < len && u[i + 1] >= 0xdc00 && u[i + 1] < 0xe000) c = 0x10000 + ((c - 0xd800) << 10) + (u[++i] - 0xdc00);
		else if (c >= 0xd800 && c < 0xe000) c = 0xfffd;
		if (c == 0) out[k++] = (char)0xc0, out[k++] = (char)0x80;
		else if (c < 0x80) out[k++] = (char)c;
		else if (c < 0x800) out[k++] = (char)(0xc0 | c >> 6), out[k++] = (char)(0x80 | (c & 63));
		else if (c < 0x10000) out[k++] = (char)(0xe0 | c >> 12), out[k++] = (char)(0x80 | (c >> 6 & 63)), out[k++] = (char)(0x80 | (c & 63));
		else out[k++] = (char)(0xf0 | c >> 18), out[k++] = (char)(0x80 | (c >> 12 & 63)), out[k++] = (char)(0x80 | (c >> 6 & 63)), out[k++] = (char)(0x80 | (c & 63));
	}
	out[k] = 0;
	if (n) *n = k;
	return out;
}

static JSValueRef jsStr(const char *s) {
	if (!s) return JSValueMakeNull(js.ctx);
	JSStringRef t = jsText(s, strlen(s));
	JSValueRef v = JSValueMakeString(js.ctx, t);
	JSStringRelease(t);
	return v;
}

/** a JavaScript string's text, fresh; NULL if it is not a string */
static char *textOf(JSValueRef v) {
	if (!v || !JSValueIsString(js.ctx, v)) return NULL;
	JSStringRef s = JSValueToStringCopy(js.ctx, v, NULL);
	char *t = cText(s, NULL);
	JSStringRelease(s);
	return t;
}

static void put(JSObjectRef o, const char *key, JSValueRef v) {
	JSStringRef k = JSStringCreateWithUTF8CString(key);
	JSObjectSetProperty(js.ctx, o, k, v, kJSPropertyAttributeNone, NULL);
	JSStringRelease(k);
}

static JSValueRef get(JSValueRef o, const char *key) {
	if (!o || !JSValueIsObject(js.ctx, o)) return NULL;
	JSStringRef k = JSStringCreateWithUTF8CString(key);
	JSValueRef v = JSObjectGetProperty(js.ctx, (JSObjectRef)o, k, NULL);
	JSStringRelease(k);
	return v && !JSValueIsUndefined(js.ctx, v) ? v : NULL;
}

static char *saying(JSValueRef e) {
	JSStringRef s = e ? JSValueToStringCopy(js.ctx, e, NULL) : NULL;
	if (!s) return strdup("an exception");
	char *t = cText(s, NULL);
	JSStringRelease(s);
	return t;
}

/** an Error with a code, thrown into the program */
static JSValueRef throwing(JSValueRef *exception, const char *code, const char *message) {
	JSValueRef text = jsStr(message ? message : code);
	JSObjectRef e = JSObjectMakeError(js.ctx, 1, &text, NULL);
	put(e, "code", jsStr(code));
	*exception = e;
	return JSValueMakeUndefined(js.ctx);
}

// --- values

static void freeBytes(void *bytes, void *data) {
	(void)data;
	free(bytes);
}

// by op_elements; no uint8: a Uint8Array is bytes
static const JSTypedArrayType kinds[] = {
	kJSTypedArrayTypeInt8Array, kJSTypedArrayTypeInt16Array, kJSTypedArrayTypeUint16Array, kJSTypedArrayTypeInt32Array,
	kJSTypedArrayTypeUint32Array, kJSTypedArrayTypeNone, kJSTypedArrayTypeNone, kJSTypedArrayTypeFloat32Array,
	kJSTypedArrayTypeFloat64Array,
};

/** a graph value as the program takes it; NULL as null */
static JSValueRef toJs(const op_value *v) {
	JSContextRef ctx = js.ctx;
	if (!v) return JSValueMakeNull(ctx);
	ap_fn *live = ap_live_fn(hostOs(js.host), v);
	if (live) {
		// a function of a program's comes back as itself; another (a driver's) as a stand-in
		if (live->call == callJs && ((JsFn *)live)->f) return ((JsFn *)live)->f;
		JSValueRef kind = jsStr("live");
		return JSObjectCallAsFunction(ctx, js.stand, NULL, 1, &kind, NULL);
	}
	switch (v->type) {
	case OP_NULL: return JSValueMakeNull(ctx);
	case OP_BOOL: return JSValueMakeBoolean(ctx, v->bool_);
	case OP_NUM: return JSValueMakeNumber(ctx, v->num);
	case OP_STR: {
		JSStringRef t = jsText(v->str, v->bytes);
		JSValueRef s = JSValueMakeString(ctx, t);
		JSStringRelease(t);
		return s;
	}
	case OP_BYTES: {
		void *copy = malloc(v->bytes ? v->bytes : 1);
		memcpy(copy, v->data, v->bytes);
		return JSObjectMakeTypedArrayWithBytesNoCopy(ctx, kJSTypedArrayTypeUint8Array, copy, v->bytes, freeBytes, NULL, NULL);
	}
	case OP_TYPED: {
		size_t n = v->bytes;
		void *copy = malloc(n ? n : 1);
		memcpy(copy, v->data, n);
		if (kinds[v->kind] != kJSTypedArrayTypeNone) return JSObjectMakeTypedArrayWithBytesNoCopy(ctx, kinds[v->kind], copy, n, freeBytes, NULL, NULL);
		JSValueRef buffer = JSObjectMakeArrayBufferWithBytesNoCopy(ctx, copy, n, freeBytes, NULL, NULL);
		return JSObjectCallAsConstructor(ctx, v->kind == OP_INT64 ? js.big64 : js.bigu64, 1, &buffer, NULL);
	}
	case OP_STAND: {
		JSValueRef kind = toJs(v->count ? v->items[0] : NULL);
		return JSObjectCallAsFunction(ctx, js.stand, NULL, 1, &kind, NULL);
	}
	case OP_LIST: {
		JSObjectRef a = JSObjectMakeArray(ctx, 0, NULL, NULL);
		for (size_t i = 0; i < v->count; i++) JSObjectSetPropertyAtIndex(ctx, a, (unsigned)i, toJs(v->items[i]), NULL);
		return a;
	}
	case OP_MAP: {
		JSObjectRef o = JSObjectMake(ctx, NULL, NULL);
		for (size_t i = 0; i < v->count; i++) put(o, v->keys[i], toJs(v->items[i]));
		return o;
	}
	}
	return JSValueMakeNull(ctx);
}

/** a live function let go (api.h, ap_fn's free): its JavaScript function unprotected, the JsFn freed */
static void jsFree(ap_fn *self) {
	JsFn *fn = (JsFn *)self;
	if (fn->f) JSValueUnprotect(js.ctx, fn->f);
	free(fn->source), free(fn->url), free(fn->wasm);
	free(fn);
}

static JsFn *jsFn(JSObjectRef f) {
	JsFn *fn = calloc(1, sizeof *fn);
	fn->base.call = callJs;
	fn->base.free = jsFree;
	fn->f = f;
	JSValueProtect(js.ctx, f);
	return fn;
}

/** the interface of the part running now (else the host's): a live function's maker */
static ap_api *runningApi(void) {
	for (int i = js.nframes - 1; i >= 0; i--)
		if (js.frames[i].alive) return js.frames[i].g->api;
	return ap_host(hostOs(js.host));
}

/** a program's value as the graph holds it: undefined as null, a function live; NULL with *why for what is no value */
static op_value *fromJs(JSValueRef v, int depth, const char **why) {
	JSContextRef ctx = js.ctx;
	if (depth > 512) return *why = "a value nests too deep, or holds itself", NULL;
	switch (JSValueGetType(ctx, v)) {
	case kJSTypeUndefined:
	case kJSTypeNull: return op_null();
	case kJSTypeBoolean: return op_bool(JSValueToBoolean(ctx, v));
	case kJSTypeNumber: return op_num(JSValueToNumber(ctx, v, NULL));
	case kJSTypeString: {
		JSStringRef str = JSValueToStringCopy(ctx, v, NULL);
		size_t n;
		char *t = cText(str, &n);
		JSStringRelease(str);
		return op_str_take(t, n);
	}
	case kJSTypeObject: break;
	default: return *why = "a symbol or a bigint is not a value", NULL;
	}
	JSObjectRef o = (JSObjectRef)v;
	if (JSObjectIsFunction(ctx, o)) return ap_live(runningApi(), &jsFn(o)->base);
	JSValueRef stand = JSObjectCallAsFunction(ctx, js.isStand, NULL, 1, &v, NULL);
	if (stand && JSValueIsObject(ctx, stand)) {
		op_value *kind = fromJs(get(stand, "kind"), depth + 1, why);
		return kind ? op_stand(kind) : NULL;
	}
	JSTypedArrayType type = JSValueGetTypedArrayType(ctx, v, NULL);
	if (type == kJSTypedArrayTypeArrayBuffer) return *why = "an ArrayBuffer is not a value: bytes are a Uint8Array", NULL;
	if (type == kJSTypedArrayTypeUint8Array) {
		char *base = JSObjectGetTypedArrayBytesPtr(ctx, o, NULL);
		return op_bytes(base + JSObjectGetTypedArrayByteOffset(ctx, o, NULL), JSObjectGetTypedArrayByteLength(ctx, o, NULL));
	}
	int kind = -1;
	for (int k = 0; k < (int)(sizeof kinds / sizeof *kinds); k++)
		if (kinds[k] != kJSTypedArrayTypeNone && kinds[k] == type) kind = k;
	if (kind < 0 && JSValueIsInstanceOfConstructor(ctx, v, js.big64, NULL)) kind = OP_INT64;
	if (kind < 0 && JSValueIsInstanceOfConstructor(ctx, v, js.bigu64, NULL)) kind = OP_UINT64;
	if (kind >= 0) {
		char *base = JSObjectGetTypedArrayBytesPtr(ctx, o, NULL);
		return op_typed((op_elements)kind, base + JSObjectGetTypedArrayByteOffset(ctx, o, NULL), JSObjectGetTypedArrayLength(ctx, o, NULL));
	}
	if (type != kJSTypedArrayTypeNone) return *why = "a Uint8ClampedArray is not a value", NULL;
	if (JSValueIsArray(ctx, v)) {
		size_t n = (size_t)JSValueToNumber(ctx, get(o, "length"), NULL);
		op_value *l = op_list();
		for (size_t i = 0; i < n; i++) {
			op_value *x = fromJs(JSObjectGetPropertyAtIndex(ctx, o, (unsigned)i, NULL), depth + 1, why);
			if (!x) {
				op_free(l);
				return NULL;
			}
			op_push(l, x);
		}
		return l;
	}
	JSValueRef proto = JSObjectGetPrototype(ctx, o);
	if (!JSValueIsNull(ctx, proto) && !JSValueIsStrictEqual(ctx, proto, js.object)) return *why = "an object of a class is not a value", NULL;
	JSPropertyNameArrayRef names = JSObjectCopyPropertyNames(ctx, o);
	size_t n = JSPropertyNameArrayGetCount(names);
	op_value *m = op_map();
	for (size_t i = 0; i < n && m; i++) {
		JSStringRef k = JSPropertyNameArrayGetNameAtIndex(names, i);
		JSValueRef item = JSObjectGetProperty(ctx, o, k, NULL);
		if (JSValueIsUndefined(ctx, item)) continue;
		op_value *x = fromJs(item, depth + 1, why);
		if (!x) {
			op_free(m);
			m = NULL;
		} else {
			char *key = cText(k, NULL);
			op_set(m, key, x);
			free(key);
		}
	}
	JSPropertyNameArrayRelease(names);
	return m;
}

// --- __ermineOp(handle, op, ...): a word of the API's through the interface of a part running

/** an argument as a value: none (or undefined) NULL; one that is no value leaves *why, once */
static op_value *argOf(JSValueRef v, const char **why) {
	if (!v || *why || JSValueIsUndefined(js.ctx, v)) return NULL;
	return fromJs(v, 0, why);
}

static JSValueRef op(JSContextRef ctx, JSObjectRef function, JSObjectRef self, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
	(void)function, (void)self;
	int64_t handle = argc > 0 && JSValueIsNumber(ctx, argv[0]) ? (int64_t)JSValueToNumber(ctx, argv[0], NULL) : -1;
	Frame *frame = NULL;
	for (int i = js.nframes - 1; i >= 0 && !frame; i--)
		if (js.frames[i].id == handle / 2) frame = &js.frames[i];
	if (!frame || !frame->alive) return throwing(exception, "stopped", "stopped: this part has returned");
	ap_given *g = frame->g;
	ap_api *api = handle % 2 ? g->peep : g->api;
	char *name = argc > 1 ? textOf(argv[1]) : NULL;
	if (!name || !api) {
		free(name);
		return throwing(exception, "stopped", "stopped: no such interface");
	}
	const char *why = NULL;
	// "@op": the operation, its changes carrying the cause given first (api.as)
	size_t first = 2;
	op_value *cause = NULL;
	if (name[0] == '@') {
		memmove(name, name + 1, strlen(name));
		cause = argc > 2 ? fromJs(argv[2], 0, &why) : NULL;
		if (cause) api = ap_as(api, cause);
		first = 3;
	}
	// the word's arguments as values, in the order words.h takes them: the runner's are positional
	// (runner.ts, apiOf) but create's options and start's one map, unpacked here
	op_value *args[6] = { 0 };
	size_t n = 0;
	JSValueRef a1 = argc > first ? argv[first] : NULL, a2 = argc > first + 1 ? argv[first + 1] : NULL;
	if (!strcmp(name, "create")) {
		args[0] = argOf(a1, &why), args[1] = argOf(get(a2, "id"), &why), args[2] = argOf(get(a2, "ephemeral"), &why);
		n = 3;
	} else if (!strcmp(name, "start")) {
		for (const char *const *f = wdFields(name); f[n]; n++) args[n] = argOf(get(a1, f[n]), &why);
	} else {
		for (; n < 6 && first + n < argc; n++) args[n] = argOf(argv[first + n], &why);
	}
	op_value *out = NULL;
	const ap_error *e = why ? ap_error_new(hostOs(js.host), "wrong-field", why) : wdDo(g, api, name, (const op_value *const *)args, n, &out);
	for (size_t i = 0; i < 6; i++) op_free(args[i]);
	free(name);
	op_free(cause);
	if (e) {
		JSValueRef r = throwing(exception, e->code ? e->code : "thrown", e->message ? e->message : e->code);
		if (e->name) put((JSObjectRef)*exception, "name", jsStr(e->name));
		return r;
	}
	JSValueRef r = out ? toJs(out) : JSValueMakeNull(ctx);
	op_free(out);
	return r;
}

/** __ermineHere(pid): the process's own node as an address from the root, as the host knows it; null if it does not */
static JSValueRef hereOf(JSContextRef ctx, JSObjectRef function, JSObjectRef self, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
	(void)function, (void)self, (void)exception;
	char *pid = argc ? textOf(argv[0]) : NULL;
	Json *here = hostHere(js.host, pid);
	free(pid);
	if (!here) return JSValueMakeNull(ctx);
	JSObjectRef a = JSObjectMakeArray(ctx, 0, NULL, NULL);
	for (int i = 0; i < here->array.count; i++) JSObjectSetPropertyAtIndex(ctx, a, (unsigned)i, jsStr(jsonText(here->array.items[i])), NULL);
	jsonFree(here);
	return a;
}

/** __ermineKill(pid): the process killed once the part asking returns (hostKill) */
static JSValueRef killOf(JSContextRef ctx, JSObjectRef function, JSObjectRef self, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
	(void)function, (void)self;
	char *pid = argc ? textOf(argv[0]) : NULL;
	if (!pid) return throwing(exception, "wrong-field", "kill takes a process's id");
	hostKill(js.host, pid);
	free(pid);
	return JSValueMakeUndefined(ctx);
}

/** __ermineAfter(ms, address): the handler at address (from the root) called in ms */
static JSValueRef afterOf(JSContextRef ctx, JSObjectRef function, JSObjectRef self, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
	(void)function, (void)self;
	double ms = argc && JSValueIsNumber(ctx, argv[0]) ? JSValueToNumber(ctx, argv[0], NULL) : 0;
	const char *why = NULL;
	size_t n = 0;
	op_value *names = argc > 1 ? fromJs(argv[1], 0, &why) : NULL;
	const char *const *address = wdNames(hostOs(js.host), names, &n);
	if (!address) {
		op_free(names);
		return throwing(exception, "wrong-field", "after takes ms and an address");
	}
	Json *to = jsonArray();
	for (size_t i = 0; i < n; i++) jsonPush(to, jsonString(address[i]));
	op_free(names);
	hostAfter(js.host, hostNow(js.host) + (int64_t)(ms < 0 ? 0 : ms * 1000), to);
	return JSValueMakeUndefined(ctx);
}

/** __ermineSay(text): a line in the OS's log */
static JSValueRef sayOf(JSContextRef ctx, JSObjectRef function, JSObjectRef self, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
	(void)function, (void)self, (void)exception;
	char *t = saying(argc ? argv[0] : NULL);
	hostSay(js.host, "js: %s", t);
	free(t);
	return JSValueMakeUndefined(ctx);
}

/** __ermineEval(source, url): a script evaluated with that URL, so its frames say url:line */
static JSValueRef evalOf(JSContextRef ctx, JSObjectRef function, JSObjectRef self, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
	(void)function, (void)self;
	if (argc < 2) return JSValueMakeUndefined(ctx);
	JSStringRef source = JSValueToStringCopy(ctx, argv[0], exception), url = JSValueToStringCopy(ctx, argv[1], exception);
	JSValueRef v = source && url ? JSEvaluateScript(ctx, source, NULL, url, 1, exception) : NULL;
	if (source) JSStringRelease(source);
	if (url) JSStringRelease(url);
	return v ? v : JSValueMakeUndefined(ctx);
}

/** a vram plane's memory mapped for a Uint32Array: let go when the array is collected */
typedef struct PlaneMap {
	void *mapping;
	size_t bytes;
} PlaneMap;

static void dropPlane(void *bytes, void *ref) {
	(void)bytes;
	PlaneMap *m = ref;
	hostPlaneUnmap(m->mapping, m->bytes);
	free(m);
}

/** __ermineVram(id): vram plane id's memory as a Uint32Array of its w × h, as its node says it
 * (/dev/vram/planes, hostPlaneSaid), mapped while the array lives; null when no node says it */
static JSValueRef vramOf(JSContextRef ctx, JSObjectRef function, JSObjectRef self, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
	(void)function, (void)self;
	int64_t id = argc && JSValueIsNumber(ctx, argv[0]) ? (int64_t)JSValueToNumber(ctx, argv[0], NULL) : -1;
	HostPlaneSaid said;
	if (!hostPlaneSaid(js.host, "vram", id, &said)) return JSValueMakeNull(ctx);
	PlaneMap *m = calloc(1, sizeof *m);
	m->mapping = hostPlaneMap(&said, &m->bytes);
	size_t need = said.offset + (size_t)said.stride * (size_t)said.h * 4;
	if (!m->mapping || need > m->bytes) {
		dropPlane(NULL, m);
		return JSValueMakeNull(ctx);
	}
	JSObjectRef a = JSObjectMakeTypedArrayWithBytesNoCopy(ctx, kJSTypedArrayTypeUint32Array, (char *)m->mapping + said.offset, (size_t)said.stride * (size_t)said.h * 4, dropPlane, m, exception);
	if (!a) {
		dropPlane(NULL, m);
		return JSValueMakeNull(ctx);
	}
	return a;
}

// --- the runner

static JSObjectRef global(const char *name) {
	JSValueRef v = get(JSContextGetGlobalObject(js.ctx), name);
	return v && JSValueIsObject(js.ctx, v) ? (JSObjectRef)v : NULL;
}

static void define(const char *name, JSObjectCallAsFunctionCallback f) {
	JSStringRef k = JSStringCreateWithUTF8CString(name);
	JSObjectRef fn = JSObjectMakeFunctionWithCallback(js.ctx, k, f);
	JSObjectSetProperty(js.ctx, JSContextGetGlobalObject(js.ctx), k, fn, kJSPropertyAttributeNone, NULL);
	JSStringRelease(k);
}

static char *slurp(const char *path) {
	FILE *f = fopen(path, "rb");
	if (!f) return NULL;
	fseek(f, 0, SEEK_END);
	long n = ftell(f);
	fseek(f, 0, SEEK_SET);
	char *text = malloc((size_t)n + 1);
	size_t got = fread(text, 1, (size_t)n, f);
	text[got] = 0;
	fclose(f);
	return text;
}

/** a context, and the runner evaluated in it: config's runner names its folder; js/runner.js there */
static bool up(void) {
	if (js.up) return true;
	if (js.gone) return false;
	js.gone = true; // until it is up
	const char *runner = hostConfig(js.host)->runner;
	char *path = runner ? strdup(runner) : strdup("playground/experimental_os/newos/js/runner.js");
	char *source = slurp(path);
	if (!source) {
		hostSay(js.host, "js: no runner at %s", path);
		free(path);
		return false;
	}
	js.ctx = JSGlobalContextCreate(NULL);
	JSStringRef name = JSStringCreateWithUTF8CString("ermineOS");
	JSGlobalContextSetName(js.ctx, name);
	JSStringRelease(name);
	js.object = (JSObjectRef)get(global("Object"), "prototype");
	js.big64 = global("BigInt64Array");
	js.bigu64 = global("BigUint64Array");
	JSValueProtect(js.ctx, js.object);
	JSValueProtect(js.ctx, js.big64);
	JSValueProtect(js.ctx, js.bigu64);
	define("__ermineOp", op);
	define("__ermineSay", sayOf);
	define("__ermineVram", vramOf);
	define("__ermineEval", evalOf);
	define("__ermineHere", hereOf);
	define("__ermineAfter", afterOf);
	define("__ermineKill", killOf);
	JSStringRef script = JSStringCreateWithUTF8CString(source), url = JSStringCreateWithUTF8CString(path);
	JSValueRef exception = NULL;
	JSEvaluateScript(js.ctx, script, NULL, url, 1, &exception);
	JSStringRelease(script);
	JSStringRelease(url);
	free(source);
	JSObjectRef hooks = global("__ermine");
	if (exception || !hooks) {
		char *t = saying(exception);
		hostSay(js.host, "js: the runner %s did not start: %s", path, t);
		free(t);
		free(path);
		return false;
	}
	js.run = (JSObjectRef)get(hooks, "run");
	js.load = (JSObjectRef)get(hooks, "load");
	js.wasm = (JSObjectRef)get(hooks, "wasm");
	js.stand = (JSObjectRef)get(hooks, "stand");
	js.isStand = (JSObjectRef)get(hooks, "isStand");
	js.pending = get(hooks, "pending");
	JSValueProtect(js.ctx, js.run);
	JSValueProtect(js.ctx, js.load);
	JSValueProtect(js.ctx, js.wasm);
	JSValueProtect(js.ctx, js.stand);
	JSValueProtect(js.ctx, js.isStand);
	JSValueProtect(js.ctx, js.pending);
	JSStringRef k = JSStringCreateWithUTF8CString("__ermine");
	JSObjectDeleteProperty(js.ctx, JSContextGetGlobalObject(js.ctx), k, NULL);
	JSStringRelease(k);
	hostSay(js.host, "js: the runner is JavaScriptCore's, %s", path);
	free(path);
	js.up = true;
	js.gone = false;
	return true;
}

/** what a part is told of itself, for the runner to build its map from: which part, the interface's handle, and its fields */
static JSObjectRef infoOf(ap_given *g, int64_t handle) {
	JSContextRef ctx = js.ctx;
	JSObjectRef o = JSObjectMake(ctx, NULL, NULL);
	const char *part = g->part == AP_CLEANUP ? "cleanup" : g->part == AP_COMPUTE ? "compute" : "setup";
	put(o, "part", jsStr(part));
	put(o, "handle", JSValueMakeNumber(ctx, (double)handle));
	if (g->self) put(o, "self", jsStr(g->self));
	if (g->name) put(o, "name", jsStr(g->name));
	if (g->part == AP_EFFECT) {
		put(o, "value", toJs(g->value));
		if (g->previous) put(o, "previous", toJs(g->previous));
	}
	if (g->args) put(o, "args", toJs(g->args));
	if (g->part == AP_CLEANUP) put(o, "killed", JSValueMakeBoolean(ctx, g->killed));
	if (g->part == AP_COMPUTE) put(o, "by", JSObjectMakeArray(ctx, 0, NULL, NULL));
	return o;
}

/** a JavaScript part, as the API calls it */
static const ap_error *callJs(ap_fn *self, ap_given *g, op_value **out, int *pending) {
	JsFn *f = (JsFn *)self;
	ap_os *os = hostOs(js.host);
	if (!up()) return ap_error_new(os, "not-a-program", "no JavaScript runner");
	if (!f->f) {
		// a program's module, loaded at its first run: JavaScript's source, or a wasm module's bytes (ermine:wasm)
		JSValueRef args[2] = { jsStr(f->source), jsStr(f->url) }, exception = NULL;
		if (f->wasm) {
			void *copy = malloc(f->nwasm ? f->nwasm : 1);
			memcpy(copy, f->wasm, f->nwasm);
			args[0] = JSObjectMakeArrayBufferWithBytesNoCopy(js.ctx, copy, f->nwasm, freeBytes, NULL, NULL);
		}
		JSValueRef loaded = JSObjectCallAsFunction(js.ctx, f->wasm ? js.wasm : js.load, NULL, 2, args, &exception);
		if (exception || !loaded || !JSValueIsObject(js.ctx, loaded) || !JSObjectIsFunction(js.ctx, (JSObjectRef)loaded)) {
			char *t = exception ? saying(exception) : strdup("its default export is not a function");
			const ap_error *e = ap_error_new(os, "not-a-program", t);
			free(t);
			return e;
		}
		f->f = (JSObjectRef)loaded;
		JSValueProtect(js.ctx, f->f);
	}
	if (js.nframes == js.room) {
		js.room = js.room ? js.room * 2 : 64;
		js.frames = realloc(js.frames, sizeof *js.frames * (size_t)js.room);
	}
	int at = js.nframes++;
	js.frames[at] = (Frame){ g, ++js.ids, true };
	JSValueRef args[2] = { f->f, infoOf(g, js.ids * 2) }, exception = NULL;
	JSValueRef r = JSObjectCallAsFunction(js.ctx, js.run, NULL, 2, args, &exception);
	js.frames[at].alive = false;
	// frames are kept until every part above them has returned, then let go of together
	while (js.nframes && !js.frames[js.nframes - 1].alive) js.nframes--;
	if (exception) {
		JSValueRef code = get(exception, "code");
		char *c = code ? textOf(code) : NULL, *t = saying(exception);
		const ap_error *e = ap_error_new(os, c ? c : "thrown", t);
		free(c);
		free(t);
		return e;
	}
	if (r && JSValueIsStrictEqual(js.ctx, r, js.pending)) {
		*pending = 1;
		return NULL;
	}
	const char *why = NULL;
	op_value *v = r ? fromJs(r, 0, &why) : NULL;
	if (why) return ap_error_new(os, "thrown", why);
	*out = v;
	return NULL;
}

/** where the process's program is, for its frames: its pin's program, from the process's node */
static char *urlOf(ap_api *api) {
	const nd_entry *e = api->self ? tb_get(ap_table(hostOs(js.host)), tb_string("attributes"), tb_string(api->self)) : NULL;
	const op_value *pin = e && e->value && e->value->type == OP_MAP ? op_get(e->value, "ermine.process.pin") : NULL;
	const op_value *program = pin && pin->type == OP_MAP ? op_get(pin, "program") : NULL;
	const op_value *at = program && program->type == OP_MAP ? op_get(program, "at") : NULL;
	char url[1024] = "ermine://";
	for (size_t i = 0; at && at->type == OP_LIST && i < at->count; i++)
		if (at->items[i]->type == OP_STR) snprintf(url + strlen(url), sizeof url - strlen(url), "/%s", at->items[i]->str);
	if (!at) snprintf(url + strlen(url), sizeof url - strlen(url), "/%s", api->name ? api->name : "program");
	return strdup(url);
}

hf_run jscRun(const op_value *code, void *data_api, void *data) {
	js.host = data;
	ap_api *api = data_api;
	if (!code || code->type != OP_STR) return (hf_run){ .error = strdup("not-a-program: a JavaScript program's value is its source") };
	JsFn *f = calloc(1, sizeof *f);
	f->base.call = callJs;
	f->source = strdup(code->str);
	f->url = urlOf(api);
	const ap_error *e = ap_run_setup(api, &f->base);
	if (!e) return (hf_run){ 0 };
	char text[1024];
	snprintf(text, sizeof text, "%s%s%s", e->code ? e->code : "thrown", e->message ? ": " : "", e->message ? e->message : "");
	return (hf_run){ .error = strdup(text) };
}

ap_fn *jscWasm(Host *host, const unsigned char *bytes, size_t n, const char *url) {
	js.host = host;
	JsFn *f = calloc(1, sizeof *f);
	f->base.call = callJs;
	f->source = strdup("");
	f->url = strdup(url);
	f->wasm = malloc(n ? n : 1);
	memcpy(f->wasm, bytes, n);
	f->nwasm = n;
	return &f->base;
}
