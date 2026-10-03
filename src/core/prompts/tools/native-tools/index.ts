import { OpenAI } from "openai/client"
import askFollowupQuestion from "./ask_followup_question"
import attemptCompletion from "./attempt_completion"
import checkPastChatMemories from "./check_past_chat_memories"
import bash from "./bash"
import listCodeDefinitionNames from "./list_code_definition_names"
import lsp from "./lsp"
import { read_file } from "./read_file"
import fileEdit from "./file_edit"
import multiFileEdit from "./multi_file_edit"
import fileWrite from "./file_write"
import updateTodoList from "./update_todo_list"
import codebaseSearch from "./codebase_search"
import useSkill from "./use_skill"
import figmaFetch from "./figma_fetch"
import webFetch from "./web_fetch"
import webSearch from "./web_search"
import generateFile from "./generate_file"

// The model-facing shell tool is "Bash" (internal name: execute_command, see
// shared/toolAliases.ts). list_files / search_files are intentionally not
// offered: the model uses rg/find/ls through Bash, and read-only commands skip
// the approval prompt (see core/tools/readOnlyCommand.ts).
export const nativeTools = [
	fileEdit,
	multiFileEdit,
	fileWrite,
	askFollowupQuestion,
	attemptCompletion,
	checkPastChatMemories,
	codebaseSearch,
	bash,
	listCodeDefinitionNames,
	lsp,
	read_file,
	updateTodoList,
	useSkill,
	figmaFetch,
	webFetch,
	webSearch,
	generateFile,
] satisfies OpenAI.Chat.ChatCompletionTool[]
