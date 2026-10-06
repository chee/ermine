// json_test.c: checks json.c against what JavaScript does. make check.
// The number table was made with JSON.stringify in deno.

#include "json.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures = 0;

static void expectText(const char *what, const char *got, const char *want) {
	if (strcmp(got, want) != 0) {
		printf("FAIL %s: got %s, want %s\n", what, got, want);
		failures++;
	}
}

static void expectTrue(const char *what, bool ok) {
	if (!ok) {
		printf("FAIL %s\n", what);
		failures++;
	}
}

static const struct {
	double number;
	const char *text;
} numbers[] = {
	{ 0.0000000000000000, "0" },
	{ -0.0, "0" },
	{ 1.0000000000000000, "1" },
	{ -1.0000000000000000, "-1" },
	{ 0.10000000000000001, "0.1" },
	{ 0.30000000000000004, "0.30000000000000004" },
	{ 0.33333333333333331, "0.3333333333333333" },
	{ 123456789.00000000, "123456789" },
	{ 1.0000000000000000e+21, "1e+21" },
	{ 1.0000000000000000e+20, "100000000000000000000" },
	{ 1.2300000000000001e+22, "1.23e+22" },
	{ 1.4999999999999999e-7, "1.5e-7" },
	{ 9.9999999999999995e-7, "0.000001" },
	{ 0.0000012340000000000000, "0.000001234" },
	{ 9.9999999999999995e-8, "1e-7" },
	{ 4.9406564584124654e-324, "5e-324" },
	{ 1.7976931348623157e+308, "1.7976931348623157e+308" },
	{ 9007199254740992.0, "9007199254740992" },
	{ 9007199254740994.0, "9007199254740994" },
	{ -9.2233720368547758e+18, "-9223372036854776000" },
	{ 100.00000000000000, "100" },
	{ 1.0000000000000001e+300, "1e+300" },
	{ 12345.678900000001, "12345.6789" },
	{ 0.50000000000000000, "0.5" },
	{ 4.3499999999999996, "4.35" },
	{ 9007199254740992.0, "9007199254740992" },
	{ 1.0000000000000000e+22, "1e+22" },
	{ 1.2000000000000000e+21, "1.2e+21" },
	{ 1.2345678901234568e+20, "123456789012345680000" },
	{ 0.000010000000000000001, "0.00001" },
	{ 2.4999999999999999e-7, "2.5e-7" },
};

/** parses the line and prints it back */
static void roundTrip(const char *line, const char *want) {
	char *why = NULL;
	Json *value = jsonParse(line, strlen(line), &why);
	if (!value) {
		printf("FAIL parse %s: %s\n", line, why);
		failures++;
		free(why);
		return;
	}
	char *text = jsonPrint(value);
	expectText(line, text, want);
	free(text);
	jsonFree(value);
}

static Json *parse(const char *line) {
	char *why = NULL;
	Json *value = jsonParse(line, strlen(line), &why);
	if (!value) {
		printf("FAIL parse %s: %s\n", line, why);
		exit(1);
	}
	return value;
}

