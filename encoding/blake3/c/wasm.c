// compact portable blake3: one-shot hash, any length, 32-byte output. freestanding.
typedef unsigned char u8;
typedef unsigned u32;

enum { START = 1, END = 2, PARENT = 4, ROOT = 8 };

static const u32 iv[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                          0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
static const u8 perm[16] = {2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8};

static u32 stack[54][8];
static u32 out[8];

static u32 ror(u32 x, int n) { return x >> n | x << (32 - n); }

#define G(a, b, c, d, x, y) \
	v[a] += v[b] + x; v[d] = ror(v[d] ^ v[a], 16); v[c] += v[d]; v[b] = ror(v[b] ^ v[c], 12); \
	v[a] += v[b] + y; v[d] = ror(v[d] ^ v[a], 8); v[c] += v[d]; v[b] = ror(v[b] ^ v[c], 7);

// one compression: chaining value cv + message m -> cv (low half xor high half)
static void compress(u32 *cv, u32 *m, u32 ctr, u32 len, u32 flags) {
	u32 v[16], t[16];
	int i, r;
	for (i = 0; i < 8; i++) v[i] = cv[i], v[i + 8] = iv[i];
	v[12] = ctr; v[13] = 0; v[14] = len; v[15] = flags;
	for (r = 0; r < 7; r++) {
		G(0, 4, 8, 12, m[0], m[1]) G(1, 5, 9, 13, m[2], m[3])
		G(2, 6, 10, 14, m[4], m[5]) G(3, 7, 11, 15, m[6], m[7])
		G(0, 5, 10, 15, m[8], m[9]) G(1, 6, 11, 12, m[10], m[11])
		G(2, 7, 8, 13, m[12], m[13]) G(3, 4, 9, 14, m[14], m[15])
		for (i = 0; i < 16; i++) t[i] = m[perm[i]];
		for (i = 0; i < 16; i++) m[i] = t[i];
	}
	for (i = 0; i < 8; i++) cv[i] = v[i] ^ v[i + 8];
}

static void parent(u32 *left, u32 *right, u32 flags, u32 *cv) {
	u32 m[16];
	int i;
	for (i = 0; i < 8; i++) m[i] = left[i], m[i + 8] = right[i], cv[i] = iv[i];
	compress(cv, m, 0, 64, PARENT | flags);
}

// chaining value of one chunk (up to 1024 bytes)
static void chunk(const u8 *p, u32 n, u32 ctr, u32 flags, u32 *cv) {
	u32 m[16], b = 0, f = START;
	int i;
	for (i = 0; i < 8; i++) cv[i] = iv[i];
	do {
		u32 k = n - b > 64 ? 64 : n - b;
		for (i = 0; i < 16; i++) m[i] = 0;
		for (i = 0; i < (int)k; i++) m[i >> 2] |= (u32)p[b + i] << (i & 3) * 8;
		b += k;
		compress(cv, m, ctr, k, f | (b >= n ? END | flags : 0));
		f = 0;
	} while (b < n);
}

extern u8 __heap_base;

void *room(u32 n) {
	u32 need = (u32)&__heap_base + n;
	u32 have = __builtin_wasm_memory_size(0) * 65536;
	if (need > have) __builtin_wasm_memory_grow(0, (need - have + 65535) / 65536);
	return &__heap_base;
}

void *hash(u32 n) {
	const u8 *p = &__heap_base;
	u32 cv[8], sp = 0, i = 0;
	if (n <= 1024) {
		chunk(p, n, 0, ROOT, out);
		return out;
	}
	for (; n > 1024; i++, p += 1024, n -= 1024) {
		u32 t = i + 1;
		chunk(p, 1024, i, 0, cv);
		for (; !(t & 1); t >>= 1) parent(stack[--sp], cv, 0, cv);
		for (t = 0; t < 8; t++) stack[sp][t] = cv[t];
		sp++;
	}
	chunk(p, n, i, 0, cv);
	while (sp--) parent(stack[sp], cv, sp ? 0 : ROOT, cv);
	for (i = 0; i < 8; i++) out[i] = cv[i];
	return out;
}
