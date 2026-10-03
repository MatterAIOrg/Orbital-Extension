import { ModelInfo, ToolName } from "@roo-code/types"
import { CodeIndexManager } from "../../../../services/code-index/manager"
import { Mode, getModeConfig, isToolAllowedForMode, getGroupName } from "../../../../shared/modes"
import { ClineProviderState } from "../../../webview/ClineProvider"
import OpenAI from "openai"
import { ALWAYS_AVAILABLE_TOOLS, TOOL_GROUPS } from "../../../../shared/tools"
import { nativeTools } from "."
import { read_file } from "./read_file"
import { toInternalToolName } from "../../../../shared/toolAliases"

export function getAllowedJSONToolsForMode(
	mode: Mode,
	codeIndexManager: CodeIndexManager | undefined,
	clineProviderState: ClineProviderState | undefined,
	diffEnabled: boolean,
	model: { id: string; info: ModelInfo } | undefined,
): OpenAI.Chat.ChatCompletionTool[] {
	const config = getModeConfig(mode, clineProviderState?.customModes)

	const tools = new Set<string>()

	// Add tools from mode's groups
	config.groups.forEach((groupEntry) => {
		const groupName = getGroupName(groupEntry)
		const toolGroup = TOOL_GROUPS[groupName]
		if (toolGroup) {
			toolGroup.tools.forEach((tool) => {
				if (
					isToolAllowedForMode(
						tool as ToolName,
						mode,
						clineProviderState?.customModes ?? [],
						undefined,
						undefined,
						clineProviderState?.experiments ?? {},
					)
				) {
					tools.add(tool)
				}
			})
		}
	})

	// Add always available tools
	ALWAYS_AVAILABLE_TOOLS.forEach((tool) => tools.add(tool))

	// Conditionally exclude codebase_search if feature is disabled or not configured
	if (
		!codeIndexManager ||
		!(codeIndexManager.isFeatureEnabled && codeIndexManager.isFeatureConfigured && codeIndexManager.isInitialized)
	) {
		tools.delete("codebase_search")
	}

	// Conditionally exclude update_todo_list if disabled in settings
	if (clineProviderState?.apiConfiguration?.todoListEnabled === false) {
		tools.delete("update_todo_list")
	}

	// Conditionally exclude generate_image if experiment is not enabled
	if (!clineProviderState?.experiments?.imageGeneration) {
		tools.delete("generate_image")
	}

	// Conditionally exclude run_slash_command if experiment is not enabled
	if (!clineProviderState?.experiments?.runSlashCommand) {
		tools.delete("run_slash_command")
	}

	if (!clineProviderState?.browserToolEnabled || !model?.info.supportsImages) {
		tools.delete("browser_action")
	}

	// Create a map of tool names to native tool definitions for quick lookup
	const allowedTools: OpenAI.Chat.ChatCompletionTool[] = []

	let isReadFileToolAllowedForMode = false
	for (const nativeTool of nativeTools) {
		const toolName = toInternalToolName(nativeTool.function.name)

		// If the tool is in the allowed set, add it.
		if (tools.has(toolName)) {
			if (toolName === "read_file") {
				isReadFileToolAllowedForMode = true
			} else {
				allowedTools.push(nativeTool)
			}
		}
	}

	if (isReadFileToolAllowedForMode) {
		allowedTools.push(read_file)
	}

	return allowedTools
}
