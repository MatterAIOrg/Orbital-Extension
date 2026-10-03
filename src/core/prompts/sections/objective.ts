import { CodeIndexManager } from "../../../services/code-index/manager"

export function getObjectiveSection(
	codeIndexManager?: CodeIndexManager,
	experimentsConfig?: Record<string, boolean>,
): string {
	const isCodebaseSearchAvailable =
		codeIndexManager &&
		codeIndexManager.isFeatureEnabled &&
		codeIndexManager.isFeatureConfigured &&
		codeIndexManager.isInitialized

	const codebaseSearchInstruction = isCodebaseSearchAvailable
		? "When the target is unclear, you may use `codebase_search` to find relevant code by intent; for known symbols or paths, use `rg` via the Bash tool or `read_file` directly. Then, "
		: ""

	return `====

OBJECTIVE

You accomplish a given task iteratively, breaking it down into clear steps and working through them methodically.

1. Analyze the user's task and set clear, achievable goals to accomplish it. Prioritize these goals in a logical order.
2. Work through these goals efficiently. Batch independent reads and searches when their targets are known; keep dependent edits and commands sequential.
3. Remember, you have extensive capabilities with access to a wide range of tools that can be used in powerful and clever ways as necessary to accomplish each goal. Before calling a tool, do focused analysis. ${codebaseSearchInstruction}analyze the file structure provided in environment_details to gain context and insights for proceeding effectively. Choose the most relevant tool and provide every required parameter from the available context. If a required parameter is genuinely missing, use ask_followup_question instead of sending a filler value.
4. Once you've completed the user's task, you must use the attempt_completion tool to present the result of the task to the user.
5. The user may provide feedback, which you can use to make improvements and try again. But DO NOT continue in pointless back and forth conversations, i.e. don't end your responses with questions or offers for further assistance.`
}
