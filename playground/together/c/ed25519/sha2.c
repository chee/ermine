#include "sha2.h"

#include <string.h>

static const uint64_t k[80] = {
	0x428a2f98d728ae22u, 0x7137449123ef65cdu, 0xb5c0fbcfec4d3b2fu, 0xe9b5dba58189dbbcu,
	0x3956c25bf348b538u, 0x59f111f1b605d019u, 0x923f82a4af194f9bu, 0xab1c5ed5da6d8118u,
	0xd807aa98a3030242u, 0x12835b0145706fbeu, 0x243185be4ee4b28cu, 0x550c7dc3d5ffb4e2u,
	0x72be5d74f27b896fu, 0x80deb1fe3b1696b1u, 0x9bdc06a725c71235u, 0xc19bf174cf692694u,
	0xe49b69c19ef14ad2u, 0xefbe4786384f25e3u, 0x0fc19dc68b8cd5b5u, 0x240ca1cc77ac9c65u,
	0x2de92c6f592b0275u, 0x4a7484aa6ea6e483u, 0x5cb0a9dcbd41fbd4u, 0x76f988da831153b5u,
	0x983e5152ee66dfabu, 0xa831c66d2db43210u, 0xb00327c898fb213fu, 0xbf597fc7beef0ee4u,
	0xc6e00bf33da88fc2u, 0xd5a79147930aa725u, 0x06ca6351e003826fu, 0x142929670a0e6e70u,
	0x27b70a8546d22ffcu, 0x2e1b21385c26c926u, 0x4d2c6dfc5ac42aedu, 0x53380d139d95b3dfu,
	0x650a73548baf63deu, 0x766a0abb3c77b2a8u, 0x81c2c92e47edaee6u, 0x92722c851482353bu,
	0xa2bfe8a14cf10364u, 0xa81a664bbc423001u, 0xc24b8b70d0f89791u, 0xc76c51a30654be30u,
	0xd192e819d6ef5218u, 0xd69906245565a910u, 0xf40e35855771202au, 0x106aa07032bbd1b8u,
	0x19a4c116b8d2d0c8u, 0x1e376c085141ab53u, 0x2748774cdf8eeb99u, 0x34b0bcb5e19b48a8u,
	0x391c0cb3c5c95a63u, 0x4ed8aa4ae3418acbu, 0x5b9cca4f7763e373u, 0x682e6ff3d6b2b8a3u,
	0x748f82ee5defb2fcu, 0x78a5636f43172f60u, 0x84c87814a1f0ab72u, 0x8cc702081a6439ecu,
	0x90befffa23631e28u, 0xa4506cebde82bde9u, 0xbef9a3f7b2c67915u, 0xc67178f2e372532bu,
	0xca273eceea26619cu, 0xd186b8c721c0c207u, 0xeada7dd6cde0eb1eu, 0xf57d4f7fee6ed178u,
	0x06f067aa72176fbau, 0x0a637dc5a2c898a6u, 0x113f9804bef90daeu, 0x1b710b35131c471bu,
	0x28db77f523047d84u, 0x32caab7b40c72493u, 0x3c9ebe0a15c9bebcu, 0x431d67c49c100d4cu,
	0x4cc5d4becb3e42b6u, 0x597f299cfc657e2au, 0x5fcb6fab3ad6faecu, 0x6c44198c4a475817u,
};

static uint64_t rotate(uint64_t x, int n) {
	return x >> n | x << (64 - n);
}

// one 128-byte block into the state
static void compress(ErmSha512 *h, const unsigned char *block) {
	uint64_t w[80], v[8];
	for (int i = 0; i < 16; i++) {
		w[i] = 0;
		for (int j = 0; j < 8; j++) w[i] = w[i] << 8 | block[8 * i + j];
	}
	for (int i = 16; i < 80; i++) {
		uint64_t s0 = rotate(w[i - 15], 1) ^ rotate(w[i - 15], 8) ^ w[i - 15] >> 7;
		uint64_t s1 = rotate(w[i - 2], 19) ^ rotate(w[i - 2], 61) ^ w[i - 2] >> 6;
		w[i] = w[i - 16] + s0 + w[i - 7] + s1;
	}
	memcpy(v, h->state, sizeof v);
	for (int i = 0; i < 80; i++) {
		uint64_t s1 = rotate(v[4], 14) ^ rotate(v[4], 18) ^ rotate(v[4], 41);
		uint64_t choose = (v[4] & v[5]) ^ (~v[4] & v[6]);
		uint64_t t1 = v[7] + s1 + choose + k[i] + w[i];
		uint64_t s0 = rotate(v[0], 28) ^ rotate(v[0], 34) ^ rotate(v[0], 39);
		uint64_t majority = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
		uint64_t t2 = s0 + majority;
		memmove(v + 1, v, 7 * sizeof *v);
		v[4] += t1;
		v[0] = t1 + t2;
	}
	for (int i = 0; i < 8; i++) h->state[i] += v[i];
}

void ermSha512Start(ErmSha512 *h) {
	static const uint64_t start[8] = {
		0x6a09e667f3bcc908u, 0xbb67ae8584caa73bu, 0x3c6ef372fe94f82bu, 0xa54ff53a5f1d36f1u,
		0x510e527fade682d1u, 0x9b05688c2b3e6c1fu, 0x1f83d9abfb41bd6bu, 0x5be0cd19137e2179u,
	};
	memcpy(h->state, start, sizeof start);
	h->used = 0;
	h->length = 0;
}

void ermSha512Add(ErmSha512 *h, const void *data, size_t length) {
	const unsigned char *p = data;
	h->length += length;
	while (length > 0) {
		size_t n = 128 - h->used < length ? 128 - h->used : length;
		memcpy(h->block + h->used, p, n);
		h->used += n;
		p += n;
		length -= n;
		if (h->used == 128) compress(h, h->block), h->used = 0;
	}
}

void ermSha512End(ErmSha512 *h, unsigned char out[64]) {
	uint64_t bits = h->length * 8;
	unsigned char pad = 0x80, zero = 0, size[16] = {0};
	ermSha512Add(h, &pad, 1);
	while (h->used != 112) ermSha512Add(h, &zero, 1);
	for (int i = 0; i < 8; i++) size[15 - i] = (unsigned char)(bits >> (8 * i));
	ermSha512Add(h, size, 16);
	for (int i = 0; i < 64; i++) out[i] = (unsigned char)(h->state[i / 8] >> (56 - 8 * (i % 8)));
}

void ermSha512(const void *data, size_t length, unsigned char out[64]) {
	ErmSha512 h;
	ermSha512Start(&h);
	ermSha512Add(&h, data, length);
	ermSha512End(&h, out);
}
