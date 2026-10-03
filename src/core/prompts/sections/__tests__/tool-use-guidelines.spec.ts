import { getToolUseGuidelinesSection } from "../tool-use-guidelines"
import type { CodeIndexManager } from "../../../../services/code-index/manager"

describe("getToolUseGuidelinesSection", () => {
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
		const guidelines = getToolUseGuidelinesSection(enabled)
		expect(guidelines).toContain("Use `codebase_search` when the target is unclear")
		expect(guidelines).toContain("use `rg` via the Bash tool or `read_file` directly")
		expect(guidelines).not.toContain("CRITICAL")
	})

	it("does not mention unavailable semantic search", () => {
		expect(getToolUseGuidelinesSection(disabled)).not.toContain("codebase_search")
	})

	it("keeps the JSON guidance batch-oriented", () => {
		const guidelines = getToolUseGuidelinesSection(disabled, "json")
		expect(guidelines).toContain("Batch independent reads and searches in the same message")
		expect(guidelines).toContain("Batching independent operations reduces latency")
		expect(guidelines).not.toContain("one tool at a time")
	})

	it("keeps XML guidance dependent-action safe", () => {
		const guidelines = getToolUseGuidelinesSection(disabled)
		expect(guidelines).toContain("Use the XML format")
		expect(guidelines).toContain("wait for the tool result before dependent actions")
	})
})
