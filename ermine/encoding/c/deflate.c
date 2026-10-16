// deflate.h, in C: deflate.ts line for line (its header states every rule).
#include "deflate.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define DF_WINDOW 32768
#define DF_MIN 3
#define DF_MAX 258
#define DF_CHAIN 64
#define DF_NICE 128
#define DF_LAZY 32
#define DF_BLOCK 16384

static void *df_alloc(size_t n) {
	void *p = malloc(n ? n : 1);
	if (p == NULL) {
		fputs("deflate: out of memory\n", stderr);
		abort();
	}
	return p;
}
static void *df_grow(void *p, size_t n) {
	p = realloc(p, n ? n : 1);
	if (p == NULL) {
		fputs("deflate: out of memory\n", stderr);
		abort();
	}
	return p;
}

// lengths 3..258 and distances 1..32768 as codes, extra bits and bases (RFC 1951 3.2.5)
static const int DF_LBASE[29] = {3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99,
	115, 131, 163, 195, 227, 258};
static const int DF_LEXTRA[29] = {0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0};
static const int DF_DBASE[30] = {1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025,
	1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577};
static const int DF_DEXTRA[30] = {0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11,
	12, 12, 13, 13};
// the code length code's order
static const int DF_ORDER[19] = {16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15};

// a length's code (less 257), a distance's code
static uint8_t DF_LCODE[DF_MAX + 1], DF_DCODE[DF_WINDOW + 1];
// fixed codes' lengths (RFC 1951 3.2.6) and their codes
static uint8_t DF_FIXED_L[288], DF_FIXED_D[30];
static uint32_t DF_FIXED_LC[288], DF_FIXED_DC[30];
static int df_ready;

// a code's bits reversed, as deflate sends Huffman codes
static uint32_t df_reverse(uint32_t code, int len) {
	uint32_t r = 0;
	for (int i = 0; i < len; i++) r = (r << 1) | ((code >> i) & 1);
	return r;
}

// canonical codes from lengths (RFC 1951 3.2.2), reversed for sending
static void df_codes(const uint8_t *lengths, int n, uint32_t *out) {
	uint32_t count[16] = {0}, next[16] = {0};
	for (int i = 0; i < n; i++) count[lengths[i]]++;
	count[0] = 0;
	uint32_t code = 0;
	for (int b = 1; b < 16; b++) {
		code = (code + count[b - 1]) << 1;
		next[b] = code;
	}
	for (int i = 0; i < n; i++) {
		int l = lengths[i];
		out[i] = l ? df_reverse(next[l]++, l) : 0;
	}
}

static void df_setup(void) {
	if (df_ready) return;
	for (int c = 0; c < 28; c++)
		for (int l = DF_LBASE[c]; l < DF_LBASE[c + 1]; l++) DF_LCODE[l] = (uint8_t)c;
	DF_LCODE[258] = 28;
	for (int c = 0; c < 30; c++)
		for (int d = DF_DBASE[c]; d < (c < 29 ? DF_DBASE[c + 1] : DF_WINDOW + 1); d++) DF_DCODE[d] = (uint8_t)c;
	memset(DF_FIXED_L, 8, 144), memset(DF_FIXED_L + 144, 9, 112), memset(DF_FIXED_L + 256, 7, 24), memset(DF_FIXED_L + 280, 8, 8);
	memset(DF_FIXED_D, 5, 30);
	df_codes(DF_FIXED_L, 288, DF_FIXED_LC);
	df_codes(DF_FIXED_D, 30, DF_FIXED_DC);
	df_ready = 1;
}

// --- writing bits, least significant first

typedef struct {
	uint8_t *buf;
	size_t n, cap;
	uint64_t acc;
	int count;
} df_writer;

static void df_put_byte(df_writer *o, uint8_t b) {
	if (o->n == o->cap) o->buf = df_grow(o->buf, o->cap *= 2);
	o->buf[o->n++] = b;
}

