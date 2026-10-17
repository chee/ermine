// cc.c: C compiled to wasm (cc.h; CLOADER.md, How it runs). A job holds what
// the finder copied out of the graph: the source, /c's value's tools and
// flags, and the headers beside the program and in /lib/c. ccRun writes them
// to a folder of their own, runs clang, then wasm-ld (posix_spawn), and reads
// back the module, its exports, clang's diagnostics (SARIF; wasm-ld's are
// text) and the headers clang entered (-MMD), in order. Freestanding: no
// libc and no SDK header is read, only clang's own (stdint.h, stdarg.h …),
// which count as the compiler.
//
// Native (job->native): the same compile for arm64-apple-macos11, then clang
// links it a dylib (-dynamiclib) against the SDK's libSystem (memcpy and the
// like, which the compiler may call), ad hoc signed by the linker. Its headers
// are still only ermine.h's and clang's own.
//
// The keys are the cache's trace (CACHE.tex): BLAKE3 over canonical CBOR,
// each key the hash of the one before and an answer.

#define _DARWIN_C_SOURCE

#include "cc.h"
#include "../../../ermine/encoding/c/json_text.h"

#include "../../../ermine/encoding/c/blake3/blake3.h"
#include "../../../ermine/encoding/c/cbor.h"

#include <errno.h>
#include <limits.h>
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

/** a compile given longer than this is stopped */
#define PATIENCE_MS 30000

// --- keys

static void hash(const Json *v, uint8_t out[32]) {
	size_t n = 0;
	const char *why = NULL;
	cborEncode(v, NULL, 0, &n, &why);
	unsigned char *bytes = malloc(n ? n : 1);
	if (!cborEncode(v, bytes, n, &n, &why)) n = 0; // a string that is not UTF-8: hashed as nothing
	blake3_hasher h;
	blake3_hasher_init(&h);
	blake3_hasher_update(&h, bytes, n);
	blake3_hasher_finalize(&h, out, 32);
	free(bytes);
}

void ccRoot(const Json *c, uint8_t out[32]) {
	Json *root = jsonArray(), *key = jsonObject();
	jsonAdd(key, "c", c ? jsonShallow(c) : jsonNull());
	jsonPush(root, jsonString("ermine-cache"));
	jsonPush(root, key);
	hash(root, out);
	jsonFree(root);
}

void ccText(const char *text, size_t n, uint8_t out[32]) {
	Json *s = jsonStringOfLength(text, n);
	hash(s, out);
	jsonFree(s);
}

Json *ccAnswer(CcWhere where, const uint8_t *h) {
	Json *a = jsonArray();
	jsonPush(a, jsonString(where == CC_HERE ? "here" : where == CC_LIB ? "lib" : "none"));
	jsonPush(a, h && where != CC_NONE ? jsonBytes(h, 32) : jsonNull());
	return a;
}

void ccNext(const uint8_t key[32], const Json *answer, uint8_t out[32]) {
	Json *pair = jsonArray();
	jsonPush(pair, jsonBytes(key, 32));
	jsonPush(pair, jsonShallow(answer));
	hash(pair, out);
	jsonFree(pair);
}

void ccHex(const uint8_t key[32], char out[65]) {
	for (int i = 0; i < 32; i++) snprintf(out + 2 * i, 3, "%02x", key[i]);
}

// --- files