int main(void) {
	for (size_t i = 0; i < sizeof numbers / sizeof *numbers; i++) {
		char text[32];
		jsonNumberText(numbers[i].number, text);
		expectText("number", text, numbers[i].text);
	}

	// strings: JSON.stringify's escapes; U+2028 and U+0085 raw; DEL raw
	roundTrip("\"a\\u0001\\b\\f\\n\\r\\t\\\"\\\\\\/\x7f\"", "\"a\\u0001\\b\\f\\n\\r\\t\\\"\\\\/\x7f\"");
	roundTrip("\"\\u2028\xc2\x85\"", "\"\xe2\x80\xa8\xc2\x85\"");
	roundTrip("\"\\ud83d\\ude00\"", "\"\xf0\x9f\x98\x80\"");
	roundTrip("\"\\ud800x\\udc00\"", "\"\\ud800x\\udc00\"");
	roundTrip("\"\\u0000\"", "\"\\u0000\"");
	roundTrip(" {\"a\" : [1, 2.50, -0, 1E3, true, false, null], \"b\": {}} \r", "{\"a\":[1,2.5,0,1000,true,false,null],\"b\":{}}");
	roundTrip("{\"a\":1,\"a\":2}", "{\"a\":2}");

	// failures
	const char *bad[] = { "", "nul", "[1,]", "{\"a\"}", "01", "1.", "\"\x01\"", "\"\xff\"", "[1] 2", "{'a':1}" };
	for (size_t i = 0; i < sizeof bad / sizeof *bad; i++) {
		char *why = NULL;
		Json *value = jsonParse(bad[i], strlen(bad[i]), &why);
		expectTrue(bad[i], value == NULL && why != NULL);
		free(why);
	}

	// code points
	Json *s = parse("\"a\xc3\xa9\xf0\x9f\x98\x80z\\ud800\"");
	expectTrue("count", utf8Count(s->string, s->stringLength) == 5);
	expectTrue("offset 0", utf8Offset(s->string, s->stringLength, 0) == 0);
	expectTrue("offset 2", utf8Offset(s->string, s->stringLength, 2) == 3);
	expectTrue("offset 3", utf8Offset(s->string, s->stringLength, 3) == 7);
	expectTrue("offset 4", utf8Offset(s->string, s->stringLength, 4) == 8);
	expectTrue("offset 5", utf8Offset(s->string, s->stringLength, 5) == s->stringLength);
	expectTrue("offset 9", utf8Offset(s->string, s->stringLength, 9) == s->stringLength);
	expectTrue("order", utf8Compare("a", 1, "\xc3\xa9", 2) < 0 && utf8Compare("ab", 2, "a", 1) > 0 && utf8Compare("\xef\xbf\xbf", 3, "\xf0\x9f\x98\x80", 4) < 0);

	// equality
	expectTrue("objects in any order", jsonEqual(parse("{\"a\":1,\"b\":[1,{\"c\":null}]}"), parse("{\"b\":[1.0,{\"c\":null}],\"a\":1e0}")));
	expectTrue("-0 is 0", jsonEqual(parse("-0"), parse("0")));
	expectTrue("lists in order", !jsonEqual(parse("[1,2]"), parse("[2,1]")));
	expectTrue("more keys", !jsonEqual(parse("{\"a\":1}"), parse("{\"a\":1,\"b\":2}")));
	expectTrue("types", !jsonEqual(parse("1"), parse("\"1\"")) && !jsonEqual(parse("null"), parse("false")));
	expectTrue("absent", jsonEqual(NULL, NULL) && !jsonEqual(NULL, parse("null")));

	// set and remove
	Json *o = parse("{\"a\":1,\"b\":2}");
	jsonSet(o, "a", 1, jsonInteger(3));
	jsonSet(o, "c", 1, jsonInteger(4));
	expectTrue("remove", jsonRemove(o, "b", 1) && !jsonRemove(o, "x", 1));
	char *printed = jsonPrint(o);
	expectText("set", printed, "{\"a\":3,\"c\":4}");
	free(printed);

	int64_t whole;
	expectTrue("whole", jsonIsWhole(parse("3"), &whole) && whole == 3 && !jsonIsWhole(parse("3.5"), &whole) && !jsonIsWhole(parse("\"3\""), &whole));
	Json *nul = parse("\"a\\u0000b\"");
	expectTrue("nul is text", jsonText(nul) && strcmp(jsonText(nul), "a\xc0\x80" "b") == 0 && utf8Count(nul->string, nul->stringLength) == 3);
	char *nulPrinted = jsonPrint(nul);
	expectText("nul prints", nulPrinted, "\"a\\u0000b\"");
	free(nulPrinted);
	expectTrue("nul sorts first", textCompare("a\xc0\x80", "a\x01") < 0 && textCompare("a", "a\xc0\x80") < 0 && textCompare("\xc0\x80", "\xc0\x80") == 0);
	expectTrue("nul is not the end", !jsonEqual(nul, parse("\"a\"")));
	{
		size_t depth = 200000;
		char *deep = allocate(2 * depth + 1);
		memset(deep, '[', depth);
		memset(deep + depth, ']', depth);
		char *why = NULL;
		expectTrue("deep parses", jsonParse(deep, 2 * depth, &why) != NULL);
		free(deep);
	}

	if (failures) {
		printf("%d failed\n", failures);
		return 1;
	}
	puts("json: all passed");
	return 0;
}
