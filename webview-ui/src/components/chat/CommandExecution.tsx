import { ArrowDown, ArrowUp, ChevronDown, CornerDownLeft, OctagonX } from "lucide-react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useEvent } from "react-use"

import { CommandExecutionStatus, commandExecutionStatusSchema } from "@roo-code/types"

import { ExtensionMessage } from "@roo/ExtensionMessage"
import { safeJsonParse } from "@roo/safeJsonParse"

import { COMMAND_OUTPUT_STRING } from "@roo/combineCommandSequences"

import { StandardTooltip } from "@src/components/ui"
import { ImageAttachment } from "@src/components/common/Thumbnails"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { cn } from "@src/lib/utils"
import { vscode } from "@src/utils/vscode"
import { t } from "i18next"
import { extractPatternsFromCommand } from "../../utils/command-parser"
import { parseCommand } from "../../utils/command-validation"
import CodeBlock from "../kilocode/common/CodeBlock" // kilocode_change
import { CommandPatternSelector } from "./CommandPatternSelector"
import { MatterProgressIndicator } from "./ProgressIndicator"

interface CommandPattern {
	pattern: string
	description?: string
}

interface CommandExecutionProps {
	executionId: string
	text?: string
	onPrimaryButtonClick?: (text?: string, images?: ImageAttachment[]) => void
	onSecondaryButtonClick?: (text?: string, images?: ImageAttachment[]) => void
	enableButtons?: boolean
}

type ApprovalOption = "yes" | "yes_always" | "no_feedback"

const APPROVAL_OPTIONS: Array<{ key: ApprovalOption; label: string }> = [
	{ key: "yes", label: "Yes" },
	{ key: "yes_always", label: "Yes, and don't ask again for commands that start with" },
	{ key: "no_feedback", label: "No, and tell Orbital what to do differently" },
]

