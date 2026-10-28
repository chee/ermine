// a program for ermine-run's dlopen loader: ./ermine-run dlopen ./hello.so
// the loader finds `setup` and runs it once as the process; what it gives is the process's value
#include "software.h"

es_out setup(es_context *c, void *ctx) {
	(void)c, (void)ctx;
	return es_out_of(op_str("hello from a shared library"));
}
