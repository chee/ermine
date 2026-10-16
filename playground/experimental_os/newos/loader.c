// loader.c: C programs (loader.h; CLOADER.md, How it runs), as ermine/programs runs any program: a
// program of type public.c-source is run by /loaders' chain, the compiler "clang" (C to a wasm
// module, org.webassembly.wasm) then the runner "wasm". The build (build.c) caches the compile by
// its source: a program compiled before is not compiled again.
//
// The compile is cc.c's, on a thread: clang and wasm-ld, the headers in /lib/c given to it (read as
// the compile starts, told to no one). Its promise settles at the turn after it is done, which the
// thread wakes with LOADER_IRQ: a module, or the compile's first error. The runner gives the module
// to the JavaScript runner (jsc.c's jscWasm, js/wasm.ts), which runs it as parts, as 10-12's did.
//
// Native (CLOADER.md, Native): a C program whose ermine.programs.loader is /loaders/clang-native is
// compiled by the compiler "clang-native", the same compile made an arm64 dylib (cc.c), cached the
// same way; dylib.c's runner "dlopen" runs it.
//
// Not here, as 10-12's loader had it: headers beside the program (the compiler is given its source
// only), and the compile's diagnostics kept for an editor (a failed one's first error is its status).

#include "loader.h"

#include "cc.h"
#include "jsc.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/** a compile on a thread, and the promise its build waits on */
typedef struct Job {
	CcJob *cc;
	sc_promise *promise;
	struct Job *next;
} Job;

static struct {
	pthread_mutex_t lock;
	Job *done; // compiles done, not yet settled, newest first
} L = { PTHREAD_MUTEX_INITIALIZER, NULL };

static void *compiling(void *arg) {
	Job *j = arg;
	ccRun(j->cc);
	pthread_mutex_lock(&L.lock);
	j->next = L.done;
	L.done = j;
	pthread_mutex_unlock(&L.lock);
	char record[32];
	snprintf(record, sizeof record, "{\"irq\": %d}", LOADER_IRQ);
	ermosPost(record);
	return NULL;
}

/** the headers in /lib/c (and its folders, a level down), read now, told to no one */
static void headers(Host *h, CcFile **files, int *count) {
	ap_api *api = ap_peep(ap_host(hostOs(h)));
	size_t n;
	const char *const *lib = hostPath(h, &n, "lib", "c", NULL);
	ap_namelist names = { 0 };
	if (ap_names(api, lib, n, &names)) return;
	for (size_t i = 0; i < names.n; i++) {
		const char *at[] = { "lib", "c", names.names[i] };
		const op_value *text = hostRead(api, at, 3);
		if (!text || text->type != OP_STR || !strstr(names.names[i], ".h")) continue;
		*files = realloc(*files, sizeof **files * (size_t)(*count + 1));
		(*files)[(*count)++] = (CcFile){ strdup(names.names[i]), strndup(text->str, text->bytes), text->bytes };
	}
}

static hf_out compile(const op_value *input, Host *h, bool native) {
	if (!input || input->type != OP_STR) return (hf_out){ .kind = HF_FAILED, .error = strdup("not C source: a program's value is its text") };
	Job *j = calloc(1, sizeof *j);
	CcJob *cc = j->cc = calloc(1, sizeof *cc);
	cc->source = strndup(input->str, input->bytes);
	cc->nsource = input->bytes;
	cc->compiler = strdup("clang");
	cc->linker = strdup("wasm-ld");
	cc->native = native;
	cc->flags = calloc(3, sizeof *cc->flags);
	cc->flags[cc->nflags++] = strdup("-O2");
	cc->flags[cc->nflags++] = strdup("-Wall");
	headers(h, &cc->lib, &cc->nlib);
	j->promise = sc_promise_new(ap_scheduler(hostOs(h)));
	pthread_t t;
	pthread_attr_t attr;
	pthread_attr_init(&attr);
	pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
	pthread_create(&t, &attr, compiling, j);
	pthread_attr_destroy(&attr);
	return (hf_out){ .kind = HF_AWAIT, .promise = j->promise };
}

hf_out loaderCompile(const op_value *input, const hf_context *ctx, void *data) {
	(void)ctx;
	return compile(input, data, false);
}

hf_out loaderCompileNative(const op_value *input, const hf_context *ctx, void *data) {
	(void)ctx;
	return compile(input, data, true);
}

/** a compile's first error, as "line:column message" */
static char *firstError(const Json *diagnostics) {
	for (int i = 0; jsonIsArray(diagnostics) && i < diagnostics->array.count; i++) {
		const Json *d = diagnostics->array.items[i];
		const char *level = jsonText(jsonGet(d, "level")), *message = jsonText(jsonGet(d, "message")), *file = jsonText(jsonGet(d, "file"));
		if (!level || strcmp(level, "error")) continue;
		int64_t line = 0, column = 0;
		jsonIsWhole(jsonGet(d, "line"), &line);
		jsonIsWhole(jsonGet(d, "column"), &column);
		return formatString("it did not compile: %s%s%lld:%lld %s", file ? file : "", file ? ":" : "", (long long)line, (long long)column, message ? message : "");
	}
	return strdup("it did not compile");
}

void loaderTurn(Host *h) {
	(void)h;
	pthread_mutex_lock(&L.lock);
	Job *done = L.done;
	L.done = NULL;
	pthread_mutex_unlock(&L.lock);
	while (done) {
		Job *j = done;
		done = j->next;
		if (j->cc->ok) sc_resolve(j->promise, op_bytes(j->cc->wasm, j->cc->nwasm));
		else sc_reject(j->promise, firstError(j->cc->diagnostics));
		sc_promise_free(j->promise);
		ccFree(j->cc);
		free(j);
	}
}

hf_run loaderRun(const op_value *code, void *api, void *data) {
	Host *h = data;
	if (!code || code->type != OP_BYTES) return (hf_run){ .error = strdup("not-a-program: a wasm module is bytes") };
	ap_api *a = api;
	char url[512];
	snprintf(url, sizeof url, "ermine:///%s.wasm", a->name ? a->name : "program");
	const ap_error *e = ap_run_setup(a, jscWasm(h, code->data, code->bytes, url));
	if (!e) return (hf_run){ 0 };
	char text[1024];
	snprintf(text, sizeof text, "%s%s%s", e->code ? e->code : "thrown", e->message ? ": " : "", e->message ? e->message : "");
	return (hf_run){ .error = strdup(text) };
}
