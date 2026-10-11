// Making a change (newcore/nodes/CHANGE.tex), in C.
#include "change.h"

ch_change ch_make(const char *node, ch_header header, const ch_site *outside) {
	if (!header.has_site && outside) {
		header.has_site = 1;
		header.site = *outside;
	}
	return (ch_change){header, node};
}
