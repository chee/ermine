// apply_value and apply_json on a value nested two million deep: no recursion, so no stack overflow.
// Built and run by deep_test.sh.
#include "apply.h"

#include <stdio.h>

int main(void) {
	Json *j = jsonNull();
	for (int i = 0; i < 2000000; i++) {
		Json *a = i % 3 == 0 ? jsonObject() : i % 3 == 1 ? jsonArray() : NULL;
		if (a == NULL) j = jsonStand(j);
		else if (i % 3 == 0) jsonAdd(a, "k", j), j = a;
		else jsonPush(a, j), j = a;
	}
	op_value *v = apply_value(j);
	Json *back = v ? apply_json(v) : NULL;
	int ok = back != NULL && jsonEqual(j, back);
	if (v) op_free(v);
	if (back) jsonFree(back);
	jsonFree(j);
	puts(ok ? "ok" : "FAIL");
	return !ok;
}
