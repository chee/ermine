// foundation.c: macOS's Foundation through the Objective-C runtime. See foundation.h; the rules are foundation.ts's.
#include "foundation.h"

#include <stdlib.h>
#include <string.h>

// ---- the calls that do nothing

static int plain_coordinate(const char *path, bool writing, unsigned options, int (*fn)(void *), void *context) {
	(void)path, (void)writing, (void)options;
	return fn(context);
}

static bool plain_bookmark(const char *path, uint8_t **data, size_t *length) {
	(void)path, (void)data, (void)length;
	return false;
}

static char *plain_resolve(const uint8_t *data, size_t length) {
	(void)data, (void)length;
	return NULL;
}

static bool plain_ubiquitous(const char *path) {
	(void)path;
	return false;
}

static char *plain_alias(const char *path) {
	(void)path;
	return NULL;
}

const fd_foundation fd_plain = {plain_coordinate, plain_bookmark, plain_resolve, plain_ubiquitous, plain_alias};

#ifndef __APPLE__

bool fd_trash(const char *path) {
	(void)path;
	return false;
}

const fd_foundation fd_system = {plain_coordinate, plain_bookmark, plain_resolve, plain_ubiquitous, plain_alias};

#else

#include <dlfcn.h>

// <Foundation/NSURL.h>
#define BOOKMARK_WITHOUT_UI (1ul << 8)
#define BOOKMARK_WITHOUT_MOUNTING (1ul << 9)
// <objc/runtime.h>: a block that is global has this flag, and no state
#define BLOCK_IS_GLOBAL (1 << 28)

typedef void *id;
typedef void *SEL;
typedef unsigned char Bool;

static id (*get_class)(const char *);
static SEL (*register_name)(const char *);
static void *(*pool_push)(void);
static void (*pool_pop)(void *);
static void *send_raw;
static void *global_block;
static int loaded; // 0 not yet, 1 loaded, -1 there is none

// libobjc and Foundation, opened once, when first needed
static bool load(void) {
	if (loaded) return loaded > 0;
	loaded = -1;
	// loaded for its classes; nothing is called through this handle
	if (!dlopen("/System/Library/Frameworks/Foundation.framework/Foundation", RTLD_LAZY)) return false;
	void *o = dlopen("/usr/lib/libobjc.A.dylib", RTLD_LAZY);
	if (!o) return false;
	*(void **)&get_class = dlsym(o, "objc_getClass");
	*(void **)&register_name = dlsym(o, "sel_registerName");
	*(void **)&pool_push = dlsym(o, "objc_autoreleasePoolPush");
	*(void **)&pool_pop = dlsym(o, "objc_autoreleasePoolPop");
	send_raw = dlsym(o, "objc_msgSend");
	global_block = dlsym(RTLD_DEFAULT, "_NSConcreteGlobalBlock");
	if (!get_class || !register_name || !pool_push || !pool_pop || !send_raw || !global_block) return false;
	loaded = 1;
	return true;
}

static id cls(const char *name) {
	return get_class(name);
}

// messages of each shape this file sends, as objc_msgSend cast to the types of the call
#define S(name) register_name(name)
typedef id (*Send0)(id, SEL);
typedef id (*Send1)(id, SEL, void *);
typedef id (*Send2)(id, SEL, void *, void *);
typedef id (*Send4)(id, SEL, unsigned long, void *, void *, void *);
typedef id (*Send5)(id, SEL, void *, unsigned long, void *, Bool *, void *);
typedef id (*SendBytes)(id, SEL, const void *, unsigned long);
typedef Bool (*SendBool)(id, SEL);
typedef Bool (*SendGet)(id, SEL, void *, void *, void *);
typedef unsigned long (*SendLength)(id, SEL);
typedef const void *(*SendPointer)(id, SEL);
typedef const char *(*SendText)(id, SEL);
typedef void (*SendVoid)(id, SEL);
typedef void (*SendCoordinate)(id, SEL, void *, unsigned long, void *, void *);

static id string(const char *s) {
	return ((Send1)send_raw)(cls("NSString"), S("stringWithUTF8String:"), (void *)s);
}

static id url(const char *path) {
	return ((Send1)send_raw)(cls("NSURL"), S("fileURLWithPath:"), string(path));
}

static char *text_of(id s) {
	if (!s) return NULL;
	const char *c = ((SendText)send_raw)(s, S("UTF8String"));
	return c ? strdup(c) : NULL;
}

static id data_of(const uint8_t *b, size_t length) {
	static const uint8_t one;
	return ((SendBytes)send_raw)(cls("NSData"), S("dataWithBytes:length:"), length ? b : &one, length);
}

