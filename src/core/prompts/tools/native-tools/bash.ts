import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "Bash",
		description:
			"Run one bash command. Also use it to explore the codebase: search with rg/grep, list with ls/find/tree, inspect git state. Read-only commands run without approval. Provide a short user-facing message and explicitly classify whether it may modify or delete data. Prefer commands scoped to the workspace. For long-running commands (downloads, builds, test suites, installs, dev servers), set background to true: the command starts detached and returns an id at once. The user sees running commands above the chat input and can stop them there, so never ask the user to check on one or repeat its id. You are told when it finishes (in a <background_commands> note on a later message); use check_background when you need its output sooner and kill_background to stop it.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: "Shell command to execute",
				},
				cwd: {
					type: ["string", "null"],
					description: "Working directory, or null for the workspace directory",
				},
				message: {
					type: "string",
					description: "Clear one-line description shown to the user for approval",
				},
				background: {
					type: ["boolean", "null"],
					description:
						"true to run the command in the background (non-blocking) and return its id immediately; its output is captured and available through check_background. null or false to wait for the command to finish.",
				},
				isDangerous: {
					type: "boolean",
					description:
						"Set true when the command is potentially destructive or irreversible — e.g. deletes/overwrites files (rm, mv over existing paths), force-pushes or resets git history, drops/migrates databases, changes system/network/permission state, installs globally, or sends data to external services. Set false for safe read-only or routine commands (ls, cat, build, test, install local deps). The user's selected approval mode may auto-approve only commands marked false.",
				},
			},
			required: ["command", "cwd", "message", "background", "isDangerous"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
