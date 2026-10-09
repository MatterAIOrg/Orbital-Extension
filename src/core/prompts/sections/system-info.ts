import os from "os"
import osName from "os-name"

import { getCommandShell, getShell } from "../../../utils/shell"

function describeCommandShell(): string {
	const shell = getCommandShell()
	if (shell.isBash) return "bash (write commands in bash syntax)"
	return process.platform === "win32"
		? "cmd.exe (bash is not installed, so bash syntax and rg/find/ls/grep pipelines may not work; use cmd.exe-compatible commands and check a tool exists before relying on it)"
		: "the default shell (bash was not found; stick to POSIX sh syntax)"
}

/**
 * Operating system, shells and directories. Sent with the environment details
 * on the first message; the static system prompt's harness section explains
 * how the workspace directory is used.
 */
export function getSystemInfoSection(cwd: string): string {
	return `## System Information
- Operating System: ${osName()}
- Default Shell: ${getShell()}
- Bash Tool Shell: ${describeCommandShell()}
- Home Directory: ${os.homedir().toPosix()}
- Current Workspace Directory: ${cwd.toPosix()}`
}
