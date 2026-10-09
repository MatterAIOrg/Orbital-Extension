import { execFile } from "child_process"
import { promisify } from "util"

import * as vscode from "vscode"

import type { ClineRulesToggles } from "../../shared/cline-rules"
import { formatLanguage } from "../../shared/language"
import { getGitRepositoryInfo } from "../../utils/git"
import { addCustomInstructions } from "../prompts/sections"
import { buildContextReminders } from "../prompts/system"
import type { Task } from "../task/Task"

const execFileAsync = promisify(execFile)

const MAX_STATUS_LINES = 20

async function git(cwd: string, args: string[]): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("git", args, { cwd, timeout: 5000 })
		return stdout.trimEnd()
	} catch {
		return undefined
	}
}

/**
 * Git snapshot for the first message's context reminder, in the layout Claude
 * Code uses: branch, main branch, user, status and recent commits. Empty
 * outside a repository.
 */
export async function getGitSnapshot(cwd: string): Promise<string> {
	const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
	if (branch === undefined) return ""
	const [mainRef, user, status, commits, info] = await Promise.all([
		git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
		git(cwd, ["config", "user.name"]),
		git(cwd, ["status", "--short"]),
		git(cwd, ["log", "--oneline", "-n", "5"]),
		getGitRepositoryInfo(cwd).catch(() => ({}) as { repositoryUrl?: string }),
	])
	const mainBranch = mainRef?.replace(/^origin\//, "")
	const statusLines = (status ?? "").split("\n").filter(Boolean)
	return [
		"# gitStatus",
		"This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.",
		"",
		`Current branch: ${branch}`,
		...(mainBranch ? ["", `Main branch (you will usually use this for PRs): ${mainBranch}`] : []),
		...(info.repositoryUrl ? ["", `Repository: ${info.repositoryUrl}`] : []),
		...(user ? ["", `Git user: ${user}`] : []),
		"",
		"Status:",
		statusLines.length === 0
			? "(clean)"
			: statusLines.slice(0, MAX_STATUS_LINES).join("\n") +
				(statusLines.length > MAX_STATUS_LINES ? `\n… (${statusLines.length - MAX_STATUS_LINES} more)` : ""),
		...(commits ? ["", "Recent commits:", commits] : []),
	].join("\n")
}

/**
 * The user's custom instructions: language preference, global instructions,
 * .orbitalrules / rule files and AGENTS.md. Mode-specific instructions are
 * left out: the mode can change mid-task, while this is sent once.
 */
async function getMemorySection(task: Task): Promise<string> {
	const provider = task.providerRef.deref()
	const state = await provider?.getState()
	const contextProxy = provider?.contextProxy
	const localRulesToggleState = contextProxy
		? ((await contextProxy.getWorkspaceState(provider.context, "localRulesToggles")) as ClineRulesToggles)
		: undefined
	const globalRulesToggleState = contextProxy
		? ((await contextProxy.getGlobalState("globalRulesToggles")) as ClineRulesToggles)
		: undefined
	const instructions = await addCustomInstructions("", state?.customInstructions ?? "", task.cwd, "", {
		language: state?.language ?? formatLanguage(vscode.env.language),
		rooIgnoreInstructions: task.rooIgnoreController?.getInstructions(),
		localRulesToggleState,
		globalRulesToggleState,
		settings: {
			maxConcurrentFileReads: state?.maxConcurrentFileReads ?? 5,
			todoListEnabled: state?.apiConfiguration?.todoListEnabled ?? true,
			useAgentRules: vscode.workspace.getConfiguration("kilo-code").get<boolean>("useAgentRules") ?? true,
			newTaskRequireTodos: vscode.workspace
				.getConfiguration("kilo-code")
				.get<boolean>("newTaskRequireTodos", false),
		},
	})
	// Drop the "USER'S CUSTOM INSTRUCTIONS" banner: the reminder has its own preamble.
	return instructions.replace(/^\s*====\s*\n\s*USER'S CUSTOM INSTRUCTIONS\s*\n[^\n]*\n\s*/, "").trim()
}

/**
 * <system-reminder> blocks that open a task's first user message: custom
 * instructions (AGENTS.md, rules) and the git snapshot. They used to live in
 * (or were missing from) the system prompt; as conversation context the
 * system prompt stays byte-identical and the prompt cache keeps hitting.
 */
export async function getContextReminders(task: Task): Promise<string> {
	const [memory, gitSnapshot] = await Promise.all([
		getMemorySection(task).catch((error) => {
			console.error("[contextReminders] failed to load custom instructions:", error)
			return ""
		}),
		getGitSnapshot(task.cwd),
	])
	return buildContextReminders(memory, gitSnapshot)
}
