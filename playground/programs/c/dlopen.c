// The dlopen runner (dlopen.h), in C.
#define _DEFAULT_SOURCE
#define _DARWIN_C_SOURCE
#include "dlopen.h"

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#include "../../compilers/c/mem.h"
#include "native.h"

extern char **environ;

struct dlr {
	char *dir;
	void (*note)(const char *what, const char *detail, void *ctx);
	void *(*api)(void *start, void *ctx);
	void *ctx;
};

// a library loaded: its runner, its handle, its file, its exports (NULL: not exported)
typedef struct {
	dlr *d;
	void *handle;
	char *path;
	native_compile *compile;
	native_run *run;
	native_stop *stop;
} lib;

// what a run started: its stop and state; own, a library to let go after (a library run as a program)
typedef struct {
	native_stop *stop;
	void *state;
	lib *own;
} running;

dlr *dlr_new(const dlr_setup *setup) {
	dlr *d = pg_alloc(sizeof *d);
	const char *dir = setup != NULL && setup->dir != NULL ? setup->dir : getenv("TMPDIR");
	d->dir = pg_dup(dir != NULL && *dir ? dir : "/tmp");
	size_t n = strlen(d->dir);
	while (n > 1 && d->dir[n - 1] == '/') d->dir[--n] = '\0';
	if (setup != NULL) d->note = setup->note, d->api = setup->api, d->ctx = setup->ctx;
	return d;
}

void dlr_free(dlr *d) {
	if (d == NULL) return;
	free(d->dir);
	free(d);
}

static void note(dlr *d, const char *what, const char *detail) {
	if (d->note != NULL) d->note(what, detail, d->ctx);
	else fprintf(stderr, "dlopen: %s: %s\n", what, detail);
}

static char *format(const char *f, ...) {
	va_list a;
	va_start(a, f);
	int n = vsnprintf(NULL, 0, f, a);
	va_end(a);
	char *s = pg_alloc((size_t)n + 1);
	va_start(a, f);
	vsnprintf(s, (size_t)n + 1, f, a);
	va_end(a);
	return s;
}

// a value's bytes: bytes as they are, a string's UTF-8; else 0
static int bytes_of(const op_value *v, const uint8_t **out, size_t *n) {
	if (v != NULL && v->type == OP_BYTES) return *out = v->data, *n = v->bytes, 1;
	if (v != NULL && v->type == OP_STR) return *out = (const uint8_t *)v->str, *n = v->bytes, 1;
	return 0;
}

// an export by name, as a function pointer (POSIX: dlsym's object pointer is one)
static void *symbol(void *handle, const char *name) { return dlsym(handle, name); }
#define EXPORT(l, field, name) \
	do { \
		void *f_ = symbol((l)->handle, name); \
		memcpy(&(l)->field, &f_, sizeof f_); \
	} while (0)

