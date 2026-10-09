// forked_change: the effort picks behind the X-MATTERAI-REASONING-EFFORT header.
// The handler reads them on every request (not once per task), so a level
// picked in any chat applies to every task's next request.

import type { GatewayEffort } from "@roo-code/types"

type ModelEffortsSource = () => Record<string, GatewayEffort> | undefined

let source: ModelEffortsSource = () => undefined

/** Wire the store the picks live in (ClineProvider's global state). */
export function setModelEffortsSource(next: ModelEffortsSource): void {
	source = next
}

export function getModelEfforts(): Record<string, GatewayEffort> | undefined {
	try {
		return source()
	} catch {
		return undefined
	}
}
