// hello: a C program says a line and gives its process a value.
#include <ermine.h>

er_value setup(void) {
	er_say("hello");
	return er_text("hello, world");
}