static void df_put(df_writer *o, uint32_t value, int count) {
	o->acc |= (uint64_t)value << o->count;
	o->count += count;
	while (o->count >= 8) {
		df_put_byte(o, (uint8_t)(o->acc & 0xff));
		o->acc >>= 8;
		o->count -= 8;
	}
}

// to a byte boundary, zeros
static void df_align(df_writer *o) {
	if (o->count > 0) df_put_byte(o, (uint8_t)(o->acc & 0xff));
	o->acc = 0;
	o->count = 0;
}

// --- code lengths by package-merge

#define DF_INF INT64_MAX

// code lengths for counts, at most limit bits: the singles in order of count, ties by symbol; each
// level the pairs of the level before packaged, and merged with the singles by weight, a single
// before a package of the same weight; the first 2n - 2 items of the last level chosen, and a
// symbol's length is how many chosen items hold it (counted down the levels)
static void df_lengths_of(const uint32_t *counts, int nsym, int limit, uint8_t *out) {
	int used[286], m = 0;
	memset(out, 0, (size_t)nsym);
	for (int s = 0; s < nsym; s++)
		if (counts[s] > 0) used[m++] = s;
	if (m == 0) return;
	if (m == 1) {
		out[used[0]] = 1;
		return;
	}
	// stable by count, so ties are by symbol
	for (int i = 1; i < m; i++) {
		int s = used[i], j = i;
		while (j > 0 && counts[used[j - 1]] > counts[s]) used[j] = used[j - 1], j--;
		used[j] = s;
	}
	// each level: its items' weights, and what each is: a single's symbol (>= 0), or a package of
	// items 2k and 2k + 1 of the level before (-1 - k)
	int64_t weights[15][572];
	int kinds[15][572], size[15];
	for (int i = 0; i < m; i++) weights[0][i] = counts[used[i]], kinds[0][i] = used[i];
	size[0] = m;
	for (int level = 1; level < limit; level++) {
		const int64_t *pw = weights[level - 1];
		int64_t *w = weights[level];
		int *k = kinds[level], len = 0, a = 0, b = 0, packages = size[level - 1] >> 1;
		while (a < m || b < packages) {
			int64_t bw = b < packages ? pw[2 * b] + pw[2 * b + 1] : DF_INF;
			if (a < m && (int64_t)counts[used[a]] <= bw) w[len] = counts[used[a]], k[len++] = used[a++];
			else w[len] = bw, k[len++] = -1 - b++;
		}
		size[level] = len;
	}
	// chosen: the first 2m - 2 of the last level; a package passes its count to its pair below
	uint32_t chosen[572] = {0}, below[572];
	for (int i = 0; i < 2 * m - 2 && i < size[limit - 1]; i++) chosen[i] = 1;
	for (int level = limit - 1; level >= 0; level--) {
		int n = size[level], bn = level > 0 ? size[level - 1] : 0;
		memset(below, 0, (size_t)bn * sizeof *below);
		for (int i = 0; i < n; i++) {
			uint32_t c = chosen[i];
			if (!c) continue;
			int k = kinds[level][i];
			if (k >= 0) out[k] += (uint8_t)c;
			else {
				int j = -1 - k;
				below[2 * j] += c, below[2 * j + 1] += c;
			}
		}
		memcpy(chosen, below, (size_t)bn * sizeof *below);
	}
}

// --- the encoder

static int df_nonzero(const uint32_t *xs, int n) {
	int t = 0;
	for (int i = 0; i < n; i++) t += xs[i] > 0;
	return t;
}