static bool bytes_of(id data, uint8_t **out, size_t *length) {
	unsigned long n = ((SendLength)send_raw)(data, S("length"));
	const void *p = ((SendPointer)send_raw)(data, S("bytes"));
	*out = malloc(n ? n : 1);
	if (!*out) abort();
	if (n && p) memcpy(*out, p, n);
	*length = n;
	return true;
}

// the URL a bookmark's data resolves to, or NULL
static id resolved(id data) {
	Bool stale = 0;
	id err = NULL;
	return ((Send5)send_raw)(cls("NSURL"), S("URLByResolvingBookmarkData:options:relativeToURL:bookmarkDataIsStale:error:"), data,
		BOOKMARK_WITHOUT_UI | BOOKMARK_WITHOUT_MOUNTING, NULL, &stale, &err);
}

static char *path_of(id u) {
	return u ? text_of(((Send0)send_raw)(u, S("path"))) : NULL;
}

// a block: struct Block { void *isa; int flags; int reserved; void *invoke; struct Descriptor *descriptor }
typedef struct {
	void *isa;
	int flags, reserved;
	void *invoke;
	void *descriptor;
} Block;
static struct {
	unsigned long reserved, size;
} descriptor = {0, sizeof(Block)};

// what the accessor runs: the call in progress, kept so a coordinated call within a coordinated call is its own
static struct Running {
	int (*fn)(void *);
	void *context;
	int result;
	bool ran;
} *running;

static void accessor(void *block, void *newurl) {
	(void)block, (void)newurl;
	struct Running *r = running;
	r->result = r->fn(r->context);
	r->ran = true;
}

static int mac_coordinate(const char *path, bool writing, unsigned options, int (*fn)(void *), void *context) {
	if (!load()) return fn(context);
	struct Running mine = {fn, context, 0, false}, *outer = running;
	void *pool = pool_push();
	id coordinator = ((Send1)send_raw)(((Send0)send_raw)(cls("NSFileCoordinator"), S("alloc")), S("initWithFilePresenter:"), NULL);
	Block b = {global_block, BLOCK_IS_GLOBAL, 0, (void *)accessor, &descriptor};
	id err = NULL;
	running = &mine;
	((SendCoordinate)send_raw)(coordinator,
		S(writing ? "coordinateWritingItemAtURL:options:error:byAccessor:" : "coordinateReadingItemAtURL:options:error:byAccessor:"), url(path),
		options, &err, &b);
	running = outer;
	((SendVoid)send_raw)(coordinator, S("release"));
	pool_pop(pool);
	// the coordinator refused without running the accessor: plain
	return mine.ran ? mine.result : fn(context);
}

static bool mac_bookmark(const char *path, uint8_t **data, size_t *length) {
	if (!load()) return false;
	void *pool = pool_push();
	id err = NULL;
	id d = ((Send4)send_raw)(url(path), S("bookmarkDataWithOptions:includingResourceValuesForKeys:relativeToURL:error:"), 0, NULL, NULL, &err);
	bool ok = d && bytes_of(d, data, length);
	pool_pop(pool);
	return ok;
}

static char *mac_resolve(const uint8_t *data, size_t length) {
	if (!load()) return NULL;
	void *pool = pool_push();
	char *out = path_of(resolved(data_of(data, length)));
	pool_pop(pool);
	return out;
}

static bool mac_ubiquitous(const char *path) {
	if (!load()) return false;
	void *pool = pool_push();
	id value = NULL, err = NULL;
	Bool ok = ((SendGet)send_raw)(url(path), S("getResourceValue:forKey:error:"), &value, string("NSURLIsUbiquitousItemKey"), &err);
	bool yes = ok && value && ((SendBool)send_raw)(value, S("boolValue"));
	pool_pop(pool);
	return yes;
}

static char *mac_alias(const char *path) {
	if (!load()) return NULL;
	void *pool = pool_push();
	id err = NULL;
	id d = ((Send2)send_raw)(cls("NSURL"), S("bookmarkDataWithContentsOfURL:error:"), url(path), &err);
	char *out = d ? path_of(resolved(d)) : NULL;
	pool_pop(pool);
	return out;
}

bool fd_trash(const char *path) {
	if (!load()) return false;
	void *pool = pool_push();
	id err = NULL;
	id manager = ((Send0)send_raw)(cls("NSFileManager"), S("defaultManager"));
	Bool ok = ((SendGet)send_raw)(manager, S("trashItemAtURL:resultingItemURL:error:"), url(path), NULL, &err);
	pool_pop(pool);
	return ok;
}

const fd_foundation fd_system = {mac_coordinate, mac_bookmark, mac_resolve, mac_ubiquitous, mac_alias};

#endif