export const CommandExecution = memo(
	({ executionId, text, onPrimaryButtonClick, onSecondaryButtonClick, enableButtons }: CommandExecutionProps) => {
		const { allowedCommands = [], deniedCommands = [], setAllowedCommands, setDeniedCommands } = useExtensionState()

		const {
			message: customMessage,
			command,
			output: parsedOutput,
		} = useMemo(() => parseCommandAndOutput(text), [text])

		const [isExpanded, setIsExpanded] = useState(false)
		const [selectedOption, setSelectedOption] = useState<ApprovalOption>("yes")
		const [feedbackText, setFeedbackText] = useState("")
		const [streamingOutput, setStreamingOutput] = useState("")
		const [status, setStatus] = useState<CommandExecutionStatus | null>(null)
		const [elapsedSeconds, setElapsedSeconds] = useState<number>(0)
		const [completedSeconds, setCompletedSeconds] = useState<number | null>(null)
		const startTimeRef = useRef<number | null>(null)

		// The command's output can either come from the text associated with the
		// task message (this is the case for completed commands) or from the
		// streaming output (this is the case for running commands).
		const output = streamingOutput || parsedOutput
		const commandTitle =
			customMessage?.trim() || command.trim().split(/\r?\n/, 1)[0] || t("chat:commandExecution.running")
		const hasDetails = command.trim().length > 0 || output.trim().length > 0
		const hasCompleted = status?.status === "exited" || Boolean(text?.includes(COMMAND_OUTPUT_STRING))
		const isRunningCommand = status?.status === "started" || (!status && !hasCompleted)
		const isApprovalMode = !!onPrimaryButtonClick && !!onSecondaryButtonClick && !!enableButtons && !status
		const commandRef = useRef(command)
		commandRef.current = command

		// Extract command patterns from the actual command that was executed
		const commandPatterns = useMemo<CommandPattern[]>(() => {
			const allCommands = parseCommand(command)
			const allPatterns = new Set<string>()

			allCommands.forEach((cmd) => {
				if (cmd.trim()) {
					allPatterns.add(cmd.trim())
				}
			})

			allCommands.forEach((cmd) => {
				const patterns = extractPatternsFromCommand(cmd)
				patterns.forEach((pattern) => allPatterns.add(pattern))
			})

			return Array.from(allPatterns).map((pattern) => ({
				pattern,
			}))
		}, [command])

		// Handle pattern changes
		const handleAllowPatternChange = (pattern: string) => {
			const isAllowed = allowedCommands.includes(pattern)
			const newAllowed = isAllowed ? allowedCommands.filter((p) => p !== pattern) : [...allowedCommands, pattern]
			const newDenied = deniedCommands.filter((p) => p !== pattern)

			setAllowedCommands(newAllowed)
			setDeniedCommands(newDenied)
			vscode.postMessage({ type: "allowedCommands", commands: newAllowed })
			vscode.postMessage({ type: "deniedCommands", commands: newDenied })
		}

		const handleDenyPatternChange = (pattern: string) => {
			const isDenied = deniedCommands.includes(pattern)
			const newDenied = isDenied ? deniedCommands.filter((p) => p !== pattern) : [...deniedCommands, pattern]
			const newAllowed = allowedCommands.filter((p) => p !== pattern)

			setAllowedCommands(newAllowed)
			setDeniedCommands(newDenied)
			vscode.postMessage({ type: "allowedCommands", commands: newAllowed })
			vscode.postMessage({ type: "deniedCommands", commands: newDenied })
		}

		const onMessage = useCallback(
			(event: MessageEvent) => {
				const message: ExtensionMessage = event.data

				if (message.type === "commandExecutionStatus") {
					const result = commandExecutionStatusSchema.safeParse(safeJsonParse(message.text, {}))

					if (result.success) {
						const data = result.data

						if (data.executionId !== executionId) {
							return
						}

						switch (data.status) {
							case "started":
								startTimeRef.current = data.startTime ?? null
								setStatus(data)
								break
							case "output":
								setStreamingOutput(data.output)
								break
							case "fallback":
								setIsExpanded(true)
								break
							default:
								setStatus(data)
								break
						}
					}
				}
			},
			[executionId],
		)

		useEvent("message", onMessage)

		// Timer effect for showing "Running for X seconds"
		useEffect(() => {
			if (status?.status === "started" && startTimeRef.current) {
				const startTime = startTimeRef.current

				const interval = setInterval(() => {
					const elapsed = Math.floor((Date.now() - startTime) / 1000)
					setElapsedSeconds(elapsed)
				}, 1000)

				setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000))

				return () => clearInterval(interval)
			}
		}, [status])

		// Calculate final duration when command completes
		useEffect(() => {
			if (status?.status === "exited" && startTimeRef.current) {
				const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000)
				setCompletedSeconds(elapsed)
			}
		}, [status])

		const handleSubmit = useCallback(() => {
			if (!onPrimaryButtonClick || !onSecondaryButtonClick) return

			switch (selectedOption) {
				case "yes":
					onPrimaryButtonClick()
					break
				case "yes_always": {
					const currentCommand = commandRef.current.trim()
					if (currentCommand && !allowedCommands.includes(currentCommand)) {
						const newAllowedCommands = [...allowedCommands, currentCommand]
						setAllowedCommands(newAllowedCommands)
						vscode.postMessage({ type: "allowedCommands", commands: newAllowedCommands })
					}
					onPrimaryButtonClick()
					break
				}
				case "no_feedback":
					onSecondaryButtonClick(feedbackText || undefined)
					break
			}
		}, [
			selectedOption,
			onPrimaryButtonClick,
			onSecondaryButtonClick,
			allowedCommands,
			setAllowedCommands,
			feedbackText,
		])

		const handleSkip = useCallback(() => {
			onSecondaryButtonClick?.()
		}, [onSecondaryButtonClick])

		useEffect(() => {
			if (!isApprovalMode) return

			const handleKeyDown = (event: KeyboardEvent) => {
				const selectedIndex = APPROVAL_OPTIONS.findIndex((option) => option.key === selectedOption)

				switch (event.key) {
					case "ArrowUp":
						event.preventDefault()
						setSelectedOption(APPROVAL_OPTIONS[Math.max(0, selectedIndex - 1)].key)
						break
					case "ArrowDown":
						event.preventDefault()
						setSelectedOption(
							APPROVAL_OPTIONS[Math.min(APPROVAL_OPTIONS.length - 1, selectedIndex + 1)].key,
						)
						break
					case "Enter":
						event.preventDefault()
						handleSubmit()
						break
					case "Escape":
						event.preventDefault()
						handleSkip()
						break
				}
			}

			window.addEventListener("keydown", handleKeyDown)
			return () => window.removeEventListener("keydown", handleKeyDown)
		}, [isApprovalMode, selectedOption, handleSubmit, handleSkip])

		if (isApprovalMode) {
			const commandPrefix = command.trim().replace(/\s+/g, " ")

			return (
				<div
					data-testid="command-approval"
					className="mb-2 overflow-hidden rounded-2xl border border-[var(--vscode-commandCenter-inactiveBorder)] bg-vscode-editor-background p-3">
					<div className="px-1 pb-3 pt-0.5 text-sm font-semibold leading-5 text-vscode-foreground">
						{customMessage?.trim() || "Allow this command to run."}
					</div>

					<div className="relative overflow-hidden rounded-xl bg-[color-mix(in_srgb,var(--vscode-input-background)_82%,var(--vscode-editor-background))] px-3 pb-9 pt-2.5">
						<code
							data-testid="command-approval-preview"
							className={cn(
								"block whitespace-pre-wrap break-all font-mono text-xs leading-5 text-vscode-descriptionForeground",
								isExpanded ? "max-h-48 overflow-y-auto" : "line-clamp-3",
							)}>
							{command}
						</code>
						<button
							type="button"
							className="absolute bottom-2 right-3 cursor-pointer border-0 bg-transparent p-0 text-xs font-medium text-vscode-descriptionForeground hover:text-vscode-foreground"
							onClick={() => setIsExpanded((expanded) => !expanded)}>
							{isExpanded ? "Collapse" : "Expand"}
						</button>
					</div>

					<div className="mt-3 flex flex-col gap-1">
						{APPROVAL_OPTIONS.map((option, index) => {
							const isSelected = selectedOption === option.key
							return (
								<div key={option.key} className="flex min-w-0 items-center gap-2">
									<button
										type="button"
										className={cn(
											"flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-xl border-0 px-2 py-2 text-left text-sm transition-colors",
											isSelected
												? "bg-[color-mix(in_srgb,var(--vscode-input-background)_88%,var(--vscode-foreground)_4%)] text-vscode-foreground"
												: "bg-transparent text-vscode-descriptionForeground hover:bg-vscode-list-hoverBackground hover:text-vscode-foreground",
										)}
										onClick={() => {
											setSelectedOption(option.key)
											if (option.key !== "no_feedback") setFeedbackText("")
										}}>
										<span className="w-5 shrink-0 text-xs text-vscode-descriptionForeground">
											{index + 1}.
										</span>
										<span className="min-w-0 flex-1 truncate font-medium">
											{option.label}
											{option.key === "yes_always" && (
												<code className="ml-1 font-mono font-medium text-vscode-descriptionForeground">
													{commandPrefix}
												</code>
											)}
										</span>
										{isSelected && (
											<span className="flex shrink-0 items-center gap-1 text-vscode-descriptionForeground">
												<ArrowUp className="size-3.5" aria-hidden="true" />
												<ArrowDown className="size-3.5" aria-hidden="true" />
											</span>
										)}
									</button>

									{index === APPROVAL_OPTIONS.length - 1 && (
										<div className="flex shrink-0 items-center gap-2 pl-1">
											<button
												type="button"
												className="cursor-pointer rounded-lg border-0 bg-transparent px-2 py-1.5 text-sm font-medium text-vscode-descriptionForeground hover:bg-vscode-toolbar-hoverBackground hover:text-vscode-foreground"
												onClick={handleSkip}>
												Skip
											</button>
											<button
												type="button"
												className="flex cursor-pointer items-center gap-2 rounded-full border-0 bg-vscode-foreground px-3 py-1.5 text-sm font-semibold text-vscode-editor-background hover:opacity-90"
												onClick={handleSubmit}>
												Submit
												<span className="flex size-5 items-center justify-center rounded-md bg-vscode-editor-background/10">
													<CornerDownLeft className="size-3" aria-hidden="true" />
												</span>
											</button>
										</div>
									)}
								</div>
							)
						})}
					</div>

					{selectedOption === "no_feedback" && (
						<input
							type="text"
							autoFocus
							className="mt-2 w-full rounded-lg border border-vscode-input-border bg-vscode-input-background px-3 py-2 text-xs text-vscode-input-foreground outline-none focus:border-vscode-focusBorder"
							placeholder="Tell Orbital what to do differently..."
							value={feedbackText}
							onChange={(event) => setFeedbackText(event.target.value)}
						/>
					)}
				</div>
			)
		}

		// Compact command row with opt-in details after approval/execution.
		return (
			<>
				<div className="mb-1 overflow-hidden rounded-lg border border-vscode-border bg-vscode-editor-background">
					<div className="flex min-w-0 items-center gap-1.5 px-2 py-1">
						{isRunningCommand ? (
							<MatterProgressIndicator className="shrink-0 text-[13px] leading-none text-vscode-descriptionForeground" />
						) : status?.status === "exited" ? (
							<StandardTooltip
								content={t("chat.commandExecution.exitStatus", { exitStatus: status.exitCode })}>
								<div
									className={cn(
										"size-1.5 shrink-0 rounded-full",
										status.exitCode === 0 ? "bg-green-600" : "bg-red-600",
									)}
								/>
							</StandardTooltip>
						) : null}
						<span
							data-testid="command-status"
							className="shrink-0 text-xs font-medium text-vscode-foreground">
							Bash
						</span>
						<span aria-hidden="true" className="shrink-0 text-vscode-descriptionForeground/50">
							·
						</span>

						<button
							type="button"
							data-testid="command-execution-toggle"
							aria-expanded={isExpanded}
							disabled={!hasDetails}
							className="flex min-w-0 flex-1 cursor-pointer items-center border-0 bg-transparent p-0 text-left text-vscode-foreground disabled:cursor-default"
							onClick={() => setIsExpanded((expanded) => !expanded)}
							title={commandTitle}>
							<span
								data-testid="command-title"
								className={cn("truncate text-xs font-medium", !customMessage && "font-mono")}>
								{commandTitle}
							</span>
						</button>

						{status?.status === "started" && (
							<span className="shrink-0 text-[11px] text-vscode-descriptionForeground">
								{elapsedSeconds}s
							</span>
						)}
						{status?.status === "exited" && completedSeconds !== null && (
							<span className="shrink-0 text-[11px] text-vscode-descriptionForeground">
								{completedSeconds}s
							</span>
						)}

						{status?.status === "started" && (
							<StandardTooltip content={t("chat:commandExecution.abort")}>
								<button
									type="button"
									className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-vscode-descriptionForeground hover:bg-vscode-toolbar-hoverBackground hover:text-vscode-foreground"
									onClick={() =>
										vscode.postMessage({
											type: "terminalOperation",
											terminalOperation: "abort",
										})
									}>
									<OctagonX className="size-3.5" />
								</button>
							</StandardTooltip>
						)}

						<button
							type="button"
							className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-vscode-descriptionForeground hover:bg-vscode-toolbar-hoverBackground hover:text-vscode-foreground"
							aria-label={isExpanded ? "Collapse command details" : "Expand command details"}
							onClick={() => setIsExpanded((expanded) => !expanded)}>
							<ChevronDown
								className={cn("size-3.5 transition-transform duration-150", isExpanded && "rotate-180")}
							/>
						</button>
					</div>

					<div
						data-testid="command-execution-details"
						aria-hidden={!isExpanded}
						className={cn("border-t border-border", !isExpanded && "hidden")}>
						<div className="max-h-[calc(100vh/2.5)] overflow-y-auto py-2 pl-2">
							<CodeBlock source={command} language="shell" />
							<OutputContainer isExpanded output={output} />
						</div>
						{command && command.trim() && (
							<CommandPatternSelector
								patterns={commandPatterns}
								allowedCommands={allowedCommands}
								deniedCommands={deniedCommands}
								onAllowPatternChange={handleAllowPatternChange}
								onDenyPatternChange={handleDenyPatternChange}
							/>
						)}
					</div>
				</div>
			</>
		)
	},
)

