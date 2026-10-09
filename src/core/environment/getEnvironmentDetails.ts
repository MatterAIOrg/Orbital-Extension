import path from "path"

import delay from "delay"
import pWaitFor from "p-wait-for"
import * as vscode from "vscode"

import type { ExperimentId } from "@roo-code/types"
import { DEFAULT_TERMINAL_OUTPUT_CHARACTER_LIMIT } from "@roo-code/types"

import { Terminal } from "../../integrations/terminal/Terminal"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"
import { EXPERIMENT_IDS, experiments as Experiments } from "../../shared/experiments"
import { getApiMetrics } from "../../shared/getApiMetrics"
import { formatLanguage } from "../../shared/language"
import { defaultModeSlug, getFullModeDetails } from "../../shared/modes"
import { renderLinkedReposSection } from "../../services/links"
import { getSkillsSection } from "../prompts/system"
import { getSystemInfoSection } from "../prompts/sections"

import { Task } from "../task/Task"

// forked_change start
import { TelemetryService } from "@roo-code/telemetry"
import { NativeOllamaHandler } from "../../api/providers/native-ollama"
import { OpenRouterHandler } from "../../api/providers/openrouter"
import { t } from "../../i18n"
// forked_change end

export async function getEnvironmentDetails(cline: Task, includeFileDetails: boolean = false) {
	let details = ""

	const clineProvider = cline.providerRef.deref()
	const state = await clineProvider?.getState()
	const {
		terminalOutputLineLimit = 500,
		terminalOutputCharacterLimit = DEFAULT_TERMINAL_OUTPUT_CHARACTER_LIMIT,
		maxWorkspaceFiles = 200,
	} = state ?? {}

	// It could be useful for cline to know if the user went from one or no
	// file to another between messages, so we always include this context.
	details += "\n\n## VSCode Visible Files"

	const visibleFilePaths = vscode.window.visibleTextEditors
		?.map((editor) => editor.document?.uri?.fsPath)
		.filter(Boolean)
		.map((absolutePath) => path.relative(cline.cwd, absolutePath))
		.slice(0, maxWorkspaceFiles)

	// Filter paths through rooIgnoreController
	const allowedVisibleFiles = cline.rooIgnoreController
		? cline.rooIgnoreController.filterPaths(visibleFilePaths)
		: visibleFilePaths.map((p) => p.toPosix()).join("\n")

	if (allowedVisibleFiles) {
		details += `\n${allowedVisibleFiles}`
	} else {
		details += "\n(No visible files)"
	}

	details += "\n\n## VSCode Open Tabs"
	const { maxOpenTabsContext } = state ?? {}
	const maxTabs = maxOpenTabsContext ?? 20
	const openTabPaths = vscode.window.tabGroups.all
		.flatMap((group) => group.tabs)
		.filter((tab) => tab.input instanceof vscode.TabInputText)
		.map((tab) => (tab.input as vscode.TabInputText).uri.fsPath)
		.filter(Boolean)
		.map((absolutePath) => path.relative(cline.cwd, absolutePath).toPosix())
		.slice(0, maxTabs)

	// Filter paths through rooIgnoreController
	const allowedOpenTabs = cline.rooIgnoreController
		? cline.rooIgnoreController.filterPaths(openTabPaths)
		: openTabPaths.map((p) => p.toPosix()).join("\n")

	if (allowedOpenTabs) {
		details += `\n${allowedOpenTabs}`
	} else {
		details += "\n(No open tabs)"
	}

	// Get task-specific and background terminals.
	const busyTerminals = [
		...TerminalRegistry.getTerminals(true, cline.taskId),
		...TerminalRegistry.getBackgroundTerminals(true),
	]

	const inactiveTerminals = [
		...TerminalRegistry.getTerminals(false, cline.taskId),
		...TerminalRegistry.getBackgroundTerminals(false),
	]

	if (busyTerminals.length > 0) {
		if (cline.didEditFile) {
			await delay(300) // Delay after saving file to let terminals catch up.
		}

		// Wait for terminals to cool down.
		await pWaitFor(() => busyTerminals.every((t) => !TerminalRegistry.isProcessHot(t.id)), {
			interval: 100,
			timeout: 5_000,
		}).catch(() => {})
	}

	// Reset, this lets us know when to wait for saved files to update terminals.
	cline.didEditFile = false

	// Waiting for updated diagnostics lets terminal output be the most
	// up-to-date possible.
	let terminalDetails = ""

	if (busyTerminals.length > 0) {
		// Terminals are cool, let's retrieve their output.
		terminalDetails += "\n\n## Actively Running Terminals"

		for (const busyTerminal of busyTerminals) {
			const cwd = busyTerminal.getCurrentWorkingDirectory()
			terminalDetails += `\n### Terminal ${busyTerminal.id} (Active)`
			terminalDetails += `\n- Working Directory: \`${cwd}\``
			terminalDetails += `\n- Original command: \`${busyTerminal.getLastCommand()}\``
			let newOutput = TerminalRegistry.getUnretrievedOutput(busyTerminal.id)

			if (newOutput) {
				newOutput = Terminal.compressTerminalOutput(
					newOutput,
					terminalOutputLineLimit,
					terminalOutputCharacterLimit,
				)
				terminalDetails += `\n#### New Output\n${newOutput}`
			}
		}
	}

	// First check if any inactive terminals in this task have completed
	// processes with output.
	const terminalsWithOutput = inactiveTerminals.filter((terminal) => {
		const completedProcesses = terminal.getProcessesWithOutput()
		return completedProcesses.length > 0
	})

	// Only add the header if there are terminals with output.
	if (terminalsWithOutput.length > 0) {
		terminalDetails += "\n\n## Inactive Terminals with Completed Process Output"

		// Process each terminal with output.
		for (const inactiveTerminal of terminalsWithOutput) {
			let terminalOutputs: string[] = []

			// Get output from completed processes queue.
			const completedProcesses = inactiveTerminal.getProcessesWithOutput()

			for (const process of completedProcesses) {
				let output = process.getUnretrievedOutput()

				if (output) {
					output = Terminal.compressTerminalOutput(
						output,
						terminalOutputLineLimit,
						terminalOutputCharacterLimit,
					)
					terminalOutputs.push(`Command: \`${process.command}\`\n${output}`)
				}
			}

			// Clean the queue after retrieving output.
			inactiveTerminal.cleanCompletedProcessQueue()

			// Add this terminal's outputs to the details.
			if (terminalOutputs.length > 0) {
				const cwd = inactiveTerminal.getCurrentWorkingDirectory()
				terminalDetails += `\n### Terminal ${inactiveTerminal.id} (Inactive)`
				terminalDetails += `\n- Working Directory: \`${cwd}\``
				terminalOutputs.forEach((output) => {
					terminalDetails += `\n#### New Output\n${output}`
				})
			}
		}
	}

	// console.log(`[Task#getEnvironmentDetails] terminalDetails: ${terminalDetails}`)

	// Add recently modified files section.
	const recentlyModifiedFiles = cline.fileContextTracker.getAndClearRecentlyModifiedFiles()

	if (recentlyModifiedFiles.length > 0) {
		details +=
			"\n\n## Recently Modified Files\nThese files have been modified since you last accessed them (file was just edited so you may need to re-read it before editing):"
		for (const filePath of recentlyModifiedFiles) {
			details += `\n- ${filePath}`
		}
	}

	if (terminalDetails) {
		details += terminalDetails
	}

	// Add current time information with timezone.
	const now = new Date()

	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
	const timeZoneOffset = -now.getTimezoneOffset() / 60 // Convert to hours and invert sign to match conventional notation
	const timeZoneOffsetHours = Math.floor(Math.abs(timeZoneOffset))
	const timeZoneOffsetMinutes = Math.abs(Math.round((Math.abs(timeZoneOffset) - timeZoneOffsetHours) * 60))
	const timeZoneOffsetStr = `${timeZoneOffset >= 0 ? "+" : "-"}${timeZoneOffsetHours}:${timeZoneOffsetMinutes.toString().padStart(2, "0")}`
	details += `\n\n## Current Time\nCurrent time in ISO 8601 UTC format: ${now.toISOString()}\nUser time zone: ${timeZone}, UTC${timeZoneOffsetStr}`

	// Add context tokens information.
	const { contextTokens, totalCost } = getApiMetrics(cline.clineMessages)

	// forked_change start
	// Be sure to fetch the model information before we need it.
	if (cline.api instanceof OpenRouterHandler || cline.api instanceof NativeOllamaHandler) {
		try {
			await cline.api.fetchModel()
		} catch (e) {
			TelemetryService.instance.captureException(e, { context: "getEnvironmentDetails" })
			await cline.say(
				"error",
				t("kilocode:task.notLoggedInError", { error: e instanceof Error ? e.message : String(e) }),
			)
			return `# Environment Details\n\n${details.trim()}`
		}
	}
	// forked_change end

	const { id: modelId, info: modelInfo } = cline.api.getModel()

	// details += `\n\n# Current Cost\n${totalCost !== null ? `$${totalCost.toFixed(2)}` : "(Not available)"}`

	// Add current mode and any mode-specific warnings.
	const {
		mode,
		customModes,
		customModePrompts,
		experiments = {} as Record<ExperimentId, boolean>,
		customInstructions: globalCustomInstructions,
		language,
	} = state ?? {}

	const modeDetails = await getFullModeDetails(mode ?? defaultModeSlug, customModes, customModePrompts, {
		cwd: cline.cwd,
		globalCustomInstructions,
		language: language ?? formatLanguage(vscode.env.language),
	})

	const currentMode = modeDetails.slug ?? mode // kilocode_change: don't try to use non-existent modes

	details += `\n\n## Current Mode\n`
	details += `- Slug: ${currentMode}\n`
	details += `- Name: ${modeDetails.name}\n`
	details += `- Model: ${modelId}\n`

	if (Experiments.isEnabled(experiments ?? {}, EXPERIMENT_IDS.POWER_STEERING)) {
		details += `\n### Role\n${modeDetails.roleDefinition}\n`

		if (modeDetails.customInstructions) {
			details += `\n### Custom Instructions\n${modeDetails.customInstructions}\n`
		}
	}

	if (includeFileDetails) {
		// forked_change: no automatic file listing. It differed per workspace and
		// session, which rewrote the first request and defeated the provider's
		// prompt cache; the model explores with Bash instead.
		details += `\n\n## Current Workspace Directory (${cline.cwd.toPosix()})\nNo file listing is attached; explore the project with Bash (\`ls\`, \`rg --files\`, \`git ls-files\`) rather than guessing at its layout. Prefer a non-recursive \`ls\` for generic directories where you don't need the nested structure, like the Desktop.`

		// forked_change: per-session context that used to live in the system
		// prompt (OS, shells, directories, skills catalog). Kept out of it so
		// the system prompt is byte-identical across sessions and workspaces.
		details += `\n\n${getSystemInfoSection(cline.cwd)}`

		// forked_change start: linked repositories (.orb/links.json). Shared with
		// the OrbCode CLI; gated behind includeFileDetails so it only rides along
		// with the heavy first-message context, not every turn.
		const linkedRepos = await renderLinkedReposSection(cline.cwd)
		if (linkedRepos) {
			details += `\n\n${linkedRepos}`
		}
		// forked_change end

		const skills = await getSkillsSection(cline.cwd)
		if (skills) {
			details += `\n\n## Available Skills\n${skills.trim()}`
		}
	}

	// const todoListEnabled =
	// 	state && typeof state.apiConfiguration?.todoListEnabled === "boolean"
	// 		? state.apiConfiguration.todoListEnabled
	// 		: true
	// const reminderSection = todoListEnabled ? formatReminderSection(cline.todoList) : ""
	// return `# Environment Details\n\n${details.trim()}\n${reminderSection}`
	return `# Environment Details\n\n${details.trim()}`
}