// one block of the symbols s to end: a literal (dist 0, lit the byte) or a match (lit its length)
static void df_block(df_writer *out, const uint8_t *input, const uint16_t *lits, const uint16_t *dists, size_t s,
	size_t end, size_t first, size_t nbytes, int last) {
	uint32_t lc[286] = {0}, dc[30] = {0};
	int64_t extra = 0; // the extra bits every code carries, the same whichever codes
	for (size_t i = s; i < end; i++) {
		if (dists[i] == 0) lc[lits[i]]++;
		else {
			int c = DF_LCODE[lits[i]], d = DF_DCODE[dists[i]];
			lc[257 + c]++, dc[d]++;
			extra += DF_LEXTRA[c] + DF_DEXTRA[d];
		}
	}
	lc[256]++;
	// the dynamic codes
	uint32_t lcount[286], dcount[30];
	memcpy(lcount, lc, sizeof lc), memcpy(dcount, dc, sizeof dc);
	for (int k = 0, used = df_nonzero(lcount, 286); used < 2; k++)
		if (lcount[k] == 0) lcount[k] = 1, used++;
	for (int k = 0, used = df_nonzero(dcount, 30); used < 2; k++)
		if (dcount[k] == 0) dcount[k] = 1, used++;
	uint8_t ll[286], dl[30];
	df_lengths_of(lcount, 286, 15, ll);
	df_lengths_of(dcount, 30, 15, dl);
	int hlit = 286;
	while (hlit > 257 && ll[hlit - 1] == 0) hlit--;
	int hdist = 30;
	while (hdist > 1 && dl[hdist - 1] == 0) hdist--;
	uint8_t seq[316];
	memcpy(seq, ll, (size_t)hlit), memcpy(seq + hlit, dl, (size_t)hdist);
	int total = hlit + hdist;
	// the sequence run-length coded: symbols, and each one's extra value
	uint8_t rle[320], rlx[320];
	int nrle = 0;
	for (int i = 0; i < total;) {
		int v = seq[i], r = 1;
		while (i + r < total && seq[i + r] == v) r++;
		i += r;
		if (v == 0) {
			while (r >= 11) {
				int k = r < 138 ? r : 138;
				rle[nrle] = 18, rlx[nrle++] = (uint8_t)(k - 11), r -= k;
			}
			if (r >= 3) rle[nrle] = 17, rlx[nrle++] = (uint8_t)(r - 3), r = 0;
			for (; r > 0; r--) rle[nrle] = 0, rlx[nrle++] = 0;
		} else {
			rle[nrle] = (uint8_t)v, rlx[nrle++] = 0, r--;
			while (r >= 3) {
				int k = r < 6 ? r : 6;
				rle[nrle] = 16, rlx[nrle++] = (uint8_t)(k - 3), r -= k;
			}
			for (; r > 0; r--) rle[nrle] = (uint8_t)v, rlx[nrle++] = 0;
		}
	}
	uint32_t cc[19] = {0};
	for (int i = 0; i < nrle; i++) cc[rle[i]]++;
	uint8_t cl[19];
	df_lengths_of(cc, 19, 7, cl);
	int hclen = 19;
	while (hclen > 4 && cl[DF_ORDER[hclen - 1]] == 0) hclen--;
	// sizes in bits, beyond the 3-bit header
	int64_t dynamic = 5 + 5 + 4 + 3 * hclen + extra;
	for (int i = 0; i < nrle; i++) {
		int y = rle[i];
		dynamic += cl[y] + (y == 16 ? 2 : y == 17 ? 3 : y == 18 ? 7 : 0);
	}
	int64_t fixed = extra;
	for (int k = 0; k < 286; k++) dynamic += (int64_t)lc[k] * ll[k], fixed += (int64_t)lc[k] * DF_FIXED_L[k];
	for (int k = 0; k < 30; k++) dynamic += (int64_t)dc[k] * dl[k], fixed += (int64_t)dc[k] * DF_FIXED_D[k];
	// stored: to the byte, then four bytes of length, then the bytes
	int pad = (8 - ((out->count + 3) % 8)) % 8;
	int64_t stored = nbytes <= 65535 ? pad + 32 + 8 * (int64_t)nbytes : DF_INF;
	if (stored <= fixed && stored <= dynamic) {
		df_put(out, (last ? 1 : 0) | (0 << 1), 3);
		df_align(out);
		df_put(out, (uint32_t)(nbytes & 0xffff), 16), df_put(out, (uint32_t)(~nbytes & 0xffff), 16);
		for (size_t i = 0; i < nbytes; i++) df_put_byte(out, input[first + i]);
		return;
	}
	uint32_t lcodes[288], dcodes[30];
	uint8_t llen[288], dlen[30];
	if (fixed <= dynamic) {
		df_put(out, (last ? 1 : 0) | (1 << 1), 3);
		memcpy(lcodes, DF_FIXED_LC, sizeof DF_FIXED_LC), memcpy(llen, DF_FIXED_L, sizeof DF_FIXED_L);
		memcpy(dcodes, DF_FIXED_DC, sizeof DF_FIXED_DC), memcpy(dlen, DF_FIXED_D, sizeof DF_FIXED_D);
	} else {
		df_put(out, (last ? 1 : 0) | (2 << 1), 3);
		df_put(out, (uint32_t)(hlit - 257), 5), df_put(out, (uint32_t)(hdist - 1), 5), df_put(out, (uint32_t)(hclen - 4), 4);
		for (int k = 0; k < hclen; k++) df_put(out, cl[DF_ORDER[k]], 3);
		uint32_t ccodes[19];
		df_codes(cl, 19, ccodes);
		for (int i = 0; i < nrle; i++) {
			int y = rle[i];
			df_put(out, ccodes[y], cl[y]);
			if (y == 16) df_put(out, rlx[i], 2);
			else if (y == 17) df_put(out, rlx[i], 3);
			else if (y == 18) df_put(out, rlx[i], 7);
		}
		df_codes(ll, 286, lcodes), memcpy(llen, ll, sizeof ll);
		df_codes(dl, 30, dcodes), memcpy(dlen, dl, sizeof dl);
	}
	for (size_t i = s; i < end; i++) {
		int lit = lits[i], dist = dists[i];
		if (dist == 0) {
			df_put(out, lcodes[lit], llen[lit]);
			continue;
		}
		int c = DF_LCODE[lit], d = DF_DCODE[dist];
		df_put(out, lcodes[257 + c], llen[257 + c]);
		if (DF_LEXTRA[c]) df_put(out, (uint32_t)(lit - DF_LBASE[c]), DF_LEXTRA[c]);
		df_put(out, dcodes[d], dlen[d]);
		if (DF_DEXTRA[d]) df_put(out, (uint32_t)(dist - DF_DBASE[d]), DF_DEXTRA[d]);
	}
	df_put(out, lcodes[256], llen[256]);
}

