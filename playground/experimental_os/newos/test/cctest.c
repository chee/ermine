// cctest.c: cc.c on its own (cc.sh builds and runs it): source and headers in;
// the keys, the module, its exports, the steps and the diagnostics out.

#include "../cc.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failed;

#define CHECK(c, ...) \
	do { \
		if (!(c)) { \
			failed++; \
			fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
			fprintf(stderr, __VA_ARGS__); \
			fputc('\n', stderr); \
		} \
	} while (0)

static char *slurp(const char *path, size_t *n) {
	FILE *f = fopen(path, "rb");
	if (!f) return NULL;
	fseek(f, 0, SEEK_END);
	long len = ftell(f);
	fseek(f, 0, SEEK_SET);
	char *text = malloc((size_t)len + 1);
	*n = fread(text, 1, (size_t)len, f);
	text[*n] = 0;
	fclose(f);
	return text;
}

static CcJob *job(const char *source, const char *ermine, size_t nermine, const char *beside, const char *besideText) {
	CcJob *j = calloc(1, sizeof *j);
	j->source = strdup(source);
	j->nsource = strlen(source);
	j->flags = calloc(1, sizeof *j->flags);
	j->flags[0] = strdup("-O2");
	j->nflags = 1;
	j->lib = calloc(1, sizeof *j->lib);
	j->lib[0] = (CcFile){ strdup("ermine.h"), strndup(ermine, nermine), nermine };
	j->nlib = 1;
	if (beside) {
		j->here = calloc(1, sizeof *j->here);
		j->here[0] = (CcFile){ strdup(beside), strdup(besideText), strlen(besideText) };
		j->nhere = 1;
	}
	return j;
}

static bool exports(const CcJob *j, const char *name) {
	for (int i = 0; j->exports && i < j->exports->array.count; i++)
		if (!strcmp(jsonText(j->exports->array.items[i]), name)) return true;
	return false;
}

static const char *first(const CcJob *j) {
	Json *d = j->diagnostics && j->diagnostics->array.count ? j->diagnostics->array.items[0] : NULL;
	return d ? jsonText(jsonGet(d, "message")) : "";
}

int main(int argc, char **argv) {
	size_t n;
	char *ermine = slurp(argc > 1 ? argv[1] : "playground/experimental_os/newos/image/lib/c/ermine.h", &n);
	if (!ermine) {
		fprintf(stderr, "cctest: no ermine.h (give its path)\n");
		return 1;
	}

	// the keys: the same in, the same key; another answer, another key
	uint8_t k0[32], k0b[32], h[32], k1[32], k1b[32];
	const char *cv = "{\"compiler\": \"clang\", \"flags\": [\"-O2\"]}";
	char *why = NULL;
	Json *c = jsonParse(cv, strlen(cv), &why);
	ccRoot(c, k0);
	ccRoot(c, k0b);
	CHECK(!memcmp(k0, k0b, 32), "a root key is the same for the same /c");
	ccText("x", 1, h);
	Json *a = ccAnswer(CC_LIB, h), *b = ccAnswer(CC_HERE, h);
	ccNext(k0, a, k1);
	ccNext(k0, b, k1b);
	CHECK(memcmp(k1, k1b, 32), "a header beside the program is another key than /lib/c's");
	char hex[65];
	ccHex(k1, hex);
	CHECK(strlen(hex) == 64, "a key in hex is 64 digits");
	jsonFree(a), jsonFree(b), jsonFree(c);

	// hello: a module, setup exported, ermine.h entered from /lib/c
	CcJob *j = job("#include <ermine.h>\ner_value setup(void) {\n\ter_say(\"hello\");\n\treturn er_text(\"hello, world\");\n}\n", ermine, n, NULL, NULL);
	ccRun(j);
	CHECK(j->ok, "hello compiles: %s", first(j));
	CHECK(j->nwasm > 8 && !memcmp(j->wasm, "\0asm", 4), "a module");
	CHECK(exports(j, "setup"), "setup exported");
	CHECK(j->nsteps == 1 && !strcmp(j->steps[0].name, "ermine.h") && j->steps[0].where == CC_LIB, "ermine.h entered from /lib/c (%d steps)", j->nsteps);
	printf("hello: %zu bytes, %lld ms, %s\n", j->nwasm, (long long)j->ms, j->compiler_is ? j->compiler_is : "?");
	ccFree(j);

	// a header beside the program, entered after ermine.h, in clang's order
	j = job("#include <ermine.h>\n#include \"two.h\"\ner_value setup(void) { return er_int(TWO); }\n", ermine, n, "two.h", "#define TWO 2\n");
	ccRun(j);
	CHECK(j->ok, "two compiles: %s", first(j));
	CHECK(j->nsteps == 2 && j->steps[1].where == CC_HERE && !strcmp(j->steps[1].name, "two.h"), "two.h entered from beside the program");
	ccFree(j);

	// an error: its line and column, no module
	j = job("#include <ermine.h>\ner_value setup(void) {\n\treturn er_text(helo);\n}\n", ermine, n, NULL, NULL);
	ccRun(j);
	CHECK(!j->ok && !j->wasm, "helo does not compile");
	Json *d = j->diagnostics->array.count ? j->diagnostics->array.items[0] : NULL;
	int64_t line = 0, column = 0;
	jsonIsWhole(jsonGet(d, "line"), &line);
	jsonIsWhole(jsonGet(d, "column"), &column);
	CHECK(line == 3 && column == 17 && strstr(first(j), "helo"), "3:17 says helo: %lld:%lld %s", (long long)line, (long long)column, first(j));
	ccFree(j);

	// libc: said plainly, and the include is a step, answered none
	j = job("#include <stdio.h>\n#include <ermine.h>\ner_value setup(void) { return er_none(); }\n", ermine, n, NULL, NULL);
	ccRun(j);
	CHECK(!j->ok && strstr(first(j), "no libc yet"), "stdio.h: no libc yet: %s", first(j));
	CHECK(j->nsteps >= 1 && !strcmp(j->steps[j->nsteps - 1].name, "stdio.h") && j->steps[j->nsteps - 1].where == CC_NONE, "stdio.h a step, none");
	ccFree(j);

	// main and no setup: the linker's word, said plainly
	j = job("#include <ermine.h>\nint main(void) { return 0; }\n", ermine, n, NULL, NULL);
	ccRun(j);
	CHECK(!j->ok && strstr(first(j), "setup(), not main"), "main: %s", first(j));
	ccFree(j);

	// an import ermine.h does not give: a link error, not a failed start
	j = job("#include <ermine.h>\nextern int nothing(void);\ner_value setup(void) { return er_int(nothing()); }\n", ermine, n, NULL, NULL);
	ccRun(j);
	CHECK(!j->ok && strstr(first(j), "undefined symbol: nothing"), "undefined: %s", first(j));
	ccFree(j);

	free(ermine);
	printf(failed ? "cctest: %d failed\n" : "cctest: all passed\n", failed);
	return failed ? 1 : 0;
}
