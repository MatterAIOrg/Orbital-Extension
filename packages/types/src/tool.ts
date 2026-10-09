import { z } from "zod"

/**
 * ToolGroup
 */

export const toolGroups = ["read", "edit", "browser", "command", "mcp", "modes"] as const

export const toolGroupsSchema = z.enum(toolGroups)

export type ToolGroup = z.infer<typeof toolGroupsSchema>

/**
 * ToolName
 */

export const toolNames = [
	"execute_command",
	"read_file",
	"file_edit",
	"multi_file_edit",
	"file_write",
	"search_files",
	"list_files",
	"list_code_definition_names",
	"lsp",
	"browser_action",
	"use_mcp_tool",
	"access_mcp_resource",
	"mcp_authenticate",
	"ask_followup_question",
	"attempt_completion",
	"switch_mode",
	"new_task",
	"fetch_instructions",
	"codebase_search",
	// forked_change start
	"new_rule",
	"report_bug",
	"condense",
	// forked_change end
	"update_todo_list",
	"run_slash_command",
	"generate_image",
	"check_past_chat_memories",
	"use_skill",
	"web_fetch",
	"web_search",
	"figma_fetch",
	"generate_file",
	"check_background", // forked_change: background shells
	"kill_background", // forked_change: background shells
] as const

export const toolNamesSchema = z.enum(toolNames)

export type ToolName = z.infer<typeof toolNamesSchema>

/**
 * ToolUsage
 */

export const toolUsageSchema = z.record(
	toolNamesSchema,
	z.object({
		attempts: z.number(),
		failures: z.number(),
	}),
)

export type ToolUsage = z.infer<typeof toolUsageSchema>