// the matcher: hash chains over the input
typedef struct {
	const uint8_t *in;
	size_t n, ins;
	int64_t *head, *prev;
	int found, at; // the best match of the last find: its length (0: none) and distance
} df_finder;

static inline uint32_t df_hash_at(const uint8_t *in, size_t p) {
	return (((uint32_t)in[p] << 10) ^ ((uint32_t)in[p + 1] << 5) ^ in[p + 2]) & 32767;
}

// every position before p in its chain
static void df_upto(df_finder *f, size_t p) {
	for (; f->ins < p; f->ins++) {
		if (f->ins + 2 >= f->n) continue;
		uint32_t h = df_hash_at(f->in, f->ins);
		f->prev[f->ins & (DF_WINDOW - 1)] = f->head[h];
		f->head[h] = (int64_t)f->ins;
	}
}

// the best match at p
static void df_find(df_finder *f, size_t p) {
	const uint8_t *in = f->in;
	df_upto(f, p);
	f->found = 0, f->at = 0;
	if (p + 2 >= f->n) return;
	size_t most = f->n - p < DF_MAX ? f->n - p : DF_MAX;
	size_t best = 0, dist = 0;
	int walked = 0;
	int64_t cand = f->head[df_hash_at(in, p)];
	while (cand >= 0 && walked < DF_CHAIN && p - (size_t)cand <= DF_WINDOW) {
		walked++;
		if (in[(size_t)cand + best] == in[p + best]) {
			size_t l = 0;
			while (l < most && in[(size_t)cand + l] == in[p + l]) l++;
			if (l > best) {
				best = l, dist = p - (size_t)cand;
				if (l >= DF_NICE || l == most) break;
			}
		}
		int64_t next = f->prev[(size_t)cand & (DF_WINDOW - 1)];
		if (next >= cand) break;
		cand = next;
	}
	if (best >= DF_MIN) f->found = (int)best, f->at = (int)dist;
}

