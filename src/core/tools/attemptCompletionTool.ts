import Anthropic from "@anthropic-ai/sdk"
import * as vscode from "vscode"

import { RooCodeEventName } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../task/Task"
import {
	ToolResponse,
	ToolUse,
	AskApproval,
	HandleError,
	PushToolResult,
	RemoveClosingTag,
	ToolDescription,
	AskFinishSubTaskApproval,
} from "../../shared/tools"
import { formatResponse } from "../prompts/responses"
import { Package } from "../../shared/package"
import { getCommitRangeForNewCompletion } from "../checkpoints/kilocode/seeNewChanges"
import { MemoryManager } from "../../services/chat-memory"

// forked_change start
async function getClineMessageOptions(task: Task) {
	const commitRange = await getCommitRangeForNewCompletion(task)
	return (
		commitRange && {
			metadata: {
				kiloCode: { commitRange },
			},
		}
	)
}

/**
 * Save completion result as a chat memory
 * This is non-critical - errors are logged but don't block completion
 */
async function saveCompletionMemory(cline: Task, result: string): Promise<void> {
	try {
		const provider = cline.providerRef.deref()
		const globalStoragePath = provider?.contextProxy.globalStorageUri.fsPath

		if (!globalStoragePath) {
			return
		}

		// Get task title from the first message
		const taskTitle = cline.clineMessages[0]?.text

		// Get current mode from provider state
		const mode = (await provider?.getState())?.mode ?? "default"

		// Save memory
		const memoryManager = new MemoryManager(globalStoragePath)
		await memoryManager.saveMemory({
			taskId: cline.taskId,
			content: result,
			taskTitle,
			workspace: cline.workspacePath,
			mode,
		})
	} catch (error) {
		// Don't block completion if memory saving fails
		console.error("Failed to save chat memory:", error)
	}
}

export async function attemptCompletionTool(
	cline: Task,
	block: ToolUse,
	askApproval: AskApproval,
	handleError: HandleError,
	pushToolResult: PushToolResult,
	removeClosingTag: RemoveClosingTag,
	toolDescription: ToolDescription,
	askFinishSubTaskApproval: AskFinishSubTaskApproval,
) {
	const result: string | undefined = block.params.result
	const command: string | undefined = block.params.command

	// Get the setting for preventing completion with open todos from VSCode configuration
	const preventCompletionWithOpenTodos = vscode.workspace
		.getConfiguration(Package.name)
		.get<boolean>("preventCompletionWithOpenTodos", false)

	// Check if there are incomplete todos (only if the setting is enabled)
	const hasIncompleteTodos = cline.todoList && cline.todoList.some((todo) => todo.status !== "completed")

	if (preventCompletionWithOpenTodos && hasIncompleteTodos) {
		cline.consecutiveMistakeCount++
		cline.recordToolError("attempt_completion")

		pushToolResult(
			formatResponse.toolError(
				"Cannot complete task while there are incomplete todos. Please finish all todos before attempting completion.",
			),
		)

		return
	}

	try {
		const lastMessage = cline.clineMessages.at(-1)

		if (block.partial) {
			if (command) {
				// the attempt_completion text is done, now we're getting command
				// remove the previous partial attempt_completion ask, replace with say, post state to webview, then stream command

				// const secondLastMessage = cline.clineMessages.at(-2)
				if (lastMessage && lastMessage.ask === "command") {
					// update command
					await cline.ask("command", removeClosingTag("command", command), block.partial).catch(() => {})
				} else {
					// last message is completion_result
					// we have command string, which means we have the result as well, so finish it (doesnt have to exist yet)
					await cline.say(
						"completion_result",
						removeClosingTag("result", result),
						undefined,
						false,
						undefined,
						undefined,
						await getClineMessageOptions(cline), // kilocode_change
					)

					TelemetryService.instance.captureTaskCompleted(cline.taskId)
					cline.captureCommittedCodeUsage()
					cline.emit(RooCodeEventName.TaskCompleted, cline.taskId, cline.getTokenUsage(), cline.toolUsage)

					// Save completion as chat memory
					if (result) {
						await saveCompletionMemory(cline, result)
					}

					await cline.ask("command", removeClosingTag("command", command), block.partial).catch(() => {})
				}
			} else {
				// No command, still outputting partial result
				await cline.say("completion_result", removeClosingTag("result", result), undefined, block.partial)
			}
			return
		} else {
			if (!result) {
				cline.consecutiveMistakeCount++
				cline.recordToolError("attempt_completion")
				pushToolResult(await cline.sayAndCreateMissingParamError("attempt_completion", "result"))
				return
			}

			cline.consecutiveMistakeCount = 0

			// Command execution is permanently disabled in attempt_completion
			// Users must use the Bash tool separately before attempt_completion
			await cline.say(
				"completion_result",
				result,
				undefined,
				false,
				undefined,
				undefined,
				await getClineMessageOptions(cline), //kilocode_change
			)
			TelemetryService.instance.captureTaskCompleted(cline.taskId)
			cline.captureCommittedCodeUsage()
			cline.emit(RooCodeEventName.TaskCompleted, cline.taskId, cline.getTokenUsage(), cline.toolUsage)

			// Save completion as chat memory
			await saveCompletionMemory(cline, result)

			if (cline.parentTask) {
				const didApprove = await askFinishSubTaskApproval()

				if (!didApprove) {
					return
				}

				// tell the provider to remove the current subtask and resume the previous task in the stack
				await cline.providerRef.deref()?.finishSubTask(result)
				return
			}

			// We already sent completion_result says, an
			// empty string asks relinquishes control over
			// button and field.
			const { response, text, images, pasteChips } = await cline.ask("completion_result", "", false)

			// Signals to recursive loop to stop (for now
			// cline never happens since yesButtonClicked
			// will trigger a new task).
			if (response === "yesButtonClicked") {
				pushToolResult("")
				return
			}

			await cline.say(
				"user_feedback",
				text ?? "",
				images,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				pasteChips,
			)

			const feedbackContent: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = [
				{
					type: "text",
					text: `The user has provided feedback on the results. Consider their input to continue the task, and then attempt completion again.\n<feedback>\n${text}\n</feedback>`,
				},
				...formatResponse.imageBlocks(images),
			]

			pushToolResult([{ type: "text", text: `${toolDescription()} Result:` }, ...feedbackContent])

			return
		}
	} catch (error) {
		await handleError("inspecting site", error)
		return
	}
}
