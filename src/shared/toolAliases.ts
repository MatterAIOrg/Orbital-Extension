/**
 * The model sees the shell tool as `Bash` (what most models are trained on),
 * while the extension keeps `execute_command` as its internal tool name for
 * approval, UI, mode groups and persisted history. Translate at the boundary.
 */
const MODEL_TO_INTERNAL: Record<string, string> = { Bash: "execute_command" }
const INTERNAL_TO_MODEL: Record<string, string> = { execute_command: "Bash" }

/** Name the model used in a tool call -> internal tool name. */
export function toInternalToolName(name: string): string {
	return MODEL_TO_INTERNAL[name] ?? name
}

/** Internal tool name -> name shown to the model. */
export function toModelToolName(name: string): string {
	return INTERNAL_TO_MODEL[name] ?? name
}
