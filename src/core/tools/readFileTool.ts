import fs from "fs"
import path from "path"
import { isBinaryFile } from "isbinaryfile"

import { Task } from "../task/Task"
import { ClineSayTool } from "../../shared/ExtensionMessage"
import { formatResponse } from "../prompts/responses"
import { t } from "../../i18n"
import { ToolUse, AskApproval, HandleError, PushToolResult, RemoveClosingTag } from "../../shared/tools"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { getReadablePath } from "../../utils/path"
import { countFileLines } from "../../integrations/misc/line-counter"
import { readLines } from "../../integrations/misc/read-lines"
import { extractTextFromFile, addLineNumbers, getSupportedBinaryFormats } from "../../integrations/misc/extract-text"
import { parseSourceCodeDefinitionsForFile } from "../../services/tree-sitter"
import { parseXml } from "../../utils/xml"
import {
	blockFileReadWhenTooLarge,
	getNativeReadFileToolDescription,
	parseNativeFiles,
	parsePositiveInteger,
} from "./kilocode"
import {
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
	isSupportedImageFormat,
	validateImageForProcessing,
	processImageFile,
	ImageMemoryTracker,
} from "./helpers/imageHelpers"

// Maximum number of lines to read when limit is not specified - prevents context window overflow
const MAX_READ_FILE_LINES = 1000
// Native JSON models tend to over-fragment reads. Expanding their tiny ranges
// avoids another model round trip while keeping legacy/XML range semantics exact.
const MIN_NATIVE_READ_FILE_LINES = 200

export function getReadFileToolDescription(blockName: string, blockParams: any): string {
	// Handle both single file_path and multiple files via args
	// forked_change start
	if (blockParams.files && Array.isArray(blockParams.files)) {
		return getNativeReadFileToolDescription(blockName, parseNativeFiles(blockParams.files))
		// forked_change end
	} else if (blockParams.file_path) {
		// New single file format with file_path
		return `[${blockName} '${blockParams.file_path}']`
	} else if (blockParams.args) {
		try {
			const parsed = parseXml(blockParams.args) as any
			const files = Array.isArray(parsed.file) ? parsed.file : [parsed.file].filter(Boolean)
			const paths = files.map((f: any) => f?.path || f?.file_path).filter(Boolean) as string[]

			if (paths.length === 0) {
				return `[${blockName} with no valid paths]`
			} else if (paths.length === 1) {
				return `[${blockName} '${paths[0]}']`
			} else if (paths.length <= 3) {
				const pathList = paths.map((p) => `'${p}'`).join(", ")
				return `[${blockName} ${pathList}]`
			} else {
				return `[${blockName} ${paths.length} files]`
			}
		} catch (error) {
			console.error("Failed to parse read_file args XML for description:", error)
			return `[${blockName} with unparsable args]`
		}
	} else if (blockParams.path) {
		// Fallback for legacy single-path usage
		return `[${blockName} '${blockParams.path}']`
	} else {
		return `[${blockName} with missing path/args]`
	}
}
// Types
interface FileEntry {
	path?: string
	offset?: number
	limit?: number
}

// Interface to track file processing state
interface FileResult {
	path: string
	status: "approved" | "denied" | "blocked" | "error" | "pending"
	content?: string
	error?: string
	notice?: string
	offset?: number
	limit?: number
	xmlContent?: string // Final content for this file
	imageDataUrl?: string // Image data URL for image files
	feedbackText?: string // User feedback text from approval/denial
	feedbackImages?: any[] // User feedback images from approval/denial
	mtimeMs?: number // forked_change: file mtime at read time, for repeated-read detection
	wasRepeated?: boolean // The unchanged region was already served earlier in this task
	overlapNotice?: string // forked_change: notice prepended when the read overlaps a prior read
	totalLines?: number
	startLine?: number
	endLine?: number
}