void df_deflate(const uint8_t *input, size_t n, uint8_t **result, size_t *resultn) {
	df_setup();
	df_finder f = {.in = input, .n = n};
	f.head = df_alloc(32768 * sizeof *f.head);
	f.prev = df_alloc(DF_WINDOW * sizeof *f.prev);
	for (int i = 0; i < 32768; i++) f.head[i] = -1;
	for (int i = 0; i < DF_WINDOW; i++) f.prev[i] = -1;
	// the symbols: a literal (dist 0, lit the byte) or a match (lit its length)
	uint16_t *lits = df_alloc((n + 1) * sizeof *lits), *dists = df_alloc((n + 1) * sizeof *dists);
	size_t count = 0;
	for (size_t p = 0; p < n;) {
		df_find(&f, p);
		int len = f.found, dist = f.at;
		if (len == 0) {
			lits[count] = input[p], dists[count++] = 0;
			p++;
			continue;
		}
		if (len < DF_LAZY && p + 1 < n) {
			df_find(&f, p + 1);
			if (f.found > len) {
				lits[count] = input[p], dists[count++] = 0;
				p++;
				continue;
			}
		}
		lits[count] = (uint16_t)len, dists[count++] = (uint16_t)dist;
		p += (size_t)len;
	}
	df_writer out = {.buf = df_alloc(1024), .cap = 1024};
	if (count == 0) df_block(&out, input, lits, dists, 0, 0, 0, 0, 1);
	else {
		size_t first = 0; // the block's first byte
		for (size_t s = 0; s < count; s += DF_BLOCK) {
			size_t end = count < s + DF_BLOCK ? count : s + DF_BLOCK, nbytes = 0;
			for (size_t i = s; i < end; i++) nbytes += dists[i] ? lits[i] : 1;
			df_block(&out, input, lits, dists, s, end, first, nbytes, end == count);
			first += nbytes;
		}
	}
	df_align(&out);
	free(f.head), free(f.prev), free(lits), free(dists);
	*result = out.buf;
	*resultn = out.n;
}

// --- the decoder: any deflate. limit: the most bytes it may give

// a decoding table: for every bits that could come next (least significant first), the symbol they
// start with and its length in bits; length 0: no code starts so
typedef struct {
	uint16_t *sym;
	uint8_t *len;
	int bits; // the longest code
} df_table;

static int df_make_table(const uint8_t *lengths, int n, df_table *t) {
	uint32_t count[16] = {0};
	for (int i = 0; i < n; i++) count[lengths[i]]++;
	count[0] = 0;
	// over-subscribed: no code
	int left = 1, longest = 0;
	for (int b = 1; b < 16; b++) {
		left = (left << 1) - (int)count[b];
		if (left < 0) return 0;
		if (count[b]) longest = b;
	}
	size_t size = (size_t)1 << longest;
	t->bits = longest;
	t->sym = df_alloc(size * sizeof *t->sym);
	t->len = df_alloc(size);
	memset(t->sym, 0, size * sizeof *t->sym), memset(t->len, 0, size);
	uint32_t rev[288];
	df_codes(lengths, n, rev);
	for (int i = 0; i < n; i++) {
		int l = lengths[i];
		if (!l) continue;
		for (size_t k = rev[i]; k < size; k += (size_t)1 << l) t->sym[k] = (uint16_t)i, t->len[k] = (uint8_t)l;
	}
	return 1;
}

static void df_drop(df_table *t) {
	free(t->sym), free(t->len);
	t->sym = NULL, t->len = NULL;
}