static int64_t ms(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static bool exists(const char *path) {
	struct stat st;
	return stat(path, &st) == 0;
}

static char *slurp(const char *path, size_t *n) {
	FILE *f = fopen(path, "rb");
	if (!f) return NULL;
	fseek(f, 0, SEEK_END);
	long len = ftell(f);
	fseek(f, 0, SEEK_SET);
	char *text = malloc((size_t)(len > 0 ? len : 0) + 1);
	size_t got = fread(text, 1, (size_t)(len > 0 ? len : 0), f);
	text[got] = 0;
	fclose(f);
	if (n) *n = got;
	return text;
}

static bool spill(const char *path, const char *text, size_t n) {
	FILE *f = fopen(path, "wb");
	if (!f) return false;
	bool ok = fwrite(text, 1, n, f) == n;
	return fclose(f) == 0 && ok;
}

/** a name a header may have on disk: letters, digits, . _ - + and folders between, none starting with "." */
static bool safe(const char *name) {
	if (!*name || *name == '/' || name[strlen(name) - 1] == '/') return false;
	for (const char *c = name; *c; c++) {
		if (*c == '.' && (c == name || c[-1] == '/')) return false;
		if (*c == '/' && c[1] == '/') return false;
		if (!strchr("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-+/", *c)) return false;
	}
	return true;
}

/** a header written into its folder, the folders between made */
static bool place(const char *folder, const CcFile *f) {
	if (!safe(f->name)) return false;
	char path[2048];
	snprintf(path, sizeof path, "%s/%s", folder, f->name);
	for (char *s = path + strlen(folder) + 1; (s = strchr(s, '/')); s++) {
		*s = 0;
		mkdir(path, 0700);
		*s = '/';
	}
	return spill(path, f->text, f->n);
}

/** a folder and all in it gone */
static void sweep(const char *path) {
	char *argv[] = { "/bin/rm", "-rf", (char *)path, NULL };
	pid_t pid;
	if (posix_spawn(&pid, argv[0], NULL, NULL, argv, environ) == 0) waitpid(pid, NULL, 0);
}

// --- the tools

/** a tool by name, or as a path: the toolchain's clang, not the /usr/bin shim (CLOADER.md, Probed); Homebrew's wasm-ld */
static char *tool(const char *name) {
	if (!name || !*name) return NULL;
	if (strchr(name, '/')) return exists(name) ? strdup(name) : NULL;
	static const char *const places[] = {
		"/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin",
		"/Library/Developer/CommandLineTools/usr/bin",
		"/opt/homebrew/opt/lld@22/bin", "/opt/homebrew/opt/lld/bin", "/opt/homebrew/opt/llvm/bin", "/opt/homebrew/bin",
		"/usr/local/opt/lld/bin", "/usr/local/opt/llvm/bin", "/usr/local/bin",
	};
	char path[1024];
	for (size_t i = 0; i < sizeof places / sizeof *places; i++) {
		snprintf(path, sizeof path, "%s/%s", places[i], name);
		if (exists(path)) return strdup(path);
	}
	const char *env = getenv("PATH");
	char *list = env ? strdup(env) : NULL, *rest = list;
	for (char *dir; list && (dir = strsep(&rest, ":"));) {
		snprintf(path, sizeof path, "%s/%s", dir, name);
		if (*dir && exists(path)) {
			free(list);
			return strdup(path);
		}
	}
	free(list);
	return NULL;
}

/** argv run, its output into out and err: its exit status, -1 if it could not run or took too long */
static int run(char *const argv[], const char *out, const char *err) {
	posix_spawn_file_actions_t fa;
	posix_spawn_file_actions_init(&fa);
	posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", O_RDONLY, 0);
	posix_spawn_file_actions_addopen(&fa, 1, out, O_WRONLY | O_CREAT | O_TRUNC, 0600);
	posix_spawn_file_actions_addopen(&fa, 2, err, O_WRONLY | O_CREAT | O_TRUNC, 0600);
	pid_t pid;
	int e = posix_spawn(&pid, argv[0], &fa, NULL, argv, environ);
	posix_spawn_file_actions_destroy(&fa);
	if (e) return -1;
	int status = 0;
	for (int64_t until = ms() + PATIENCE_MS;;) {
		pid_t got = waitpid(pid, &status, WNOHANG);
		if (got == pid) break;
		if (got < 0 && errno != EINTR) return -1;
		if (ms() > until) {
			kill(pid, SIGKILL);
			waitpid(pid, &status, 0);
			return -1;
		}
		usleep(2000);
	}
	return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
}

// --- what came back

static void said(CcJob *job, const char *level, const char *message, int line, int column, const char *file) {
	Json *d = jsonObject();
	jsonAdd(d, "level", jsonString(level));
	jsonAdd(d, "message", jsonString(message));
	if (line > 0) jsonAdd(d, "line", jsonInteger(line));
	if (column > 0) jsonAdd(d, "column", jsonInteger(column));
	if (file) jsonAdd(d, "file", jsonString(file));
	jsonPush(job->diagnostics, d);
}

static void step(CcJob *job, const char *name, CcWhere where) {
	for (int i = 0; i < job->nsteps; i++)
		if (!strcmp(job->steps[i].name, name)) return;
	job->steps = realloc(job->steps, sizeof *job->steps * (size_t)(job->nsteps + 1));
	job->steps[job->nsteps++] = (CcStep){ strdup(name), where };
}

/** a header libc would give: what a person reaching for printf meets */
static bool libc(const char *name) {
	static const char *const names[] = { "stdio.h", "stdlib.h", "string.h", "math.h", "ctype.h", "time.h", "assert.h", "errno.h", "unistd.h", "fcntl.h", "signal.h", "setjmp.h", "locale.h", "wchar.h" };
	for (size_t i = 0; i < sizeof names / sizeof *names; i++)
		if (!strcmp(name, names[i])) return true;
	return false;
}

/** where the JSON object text starts with ends: clang says "1 error generated." after its SARIF */
static size_t object(const char *text) {
	int depth = 0;
	bool quoted = false;
	for (size_t i = 0; text[i]; i++) {
		char c = text[i];
		if (quoted) {
			if (c == '\\' && text[i + 1]) i++;
			else if (c == '"') quoted = false;
		} else if (c == '"') quoted = true;
		else if (c == '{') depth++;
		else if (c == '}' && --depth == 0) return i + 1;
	}
	return strlen(text);
}

/** clang's diagnostics, SARIF: each result a level, message, line and column; a header's file its include name */
static void sarif(CcJob *job, const char *text, const char *dir) {
	char *why = NULL;
	Json *s = jsonParse(text, object(text), &why);
	Json *runs = jsonGet(s, "runs");
	if (!s || !jsonIsArray(runs)) {
		// not SARIF: what clang said, as one whole-program error
		if (*text) said(job, "error", text, 0, 0, NULL);
		jsonFree(s);
		return;
	}
	for (int r = 0; r < runs->array.count; r++) {
		Json *results = jsonGet(runs->array.items[r], "results");
		for (int i = 0; results && jsonIsArray(results) && i < results->array.count; i++) {
			Json *x = results->array.items[i], *loc = NULL;
			Json *locs = jsonGet(x, "locations");
			if (jsonIsArray(locs) && locs->array.count) loc = jsonGet(locs->array.items[0], "physicalLocation");
			const char *uri = jsonText(jsonGet(jsonGet(loc, "artifactLocation"), "uri"));
			Json *region = jsonGet(loc, "region");
			int64_t line = 0, column = 0;
			jsonIsWhole(jsonGet(region, "startLine"), &line);
			jsonIsWhole(jsonGet(region, "startColumn"), &column);
			const char *level = jsonText(jsonGet(x, "level")), *message = jsonText(jsonGet(jsonGet(x, "message"), "text"));
			// where: the program's own source, or a header by its include name (/lib/c's as an address)
			char file[1024] = "";
			const char *at = uri ? strstr(uri, dir) : NULL;
			if (at) at += strlen(dir) + 1;
			if (at && !strncmp(at, "here/", 5)) snprintf(file, sizeof file, "%s", at + 5);
			else if (at && !strncmp(at, "lib/", 4)) snprintf(file, sizeof file, "/lib/c/%s", at + 4);
			// an include clang could not find is a step too, answered "none": placing it is another key
			char missing[512];
			char text2[1024];
			const char *m = message ? message : "";
			if (sscanf(m, "'%511[^']' file not found", missing) == 1) {
				step(job, missing, CC_NONE);
				if (libc(missing)) {
					snprintf(text2, sizeof text2, "no libc yet: er_say prints ('%s' file not found)", missing);
					m = text2;
				}
			}
			said(job, level ? level : "error", m, (int)line, (int)column, *file ? file : NULL);
		}
	}
	jsonFree(s);
}

/** wasm-ld's diagnostics, text: a line each ("wasm-ld: error: program.o: undefined symbol: f") */
static void linker(CcJob *job, const char *text) {
	char *copy = strdup(text), *rest = copy;
	for (char *line; (line = strsep(&rest, "\n"));) {
		if (!*line) continue;
		const char *level = "error", *m = line;
		if (!strncmp(m, "wasm-ld: ", 9)) m += 9;
		else if (!strncmp(m, "ld: ", 4)) m += 4;
		else if (!strncmp(m, "clang: ", 7)) m += 7;
		if (!strncmp(m, "error: ", 7)) m += 7;
		else if (!strncmp(m, "warning: ", 9)) m += 9, level = "warning";
		const char *o = strstr(m, "program.o: ");
		if (o) m = o + 11;
		char friendly[256];
		if (strstr(m, "--export not found: setup")) {
			snprintf(friendly, sizeof friendly, "%s", strstr(job->source, "main(") ? "a program starts at setup(), not main" : "a program starts at setup(), and this one has none");
			m = friendly;
		}
		said(job, level, m, 0, 0, NULL);
	}
	free(copy);
}

/** the headers clang entered, in order, from its -MMD file ("<dir>/program.o: <dir>/src/program.c <dir>/here/x.h <dir>/lib/ermine.h") */
static void entered(CcJob *job, const char *deps, const char *dir) {
	size_t ndir = strlen(dir);
	char word[1024];
	size_t n = 0;
	bool first = true;
	for (const char *c = deps;; c++) {
		if (*c == '\\' && c[1] == '\n') {
			c++;
			continue;
		}
		if (*c == '\\' && c[1]) {
			if (n < sizeof word - 1) word[n++] = *++c;
			continue;
		}
		if (*c && !strchr(" \t\n", *c)) {
			if (n < sizeof word - 1) word[n++] = *c;
			continue;
		}
		word[n] = 0;
		const char *w = !strncmp(word, dir, ndir) && word[ndir] == '/' ? word + ndir + 1 : word;
		if (n && !first) {
			if (!strncmp(w, "here/", 5)) step(job, w + 5, CC_HERE);
			else if (!strncmp(w, "lib/", 4)) step(job, w + 4, CC_LIB);
		}
		if (n && word[n - 1] == ':') first = false;
		n = 0;
		if (!*c) break;
	}
}

/** a module's exported functions' names (its export section, id 7) */
static Json *exported(const unsigned char *b, size_t n) {
	Json *out = jsonArray();
	size_t at = 8;
	#define LEB(v) do { v = 0; for (int s = 0; at < n; s += 7) { unsigned char x = b[at++]; v |= (uint64_t)(x & 127) << s; if (!(x & 128)) break; } } while (0)
	while (n >= 8 && at < n) {
		unsigned char id = b[at++];
		uint64_t size;
		LEB(size);
		size_t end = at + (size_t)size;
		if (id == 7) {
			uint64_t count;
			LEB(count);
			for (uint64_t i = 0; i < count && at < end; i++) {
				uint64_t len, index;
				LEB(len);
				if (at + len > end) break;
				Json *name = jsonStringOfLength((const char *)b + at, (size_t)len);
				at += (size_t)len;
				unsigned char kind = at < end ? b[at++] : 255;
				LEB(index);
				(void)index;
				if (kind == 0) jsonPush(out, name);
				else jsonFree(name);
			}
		}
		at = end;
	}
	#undef LEB
	return out;
}

/** the macOS SDK, for a native library's libSystem: $SDKROOT, Xcode's, the command line tools', else xcrun's word; NULL: none */
static char *sdk(const char *dir) {
	const char *env = getenv("SDKROOT");
	if (env && *env && exists(env)) return strdup(env);
	static const char *const places[] = {
		"/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk",
		"/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk",
	};
	for (size_t i = 0; i < sizeof places / sizeof *places; i++)
		if (exists(places[i])) return strdup(places[i]);
	char out[1100], err[1100];
	snprintf(out, sizeof out, "%s/sdk.out", dir);
	snprintf(err, sizeof err, "%s/sdk.err", dir);
	char *argv[] = { "/usr/bin/xcrun", "--show-sdk-path", NULL };
	if (run(argv, out, err) != 0) return NULL;
	char *text = slurp(out, NULL);
	if (text) text[strcspn(text, "\n")] = 0;
	if (text && !exists(text)) {
		free(text);
		return NULL;
	}
	return text;
}

/** a tool's own words of what it is: its first line of --version */
static char *version(const char *path, const char *dir) {
	char out[1100], err[1100];
	snprintf(out, sizeof out, "%s/version.out", dir);
	snprintf(err, sizeof err, "%s/version.err", dir);
	char *argv[] = { (char *)path, "--version", NULL };
	if (run(argv, out, err) != 0) return NULL;
	char *text = slurp(out, NULL);
	if (text) text[strcspn(text, "\n")] = 0;
	return text;
}

// --- the compile

void ccRun(CcJob *job) {
	int64_t began = ms();
	job->diagnostics = jsonArray();
	job->exports = jsonArray();
	static int jobs;
	char dir[1024];
	const char *tmp = getenv("TMPDIR");
	snprintf(dir, sizeof dir, "%s/ermine-cc.%d.%d", tmp && *tmp ? tmp : "/tmp", (int)getpid(), __sync_add_and_fetch(&jobs, 1));
	char *clang = tool(job->compiler ? job->compiler : "clang"), *ld = job->native ? NULL : tool(job->linker ? job->linker : "wasm-ld"), *root = NULL;
	if (!clang || (!job->native && !ld)) {
		said(job, "error", !clang ? "no C compiler here: /c names one (clang) this machine lacks" : "no wasm linker here: /c names one (wasm-ld; brew install lld) this machine lacks", 0, 0, NULL);
		goto done;
	}
	// the folder by its real path, as clang names files in what it says
	char real[PATH_MAX];
	if (mkdir(dir, 0700) || !realpath(dir, real)) {
		said(job, "error", "the compiler's folder could not be made", 0, 0, NULL);
		goto done;
	}
	snprintf(dir, sizeof dir, "%s", real);
	char src[1100], here[1100], lib[1100], out[1100], err[1100], deps[1100], obj[1100], wasm[1100];
	snprintf(src, sizeof src, "%s/src", dir);
	snprintf(here, sizeof here, "%s/here", dir);
	snprintf(lib, sizeof lib, "%s/lib", dir);
	snprintf(out, sizeof out, "%s/out", dir);
	snprintf(err, sizeof err, "%s/err", dir);
	snprintf(deps, sizeof deps, "%s/program.d", dir);
	snprintf(obj, sizeof obj, "%s/program.o", dir);
	snprintf(wasm, sizeof wasm, job->native ? "%s/program.dylib" : "%s/program.wasm", dir);
	if (job->native && !(root = sdk(dir))) {
		said(job, "error", "no macOS SDK here, for a native library's libSystem: Xcode, or the command line tools (xcode-select --install)", 0, 0, NULL);
		goto done;
	}
	if (mkdir(src, 0700) || mkdir(here, 0700) || mkdir(lib, 0700)) {
		said(job, "error", "the compiler's folder could not be made", 0, 0, NULL);
		goto done;
	}
	snprintf(src, sizeof src, "%s/src/program.c", dir);
	spill(src, job->source, job->nsource);
	for (int i = 0; i < job->nhere; i++) place(here, &job->here[i]);
	for (int i = 0; i < job->nlib; i++) place(lib, &job->lib[i]);

	// clang: wasm32, freestanding, bulk memory (a struct copy is memory.copy, not a call to a memcpy there is none of)
	{
		char ihere[1100], ilib[1100];
		snprintf(ihere, sizeof ihere, "-I%s", here);
		snprintf(ilib, sizeof ilib, "-I%s", lib);
		const char *wasm32[] = { clang, "--target=wasm32", "-ffreestanding", "-nostdlibinc", "-mbulk-memory", "-fdiagnostics-format=sarif",
		                         "-Wno-sarif-format-unstable", "-MMD", "-MF", deps, ihere, ilib };
		const char *arm64[] = { clang, "--target=arm64-apple-macos11", "-isysroot", root ? root : "", "-ffreestanding", "-nostdlibinc", "-fdiagnostics-format=sarif",
		                        "-Wno-sarif-format-unstable", "-MMD", "-MF", deps, ihere, ilib };
		const char *const *fixed = job->native ? arm64 : wasm32;
		int nfixed = job->native ? (int)(sizeof arm64 / sizeof *arm64) : (int)(sizeof wasm32 / sizeof *wasm32), k = 0;
		char **argv = calloc((size_t)(nfixed + job->nflags + 5), sizeof *argv);
		for (int i = 0; i < nfixed; i++) argv[k++] = (char *)fixed[i];
		for (int i = 0; i < job->nflags; i++) argv[k++] = job->flags[i];
		argv[k++] = "-c";
		argv[k++] = src;
		argv[k++] = "-o";
		argv[k++] = obj;
		int status = run(argv, out, err);
		free(argv);
		char *e = slurp(err, NULL);
		sarif(job, e ? e : "", dir);
		free(e);
		char *d = slurp(deps, NULL);
		// the headers entered, then the includes not found: the trace's steps, in order
		if (d) {
			CcStep *missed = job->steps;
			int nmissed = job->nsteps;
			job->steps = NULL, job->nsteps = 0;
			entered(job, d, dir);
			for (int i = 0; i < nmissed; i++) step(job, missed[i].name, CC_NONE), free(missed[i].name);
			free(missed);
		}
		free(d);
		if (status != 0) {
			if (status < 0) said(job, "error", "the compiler did not finish", 0, 0, NULL);
			goto done;
		}
	}
	// wasm-ld: no entry, setup and the stack pointer exported, the table too (a handler is an entry in it).
	// native: clang links a dylib, signed ad hoc by the linker
	{
		char *towasm[] = { ld, "--no-entry", "--export-table", "--export=__stack_pointer", "--export=setup", "-o", wasm, obj, NULL };
		char *todylib[] = { clang, "--target=arm64-apple-macos11", "-isysroot", root ? root : "", "-dynamiclib", "-o", wasm, obj, NULL };
		int status = run(job->native ? todylib : towasm, out, err);
		char *e = slurp(err, NULL);
		linker(job, e ? e : "");
		free(e);
		if (status != 0) {
			if (status < 0) said(job, "error", "the linker did not finish", 0, 0, NULL);
			goto done;
		}
	}
	job->wasm = (unsigned char *)slurp(wasm, &job->nwasm);
	if (job->native) {
		// a Mach-O, 64-bit: its magic, little-endian
		if (job->wasm && job->nwasm >= 8 && !memcmp(job->wasm, "\xcf\xfa\xed\xfe", 4)) job->ok = true;
		else said(job, "error", "the linker made no library", 0, 0, NULL);
	} else if (job->wasm && job->nwasm >= 8 && !memcmp(job->wasm, "\0asm", 4)) {
		job->ok = true;
		jsonFree(job->exports);
		job->exports = exported(job->wasm, job->nwasm);
	} else said(job, "error", "the linker made no module", 0, 0, NULL);
	// what compiled it, said once (it costs a run of each)
	{
		static char *said_is;
		static int asked;
		if (!__sync_lock_test_and_set(&asked, 1)) {
			char *c = version(clang, dir), *l = ld ? version(ld, dir) : NULL;
			size_t room = strlen(c ? c : "?") + strlen(l ? l : "?") + 8;
			char *both = malloc(room);
			snprintf(both, room, "%s; %s", c ? c : "?", l ? l : "?");
			free(c);
			free(l);
			__sync_synchronize();
			said_is = both;
		}
		job->compiler_is = said_is ? strdup(said_is) : NULL;
	}
done:
	free(clang);
	free(ld);
	free(root);
	if (exists(dir)) sweep(dir);
	job->ms = ms() - began;
}

void ccFree(CcJob *job) {
	if (!job) return;
	free(job->source);
	free(job->compiler);
	free(job->linker);
	for (int i = 0; i < job->nflags; i++) free(job->flags[i]);
	free(job->flags);
	for (int i = 0; i < job->nhere; i++) free(job->here[i].name), free(job->here[i].text);
	for (int i = 0; i < job->nlib; i++) free(job->lib[i].name), free(job->lib[i].text);
	free(job->here);
	free(job->lib);
	free(job->wasm);
	jsonFree(job->exports);
	jsonFree(job->diagnostics);
	for (int i = 0; i < job->nsteps; i++) free(job->steps[i].name);
	free(job->steps);
	free(job->compiler_is);
	free(job);
}
