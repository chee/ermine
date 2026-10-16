// A program in C. setup() runs once, as it starts; what it returns is its
// process's value. cmd-r runs it; what er_say says shows under the text.
#include <ermine.h>

er_value setup(void) {
	er_say("hello");
	return er_text("hello, world");
}