typedef struct {
	const uint8_t *in;
	long length, pos; // pos counts bytes read, past the end too
	uint64_t acc;
	long have;
	uint8_t *out;
	size_t n, cap, limit;
} df_reading;

// at least k bits in acc (zeros past the end, which a code may peek at but not use)
static void df_fill(df_reading *r, long k) {
	while (r->have < k) {
		r->acc |= (uint64_t)(r->pos < r->length ? r->in[r->pos] : 0) << r->have;
		r->pos++, r->have += 8;
	}
}

// k bits; -1: the stream ended early
static long df_take(df_reading *r, int k) {
	df_fill(r, k);
	if (r->pos - r->have / 8 > r->length && r->have - k < 8 * (r->pos - r->length)) return -1;
	long v = (long)(r->acc & (((uint64_t)1 << k) - 1));
	r->acc >>= k, r->have -= k;
	return v;
}

// the symbol next in t; -1: no code, or the stream ended early
static int df_decode(df_reading *r, const df_table *t) {
	df_fill(r, 15);
	uint32_t k = (uint32_t)(r->acc & (((uint64_t)1 << t->bits) - 1));
	int l = t->len[k];
	if (l == 0) return -1;
	// the bits a code uses must have been there
	if (8 * (r->pos - r->length) > r->have - l) return -1;
	r->acc >>= l, r->have -= l;
	return t->sym[k];
}

// room for k more bytes; 0: over the limit
static int df_room(df_reading *r, size_t k) {
	if (r->n + k > r->limit) return 0;
	if (r->n + k <= r->cap) return 1;
	size_t size = r->cap * 2;
	while (size < r->n + k) size *= 2;
	r->out = df_grow(r->out, size);
	r->cap = size;
	return 1;
}

// the end of what inflate does, one way out
#define STOP(why) \
	do { \
		code = (why); \
		goto done; \
	} while (0)

