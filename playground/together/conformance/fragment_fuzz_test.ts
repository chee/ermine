// The fragment fuzz: random DAGs (fragment_oracle.ts, dag), the harness's answers against Subduction's
// own code (fragment_oracle/, a few dozen seeds). It needs the oracle built (cargo, in
// fragment_oracle/: cargo build --release --offline); without it the test is ignored, saying so.
// The harness: the TypeScript one, or HARNESS (a command: the C binary) as the main run's
// (conformance/run.ts). Its scenarios: fragment.
import { assertEquals } from "@std/assert"
import { ask as oracle, built, dag } from "./fragment_oracle.ts"
import { ask, command } from "../../../conformance/typescript/ask.ts"

const SEEDS = 40
const subject = command("fragment")

const haveOracle = await built()
Deno.test({
	name: `fuzz: ${SEEDS} random DAGs against Subduction's own code`,
	ignore: !haveOracle,
	async fn() {
		for (let seed = 1; seed <= SEEDS; seed++) {
			const { build, walks } = await dag(seed)
			const requests = [build, ...walks]
			const want = await oracle(requests)
			const got = await ask(subject, requests)
			requests.forEach((r, i) =>
				assertEquals(got[i], want[i], `seed ${seed}, request ${i} (${r.op})`)
			)
		}
	},
})
if (!haveOracle) {
	console.error("fragment fuzz ignored: the oracle is not built (cargo, in fragment_oracle/)")
}