// forked_change: key for Task.readRegionHistory — identifies one exact read request.
function readRegionKey(fullPath: string, offset?: number, limit?: number): string {
	return `${fullPath}|${offset ?? 1}|${limit ?? "all"}`
}

// forked_change: find a previously-read region of the same file version that
// overlaps with the requested range. Returns the overlapping range or null.
// Unlike readRegionKey (exact match), this catches partial overlaps — e.g.
// reading lines 600-849 then 800-1059 — so the model can be told part of the
// content is already in context.
function findOverlappingReadRegion(
	cline: Task,
	fullPath: string,
	mtimeMs: number,
	offset: number,
	limit: number | undefined,
): { startLine: number; endLine: number } | null {
	const newStart = offset
	const newEnd = limit !== undefined ? offset + limit - 1 : Infinity
	const prefix = `${fullPath}|`
	for (const [key, storedMtime] of cline.readRegionHistory) {
		if (storedMtime !== mtimeMs) continue
		if (!key.startsWith(prefix)) continue
		const parts = key.split("|")
		const oldStart = parseInt(parts[1], 10)
		const oldLimitStr = parts[2]
		const oldEnd = oldLimitStr === "all" ? Infinity : oldStart + parseInt(oldLimitStr, 10) - 1
		// Overlap check: ranges [newStart, newEnd] and [oldStart, oldEnd]
		if (newStart <= oldEnd && oldStart <= newEnd) {
			return { startLine: oldStart, endLine: oldEnd === Infinity ? 0 : oldEnd }
		}
	}
	return null
}

