import { getObjectiveSection } from "../objective"
import type { CodeIndexManager } from "../../../../services/code-index/manager"

describe("getObjectiveSection", () => {
	const enabled = {
		isFeatureEnabled: true,
		isFeatureConfigured: true,
		isInitialized: true,
	} as CodeIndexManager
	const disabled = {
		isFeatureEnabled: false,
		isFeatureConfigured: false,
		isInitialized: false,
	} as CodeIndexManager

	it("recommends semantic search selectively", () => {
		const objective = getObjectiveSection(enabled)
		expect(objective).toContain("When the target is unclear")
		expect(objective).toContain("use `rg` via the Bash tool or `read_file` directly")
		expect(objective).not.toContain("MUST use the `codebase_search` tool")
	})

	it("does not mention unavailable semantic search", () => {
		const objective = getObjectiveSection(disabled)
		expect(objective).not.toContain("codebase_search")
	})

	it("includes efficient execution guidance", () => {
		for (const objective of [getObjectiveSection(enabled), getObjectiveSection(disabled)]) {
			expect(objective).toContain("2. Work through these goals efficiently")
			expect(objective).toContain("Before calling a tool, do focused analysis")
			expect(objective).toContain("Choose the most relevant tool")
			expect(objective).toContain("provide every required parameter from the available context")
		}
	})
})