df_code df_inflate(const uint8_t *input, size_t length, size_t limit, uint8_t **result, size_t *resultn) {
	df_setup();
	df_reading r = {.in = input, .length = (long)length, .limit = limit};
	r.cap = length * 4 > 64 ? length * 4 : 64;
	if (r.cap > limit && limit >= 64) r.cap = limit;
	r.out = df_alloc(r.cap);
	df_table lt = {0}, dt = {0};
	df_code code = DF_OK;
	for (int last = 0; !last;) {
		long v = df_take(&r, 1);
		if (v < 0) STOP(DF_NOT_DEFLATE);
		last = (int)v;
		long type = df_take(&r, 2);
		if (type < 0) STOP(DF_NOT_DEFLATE);
		if (type == 0) {
			// to the byte: what is left of this one dropped, whole bytes read ahead given back
			r.pos -= r.have >> 3, r.acc = 0, r.have = 0;
			if (r.pos + 4 > r.length) STOP(DF_NOT_DEFLATE);
			long len = input[r.pos] | (input[r.pos + 1] << 8), nlen = input[r.pos + 2] | (input[r.pos + 3] << 8);
			if (len != (~nlen & 0xffff)) STOP(DF_NOT_DEFLATE);
			r.pos += 4;
			if (r.pos + len > r.length) STOP(DF_NOT_DEFLATE);
			if (!df_room(&r, (size_t)len)) STOP(DF_OVER_THE_LIMIT);
			memcpy(r.out + r.n, input + r.pos, (size_t)len);
			r.n += (size_t)len, r.pos += len;
			continue;
		}
		df_drop(&lt), df_drop(&dt);
		uint8_t fixed_all[288 + 30];
		if (type == 1) {
			memcpy(fixed_all, DF_FIXED_L, 288), memcpy(fixed_all + 288, DF_FIXED_D, 30);
			if (!df_make_table(fixed_all, 288, &lt) || !df_make_table(fixed_all + 288, 30, &dt)) STOP(DF_NOT_DEFLATE);
		} else if (type == 2) {
			long hlit = df_take(&r, 5), hdist = df_take(&r, 5), hclen = df_take(&r, 4);
			if (hlit < 0 || hdist < 0 || hclen < 0) STOP(DF_NOT_DEFLATE);
			hlit += 257, hdist += 1, hclen += 4;
			if (hlit > 286 || hdist > 30) STOP(DF_NOT_DEFLATE);
			uint8_t cl[19] = {0};
			for (long k = 0; k < hclen; k++) {
				long b = df_take(&r, 3);
				if (b < 0) STOP(DF_NOT_DEFLATE);
				cl[DF_ORDER[k]] = (uint8_t)b;
			}
			df_table ct = {0};
			if (!df_make_table(cl, 19, &ct)) STOP(DF_NOT_DEFLATE);
			uint8_t lens[286 + 30] = {0};
			long all = hlit + hdist;
			for (long i = 0; i < all;) {
				int y = df_decode(&r, &ct);
				if (y < 0) {
					df_drop(&ct);
					STOP(DF_NOT_DEFLATE);
				}
				if (y < 16) lens[i++] = (uint8_t)y;
				else {
					long rep, x, val = 0;
					if (y == 16) {
						if (i == 0 || (x = df_take(&r, 2)) < 0) {
							df_drop(&ct);
							STOP(DF_NOT_DEFLATE);
						}
						val = lens[i - 1], rep = 3 + x;
					} else if (y == 17) {
						if ((x = df_take(&r, 3)) < 0) {
							df_drop(&ct);
							STOP(DF_NOT_DEFLATE);
						}
						rep = 3 + x;
					} else {
						if ((x = df_take(&r, 7)) < 0) {
							df_drop(&ct);
							STOP(DF_NOT_DEFLATE);
						}
						rep = 11 + x;
					}
					if (i + rep > all) {
						df_drop(&ct);
						STOP(DF_NOT_DEFLATE);
					}
					for (; rep > 0; rep--) lens[i++] = (uint8_t)val;
				}
			}
			df_drop(&ct);
			if (lens[256] == 0) STOP(DF_NOT_DEFLATE);
			if (!df_make_table(lens, (int)hlit, &lt) || !df_make_table(lens + hlit, (int)hdist, &dt)) STOP(DF_NOT_DEFLATE);
		} else STOP(DF_NOT_DEFLATE);
		for (;;) {
			int y = df_decode(&r, &lt);
			if (y < 0) STOP(DF_NOT_DEFLATE);
			if (y < 256) {
				if (!df_room(&r, 1)) STOP(DF_OVER_THE_LIMIT);
				r.out[r.n++] = (uint8_t)y;
			} else if (y == 256) break;
			else {
				int c = y - 257;
				if (c >= 29) STOP(DF_NOT_DEFLATE);
				long len = DF_LBASE[c];
				if (DF_LEXTRA[c]) {
					long x = df_take(&r, DF_LEXTRA[c]);
					if (x < 0) STOP(DF_NOT_DEFLATE);
					len += x;
				}
				int d = df_decode(&r, &dt);
				if (d < 0 || d >= 30) STOP(DF_NOT_DEFLATE);
				long dist = DF_DBASE[d];
				if (DF_DEXTRA[d]) {
					long x = df_take(&r, DF_DEXTRA[d]);
					if (x < 0) STOP(DF_NOT_DEFLATE);
					dist += x;
				}
				if ((size_t)dist > r.n) STOP(DF_NOT_DEFLATE);
				if (!df_room(&r, (size_t)len)) STOP(DF_OVER_THE_LIMIT);
				uint8_t *to = r.out + r.n;
				const uint8_t *from = to - dist;
				for (long k = 0; k < len; k++) to[k] = from[k];
				r.n += (size_t)len;
			}
		}
	}
done:
	df_drop(&lt), df_drop(&dt);
	if (code != DF_OK) {
		free(r.out);
		*result = NULL;
		*resultn = 0;
		return code;
	}
	*result = r.out;
	*resultn = r.n;
	return DF_OK;
}