// the file signed ad hoc: 1 when codesign says so
static int sign(const char *path) {
	posix_spawn_file_actions_t fa;
	posix_spawn_file_actions_init(&fa);
	posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", O_RDONLY, 0);
	posix_spawn_file_actions_addopen(&fa, 1, "/dev/null", O_WRONLY, 0);
	posix_spawn_file_actions_addopen(&fa, 2, "/dev/null", O_WRONLY, 0);
	char *argv[] = {"codesign", "-s", "-", "-f", (char *)path, NULL};
	pid_t pid;
	int err = posix_spawn(&pid, "/usr/bin/codesign", &fa, NULL, argv, environ);
	posix_spawn_file_actions_destroy(&fa);
	if (err != 0) return 0;
	int status;
	while (waitpid(pid, &status, 0) < 0) {
		if (errno != EINTR) return 0;
	}
	return WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

// the bytes to a file of their own: its path, malloc'd; NULL: not written
static char *written(dlr *d, const uint8_t *bytes, size_t n) {
	char *path = format("%s/ermine-XXXXXX.so", d->dir);
	int fd = mkstemps(path, 3);
	if (fd < 0) {
		note(d, "not written", path);
		free(path);
		return NULL;
	}
	size_t done = 0;
	while (done < n) {
		ssize_t w = write(fd, bytes + done, n - done);
		if (w < 0 && errno == EINTR) continue;
		if (w <= 0) break;
		done += (size_t)w;
	}
	close(fd);
	if (done == n) return path;
	note(d, "not written", path);
	unlink(path);
	free(path);
	return NULL;
}

static void lib_close(void *data) {
	lib *l = data;
	dlclose(l->handle);
	unlink(l->path);
	free(l->path);
	free(l);
}

static hf_out lib_compile(const op_value *input, void *data) {
	lib *l = data;
	const uint8_t *in;
	size_t n;
	if (!bytes_of(input, &in, &n)) return (hf_out){.kind = HF_FAILED, .error = pg_dup("not bytes")};
	uint8_t *out = NULL;
	size_t outn = 0;
	int rc = l->compile(in, n, &out, &outn);
	if (rc != 0) return (hf_out){.kind = HF_FAILED, .error = format("compile failed: %d", rc)};
	op_value *v = op_bytes(out, outn);
	free(out);
	return (hf_out){.kind = HF_VALUE, .value = v};
}

static void stop_running(void *ctx) {
	running *r = ctx;
	if (r->stop != NULL) r->stop(r->state);
	if (r->own != NULL) lib_close(r->own);
	free(r);
}

// run called with the program's api (the runner's api option of the start's facts; none: them);
// a handle when there is a stop to call or a library to let go
static hf_run started(lib *l, const uint8_t *code, size_t n, void *start, lib *own) {
	void *state = NULL;
	void *api = l->d->api != NULL ? l->d->api(start, l->d->ctx) : start;
	int rc = l->run(code, n, api, &state);
	if (rc != 0) {
		if (own != NULL) lib_close(own);
		return (hf_run){.error = format("run failed: %d", rc)};
	}
	if (l->stop == NULL && own == NULL) return (hf_run){0};
	running *r = pg_alloc(sizeof *r);
	*r = (running){l->stop, state, own};
	return (hf_run){.handle = {stop_running, r}};
}

static hf_run lib_run(const op_value *code, void *start, void *data) {
	const uint8_t *in;
	size_t n;
	if (!bytes_of(code, &in, &n)) return (hf_run){.error = pg_dup("not bytes")};
	return started(data, in, n, start, NULL);
}

hf_loaded dlr_load(const op_value *code, void *data) {
	dlr *d = data;
	if (code == NULL || code->type != OP_BYTES) return (hf_loaded){.error = pg_dup("not bytes")};
	char *path = written(d, code->data, code->bytes);
	if (path == NULL) return (hf_loaded){.error = pg_dup("dlopen failed")};
	void *h = dlopen(path, RTLD_NOW | RTLD_LOCAL);
	if (h == NULL) {
		const char *why = dlerror();
		if (why != NULL && strstr(why, "code signature") != NULL && sign(path)) {
			note(d, "signed", path);
			h = dlopen(path, RTLD_NOW | RTLD_LOCAL);
			if (h == NULL) why = dlerror();
		}
		if (h == NULL) {
			note(d, "dlopen failed", why != NULL ? why : path);
			unlink(path);
			free(path);
			return (hf_loaded){.error = pg_dup("dlopen failed")};
		}
	}
	lib *l = pg_alloc(sizeof *l);
	l->d = d;
	l->handle = h;
	l->path = path;
	EXPORT(l, compile, "compile");
	EXPORT(l, run, "run");
	EXPORT(l, stop, "stop");
	return (hf_loaded){.live = {
		.compile = l->compile != NULL ? lib_compile : NULL,
		.run = l->run != NULL ? lib_run : NULL,
		.close = lib_close,
		.data = l,
	}};
}

hf_run dlr_run(const op_value *code, void *start, void *data) {
	hf_loaded out = dlr_load(code, data);
	if (out.error != NULL) return (hf_run){.error = out.error};
	lib *l = out.live.data;
	if (l->run == NULL) {
		lib_close(l);
		return (hf_run){.error = pg_dup("no run in the library")};
	}
	return started(l, (const uint8_t *)"", 0, start, l);
}
