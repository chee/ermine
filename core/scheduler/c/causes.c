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

static void push(cs_cause ***stack, size_t *top, size_t *cap, cs_cause *x) {
	if (*top == *cap) {
		*cap = *cap ? *cap * 2 : 16;
		*stack = realloc(*stack, *cap * sizeof **stack);
		if (*stack == NULL) abort();
	}
	(*stack)[(*top)++] = x;
}

static int by_n(const void *a, const void *b) {
	const cs_item *x = *(cs_item *const *)a, *y = *(cs_item *const *)b;
	return x->n < y->n ? -1 : x->n > y->n;
}

// a cause, and how many of its parents are walked
typedef struct frame {
	cs_cause *x;
	size_t i;
} frame;

cs_item **cs_loop(causes *c, cs_cause *cause, cs_item *t, size_t *count) {
	if (cause == NULL || !pm_has(&c->ran, t)) return NULL;
	// each cause after its parents (causes only point back, so no cycle): on a path back to a run
	// of t when it is of t, or a parent is
	pm seen = {0}, on = {0};
	frame *stack = NULL;
	size_t top = 0, cap = 0;
	pm_set(&seen, cause, NULL);
	stack = malloc((cap = 16) * sizeof *stack);
	if (stack == NULL) abort();
	stack[top++] = (frame){cause, 0};
	while (top > 0) {
		frame *f = &stack[top - 1];
		if (f->i < f->x->count) {
			cs_cause *q = f->x->parents[f->i++];
			if (!pm_set(&seen, q, NULL)) continue;
			if (top == cap) {
				cap *= 2;
				stack = realloc(stack, cap * sizeof *stack);
				if (stack == NULL) abort();
			}
			stack[top++] = (frame){q, 0};
			continue;
		}
		cs_cause *x = f->x;
		top--;
		bool yes = x->of == t;
		for (size_t i = 0; !yes && i < x->count; i++) yes = pm_has(&on, x->parents[i]);
		if (yes) pm_set(&on, x, NULL);
	}
	free(stack);
	pm_clear(&seen);
	if (!pm_has(&on, cause)) {
		pm_clear(&on);
		return NULL;
	}
	// their computations, once each
	pm items = {0};
	for (size_t i = 0; i < on.cap; i++)
		if (on.keys[i] != NULL) pm_set(&items, ((const cs_cause *)on.keys[i])->of, NULL);
	pm_clear(&on);
	cs_item **out = malloc(items.count * sizeof *out);
	if (out == NULL) abort();
	size_t k = 0;
	for (size_t i = 0; i < items.cap; i++)
		if (items.keys[i] != NULL) out[k++] = (cs_item *)items.keys[i];
	qsort(out, k, sizeof *out, by_n);
	*count = k;
	pm_clear(&items);
	return out;
}

bool cs_from(causes *c, const cs_item *t, const cs_item *of) {
	if (!pm_has(&c->ran, of)) return false;
	pm seen = {0};
	cs_cause **stack = NULL;
	size_t top = 0, cap = 0;
	bool found = false;
	for (size_t i = 0; i < t->kept.cap; i++)
		if (t->kept.keys[i] != NULL) push(&stack, &top, &cap, (cs_cause *)t->kept.keys[i]);
	while (top > 0) {
		cs_cause *x = stack[--top];
		if (!pm_set(&seen, x, NULL)) continue;
		if (x->of == of) {
			found = true;
			break;
		}
		for (size_t i = 0; i < x->count; i++) push(&stack, &top, &cap, x->parents[i]);
	}
	free(stack);
	pm_clear(&seen);
	return found;
}

void cs_end(causes *c) {
	for (size_t i = 0; i < c->holding.cap; i++)
		if (c->holding.keys[i] != NULL) cs_forget((cs_item *)c->holding.keys[i]);
	pm_clear(&c->holding);
	pm_clear(&c->ran);
}