CommandExecution.displayName = "CommandExecution"

const OutputContainerInternal = ({ isExpanded, output }: { isExpanded: boolean; output: string }) => (
	<div
		className={cn("overflow-hidden", {
			"max-h-0": !isExpanded,
			"mt-1 pt-1 border-t border-border/25": isExpanded,
		})}>
		{output.length > 0 && <CodeBlock source={output} language="log" />}
	</div>
)

const OutputContainer = memo(OutputContainerInternal)

const parseCommandAndOutput = (text: string | undefined) => {
	if (!text) {
		return { message: "", command: "", output: "" }
	}

	let message = ""
	let remaining = text

	// Check for message prefix: "MESSAGE:...\n---\ncommand"
	const messageSeparator = "\n---\n"
	if (remaining.startsWith("MESSAGE:")) {
		const separatorIdx = remaining.indexOf(messageSeparator)
		if (separatorIdx !== -1) {
			message = remaining.slice(8, separatorIdx) // after "MESSAGE:"
			remaining = remaining.slice(separatorIdx + messageSeparator.length)
		}
	}

	// Parse command and output
	const outputIdx = remaining.indexOf(COMMAND_OUTPUT_STRING)

	if (outputIdx === -1) {
		return { message, command: remaining, output: "" }
	}

	return {
		message,
		command: remaining.slice(0, outputIdx),
		output: remaining.slice(outputIdx + COMMAND_OUTPUT_STRING.length),
	}
}
