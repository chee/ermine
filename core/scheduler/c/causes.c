#include "causes.h"

#include <stdlib.h>

struct causes {
	// the computations that ran in this pulse
	pm ran;
	// the computations holding causes, forgotten at the pulse's end
	pm holding;
};

causes *cs_new(void) {
	causes *c = calloc(1, sizeof *c);
	if (c == NULL) abort();
	return c;
}

void cs_free(causes *c) {
	pm_clear(&c->ran);
	pm_clear(&c->holding);
	free(c);
}

cs_cause *cs_ref(cs_cause *c) {
	c->refs++;
	return c;
}

// lets go; a cause with no count left lets go of its parents, with a stack of its own
void cs_release(cs_cause *c) {
	cs_cause **stack = NULL;
	size_t top = 0, cap = 0;
	for (;;) {
		if (c != NULL && --c->refs == 0) {
			for (size_t i = 0; i < c->count; i++) {
				if (top == cap) {
					cap = cap ? cap * 2 : 16;
					stack = realloc(stack, cap * sizeof *stack);
					if (stack == NULL) abort();
				}
				stack[top++] = c->parents[i];
			}
			free(c->parents);
			free(c);
		}
		if (top == 0) break;
		c = stack[--top];
	}
	free(stack);
}

cs_cause *cs_run(causes *c, cs_item *t, cs_cause *const *given, size_t count) {
	pm_set(&c->ran, t, NULL);
	cs_cause *x = calloc(1, sizeof *x);
	if (x == NULL) abort();
	x->of = t;
	x->refs = 1;
	x->count = count;
	if (count > 0) {
		x->parents = malloc(count * sizeof *x->parents);
		if (x->parents == NULL) abort();
		for (size_t i = 0; i < count; i++) x->parents[i] = cs_ref(given[i]);
	}
	return x;
}

void cs_keep(causes *c, cs_item *t, cs_cause *cause) {
	if (pm_set(&t->kept, cause, NULL)) cs_ref(cause);
	pm_set(&c->holding, t, NULL);
}

void cs_forget(cs_item *t) {
	for (size_t i = 0; i < t->kept.cap; i++)
		if (t->kept.keys[i] != NULL) cs_release((cs_cause *)t->kept.keys[i]);
	pm_clear(&t->kept);
}

// every cause reached from start, each handed to each; stops early when each answers true
static int walk(cs_cause *start, int (*each)(cs_cause *, void *), void *data) {
	pm seen = {0};
	cs_cause **stack = NULL;
	size_t top = 0, cap = 0;
	int found = 0;
	pm_set(&seen, start, NULL);
	stack = malloc((cap = 16) * sizeof *stack);
	if (stack == NULL) abort();
	stack[top++] = start;
	while (top > 0) {
		cs_cause *x = stack[--top];
		if (each(x, data)) {
			found = 1;
			break;
		}
		for (size_t i = 0; i < x->count; i++) {
			cs_cause *q = x->parents[i];
			if (!pm_set(&seen, q, NULL)) continue;
			if (top == cap) {
				cap *= 2;
				stack = realloc(stack, cap * sizeof *stack);
				if (stack == NULL) abort();
			}
			stack[top++] = q;
		}
	}
	free(stack);
	pm_clear(&seen);
	return found;
}

static int is_of(cs_cause *x, void *data) { return x->of == data; }
static int add_of(cs_cause *x, void *data) {
	pm_set(data, x->of, NULL);
	return 0;
}
static int by_n(const void *a, const void *b) {
	const cs_item *x = *(cs_item *const *)a, *y = *(cs_item *const *)b;
	return x->n < y->n ? -1 : x->n > y->n;
}

cs_item **cs_loop(causes *c, cs_cause *cause, cs_item *t, size_t *count) {
	if (cause == NULL || !pm_has(&c->ran, t)) return NULL;
	if (!walk(cause, is_of, t)) return NULL;
	pm on = {0};
	walk(cause, add_of, &on);
	cs_item **out = malloc(on.count * sizeof *out);
	if (out == NULL) abort();
	size_t k = 0;
	for (size_t i = 0; i < on.cap; i++)
		if (on.keys[i] != NULL) out[k++] = (cs_item *)on.keys[i];
	qsort(out, k, sizeof *out, by_n);
	*count = k;
	pm_clear(&on);
	return out;
}

void cs_end(causes *c) {
	for (size_t i = 0; i < c->holding.cap; i++)
		if (c->holding.keys[i] != NULL) cs_forget((cs_item *)c->holding.keys[i]);
	pm_clear(&c->holding);
	pm_clear(&c->ran);
}
