import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "check_background",
		description:
			"Check the status of a background command started with Bash(background=true). Returns the command's status (running/completed/failed/killed), exit code, and output (partial output while it is still running).",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "The background command ID returned when the command was started",
				},
			},
			required: ["id"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
