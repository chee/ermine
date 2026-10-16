// counter: each click counts one more, in ./count, a node beside the program.
// No statics: the count is the graph's, so a reboot keeps it.
#include <ermine.h>

static void click(er_args a) {
	(void)a;
	er_write(ER_AT("count"), er_int(er_int_at(ER_AT("count")) + 1));
	er_say("count %d", (int)er_int_at(ER_AT("count")));
}

er_value setup(void) {
	er_handler("click", click); // <process>/on/click
	return er_none();
}
