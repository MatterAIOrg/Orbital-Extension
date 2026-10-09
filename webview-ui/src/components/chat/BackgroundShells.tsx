// forked_change: running background shells (Bash with background=true), ported
// from OrbCode's status-bar panel. Collapsed it reads "● 2 shells running";
// expanded it lists each shell's command, elapsed time, pid, cwd and latest
// output line with a stop action. Only the current task's running shells show;
// finished ones drop out and the agent is told about them instead.
import { memo, useCallback, useEffect, useState } from "react"
import { useEvent } from "react-use"
import { useTranslation } from "react-i18next"

import type { BackgroundCommandInfo, ExtensionMessage } from "@roo/ExtensionMessage"

import { cn } from "@/lib/utils"
import { vscode } from "@/utils/vscode"
import { ArrowDown01Icon } from "@/utils/customIcons"

import { CHAT_CONTENT_HORIZONTAL_PADDING } from "./chatLayout"
import { formatElapsed } from "./TurnStats"

/** How often the expanded list refreshes the latest output lines. */
const REFRESH_MS = 3000

interface BackgroundShellsProps {
	/** Changes when the current task changes, so the list is re-requested. */
	taskId?: string
}

export const BackgroundShells = memo(({ taskId }: BackgroundShellsProps) => {
	const { t } = useTranslation("chat")
	const [shells, setShells] = useState<BackgroundCommandInfo[]>([])
	const [expanded, setExpanded] = useState(false)
	const [now, setNow] = useState(() => Date.now())

	const handleMessage = useCallback((event: MessageEvent) => {
		const message: ExtensionMessage = event.data
		if (message.type === "backgroundCommands") {
			setShells(message.backgroundCommands ?? [])
		}
	}, [])
	useEvent("message", handleMessage)

	useEffect(() => {
		vscode.postMessage({ type: "requestBackgroundCommands" })
	}, [taskId])

	const hasShells = shells.length > 0
	useEffect(() => {
		if (!hasShells) return
		const tick = setInterval(() => setNow(Date.now()), 1000)
		const refresh = expanded
			? setInterval(() => vscode.postMessage({ type: "requestBackgroundCommands" }), REFRESH_MS)
			: undefined
		return () => {
			clearInterval(tick)
			if (refresh) clearInterval(refresh)
		}
	}, [hasShells, expanded])

	if (!hasShells) {
		return null
	}

	return (
		<div className={cn(CHAT_CONTENT_HORIZONTAL_PADDING, "py-1")} data-testid="background-shells">
			<button
				type="button"
				className="flex w-full cursor-pointer items-center gap-1.5 border-none bg-transparent p-0 text-xs text-vscode-descriptionForeground hover:text-vscode-foreground"
				onClick={() => setExpanded((prev) => !prev)}
				aria-expanded={expanded}>
				<span className="text-vscode-charts-green">●</span>
				<span>{t("backgroundShells.running", { count: shells.length })}</span>
				<ArrowDown01Icon className={cn("size-3.5 transition-transform", !expanded && "-rotate-90")} />
			</button>
			{expanded && (
				<div className="mt-1.5 flex max-h-[220px] flex-col gap-1.5 overflow-y-auto">
					{shells.map((shell) => (
						<div
							key={shell.id}
							className="rounded-md border border-vscode-panel-border bg-vscode-editor-background px-2 py-1.5 text-xs"
							data-testid={`background-shell-${shell.id}`}>
							<div className="flex items-center justify-between gap-2">
								<span className="truncate font-mono text-vscode-foreground" title={shell.command}>
									$ {shell.command}
								</span>
								<button
									type="button"
									className="shrink-0 cursor-pointer border-none bg-transparent p-0 text-vscode-errorForeground hover:underline"
									onClick={() =>
										vscode.postMessage({ type: "killBackgroundCommand", text: shell.id })
									}>
									{t("backgroundShells.stop")}
								</button>
							</div>
							<div className="mt-0.5 truncate text-vscode-descriptionForeground" title={shell.cwd}>
								{formatElapsed(now - shell.startedAt)}
								{shell.pid ? ` · pid ${shell.pid}` : ""} · {shell.cwd}
							</div>
							{shell.lastLine && (
								<div className="mt-0.5 truncate font-mono text-vscode-descriptionForeground/80">
									⎿ {shell.lastLine}
								</div>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	)
})

BackgroundShells.displayName = "BackgroundShells"

export default BackgroundShells
