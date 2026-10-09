// forked_change: turn-wide spinner stats (ported from OrbCode). The in-progress
// request row shows how long the whole turn has been running and the output
// tokens generated so far, e.g. "2m 13s · ↓ 4.2k tokens". The timer covers the
// turn, not the current request, so it doesn't reset between tool rounds.
import { memo, useEffect, useMemo, useState } from "react"

import type { ClineMessage } from "@roo-code/types"
import { safeJsonParse } from "@roo/safeJsonParse"

import { useExtensionState } from "@/context/ExtensionStateContext"

/** Rough chars-per-token for text still streaming, before the provider reports usage. */
const CHARS_PER_TOKEN = 4

/** "45s", "2m 13s", "1h 4m" */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000))
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** "840", "4.2k", "1.3M" */
export function formatTokenCount(tokens: number): string {
	if (tokens < 1000) return String(Math.round(tokens))
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`
	return `${(tokens / 1_000_000).toFixed(1)}M`
}

/**
 * Start of the current turn (the task or the user's latest message) and the
 * output tokens generated since: the provider-reported count of finished
 * requests plus ~4 chars/token for whatever is still streaming.
 */
export function getTurnStats(messages: ClineMessage[]): { startedAt: number; outputTokens: number } | undefined {
	let start = -1
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].say === "user_feedback" || i === 0) {
			start = i
			break
		}
	}
	if (start === -1) return undefined

	let outputTokens = 0
	let streamedChars = 0
	for (const message of messages.slice(start + 1)) {
		if (message.say === "api_req_started") {
			const info = safeJsonParse<{ tokensOut?: number }>(message.text)
			if (typeof info?.tokensOut === "number") outputTokens += info.tokensOut
			// A new request: earlier streamed text is covered by the last report.
			streamedChars = 0
		} else if (message.partial === true) {
			streamedChars += message.text?.length ?? 0
		}
	}
	return {
		startedAt: messages[start].ts,
		outputTokens: outputTokens + Math.round(streamedChars / CHARS_PER_TOKEN),
	}
}

export const TurnStats = memo(() => {
	const { clineMessages } = useExtensionState()
	const stats = useMemo(() => getTurnStats(clineMessages), [clineMessages])
	const [now, setNow] = useState(() => Date.now())

	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(id)
	}, [])

	if (!stats) return null

	return (
		<span className="font-mono text-[11px] tabular-nums text-vscode-descriptionForeground" data-testid="turn-stats">
			{formatElapsed(now - stats.startedAt)}
			{stats.outputTokens > 0 ? ` · ↓ ${formatTokenCount(stats.outputTokens)} tokens` : ""}
		</span>
	)
})

TurnStats.displayName = "TurnStats"

export default TurnStats
