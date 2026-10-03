import { CodeIndexManager } from "../../../services/code-index/manager"
import type { ToolUseStyle } from "@roo-code/types" // kilocode_change

export function getToolUseGuidelinesSection(
	codeIndexManager?: CodeIndexManager,
	toolUseStyle?: ToolUseStyle, // kilocode_change
): string {
	const isCodebaseSearchAvailable = Boolean(
		codeIndexManager?.isFeatureEnabled && codeIndexManager.isFeatureConfigured && codeIndexManager.isInitialized,
	)

	let itemNumber = 1
	const guidelinesList: string[] = []
	guidelinesList.push(
		`${itemNumber++}. Assess what information you already have and what information you need to proceed with the task.`,
	)

	if (isCodebaseSearchAvailable) {
		guidelinesList.push(
			`${itemNumber++}. Use \`codebase_search\` when the target is unclear and intent-based discovery is useful. For known symbols, paths, or exact text, use \`rg\` via the Bash tool or \`read_file\` directly.`,
		)
	} else {
		guidelinesList.push(`${itemNumber++}. Choose the smallest available tool that answers the current question.`)
	}

	guidelinesList.push(
		`${itemNumber++}. Avoid repeating an unchanged search or read; refine the path, pattern, or line range instead.`,
	)
	guidelinesList.push(
		toolUseStyle === "json"
			? `${itemNumber++}. Batch independent reads and searches in the same message. Keep dependent edits and commands sequential.`
			: `${itemNumber++}. Use the XML format specified for each tool and wait for the tool result before dependent actions.`,
	)
	guidelinesList.push(
		`${itemNumber++}. Inspect every tool result before choosing the next dependent action. Never assume a tool call succeeded.`,
	)

	return `# Tool Use Guidelines

${guidelinesList.join("\n")}

${
	toolUseStyle === "json"
		? "Batching independent operations reduces latency while preserving sequential execution for dependent work."
		: "Proceed step-by-step for dependent actions and use each tool result to choose the next action."
}`
}
