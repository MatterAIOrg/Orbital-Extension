// forked_change: check_background / kill_background, ported from OrbCode. Both act
// only on commands this task started with Bash(background=true), so they need
// no approval; they show as read-only rows in the chat.

import { Task } from "../task/Task"
import { ToolUse, HandleError, PushToolResult, RemoveClosingTag } from "../../shared/tools"
import { ClineSayTool } from "../../shared/ExtensionMessage"
import { formatResponse } from "../prompts/responses"
import { getBackgroundCommand, killBackgroundCommand } from "../../integrations/terminal/BackgroundCommands"

const MAX_OUTPUT_CHARS = 30_000

type BackgroundTool = "checkBackground" | "killBackground"

/** Show the call in the chat and approve it at once, like the other auto-approved read tools. */
async function showToolRow(task: Task, block: ToolUse, tool: BackgroundTool, id: string | undefined): Promise<boolean> {
	const message: ClineSayTool = { tool, content: id }
	if (block.partial) {
		await task.ask("tool", JSON.stringify(message), true).catch(() => {})
		return false
	}
	setImmediate(() => {
		try {
			task.handleWebviewAskResponse?.("yesButtonClicked", undefined, undefined)
		} catch {
			// best-effort
		}
	})
	await task.ask("tool", JSON.stringify(message), false).catch(() => {})
	return true
}

/** The command, if `id` names one this task started. */
function findOwnCommand(task: Task, id: string) {
	const cmd = getBackgroundCommand(id)
	return cmd && cmd.owner === task.taskId ? cmd : null
}

function formatOutput(output: string): string {
	const trimmed = output.trim()
	if (!trimmed) return "  Output: (empty)"
	if (trimmed.length > MAX_OUTPUT_CHARS) {
		return `  Output (truncated to the last ${MAX_OUTPUT_CHARS} characters):\n${trimmed.slice(-MAX_OUTPUT_CHARS)}`
	}
	return `  Output:\n${trimmed}`
}

export async function checkBackgroundTool(
	task: Task,
	block: ToolUse,
	handleError: HandleError,
	pushToolResult: PushToolResult,
	removeClosingTag: RemoveClosingTag,
) {
	const id = removeClosingTag("id", block.params.id)?.trim()
	try {
		if (!(await showToolRow(task, block, "checkBackground", id))) return
		if (!id) {
			task.consecutiveMistakeCount++
			pushToolResult(await task.sayAndCreateMissingParamError("check_background", "id"))
			return
		}
		task.consecutiveMistakeCount = 0

		const cmd = findOwnCommand(task, id)
		if (!cmd) {
			pushToolResult(formatResponse.toolError(`No background command found with id "${id}".`))
			return
		}

		const elapsed = Math.round((Date.now() - cmd.startedAt) / 1000)
		const duration = cmd.endedAt ? Math.round((cmd.endedAt - cmd.startedAt) / 1000) : null
		let text = `Background command status:\n`
		text += `  ID: ${cmd.id}\n`
		text += `  Command: ${cmd.command}\n`
		text += `  Status: ${cmd.status}\n`
		text += `  Elapsed: ${elapsed}s${duration !== null ? ` (duration: ${duration}s)` : ""}\n`
		if (cmd.status !== "running") {
			// The agent has now seen the result; skip the next-turn completion notice.
			cmd.reported = true
			text += `  Exit code: ${cmd.exitCode === null ? "unknown" : cmd.exitCode}\n`
			text += formatOutput(cmd.output)
		} else {
			text += `  Still running...`
			if (cmd.output.trim()) {
				text += `\n  Partial output:\n${cmd.output.trim().slice(-MAX_OUTPUT_CHARS)}`
			}
		}
		pushToolResult(text)
	} catch (error) {
		await handleError("checking background command", error as Error)
	}
}

export async function killBackgroundTool(
	task: Task,
	block: ToolUse,
	handleError: HandleError,
	pushToolResult: PushToolResult,
	removeClosingTag: RemoveClosingTag,
) {
	const id = removeClosingTag("id", block.params.id)?.trim()
	try {
		if (!(await showToolRow(task, block, "killBackground", id))) return
		if (!id) {
			task.consecutiveMistakeCount++
			pushToolResult(await task.sayAndCreateMissingParamError("kill_background", "id"))
			return
		}
		task.consecutiveMistakeCount = 0

		const cmd = findOwnCommand(task, id)
		if (!cmd) {
			pushToolResult(formatResponse.toolError(`No background command found with id "${id}".`))
			return
		}
		if (cmd.status !== "running") {
			pushToolResult(`Background command ${id} is not running (status: ${cmd.status}).`)
			return
		}
		if (!killBackgroundCommand(id)) {
			pushToolResult(
				formatResponse.toolError(
					`Could not stop background command ${id} (the process may have already exited).`,
				),
			)
			return
		}
		pushToolResult(
			`Sent SIGTERM to background command ${id} (pid ${cmd.pid}). It is force-killed if still running after 3s.`,
		)
	} catch (error) {
		await handleError("stopping background command", error as Error)
	}
}
