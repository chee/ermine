// Making a because (newcore/nodes/BECAUSE.tex), in C.
#include "because.h"

bc_because bc_make(const char *layer, const void *place, const void *why, const bc_site *outside) {
	bc_because b = {layer, place, why, 0, {0}};
	if (outside) {
		b.has_site = 1;
		b.site = *outside;
	}
	return b;
}
