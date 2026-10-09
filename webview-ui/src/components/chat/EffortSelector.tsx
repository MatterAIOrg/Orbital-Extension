// forked_change: reasoning-effort selector in the chat textarea for models served
// through the MatterAI gateway (catalog `reasoning_efforts`). The pick is saved
// per model in global state and sent with every request as
// X-MATTERAI-REASONING-EFFORT, so it applies to every task until changed.
import React from "react"

import { getModelEffortLevels, resolveModelEffort, type GatewayEffort, type ModelInfo } from "@roo-code/types"

import { SelectDropdown, DropdownOptionType } from "@/components/ui"
import type { DropdownOption } from "@/components/ui/select-dropdown"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import { cn } from "@/lib/utils"

const EFFORT_CODICONS: Record<GatewayEffort, string> = {
	low: "dashboard",
	medium: "pulse",
	high: "flame",
	max: "rocket",
}

interface EffortSelectorProps {
	modelId: string
	modelInfo?: ModelInfo
	disabled?: boolean
	triggerClassName?: string
}

export const EffortSelector = ({ modelId, modelInfo, disabled = false, triggerClassName }: EffortSelectorProps) => {
	const { t } = useAppTranslation()
	const { modelEfforts } = useExtensionState()

	const levels = React.useMemo(() => getModelEffortLevels(modelId, modelInfo), [modelId, modelInfo])
	const value = resolveModelEffort(modelEfforts, modelId, modelInfo)

	const handleChange = React.useCallback(
		(selected: string) => {
			vscode.postMessage({ type: "modelEffort", values: { modelId, effort: selected } })
		},
		[modelId],
	)

	const options = React.useMemo<DropdownOption[]>(
		() =>
			levels.map((level) => ({
				value: level,
				label: t(`chat:effort.levels.${level}.label`),
				description: t(`chat:effort.levels.${level}.description`),
				codicon: EFFORT_CODICONS[level],
				type: DropdownOptionType.ITEM,
			})),
		[levels, t],
	)

	if (!value || levels.length === 0) {
		return null
	}

	return (
		<SelectDropdown
			value={value}
			title={t("chat:effort.title")}
			disabled={disabled}
			disableSearch
			options={options}
			onChange={handleChange}
			headerComponent={
				<div className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs text-vscode-descriptionForeground">
					<span>{t("chat:effort.title")}</span>
					<span>{t("chat:effort.scale")}</span>
				</div>
			}
			triggerIcon={false}
			triggerClassName={cn(
				`w-full h-7 px-2 py-0
				bg-[var(--vscode-editor-background)]
				rounded-lg
				border-none
				hover:bg-[var(--vscode-activityBar-border)]`,
				triggerClassName,
			)}
		/>
	)
}

export default EffortSelector
