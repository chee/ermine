// json_text.c: a value's JSON text (json_text.h): the parser, jsonDecode's "/" forms and the
// printer. Apart from json.c, so what never reads or writes text links none of it.

#include "json_text.h"
#include "../../../core/changeable/c/whole.h"

#include <ctype.h>
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// the typed arrays' kinds as their JSON form names them, in JsonKind's order
static const char *const kindNames[JSON_KINDS] = { "int8", "int16", "uint16", "int32", "uint32", "int64", "uint64", "float32", "float64" };

static bool isContinuation(unsigned char byte) {
	return (byte & 0xc0) == 0x80;
}

// values in JSON (conformance/typescript/form.ts) ---------------------------------------

static const char base64Digits[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static int base64Digit(char c) {
	const char *at = c ? strchr(base64Digits, c) : NULL;
	return at ? (int)(at - base64Digits) : -1;
}

/** bytes from base64, standard alphabet, no padding, in the one spelling of those bytes (the bits past the last octet zero); NULL otherwise */
static Json *bytesOf(const Json *text) {
	if (!jsonIsString(text) || text->stringLength % 4 == 1) return NULL;
	size_t n = text->stringLength, k = 0;
	unsigned char *out = allocate(n / 4 * 3 + 2);
	uint32_t bits = 0;
	int held = 0;
	for (size_t i = 0; i < n; i++) {
		int digit = base64Digit(text->string[i]);
		if (digit < 0) {
			free(out);
			return NULL;
		}
		bits = (bits << 6) | (uint32_t)digit;
		held += 6;
		if (held >= 8) {
			held -= 8;
			out[k++] = (unsigned char)(bits >> held);
		}
		bits &= (1u << held) - 1;
	}
	Json *value = bits ? NULL : jsonBytes(out, k);
	free(out);
	return value;
}

/** NaN, Infinity or -Infinity, the words JSON has no number for; false for anything else */
static bool numberWord(const Json *word, double *out) {
	const char *text = jsonText(word);
	if (!text) return false;
	if (strcmp(text, "NaN") == 0) *out = NAN;
	else if (strcmp(text, "Infinity") == 0) *out = INFINITY;
	else if (strcmp(text, "-Infinity") == 0) *out = -INFINITY;
	else return false;
	return true;
}

/**
 * one element of a typed array's list, by its kind: a whole number in range;
 * a 64-bit one as a decimal string; a float a number, or "NaN", "Infinity",
 * "-Infinity" (as the shared vectors write it). False when it is not one
 */
static bool elementOf(int kind, const Json *e, char *at) {
	if (kind == JSON_INT64 || kind == JSON_UINT64) {
		const char *text = jsonText(e);
		if (!text || (*text != '-' && !isdigit((unsigned char)*text))) return false;
		char *end;
		errno = 0;
		if (kind == JSON_INT64) *(int64_t *)at = strtoll(text, &end, 10);
		else {
			if (*text == '-') return false;
			*(uint64_t *)at = strtoull(text, &end, 10);
		}
		return !errno && !*end && (size_t)(end - text) == e->stringLength;
	}
	double d;
	if (kind == JSON_FLOAT32 || kind == JSON_FLOAT64) {
		if (jsonIsNumber(e)) d = e->number;
		else if (!numberWord(e, &d)) return false;
		if (kind == JSON_FLOAT32) *(float *)at = (float)d;
		else *(double *)at = d;
		return true;
	}
	if (!jsonIsNumber(e) || e->number != floor(e->number)) return false;
	d = e->number;
	switch (kind) {
		case JSON_INT8: if (d < INT8_MIN || d > INT8_MAX) return false; *(int8_t *)at = (int8_t)d; break;
		case JSON_INT16: if (d < INT16_MIN || d > INT16_MAX) return false; *(int16_t *)at = (int16_t)d; break;
		case JSON_UINT16: if (d < 0 || d > UINT16_MAX) return false; *(uint16_t *)at = (uint16_t)d; break;
		case JSON_INT32: if (d < INT32_MIN || d > INT32_MAX) return false; *(int32_t *)at = (int32_t)d; break;
		default: if (d < 0 || d > UINT32_MAX) return false; *(uint32_t *)at = (uint32_t)d; break;
	}
	return true;
}

/**
 * a typed array from its kind's name and the list of its elements (the
 * shared vectors' form); NULL when the kind is unknown or an element is not
 * one of its kind
 */
static Json *typedOf(const char *name, size_t nameLength, const Json *list) {
	int kind = 0;
	while (kind < JSON_KINDS && !(strlen(kindNames[kind]) == nameLength && memcmp(kindNames[kind], name, nameLength) == 0)) kind++;
	if (kind == JSON_KINDS || !jsonIsArray(list)) return NULL;
	size_t size = jsonKindSize(kind), count = (size_t)list->array.count;
	Json *value = jsonTyped((JsonKind)kind, NULL, 0);
	free(value->typed.data);
	value->typed.data = allocate(count * size + 1);
	value->typed.count = count;
	for (size_t i = 0; i < count; i++) {
		if (!elementOf(kind, list->array.items[i], (char *)value->typed.data + i * size)) {
			jsonFree(value);
			return NULL;
		}
	}
	return value;
}

static bool isKey(const JsonMember *member, const char *key) {
	return member->keyLength == strlen(key) && memcmp(member->key, key, member->keyLength) == 0;
}

/** an object whose only key is "/" */
static bool isSlashMap(const Json *value) {
	return jsonIsObject(value) && value->object.count == 1 && isKey(&value->object.members[0], "/");
}

/** a whole number from decimal digits, a '-' first or not (and no leading zero when `strict`); NULL when not that */
static Json *wholeOf(const char *text, size_t length, bool strict) {
	bool negative = length && text[0] == '-';
	const char *digits = text + negative;
	size_t n = length - negative;
	if (!n || (strict && n > 1 && digits[0] == '0')) return NULL;
	for (size_t i = 0; i < n; i++)
		if (digits[i] < '0' || digits[i] > '9') return NULL;
	size_t bytes;
	unsigned char *m = whole_parse(digits, n, &bytes);
	Json *value = jsonWhole(negative, m, bytes);
	free(m);
	return value;
}

/** a whole number past 2^53 - 1 either way, in decimal: the one spelling ({"/":{"bigint":"…"}}); a safe one is plain digits, so NULL */
static Json *bigintOf(const Json *text) {
	if (!jsonIsString(text)) return NULL;
	Json *value = wholeOf(text->string, text->stringLength, true);
	if (value && !value->big && fabs(value->number) <= 9007199254740991.0) {
		jsonFree(value);
		return NULL;
	}
	return value;
}

/** the value one "/" form other than map stands for: bytes, a number, a stand-in (its kind still to decode), or a typed array; NULL when malformed */
static Json *formOf(const JsonMember *form) {
	double number;
	if (isKey(form, "bytes")) return bytesOf(form->value);
	if (isKey(form, "bigint")) return bigintOf(form->value);
	if (isKey(form, "number")) return numberWord(form->value, &number) ? jsonNumber(number) : NULL;
	if (isKey(form, "live")) return jsonStand(form->value);
	return typedOf(form->key, form->keyLength, form->value);
}

/** here becomes what made held (made itself goes), and the form it was is let go of; keep, a part of that form, stays */
static void becomes(Json *here, Json *made, Json *keep) {
	Json *form = allocate(sizeof *form);
	*form = *here;
	*here = *made;
	if (keep) keep->refs++;
	jsonFree(form);
	free(made);
}

// No recursion: the places still to decode are kept on a stack of their own.
bool jsonDecode(Json **value) {
	Json ***stack = NULL;
	int count = 0, capacity = 0;
	stack = growArray(stack, count, &capacity, sizeof *stack);
	stack[count++] = value;
	bool ok = true;
	while (ok && count) {
		Json **at = stack[--count], *here = *at;
		if (jsonIsString(here)) {
			ok = !utf8Surrogate(here->string, here->stringLength); // no string (ENCODING.tex)
		} else if (jsonIsArray(here)) {
			for (int i = 0; i < here->array.count; i++) {
				stack = growArray(stack, count, &capacity, sizeof *stack);
				stack[count++] = &here->array.items[i];
			}
		} else if (isSlashMap(here)) {
			// one of the forms: a map with one key, the form's name
			Json *form = here->object.members[0].value;
			if (!jsonIsObject(form) || form->object.count != 1) {
				ok = false;
			} else if (isKey(&form->object.members[0], "map")) {
				// a map whose only key is "/", as data: its value is decoded in turn
				Json *map = form->object.members[0].value;
				ok = isSlashMap(map);
				if (ok) {
					becomes(here, map, map);
					stack = growArray(stack, count, &capacity, sizeof *stack);
					stack[count++] = &here->object.members[0].value;
				}
			} else {
				Json *made = formOf(&form->object.members[0]);
				ok = made != NULL;
				if (ok) becomes(here, made, made->type == JSON_STAND ? made->stand.kind : NULL);
				if (ok && here->type == JSON_STAND) {
					// its kind is decoded in turn
					stack = growArray(stack, count, &capacity, sizeof *stack);
					stack[count++] = &here->stand.kind;
				}
			}
		} else if (jsonIsObject(here)) {
			for (int i = 0; ok && i < here->object.count; i++) {
				ok = !utf8Surrogate(here->object.members[i].key, here->object.members[i].keyLength);
				stack = growArray(stack, count, &capacity, sizeof *stack);
				stack[count++] = &here->object.members[i].value;
			}
		}
	}
	free(stack);
	return ok;
}

/** the length of the well-formed UTF-8 sequence at text[0], or 0 */
static size_t utf8SequenceLength(const unsigned char *text, size_t available) {
	unsigned char lead = text[0];
	size_t length;
	uint32_t least;
	if (lead < 0x80) return 1;
	if (lead >= 0xc2 && lead <= 0xdf) {
		length = 2;
		least = 0x80;
	} else if (lead >= 0xe0 && lead <= 0xef) {
		length = 3;
		least = 0x800;
	} else if (lead >= 0xf0 && lead <= 0xf4) {
		length = 4;
		least = 0x10000;
	} else {
		return 0;
	}
	if (available < length) return 0;
	uint32_t code = lead & (0xff >> (length + 1));
	for (size_t i = 1; i < length; i++) {
		if (!isContinuation(text[i])) return 0;
		code = (code << 6) | (text[i] & 0x3f);
	}
	if (code < least || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return 0;
	return length;
}

/** writes a code point (a surrogate too, as WTF-8) as UTF-8; returns how many bytes */
static int utf8Encode(uint32_t code, char *out) {
	if (code < 0x80) {
		out[0] = (char)code;
		return 1;
	}
	if (code < 0x800) {
		out[0] = (char)(0xc0 | (code >> 6));
		out[1] = (char)(0x80 | (code & 0x3f));
		return 2;
	}
	if (code < 0x10000) {
		out[0] = (char)(0xe0 | (code >> 12));
		out[1] = (char)(0x80 | ((code >> 6) & 0x3f));
		out[2] = (char)(0x80 | (code & 0x3f));
		return 3;
	}
	out[0] = (char)(0xf0 | (code >> 18));
	out[1] = (char)(0x80 | ((code >> 12) & 0x3f));
	out[2] = (char)(0x80 | ((code >> 6) & 0x3f));
	out[3] = (char)(0x80 | (code & 0x3f));
	return 4;
}

// the parser -------------------------------------------------------------------

typedef struct Parser {
	const unsigned char *text;
	size_t length;
	size_t at;
	char *why;
} Parser;

typedef struct Bytes {
	char *text;
	int count;
	int capacity;
} Bytes;

static void putBytes(Bytes *bytes, const char *text, size_t length) {
	bytes->text = growArray(bytes->text, bytes->count + (int)length, &bytes->capacity, 1);
	memcpy(bytes->text + bytes->count, text, length);
	bytes->count += (int)length;
}

static void fail(Parser *parser, const char *why) {
	if (!parser->why) parser->why = formatString("%s at byte %zu", why, parser->at);
}

static void skipWhitespace(Parser *parser) {
	while (parser->at < parser->length) {
		unsigned char c = parser->text[parser->at];
		if (c != ' ' && c != '\t' && c != '\r' && c != '\n') break;
		parser->at++;
	}
}

static unsigned char peek(Parser *parser) {
	return parser->at < parser->length ? parser->text[parser->at] : 0;
}

static Json *parseWord(Parser *parser, const char *word, Json *value) {
	size_t length = strlen(word);
	if (parser->at + length <= parser->length && memcmp(parser->text + parser->at, word, length) == 0) {
		parser->at += length;
		return value;
	}
	jsonFree(value);
	fail(parser, "unexpected word");
	return NULL;
}

static bool isDigit(unsigned char c) {
	return c >= '0' && c <= '9';
}

static Json *parseNumber(Parser *parser) {
	size_t start = parser->at;
	if (peek(parser) == '-') parser->at++;
	if (peek(parser) == '0') {
		parser->at++;
	} else if (isDigit(peek(parser))) {
		while (isDigit(peek(parser))) parser->at++;
	} else {
		fail(parser, "bad number");
		return NULL;
	}
	if (peek(parser) == '.') {
		parser->at++;
		if (!isDigit(peek(parser))) {
			fail(parser, "bad number");
			return NULL;
		}
		while (isDigit(peek(parser))) parser->at++;
	}
	if (peek(parser) == 'e' || peek(parser) == 'E') {
		parser->at++;
		if (peek(parser) == '+' || peek(parser) == '-') parser->at++;
		if (!isDigit(peek(parser))) {
			fail(parser, "bad number");
			return NULL;
		}
		while (isDigit(peek(parser))) parser->at++;
	}
	const char *text = (const char *)parser->text + start;
	size_t length = parser->at - start;
	// digits alone: a whole number, exactly
	if (!memchr(text, '.', length) && !memchr(text, 'e', length) && !memchr(text, 'E', length) && length > 15) {
		return wholeOf(text, length, false);
	}
	char *spelled = copyStringOfLength(text, length);
	double number = strtod(spelled, NULL);
	free(spelled);
	if (!isfinite(number)) {
		fail(parser, "a number no binary64 holds");
		return NULL;
	}
	Json *value = jsonNumber(number);
	// -0 read as written: a float typed array's element keeps it; a number is 0 (written 0, encoded 00)
	value->number = number;
	return value;
}

static int hexValue(unsigned char c) {
	if (c >= '0' && c <= '9') return c - '0';
	if (c >= 'a' && c <= 'f') return c - 'a' + 10;
	if (c >= 'A' && c <= 'F') return c - 'A' + 10;
	return -1;
}

/** four hex digits at the position, or -1 (the position is then unmoved) */
static int parseHex4(Parser *parser) {
	if (parser->at + 4 > parser->length) return -1;
	int code = 0;
	for (int i = 0; i < 4; i++) {
		int digit = hexValue(parser->text[parser->at + i]);
		if (digit < 0) return -1;
		code = code * 16 + digit;
	}
	parser->at += 4;
	return code;
}

/** the text of a string from its opening quote, NUL-terminated, and its length; NULL on failure */
static char *parseStringText(Parser *parser, size_t *length) {
	parser->at++;
	Bytes out = { NULL, 0, 0 };
	while (true) {
		if (parser->at >= parser->length) {
			fail(parser, "unterminated string");
			free(out.text);
			return NULL;
		}
		unsigned char c = parser->text[parser->at];
		if (c == '"') {
			parser->at++;
			break;
		}
		if (c < 0x20) {
			fail(parser, "a control character in a string");
			free(out.text);
			return NULL;
		}
		char encoded[4];
		int count = 0;
		if (c == '\\') {
			parser->at++;
			unsigned char escape = peek(parser);
			parser->at++;
			switch (escape) {
				case '"': encoded[0] = '"'; count = 1; break;
				case '\\': encoded[0] = '\\'; count = 1; break;
				case '/': encoded[0] = '/'; count = 1; break;
				case 'b': encoded[0] = '\b'; count = 1; break;
				case 'f': encoded[0] = '\f'; count = 1; break;
				case 'n': encoded[0] = '\n'; count = 1; break;
				case 'r': encoded[0] = '\r'; count = 1; break;
				case 't': encoded[0] = '\t'; count = 1; break;
				case 'u': {
					int code = parseHex4(parser);
					if (code < 0) {
						fail(parser, "bad \\u escape");
						free(out.text);
						return NULL;
					}
					if (code >= 0xd800 && code <= 0xdbff && parser->at + 6 <= parser->length && parser->text[parser->at] == '\\' && parser->text[parser->at + 1] == 'u') {
						// a high surrogate followed by a low one is one code point
						size_t before = parser->at;
						parser->at += 2;
						int low = parseHex4(parser);
						if (low >= 0xdc00 && low <= 0xdfff) {
							code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
						} else {
							parser->at = before; // a lone high surrogate; the next escape is its own
						}
					}
					if (code == 0) {
						// U+0000 is held as C0 80, so no string holds a NUL byte
						encoded[0] = (char)0xc0;
						encoded[1] = (char)0x80;
						count = 2;
					} else {
						count = utf8Encode((uint32_t)code, encoded); // a lone surrogate as WTF-8
					}
					break;
				}
				default:
					fail(parser, "bad escape");
					free(out.text);
					return NULL;
			}
		} else {
			size_t step = utf8SequenceLength(parser->text + parser->at, parser->length - parser->at);
			if (!step) {
				fail(parser, "a string that is not UTF-8");
				free(out.text);
				return NULL;
			}
			memcpy(encoded, parser->text + parser->at, step);
			count = (int)step;
			parser->at += step;
		}
		putBytes(&out, encoded, (size_t)count);
	}
	putBytes(&out, "", 1);
	*length = (size_t)out.count - 1;
	return out.text;
}

static Json *parseString(Parser *parser) {
	size_t length;
	char *text = parseStringText(parser, &length);
	if (!text) return NULL;
	return jsonStringTaking(text, length);
}

/** a string, true, false, null or a number at the position; NULL (and a why) when there is none */
static Json *parseScalar(Parser *parser) {
	unsigned char c = peek(parser);
	switch (c) {
		case '"':
			return parseString(parser);
		case 't':
			return parseWord(parser, "true", jsonBoolean(true));
		case 'f':
			return parseWord(parser, "false", jsonBoolean(false));
		case 'n':
			return parseWord(parser, "null", jsonNull());
		default:
			if (c == '-' || isDigit(c)) return parseNumber(parser);
			fail(parser, parser->at >= parser->length ? "unexpected end" : "unexpected character");
			return NULL;
	}
}

/** a list or object being parsed, and the key of the member whose value comes next */
typedef struct Open {
	Json *container;
	char *key;
	size_t keyLength;
} Open;

/** an object's next key and its colon, into the open object */
static bool parseKey(Parser *parser, Open *open) {
	skipWhitespace(parser);
	if (peek(parser) != '"') {
		fail(parser, "expected a key");
		return false;
	}
	open->key = parseStringText(parser, &open->keyLength);
	if (!open->key) return false;
	skipWhitespace(parser);
	if (peek(parser) != ':') {
		fail(parser, "expected :");
		return false;
	}
	parser->at++;
	return true;
}

/** a whole value into the open list or object; a repeated key keeps the last value, as JSON.parse does */
static void putInto(Open *open, Json *value) {
	Json *container = open->container;
	if (container->type == JSON_ARRAY) {
		jsonPush(container, value);
		return;
	}
	jsonSet(container, open->key, open->keyLength, value);
	free(open->key);
	open->key = NULL;
}

// No depth limit and no recursion: a line that is one JSON object is a
// request, however deep (JSON.parse takes it too), so the lists and objects
// being parsed are kept on a stack of their own.
Json *jsonParse(const char *text, size_t length, char **why) {
	Parser parser = { (const unsigned char *)text, length, 0, NULL };
	Open *opens = NULL;
	int depth = 0, capacity = 0;
	Json *value = NULL;
	for (;;) {
		// a value starts here: a scalar is whole at once, a list or object opens
		skipWhitespace(&parser);
		unsigned char c = peek(&parser);
		if (c == '[' || c == '{') {
			parser.at++;
			opens = growArray(opens, depth, &capacity, sizeof *opens);
			opens[depth++] = (Open){ c == '[' ? jsonArray() : jsonObject(), NULL, 0 };
			skipWhitespace(&parser);
			if (peek(&parser) == (c == '[' ? ']' : '}')) {
				parser.at++;
				value = opens[--depth].container;
			} else {
				if (c == '{' && !parseKey(&parser, &opens[depth - 1])) goto failed;
				continue;
			}
		} else if (!(value = parseScalar(&parser))) {
			goto failed;
		}
		// the value is whole: put it in its container, and close every container that ends after it
		for (;;) {
			if (depth == 0) goto parsed;
			Open *open = &opens[depth - 1];
			bool list = open->container->type == JSON_ARRAY;
			putInto(open, value);
			value = NULL;
			skipWhitespace(&parser);
			c = peek(&parser);
			if (c == ',') {
				parser.at++;
				if (!list && !parseKey(&parser, open)) goto failed;
				break;
			}
			if (c != (list ? ']' : '}')) {
				fail(&parser, list ? "expected , or ]" : "expected , or }");
				goto failed;
			}
			parser.at++;
			value = open->container;
			depth--;
		}
	}
parsed:
	skipWhitespace(&parser);
	if (parser.at == parser.length) {
		free(opens);
		free(parser.why);
		return value;
	}
	fail(&parser, "trailing characters");
failed:
	// the open containers are not yet in each other: each is freed on its own
	jsonFree(value);
	for (int i = 0; i < depth; i++) {
		jsonFree(opens[i].container);
		free(opens[i].key);
	}
	free(opens);
	*why = parser.why ? parser.why : copyString("unreadable");
	return NULL;
}

// the printer ------------------------------------------------------------------

void jsonNumberText(double number, char out[32]) {
	if (isnan(number) || isinf(number)) {
		strcpy(out, "null");
		return;
	}
	if (number == 0) {
		strcpy(out, "0"); // -0 too
		return;
	}
	// whole and below 1e21: its digits, as JSON.stringify writes them
	if (number == floor(number) && fabs(number) < 1e21) {
		whole_js_digits(number, out);
		return;
	}
	// the fewest digits from 15 that read back as the same double; %.17g always does
	for (int precision = 15; precision <= 17; precision++) {
		snprintf(out, 32, "%.*g", precision, number);
		if (strtod(out, NULL) == number) return;
	}
}

static void putText(Bytes *bytes, const char *text) {
	putBytes(bytes, text, strlen(text));
}

/** as JSON.stringify: " \ and \b \f \n \r \t escaped, other controls as \u00xx, lone surrogates as \udxxx, the rest raw */
static void putString(Bytes *bytes, const char *text, size_t length) {
	putBytes(bytes, "\"", 1);
	const unsigned char *c = (const unsigned char *)text;
	for (size_t i = 0; i < length; i++) {
		unsigned char byte = c[i];
		char escaped[8];
		switch (byte) {
			case '"': putText(bytes, "\\\""); continue;
			case '\\': putText(bytes, "\\\\"); continue;
			case '\b': putText(bytes, "\\b"); continue;
			case '\f': putText(bytes, "\\f"); continue;
			case '\n': putText(bytes, "\\n"); continue;
			case '\r': putText(bytes, "\\r"); continue;
			case '\t': putText(bytes, "\\t"); continue;
			default: break;
		}
		if (byte == 0xc0 && i + 1 < length && c[i + 1] == 0x80) {
			putText(bytes, "\\u0000"); // U+0000, held as C0 80
			i += 1;
		} else if (byte < 0x20) {
			snprintf(escaped, sizeof escaped, "\\u%04x", byte);
			putText(bytes, escaped);
		} else if (byte == 0xed && i + 2 < length && c[i + 1] >= 0xa0 && c[i + 1] <= 0xbf) {
			unsigned code = ((byte & 0x0fu) << 12) | ((c[i + 1] & 0x3fu) << 6) | (c[i + 2] & 0x3fu);
			snprintf(escaped, sizeof escaped, "\\u%04x", code);
			putText(bytes, escaped);
			i += 2;
		} else {
			putBytes(bytes, (const char *)&c[i], 1);
		}
	}
	putBytes(bytes, "\"", 1);
}

/** a number in its JSON form: -0 as -0, NaN and the infinities as the words `words` puts them in */
static void putNumber(Bytes *bytes, double number, const char *before, const char *after) {
	char spelled[32];
	if (isnan(number) || isinf(number)) {
		putText(bytes, before);
		putText(bytes, isnan(number) ? "NaN" : number > 0 ? "Infinity" : "-Infinity");
		putText(bytes, after);
		return;
	}
	if (number == 0 && signbit(number)) {
		putText(bytes, "-0");
		return;
	}
	jsonNumberText(number, spelled);
	putText(bytes, spelled);
}

static void putBase64(Bytes *bytes, const unsigned char *data, size_t length) {
	putText(bytes, "\"");
	uint32_t bits = 0;
	int held = 0;
	for (size_t i = 0; i < length; i++) {
		bits = (bits << 8) | data[i];
		held += 8;
		while (held >= 6) {
			held -= 6;
			putBytes(bytes, &base64Digits[(bits >> held) & 63], 1);
		}
	}
	if (held) putBytes(bytes, &base64Digits[(bits << (6 - held)) & 63], 1);
	putText(bytes, "\"");
}

/** a typed array's elements as a list (the shared vectors' form): 64-bit ones as decimal strings, a float's NaN and infinities as words */
static void putElements(Bytes *bytes, const Json *value) {
	size_t size = jsonKindSize(value->typed.kind);
	char spelled[32];
	putText(bytes, "[");
	for (size_t i = 0; i < value->typed.count; i++) {
		const char *at = (const char *)value->typed.data + i * size;
		if (i) putText(bytes, ",");
		switch (value->typed.kind) {
			case JSON_INT8: snprintf(spelled, sizeof spelled, "%d", *(const int8_t *)at); break;
			case JSON_INT16: snprintf(spelled, sizeof spelled, "%d", *(const int16_t *)at); break;
			case JSON_UINT16: snprintf(spelled, sizeof spelled, "%u", *(const uint16_t *)at); break;
			case JSON_INT32: snprintf(spelled, sizeof spelled, "%ld", (long)*(const int32_t *)at); break;
			case JSON_UINT32: snprintf(spelled, sizeof spelled, "%lu", (unsigned long)*(const uint32_t *)at); break;
			case JSON_INT64: snprintf(spelled, sizeof spelled, "\"%lld\"", (long long)*(const int64_t *)at); break;
			case JSON_UINT64: snprintf(spelled, sizeof spelled, "\"%llu\"", (unsigned long long)*(const uint64_t *)at); break;
			case JSON_FLOAT32: putNumber(bytes, *(const float *)at, "\"", "\""); continue;
			default: putNumber(bytes, *(const double *)at, "\"", "\""); continue;
		}
		putText(bytes, spelled);
	}
	putText(bytes, "]");
}

/** a scalar, bytes, a typed array in its JSON form */
static void putScalar(Bytes *bytes, const Json *value) {
	switch (value->type) {
		case JSON_NULL:
			putText(bytes, "null");
			break;
		case JSON_BOOLEAN:
			putText(bytes, value->boolean ? "true" : "false");
			break;
		case JSON_NUMBER: {
			// a whole number past 2^53 - 1: its digits, in the bigint form
			bool negative;
			unsigned char scratch[128];
			const unsigned char *m;
			size_t n;
			if (fabs(value->number) > 9007199254740991.0 && jsonMagnitude(value, &negative, &m, &n, scratch)) {
				char *digits = allocate(3 * n + 3);
				whole_decimal(negative, m, n, digits);
				putText(bytes, "{\"/\":{\"bigint\":\"");
				putText(bytes, digits);
				putText(bytes, "\"}}");
				free(digits);
				break;
			}
			// -0 is 0
			putNumber(bytes, value->number == 0 ? 0 : value->number, "{\"/\":{\"number\":\"", "\"}}");
			break;
		}
		case JSON_STRING:
			putString(bytes, value->string, value->stringLength);
			break;
		case JSON_BYTES:
			putText(bytes, "{\"/\":{\"bytes\":");
			putBase64(bytes, value->bytes.data, value->bytes.length);
			putText(bytes, "}}");
			break;
		case JSON_TYPED:
			putText(bytes, "{\"/\":{\"");
			putText(bytes, kindNames[value->typed.kind]);
			putText(bytes, "\":");
			putElements(bytes, value);
			putText(bytes, "}}");
			break;
		default:
			break;
	}
}

/** a list or object being printed, and how many of its members are out */
typedef struct Printing {
	const Json *container;
	int next;
} Printing;

// No recursion: the lists and objects being printed are kept on a stack of their own.
char *jsonPrint(const Json *value) {
	Bytes bytes = { NULL, 0, 0 };
	Printing *stack = NULL;
	int depth = 0, capacity = 0;
	while (value) {
		if (value->type == JSON_ARRAY || value->type == JSON_OBJECT) {
			// a map whose only key is "/" is data, not a form: it is escaped
			if (isSlashMap(value)) putText(&bytes, "{\"/\":{\"map\":");
			putBytes(&bytes, value->type == JSON_ARRAY ? "[" : "{", 1);
			stack = growArray(stack, depth, &capacity, sizeof *stack);
			stack[depth++] = (Printing){ value, 0 };
		} else if (value->type == JSON_STAND) {
			putText(&bytes, "{\"/\":{\"live\":");
			stack = growArray(stack, depth, &capacity, sizeof *stack);
			stack[depth++] = (Printing){ value, 0 };
		} else {
			putScalar(&bytes, value);
		}
		// the next value to print, closing every container that is done
		value = NULL;
		while (depth && !value) {
			Printing *top = &stack[depth - 1];
			const Json *container = top->container;
			if (container->type == JSON_STAND) {
				if (top->next) putText(&bytes, "}}"), depth--;
				else value = container->stand.kind, top->next++;
				continue;
			}
			bool list = container->type == JSON_ARRAY;
			if (top->next == (list ? container->array.count : container->object.count)) {
				putBytes(&bytes, list ? "]" : "}", 1);
				if (isSlashMap(container)) putText(&bytes, "}}");
				depth--;
				continue;
			}
			if (top->next) putBytes(&bytes, ",", 1);
			if (list) {
				value = container->array.items[top->next];
			} else {
				const JsonMember *member = &container->object.members[top->next];
				putString(&bytes, member->key, member->keyLength);
				putBytes(&bytes, ":", 1);
				value = member->value;
			}
			top->next++;
		}
	}
	free(stack);
	putBytes(&bytes, "", 1);
	return bytes.text;
}
