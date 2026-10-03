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

export function getSystemInfoSection(cwd: string): string {
	let details = `# System Information

- Operating System: ${osName()}
- Default Shell: ${getShell()}
- Bash Tool Shell: ${describeCommandShell()}
- Home Directory: ${os.homedir().toPosix()}
- Current Workspace Directory: ${cwd.toPosix()}

The Current Workspace Directory is the active VS Code project directory, and is therefore the default directory for all tool operations. New terminals will be created in the current workspace directory, however if you change directories in a terminal it will then have a different working directory; changing directories in a terminal does not modify the workspace directory, because you do not have access to change the workspace directory. When the user initially gives you a task, a recursive list of all filepaths in the current workspace directory ('/test/path') will be included in the Environment Details section. This provides an overview of the project's file structure, offering key insights into the project from directory/file names (how developers conceptualize and organize their code) and file extensions (the language used). This can also guide decision-making on which files to explore further. If you need to further explore directories such as outside the current workspace directory, you can use ls or find through the Bash tool. Prefer a non-recursive ls for generic directories where you don't need the nested structure, like the Desktop.`

	return details
}
