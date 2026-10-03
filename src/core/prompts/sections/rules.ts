import { DiffStrategy } from "../../../shared/tools"
import { CodeIndexManager } from "../../../services/code-index/manager"
import { type ClineProviderState } from "../../webview/ClineProvider"
import { ToolUseStyle } from "../../../../packages/types/src/kilocode/native-function-calling"

function getEditingInstructions(_diffStrategy?: DiffStrategy): string {
	return [
		"- Use file_edit for one targeted replacement, multi_file_edit for multiple known replacements, and file_write only for a new file or complete rewrite.",
		"- Copy old_string verbatim from a current read and include enough unchanged context to identify one location. Use replace_all only when every occurrence should change.",
		"- When using file_write, provide complete file content. Do not use it for a targeted change.",
	].join("\n")
}

export function getRulesSection(
	cwd: string,
	supportsComputerUse: boolean,
	diffStrategy?: DiffStrategy,
	codeIndexManager?: CodeIndexManager,
	clineProviderState?: ClineProviderState,
	toolUseStyle?: ToolUseStyle,
): string {
	const isCodebaseSearchAvailable = Boolean(
		codeIndexManager?.isFeatureEnabled && codeIndexManager.isFeatureConfigured && codeIndexManager.isInitialized,
	)

	let rulesContent = `====

RULES

- The project base directory is: ${cwd.toPosix()}
- Keep file paths relative to this directory. Use the tool's cwd/path parameters instead of changing the agent workspace.
- Do not use ~ or $HOME.
- Use the smallest tool that answers the current question. Batch independent reads and searches in JSON mode; keep edits and commands sequential.
`

	if (isCodebaseSearchAvailable) {
		rulesContent +=
			"- Use codebase_search for intent-based discovery when the target is unclear. For known symbols, paths, or exact text, use `rg` via the Bash tool or read_file directly.\n"
	}

	rulesContent += `- Search and list files with rg, find and ls through the Bash tool, using a specific pattern, the narrowest plausible path, and | head to bound the output; refine the query instead of repeating it unchanged.
- Read only the relevant file region, do not walk adjacent ranges one-by-one, and do not re-read an unchanged region.
${getEditingInstructions(diffStrategy)}
- Some modes restrict which files may be edited; respect any FileRestrictionError.
- Inspect tool results before dependent actions. If a required parameter is genuinely missing, use ask_followup_question rather than a filler value.
- When complete, use attempt_completion with a concise final result.
`

	if (supportsComputerUse) {
		rulesContent +=
			"- For generic browser tasks, prefer the browser or an available MCP capability over creating code.\n"
	}

	return rulesContent
}