export async function readFileTool(
	cline: Task,
	block: ToolUse,
	askApproval: AskApproval,
	handleError: HandleError,
	pushToolResult: PushToolResult,
	_removeClosingTag: RemoveClosingTag,
) {
	const argsXmlTag: string | undefined = block.params.args
	const legacyPath: string | undefined = block.params.path
	const newFilePath: string | undefined = (block.params as any).file_path // New: support file_path directly
	const legacyStartLineStr: string | undefined = block.params.start_line
	const legacyEndLineStr: string | undefined = block.params.end_line
	// Parse offset and limit as positive integers - the model may send them as
	// strings, null, or fractional values; unparseable values fall back to the
	// tool defaults instead of failing the read.
	const rawOffset = (block.params as any).offset
	const rawLimit = (block.params as any).limit
	const offsetParam: number | undefined = parsePositiveInteger(rawOffset)
	const limitParam: number | undefined = parsePositiveInteger(rawLimit)

	const nativeFiles: any[] | undefined = (block.params as any).files // kilocode_change: Native JSON format from OpenAI-style tool calls

	// Check if the current model supports images at the beginning
	const modelInfo = cline.api.getModel().info
	const supportsImages = modelInfo.supportsImages ?? false

	// Handle partial message first
	if (block.partial) {
		let filePath = ""
		// Prioritize file_path, then args, then legacy path
		if (newFilePath) {
			filePath = newFilePath
		} else if (argsXmlTag) {
			const match = argsXmlTag.match(/<file>.*?<(?:file_)?path>([^<]+)<\/(?:file_)?path>/s)
			if (match) filePath = match[1]
		}
		if (!filePath && legacyPath) {
			// If args didn't yield a path, try legacy
			filePath = legacyPath
		}

		// Support absolute paths using cross-platform check
		const fullPath = path.isAbsolute(filePath) ? filePath : filePath ? path.resolve(cline.cwd, filePath) : ""
		const sharedMessageProps: ClineSayTool = {
			tool: "readFile",
			path: getReadablePath(cline.cwd, filePath),
			isOutsideWorkspace: filePath ? isPathOutsideWorkspace(fullPath) : false,
		}
		const partialMessage = JSON.stringify({
			...sharedMessageProps,
			content: undefined,
		} satisfies ClineSayTool)
		await cline.ask("tool", partialMessage, block.partial).catch(() => {})
		return
	}

	const fileEntries: FileEntry[] = []

	// forked_change start
	// Handle native JSON format first (from OpenAI-style tool calls)
	if (nativeFiles && Array.isArray(nativeFiles)) {
		fileEntries.push(
			...parseNativeFiles(nativeFiles).map((entry) => ({
				...entry,
				limit:
					entry.limit === undefined
						? undefined
						: Math.min(MAX_READ_FILE_LINES, Math.max(MIN_NATIVE_READ_FILE_LINES, entry.limit)),
			})),
		)
		// forked_change end
	} else if (newFilePath) {
		// Handle new single file_path format with optional offset/limit
		const fileEntry: FileEntry = {
			path: newFilePath,
			offset: offsetParam ?? 1,
			limit: limitParam, // undefined means read complete file
		}
		fileEntries.push(fileEntry)
	} else if (argsXmlTag) {
		// Parse file entries from XML (legacy multi-file format)
		try {
			const parsed = parseXml(argsXmlTag) as any
			const files = Array.isArray(parsed.file) ? parsed.file : [parsed.file].filter(Boolean)

			for (const file of files) {
				const filePath = file.file_path || file.path
				if (!filePath) continue // Skip if no path in a file entry

				// Parse offset and limit as positive integers - XML parsing may
				// produce strings, and repaired arguments may carry nulls.
				const fileEntry: FileEntry = {
					path: filePath,
					offset: parsePositiveInteger(file.offset) ?? 1,
					limit: parsePositiveInteger(file.limit), // undefined means read complete file
				}

				// Legacy support: convert line_range to offset+limit
				if (file.line_range) {
					const ranges = Array.isArray(file.line_range) ? file.line_range : [file.line_range]
					if (ranges.length > 0) {
						const match = String(ranges[0]).match(/(\d+)-(\d+)/)
						if (match) {
							const [, start, end] = match.map(Number)
							if (!isNaN(start) && !isNaN(end)) {
								fileEntry.offset = start
								fileEntry.limit = end - start + 1
							}
						}
					}
				}
				fileEntries.push(fileEntry)
			}
		} catch (error) {
			const errorMessage = `Failed to parse read_file XML args: ${error instanceof Error ? error.message : String(error)}`
			await handleError("parsing read_file args", new Error(errorMessage))
			pushToolResult(`[error] ${errorMessage}`)
			return
		}
	} else if (legacyPath) {
		// Handle legacy single file path as a fallback
		console.warn("[readFileTool] Received legacy 'path' parameter. Consider updating to use 'file_path'.")

		const fileEntry: FileEntry = {
			path: legacyPath,
			offset: 1,
			limit: undefined, // Read complete file by default
		}

		// Legacy support: convert start_line/end_line to offset+limit
		if (legacyStartLineStr && legacyEndLineStr) {
			const start = parseInt(legacyStartLineStr, 10)
			const end = parseInt(legacyEndLineStr, 10)
			if (!isNaN(start) && !isNaN(end) && start > 0 && end > 0) {
				fileEntry.offset = start
				fileEntry.limit = end - start + 1
			} else {
				console.warn(
					`[readFileTool] Invalid legacy line range for ${legacyPath}: start='${legacyStartLineStr}', end='${legacyEndLineStr}'`,
				)
			}
		}
		fileEntries.push(fileEntry)
	}

	// If, after trying all formats, no valid file entries are found.
	if (fileEntries.length === 0) {
		cline.consecutiveMistakeCount++
		cline.recordToolError("read_file")
		const errorMsg = await cline.sayAndCreateMissingParamError("read_file", "file_path (absolute path to file)")
		pushToolResult(`[error] ${errorMsg}`)
		return
	}

	// Create an array to track the state of each file
	const fileResults: FileResult[] = fileEntries.map((entry) => ({
		path: entry.path || "",
		status: "pending",
		offset: entry.offset,
		limit: entry.limit,
	}))

	// Function to update file result status
	const updateFileResult = (result: FileResult, updates: Partial<FileResult>) => {
		Object.assign(result, updates)
	}

	try {
		// First validate all files and prepare for batch approval
		const filesToApprove: FileResult[] = []

		for (let i = 0; i < fileResults.length; i++) {
			const fileResult = fileResults[i]
			const relPath = fileResult.path

			// Validate offset/limit if provided
			if (fileResult.offset !== undefined && fileResult.offset < 1) {
				const errorMsg = "Invalid offset: must be >= 1"
				updateFileResult(fileResult, {
					status: "blocked",
					error: errorMsg,
					xmlContent: `--- ${relPath} ---\n[error] ${errorMsg}`,
				})
				await handleError(`reading file ${relPath}`, new Error(errorMsg))
				continue
			}
			if (fileResult.limit !== undefined && fileResult.limit < 1) {
				const errorMsg = "Invalid limit: must be >= 1"
				updateFileResult(fileResult, {
					status: "blocked",
					error: errorMsg,
					xmlContent: `--- ${relPath} ---\n[error] ${errorMsg}`,
				})
				await handleError(`reading file ${relPath}`, new Error(errorMsg))
				continue
			}

			// Then check RooIgnore validation
			if (fileResult.status === "pending") {
				const accessAllowed = cline.rooIgnoreController?.validateAccess(relPath)
				if (!accessAllowed) {
					await cline.say("rooignore_error", relPath)
					const errorMsg = formatResponse.rooIgnoreError(relPath)
					updateFileResult(fileResult, {
						status: "blocked",
						error: errorMsg,
						xmlContent: `--- ${relPath} ---\n[error] ${errorMsg}`,
					})
					continue
				}

				// Add to files that need approval
				filesToApprove.push(fileResult)
			}
		}

		// Handle batch files - auto-approve all
		const showReadApproval = async (message: string) => {
			if (cline.parallelToolExecution) {
				// A parallel read-only batch cannot use the task's single interactive
				// ask promise. Keep the progress visible without blocking execution.
				await cline.say("tool", message, undefined, false, undefined, undefined, { isNonInteractive: true })
				return
			}

			setImmediate(() => {
				try {
					cline.handleWebviewAskResponse?.("yesButtonClicked", undefined, undefined)
				} catch {
					// best-effort
				}
			})
			await cline.ask("tool", message, false).catch(() => {})
		}

		if (filesToApprove.length > 1) {
			// Create batch message to show in UI
			const batchFiles = filesToApprove.map((fileResult) => {
				const relPath = fileResult.path
				const fullPath = path.isAbsolute(relPath) ? relPath : path.resolve(cline.cwd, relPath)
				const offset = fileResult.offset
				const limit = fileResult.limit
				return {
					path: getReadablePath(cline.cwd, relPath),
					lineSnippet: offset !== undefined && limit !== undefined ? `#L${offset}-${offset + limit - 1}` : "",
					isOutsideWorkspace: isPathOutsideWorkspace(fullPath),
					key: relPath,
					content: fullPath,
					offset,
					limit,
				}
			})

			const completeMessage = JSON.stringify({
				tool: "readFile",
				batchFiles,
			} satisfies ClineSayTool)

			await showReadApproval(completeMessage)

			// Auto-approve all files
			filesToApprove.forEach((fileResult) => {
				updateFileResult(fileResult, {
					status: "approved",
				})
			})
		} else if (filesToApprove.length === 1) {
			// Single file - show in UI and auto-approve
			const fileResult = filesToApprove[0]
			const relPath = fileResult.path
			const fullPath = path.isAbsolute(relPath) ? relPath : path.resolve(cline.cwd, relPath)
			const isOutsideWorkspace = isPathOutsideWorkspace(fullPath)

			// Get actual file line count for accurate limit display
			const totalLines = await countFileLines(fullPath).catch(() => MAX_READ_FILE_LINES)
			const effectiveLimit = fileResult.limit
				? Math.min(fileResult.limit, MAX_READ_FILE_LINES)
				: Math.min(totalLines, MAX_READ_FILE_LINES)

			const completeMessage = JSON.stringify({
				tool: "readFile",
				path: getReadablePath(cline.cwd, relPath),
				isOutsideWorkspace,
				content: fullPath,
				offset: fileResult.offset || 0,
				limit: effectiveLimit,
			} satisfies ClineSayTool)

			await showReadApproval(completeMessage)

			updateFileResult(fileResult, {
				status: "approved",
			})
		}

		// Track total image memory usage across all files
		const imageMemoryTracker = new ImageMemoryTracker()
		const state = await cline.providerRef.deref()?.getState()
		const {
			maxImageFileSize = DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
			maxTotalImageSize = DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
		} = state ?? {}
		// Always use MAX_READ_FILE_LINES - setting will be removed later
		const maxReadFileLine = MAX_READ_FILE_LINES

		// Then process only approved files
		for (const fileResult of fileResults) {
			// Skip files that weren't approved
			if (fileResult.status !== "approved") {
				continue
			}

			const relPath = fileResult.path
			const fullPath = path.isAbsolute(relPath) ? relPath : path.resolve(cline.cwd, relPath)

			// forked_change start: short-circuit repeated reads of an unchanged region.
			// A common model failure is intending "read around line N" but omitting
			// `offset`, then re-reading the file head turn after turn. If this exact
			// region of this exact file version was already served in this task,
			// return a corrective hint instead of the same content again.
			try {
				const { mtimeMs } = await fs.promises.stat(fullPath)
				fileResult.mtimeMs = mtimeMs
				const regionKey = readRegionKey(fullPath, fileResult.offset, fileResult.limit)
				if (cline.readRegionHistory.get(regionKey) === mtimeMs) {
					const startLine = fileResult.offset ?? 1
					const endLabel = fileResult.limit !== undefined ? String(startLine + fileResult.limit - 1) : "end"
					const nextRegionHint =
						startLine === 1
							? "If you need line N, request the complete surrounding function or logical region with an `offset` and a 200-1000 line `limit`; batch any other known regions in the same call."
							: "If you need more context, request a different, non-overlapping range by changing `offset` or `limit`."
					updateFileResult(fileResult, {
						wasRepeated: true,
						xmlContent: `--- ${relPath} ---
[repeated-read skipped] This unchanged region (lines ${startLine}-${endLabel}) is already available earlier in the conversation. No file content was returned.

Do not call read_file again with the same path, offset, and limit. Choose the next action now:
- If the earlier content is sufficient, continue the analysis or make the edit.
- ${nextRegionHint}
- Do not walk through nearby offsets on this file one-by-one; that is still a repeated-read loop.
- If you do not know the target line, use rg -n via the Bash tool for the relevant symbol or text, then read only the matched range.

Do not stop or ask the user because of this skipped read; proceed with the best next action above.`,
					})
					continue
				}
			} catch {
				// stat failed — fall through to the normal read path, which surfaces
				// the proper error (e.g. file not found).
			}
			// forked_change end

			// forked_change: detect overlapping reads of the same file version.
			// The exact-match check above catches identical (path, offset, limit)
			// repeats. This catches partial overlaps — e.g. reading 600-849 then
			// 800-1059 — and prepends a notice so the model knows part of the
			// content is already in context and should not re-read it.
			if (fileResult.mtimeMs !== undefined && !fileResult.wasRepeated) {
				const overlap = findOverlappingReadRegion(
					cline,
					fullPath,
					fileResult.mtimeMs,
					fileResult.offset ?? 1,
					fileResult.limit,
				)
				if (overlap) {
					const endLabel = overlap.endLine === 0 ? "end" : String(overlap.endLine)
					fileResult.overlapNotice = `[overlap notice] Lines ${overlap.startLine}-${endLabel} of this file were already read earlier in this conversation. Only lines outside that range are new. Use the earlier content for the overlapping portion instead of re-reading it.`
				}
			}

			// Process approved files
			try {
				const [totalLines, isBinary] = await Promise.all([countFileLines(fullPath), isBinaryFile(fullPath)])
				fileResult.totalLines = totalLines

				// Handle binary files (but allow specific file types that extractTextFromFile can handle)
				if (isBinary) {
					const fileExtension = path.extname(relPath).toLowerCase()
					const supportedBinaryFormats = getSupportedBinaryFormats()

					// Check if it's a supported image format
					if (isSupportedImageFormat(fileExtension)) {
						try {
							// Validate image for processing
							const validationResult = await validateImageForProcessing(
								fullPath,
								supportsImages,
								maxImageFileSize,
								maxTotalImageSize,
								imageMemoryTracker.getTotalMemoryUsed(),
							)

							if (!validationResult.isValid) {
								// Track file read
								await cline.fileContextTracker.trackFileContext(relPath, "read_tool" as RecordSource)

								updateFileResult(fileResult, {
									xmlContent: `--- ${relPath} ---\n[notice] ${validationResult.notice}`,
								})
								continue
							}

							// Process the image
							const imageResult = await processImageFile(fullPath)

							// Track memory usage for this image
							imageMemoryTracker.addMemoryUsage(imageResult.sizeInMB)

							// Track file read
							await cline.fileContextTracker.trackFileContext(relPath, "read_tool" as RecordSource)

							// Store image data URL separately
							updateFileResult(fileResult, {
								xmlContent: `--- ${relPath} ---\n[image] ${imageResult.notice}`,
								imageDataUrl: imageResult.dataUrl,
							})
							continue
						} catch (error) {
							const errorMsg = error instanceof Error ? error.message : String(error)
							updateFileResult(fileResult, {
								status: "error",
								error: `Error reading image file: ${errorMsg}`,
								xmlContent: `--- ${relPath} ---\n[error] ${errorMsg}`,
							})
							await handleError(
								`reading image file ${relPath}`,
								error instanceof Error ? error : new Error(errorMsg),
							)
							continue
						}
					}

					// Check if it's a supported binary format that can be processed
					if (supportedBinaryFormats && supportedBinaryFormats.includes(fileExtension)) {
						// For supported binary formats (.pdf, .docx, .ipynb), continue to extractTextFromFile
						// Fall through to the normal extractTextFromFile processing below
					} else {
						// Handle unknown binary format
						const fileFormat = fileExtension.slice(1) || "bin" // Remove the dot, fallback to "bin"
						updateFileResult(fileResult, {
							notice: `Binary file format: ${fileFormat}`,
							xmlContent: `--- ${relPath} ---\n[binary ${fileFormat}] content not displayed`,
						})
						continue
					}
				}

				// Handle offset/limit reads (if limit is specified)
				if (fileResult.limit !== undefined) {
					const startLine = fileResult.offset ?? 1
					// Cap limit to MAX_READ_FILE_LINES to prevent context window overflow
					const effectiveLimit = Math.min(fileResult.limit, MAX_READ_FILE_LINES)
					const endLine = startLine + effectiveLimit - 1
					fileResult.startLine = startLine
					fileResult.endLine = Math.min(endLine, totalLines)
					const content = addLineNumbers(await readLines(fullPath, endLine - 1, startLine - 1), startLine)
					let xmlContent = content
					if (fileResult.limit > MAX_READ_FILE_LINES) {
						xmlContent = `[showing ${effectiveLimit} lines, capped from requested ${fileResult.limit} lines to prevent context overflow]\n${content}`
					}
					updateFileResult(fileResult, {
						xmlContent,
					})
					continue
				}

				// Handle offset-only reads (no limit specified) - cap to MAX_READ_FILE_LINES
				if (fileResult.offset !== undefined && fileResult.offset > 1) {
					const startLine = fileResult.offset
					const endLine = startLine + MAX_READ_FILE_LINES - 1
					const actualEndLine = Math.min(endLine, totalLines)
					fileResult.startLine = startLine
					fileResult.endLine = actualEndLine
					const linesRead = actualEndLine - startLine + 1
					const content = addLineNumbers(
						await readLines(fullPath, actualEndLine - 1, startLine - 1),
						startLine,
					)
					let xmlContent = content
					if (totalLines > actualEndLine) {
						xmlContent = `[showing ${linesRead} lines from offset ${startLine}, capped at ${MAX_READ_FILE_LINES} lines. Total file length: ${totalLines} lines]\n${content}`
					}
					updateFileResult(fileResult, {
						xmlContent,
					})
					continue
				}

				// Handle files exceeding line threshold
				if (maxReadFileLine > 0 && totalLines > maxReadFileLine) {
					fileResult.startLine = 1
					fileResult.endLine = maxReadFileLine
					const content = addLineNumbers(await readLines(fullPath, maxReadFileLine - 1, 0))
					// kilocode_change: Return content without path header, just note truncation
					let fileOutput = `[showing ${maxReadFileLine} of ${totalLines} lines]\n${content}`

					try {
						const defResult = await parseSourceCodeDefinitionsForFile(fullPath, cline.rooIgnoreController)
						if (defResult) {
							fileOutput += `\n[definitions]\n${defResult}`
						}
						updateFileResult(fileResult, {
							xmlContent: fileOutput,
						})
					} catch (error) {
						if (error instanceof Error && error.message.startsWith("Unsupported language:")) {
							console.warn(`[read_file] Warning: ${error.message}`)
						} else {
							console.error(
								`[read_file] Unhandled error: ${error instanceof Error ? error.message : String(error)}`,
							)
						}
					}
					continue
				}

				// Handle normal file read
				fileResult.startLine = totalLines > 0 ? 1 : undefined
				fileResult.endLine = totalLines > 0 ? totalLines : undefined
				const content = await extractTextFromFile(fullPath)

				// forked_change start: limit output size based on token count
				const blockResult = await blockFileReadWhenTooLarge(cline, relPath, content)
				if (blockResult) {
					updateFileResult(fileResult, blockResult)
					continue
				}
				// forked_change end

				// kilocode_change: Return raw content without path header
				let fileOutput = totalLines > 0 ? content : `(empty file: ${relPath})`

				// Track file read
				await cline.fileContextTracker.trackFileContext(relPath, "read_tool" as RecordSource)

				updateFileResult(fileResult, {
					xmlContent: fileOutput,
				})
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error)
				updateFileResult(fileResult, {
					status: "error",
					error: `Error reading file: ${errorMsg}`,
					xmlContent: `--- ${relPath} ---\n[error] ${errorMsg}`,
				})
				await handleError(`reading file ${relPath}`, error instanceof Error ? error : new Error(errorMsg))
			}
		}

		// forked_change: prepend overlap notices to served content so the model
		// is aware it is partially re-reading a region.
		for (const result of fileResults) {
			if (result.overlapNotice && result.xmlContent && !result.wasRepeated) {
				result.xmlContent = `${result.overlapNotice}\n${result.xmlContent}`
			}
		}

		// forked_change start: record regions that were actually served so repeated
		// reads of the same unchanged region can be short-circuited next time.
		// Only successful reads count — denials and errors must stay retryable.
		for (const result of fileResults) {
			if (
				result.status === "approved" &&
				result.xmlContent &&
				!result.error &&
				!result.wasRepeated &&
				result.mtimeMs !== undefined
			) {
				const fullPath = path.isAbsolute(result.path) ? result.path : path.resolve(cline.cwd, result.path)
				cline.readRegionHistory.set(readRegionKey(fullPath, result.offset, result.limit), result.mtimeMs)
			}
		}

		// forked_change end

		// Generate final result from all file results
		const fileContents = fileResults
			.filter((result) => result.xmlContent)
			.map((result) => {
				const content = result.xmlContent as string
				if (fileResults.length === 1 || content.startsWith("--- ")) return content

				const range =
					result.startLine !== undefined && result.endLine !== undefined && result.totalLines !== undefined
						? ` (lines ${result.startLine}-${result.endLine} of ${result.totalLines})`
						: ""
				return `--- ${result.path}${range} ---\n${content}`
			})
		const filesOutput = fileContents.join("\n\n")

		// Collect all image data URLs from file results
		const fileImageUrls = fileResults
			.filter((result) => result.imageDataUrl)
			.map((result) => result.imageDataUrl as string)

		// Process all feedback in a unified way without branching
		let statusMessage = ""
		let feedbackImages: any[] = []

		// Handle denial with feedback (highest priority)
		const deniedWithFeedback = fileResults.find((result) => result.status === "denied" && result.feedbackText)

		if (deniedWithFeedback && deniedWithFeedback.feedbackText) {
			statusMessage = formatResponse.toolDeniedWithFeedback(deniedWithFeedback.feedbackText)
			feedbackImages = deniedWithFeedback.feedbackImages || []
		}
		// Handle generic denial
		else if (cline.didRejectTool) {
			statusMessage = formatResponse.toolDenied()
		}
		// Handle approval with feedback
		else {
			const approvedWithFeedback = fileResults.find(
				(result) => result.status === "approved" && result.feedbackText,
			)

			if (approvedWithFeedback && approvedWithFeedback.feedbackText) {
				statusMessage = formatResponse.toolApprovedWithFeedback(approvedWithFeedback.feedbackText)
				feedbackImages = approvedWithFeedback.feedbackImages || []
			}
		}

		// Combine all images: feedback images first, then file images
		const allImages = [...feedbackImages, ...fileImageUrls]

		// Re-check if the model supports images before including them, in case it changed during execution.
		const finalModelSupportsImages = cline.api.getModel().info.supportsImages ?? false
		const imagesToInclude = finalModelSupportsImages ? allImages : []

		// Push the result with appropriate formatting
		if (statusMessage || imagesToInclude.length > 0) {
			// Always use formatResponse.toolResult when we have a status message or images
			const result = formatResponse.toolResult(
				statusMessage || filesOutput,
				imagesToInclude.length > 0 ? imagesToInclude : undefined,
			)

			// Handle different return types from toolResult
			if (typeof result === "string") {
				if (statusMessage) {
					pushToolResult(`${result}\n${filesOutput}`)
				} else {
					pushToolResult(result)
				}
			} else {
				// For block-based results, append the files content as a text block if not already included
				if (statusMessage) {
					const textBlock = { type: "text" as const, text: filesOutput }
					pushToolResult([...result, textBlock])
				} else {
					pushToolResult(result)
				}
			}
		} else {
			// No images or status message, just push the file contents
			pushToolResult(filesOutput)
		}
	} catch (error) {
		// Handle all errors using per-file format for consistency
		const relPath = fileEntries[0]?.path || "unknown"
		const errorMsg = error instanceof Error ? error.message : String(error)

		// If we have file results, update the first one with the error
		if (fileResults.length > 0) {
			updateFileResult(fileResults[0], {
				status: "error",
				error: `Error reading file: ${errorMsg}`,
				xmlContent: `--- ${relPath} ---\n[error] ${errorMsg}`,
			})
		}

		await handleError(`reading file ${relPath}`, error instanceof Error ? error : new Error(errorMsg))

		// Generate final result from all file results
		const fileContents = fileResults.filter((result) => result.xmlContent).map((result) => result.xmlContent)

		pushToolResult(fileContents.join("\n\n"))
	}
}
