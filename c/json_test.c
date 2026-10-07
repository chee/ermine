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
	roundTrip(" {\"a\" : [1, 2.50, -0, 1E3, true, false, null], \"b\": {}} \r", "{\"a\":[1,2.5,-0,1000,true,false,null],\"b\":{}}");
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
	expectTrue("-0 is not 0", !jsonEqual(parse("-0"), parse("0")));
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
	// any size is whole; past int64 it is held at the edge
	expectTrue("whole past 2^53", jsonIsWhole(parse("9007199254740994"), &whole) && whole == 9007199254740994);
	expectTrue("whole past int64", jsonIsWhole(parse("1e21"), &whole) && whole == INT64_MAX && jsonIsWhole(parse("-1e21"), &whole) && whole == INT64_MIN);
	expectTrue("whole at int64's edge", jsonIsWhole(parse("-9223372036854775808"), &whole) && whole == INT64_MIN && jsonIsWhole(parse("9223372036854775807"), &whole) && whole == INT64_MAX);
	expectTrue("whole without out", jsonIsWhole(parse("1.7976931348623157e308"), NULL) && jsonIsWhole(parse("-0"), NULL) && !jsonIsWhole(parse("1e-7"), NULL));
	Json *nul = parse("\"a\\u0000b\"");
	expectTrue("nul is text", jsonText(nul) && strcmp(jsonText(nul), "a\xc0\x80" "b") == 0 && utf8Count(nul->string, nul->stringLength) == 3);
	char *nulPrinted = jsonPrint(nul);
	expectText("nul prints", nulPrinted, "\"a\\u0000b\"");
	free(nulPrinted);
	expectTrue("nul sorts first", textCompare("a\xc0\x80", "a\x01") < 0 && textCompare("a", "a\xc0\x80") < 0 && textCompare("\xc0\x80", "\xc0\x80") == 0);
	expectTrue("nul is not the end", !jsonEqual(nul, parse("\"a\"")));
	{
		// nothing recurses: a value a million levels deep parses, prints, compares and frees on the default stack
		size_t depth = 1000000;
		char *deep = allocate(2 * depth + 1);
		memset(deep, '[', depth);
		memset(deep + depth, ']', depth);
		char *why = NULL;
		Json *a = jsonParse(deep, 2 * depth, &why), *b = jsonParse(deep, 2 * depth, &why);
		expectTrue("deep parses", a != NULL && b != NULL);
		char *printed = jsonPrint(a);
		expectTrue("deep prints", strcmp(printed, deep) == 0);
		expectTrue("deep equal", jsonEqual(a, b));
		jsonPush(b, jsonNull());
		expectTrue("deep unequal", !jsonEqual(a, b));
		jsonFree(a);
		jsonFree(b);
		free(printed);
		memset(deep + depth - 1, '{', 1);
		expectTrue("deep fails", jsonParse(deep, 2 * depth, &why) == NULL && why != NULL);
		free(why);
		free(deep);
		Json *o = parse("{\"a\":[{\"b\":{\"c\":[1,\"x\",null]}}],\"d\":{}}");
		char *text = jsonPrint(o);
		expectText("nested prints", text, "{\"a\":[{\"b\":{\"c\":[1,\"x\",null]}}],\"d\":{}}");
		free(text);
		expectTrue("nested equal", jsonEqual(o, parse("{\"d\":{},\"a\":[{\"b\":{\"c\":[1,\"x\",null]}}]}")));
		expectTrue("nested unequal", !jsonEqual(o, parse("{\"d\":{},\"a\":[{\"b\":{\"c\":[1,\"x\",false]}}]}")));
		expectTrue("missing key", !jsonEqual(parse("{\"a\":1}"), parse("{\"b\":1}")));
		jsonFree(o);
	}
	{
		const char *partial[] = { "[[1],{\"a\":[2,", "{\"a\":{\"b\"", "[{}],", "{\"a\":1,}" };
		for (size_t i = 0; i < sizeof partial / sizeof *partial; i++) {
			char *why = NULL;
			expectTrue(partial[i], jsonParse(partial[i], strlen(partial[i]), &why) == NULL && why != NULL);
			free(why);
		}
	}
	{
		// what a parser reading from the start had read whole before the text stopped being JSON
		const struct {
			const char *text, *read;
		} cases[] = {
			{ "{\"seq\": 2, \"cmd\": \"read\"", "{\"seq\":2,\"cmd\":\"read\"}" },
			{ "{\"seq\":3} x", "{\"seq\":3}" },
			{ "{\"seq\":12", "{\"seq\":12}" },
			{ "{\"seq\":1x}", "{\"seq\":1}" },
			{ "{\"a\":[1,{\"seq\":5}", "{}" },
			{ "{\"seq\":tru", "{}" },
			{ "{\"seq\":\"x", "{}" },
			{ "[1,[2", "[1]" },
			{ "42 x", "42" },
			{ "not json", NULL },
			{ "", NULL },
			{ "{\"seq\":1}", NULL },
		};
		for (size_t i = 0; i < sizeof cases / sizeof *cases; i++) {
			char *why = NULL;
			Json *read = NULL, *value = jsonParseRead(cases[i].text, strlen(cases[i].text), &why, &read);
			char *text = read ? jsonPrint(read) : NULL;
			expectTrue(cases[i].text, (value != NULL) == (why == NULL) && (text ? cases[i].read && strcmp(text, cases[i].read) == 0 : !cases[i].read));
			free(text);
			free(why);
			jsonFree(read);
			jsonFree(value);
		}
	}

	{
		// PROTOCOL Values in JSON: each form read and written back as given
		const char *forms[] = {
			"{\"/\":{\"bytes\":\"aGVsbG8\"}}",
			"{\"/\":{\"bytes\":\"+/8\"}}",
			"{\"/\":{\"bytes\":\"\"}}",
			"[{\"/\":{\"float64\":[-0,\"NaN\",\"Infinity\",\"-Infinity\",1.5,1e+300]}}]",
			"{\"/\":{\"float32\":[0.1,-0,\"NaN\",3.4028235e+38]}}",
			"{\"/\":{\"int64\":[\"-9223372036854775808\",\"9007199254740993\",\"9223372036854775807\"]}}",
			"{\"/\":{\"uint64\":[\"0\",\"18446744073709551615\"]}}",
			"{\"/\":{\"int8\":[-128,127]}}",
			"{\"/\":{\"uint32\":[0,4294967295]}}",
			"{\"/\":{\"map\":{\"/\":{\"/\":{\"map\":{\"/\":null}}}}}}",
			"{\"k\":{\"/\":{\"number\":\"-Infinity\"}},\"/\":1}",
			"{\"/\":{\"number\":\"NaN\"}}",
		};
		for (size_t i = 0; i < sizeof forms / sizeof *forms; i++) {
			Json *value = parse(forms[i]);
			expectTrue(forms[i], jsonDecode(&value, false));
			char *text = jsonPrint(value);
			expectText("form round trip", text, forms[i]);
			free(text);
		}
		Json *shortest = parse("{\"/\":{\"float32\":[3.141592653589793,16777217,123456.789]}}");
		expectTrue("float32 decodes", jsonDecode(&shortest, false));
		char *text = jsonPrint(shortest);
		expectText("float32 shortest", text, "{\"/\":{\"float32\":[3.1415927,16777216,123456.79]}}");
		free(text);
		const char *malformed[] = {
			"{\"/\":{\"bytes\":\"aGk=\"}}", "{\"/\":{\"bytes\":\"aGVsb\"}}", "{\"/\":{\"bytes\":\"aGl\"}}", "{\"/\":{\"bytes\":\"-_8\"}}",
			"{\"/\":{\"int8\":[128]}}", "{\"/\":{\"uint8\":[0.5]}}", "{\"/\":{\"int64\":[1]}}", "{\"/\":{\"int64\":[\"01\"]}}",
			"{\"/\":{\"uint64\":[\"18446744073709551616\"]}}", "{\"/\":{\"int64\":[\"9223372036854775808\"]}}", "{\"/\":{\"float32\":[1e39]}}",
			"{\"/\":{\"float64\":[\"nan\"]}}", "{\"/\":{\"number\":\"-0\"}}", "{\"/\":{}}", "{\"/\":1}", "{\"/\":{\"map\":{\"/\":1,\"x\":2}}}",
			"{\"/\":{\"bytes\":\"aGk\",\"int8\":[]}}", "[{\"/\":{\"live\":\"canvas\"}}]", "{\"/\":{\"live\":\"canvas\"}}",
		};
		for (size_t i = 0; i < sizeof malformed / sizeof *malformed; i++) {
			Json *value = parse(malformed[i]);
			expectTrue(malformed[i], !jsonDecode(&value, false));
		}
		Json *live = parse("{\"/\":{\"live\":\"canvas\"}}"), *again = parse("{\"/\":{\"live\":\"canvas\"}}");
		expectTrue("a whole live value", jsonDecode(&live, true) && jsonDecode(&again, true) && live->type == JSON_LIVE);
		expectTrue("live values are equal only to themselves", jsonEqual(live, live) && !jsonEqual(live, again));
		Json *nested = parse("[{\"/\":{\"live\":\"canvas\"}}]");
		expectTrue("a live value only as the whole value", !jsonDecode(&nested, true));
		// CORE Values: equality
		Json *values[] = { parse("{\"/\":{\"number\":\"NaN\"}}"), parse("{\"/\":{\"float32\":[\"NaN\",0]}}"), parse("{\"/\":{\"float32\":[\"NaN\",-0]}}"),
			parse("{\"/\":{\"float64\":[\"NaN\",0]}}"), parse("{\"/\":{\"bytes\":\"AQI\"}}"), parse("{\"/\":{\"uint8\":[1,2]}}"), parse("[1,2]") };
		for (size_t i = 0; i < sizeof values / sizeof *values; i++) jsonDecode(&values[i], false);
		expectTrue("NaN equals NaN", jsonEqual(values[0], jsonNumber(-values[0]->number)) && !jsonEqual(parse("0"), parse("-0")));
		Json *same = parse("{\"/\":{\"float32\":[\"NaN\",0]}}");
		jsonDecode(&same, false);
		expectTrue("typed arrays element by element", jsonEqual(values[1], same) && !jsonEqual(values[1], values[2]));
		expectTrue("typed arrays only of the same kind", !jsonEqual(values[1], values[3]));
		expectTrue("bytes, a typed array and a list differ", !jsonEqual(values[4], values[5]) && !jsonEqual(values[5], values[6]) && !jsonEqual(values[4], values[6]));
	}

	if (failures) {
		printf("%d failed\n", failures);
		return 1;
	}
	puts("json: all passed");
	return 0;
}
