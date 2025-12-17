/**
 * Token 计数工具
 *
 * 提供 Anthropic Messages API 的 token 估算功能
 *
 * 注意：这是基于启发式规则的估算，不是精确计数
 * 实际 token 数可能有 ±10-20% 的差异
 */

interface Message {
	role: string;
	content: string | ContentBlock[];
}

interface ContentBlock {
	type: string;
	text?: string;
	source?: unknown;
	name?: string;
	input?: Record<string, unknown>;
	tool_use_id?: string;
	content?: unknown;
	[key: string]: unknown;
}

interface Tool {
	name: string;
	description?: string;
	input_schema: Record<string, unknown>;
}

interface CountTokensRequest {
	model: string;
	messages: Message[];
	system?: string | Array<{ type: string; text?: string }>;
	tools?: Tool[];
}

interface CountTokensResponse {
	input_tokens: number;
}

/**
 * 估算文本的 token 数量
 * 基于启发式规则：
 * - 英文: ~4 字符 = 1 token
 * - 中文/日文/韩文: ~2 字符 = 1 token
 * - 标点和空格: 通常单独计为 token
 */
function estimateTextTokens(text: string): number {
	if (!text) return 0;

	// 检测文本中的 CJK 字符比例
	const cjkRegex = /[\u4e00-\u9fa5\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g;
	const cjkMatches = text.match(cjkRegex);
	const cjkCount = cjkMatches ? cjkMatches.length : 0;
	const totalLength = text.length;
	const cjkRatio = totalLength > 0 ? cjkCount / totalLength : 0;

	// 根据 CJK 字符比例调整估算
	if (cjkRatio > 0.5) {
		// 主要是中文/日文/韩文
		return Math.ceil(totalLength / 2);
	} else {
		// 主要是英文或混合
		// 按单词计数更准确
		const words = text.split(/\s+/).filter(w => w.length > 0);
		const avgTokensPerWord = 1.3; // 英文平均每个单词约 1.3 tokens
		return Math.ceil(words.length * avgTokensPerWord);
	}
}

/**
 * 估算 JSON 对象的 token 数量
 */
function estimateJsonTokens(obj: unknown): number {
	const jsonStr = JSON.stringify(obj);
	// JSON 通常有更多的结构字符（括号、引号等）
	// 使用稍微保守的估算
	return Math.ceil(jsonStr.length / 3.5);
}

/**
 * 估算单个消息的 token 数量
 */
function estimateMessageTokens(message: Message): number {
	let tokens = 3; // 消息结构的固定开销（role 字段等）

	// 添加 role 的 token
	tokens += 1;

	// 处理 content
	if (typeof message.content === 'string') {
		tokens += estimateTextTokens(message.content);
	} else if (Array.isArray(message.content)) {
		for (const block of message.content) {
			// 内容块类型标记
			tokens += 2;

			if (block.type === 'text' && block.text) {
				tokens += estimateTextTokens(block.text);
			} else if (block.type === 'image') {
				// 图片有固定的 token 开销
				tokens += 100; // 估算值
			} else if (block.type === 'tool_use') {
				tokens += 2; // type 和 id
				if (block.name) {
					tokens += 1;
				}
				if (block.input) {
					tokens += estimateJsonTokens(block.input);
				}
			} else if (block.type === 'tool_result') {
				tokens += 2; // type 和 tool_use_id
				if (block.content) {
					if (typeof block.content === 'string') {
						tokens += estimateTextTokens(block.content);
					} else {
						tokens += estimateJsonTokens(block.content);
					}
				}
			}
		}
	}

	return tokens;
}

/**
 * 估算系统提示的 token 数量
 */
function estimateSystemTokens(system: string | Array<{ type: string; text?: string }>): number {
	let tokens = 2; // 系统提示的固定开销

	if (typeof system === 'string') {
		tokens += estimateTextTokens(system);
	} else if (Array.isArray(system)) {
		for (const block of system) {
			tokens += 1; // block 类型
			if (block.text) {
				tokens += estimateTextTokens(block.text);
			}
		}
	}

	return tokens;
}

/**
 * 估算工具定义的 token 数量
 */
function estimateToolsTokens(tools: Tool[]): number {
	let tokens = 2; // 工具数组的固定开销

	for (const tool of tools) {
		tokens += 3; // 工具对象结构
		tokens += 1; // name

		if (tool.description) {
			tokens += estimateTextTokens(tool.description);
		}

		if (tool.input_schema) {
			tokens += estimateJsonTokens(tool.input_schema);
		}
	}

	return tokens;
}

/**
 * 计算请求的总 token 数
 */
export function countTokens(request: CountTokensRequest): CountTokensResponse {
	let totalTokens = 0;

	// 1. 基础开销
	totalTokens += 3; // API 请求的固定开销

	// 2. 系统提示
	if (request.system) {
		totalTokens += estimateSystemTokens(request.system);
	}

	// 3. 消息
	if (request.messages && Array.isArray(request.messages)) {
		for (const message of request.messages) {
			totalTokens += estimateMessageTokens(message);
		}
	}

	// 4. 工具定义
	if (request.tools && request.tools.length > 0) {
		totalTokens += estimateToolsTokens(request.tools);
	}

	// 5. 添加安全边界（估算可能偏低 5-10%）
	const safetyMargin = 1.08;
	totalTokens = Math.ceil(totalTokens * safetyMargin);

	return {
		input_tokens: totalTokens
	};
}

/**
 * 批量计算多个请求的 token 数
 */
export function countTokensBatch(requests: CountTokensRequest[]): CountTokensResponse[] {
	return requests.map(req => countTokens(req));
}
