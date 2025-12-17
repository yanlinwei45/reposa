/**
 * Anthropic ↔ OpenAI 格式转换工具
 *
 * 支持将 Anthropic Messages API 格式转换为 OpenAI Chat Completions 格式
 * 以及将 OpenAI 响应转换回 Anthropic 格式
 */

// ============== 类型定义 ==============

export interface AnthropicMessage {
	role: 'user' | 'assistant';
	content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
	type: 'text' | 'image' | 'tool_use' | 'tool_result';
	text?: string;
	source?: unknown;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	tool_use_id?: string;
	content?: string | unknown[] | Record<string, unknown>;
}

export interface AnthropicTool {
	name: string;
	description?: string;
	input_schema: Record<string, unknown>;
}

export interface AnthropicRequest {
	model: string;
	messages: AnthropicMessage[];
	max_tokens: number;
	system?: string | Array<{ type: string; text: string }>;
	temperature?: number;
	top_p?: number;
	top_k?: number;
	stop_sequences?: string[];
	stream?: boolean;
	tools?: AnthropicTool[];
	tool_choice?: { type: string; name?: string };
	metadata?: Record<string, unknown>;
	thinking?: { enabled?: boolean; budget_tokens?: number };
}

export interface OpenAIMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | OpenAIContentPart[];
	name?: string;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
}

export interface OpenAIContentPart {
	type: 'text' | 'image_url';
	text?: string;
	image_url?: { url: string };
}

export interface OpenAIToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

export interface OpenAITool {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export interface OpenAIRequest {
	model: string;
	messages: OpenAIMessage[];
	max_tokens?: number;
	temperature?: number;
	top_p?: number;
	stop?: string[];
	stream?: boolean;
	tools?: OpenAITool[];
	tool_choice?: string | { type: string; function?: { name: string } };
}

// ============== Anthropic → OpenAI 转换 ==============

/**
 * 将 Anthropic 请求转换为 OpenAI 格式
 */
export function convertAnthropicToOpenAI(anthropicReq: AnthropicRequest): OpenAIRequest {
	const messages: OpenAIMessage[] = [];

	// 1. 转换系统消息
	if (anthropicReq.system) {
		if (typeof anthropicReq.system === 'string') {
			messages.push({
				role: 'system',
				content: anthropicReq.system
			});
		} else if (Array.isArray(anthropicReq.system)) {
			const systemText = anthropicReq.system
				.filter(block => block.type === 'text')
				.map(block => block.text)
				.join('\n\n')
				.trim();

			if (systemText) {
				messages.push({
					role: 'system',
					content: systemText
				});
			}
		}
	}

	// 2. 转换对话消息
	for (const msg of anthropicReq.messages) {
		if (typeof msg.content === 'string') {
			// 简单文本消息
			messages.push({
				role: msg.role,
				content: msg.content
			});
		} else if (Array.isArray(msg.content)) {
			// 复杂内容块
			const hasToolResult = msg.content.some(
				block => block.type === 'tool_result'
			);

			if (msg.role === 'user' && hasToolResult) {
				// 特殊处理：包含工具结果的用户消息
				let textContent = '';

				for (const block of msg.content) {
					if (block.type === 'text' && block.text) {
						textContent += block.text + '\n';
					} else if (block.type === 'tool_result') {
						const toolId = block.tool_use_id || 'unknown';
						const result = extractToolResultContent(block.content);
						textContent += `Tool result for ${toolId}:\n${result}\n`;
					}
				}

				messages.push({
					role: 'user',
					content: textContent.trim()
				});
			} else if (msg.role === 'assistant') {
				// 助手消息可能包含 tool_use
				let textContent = '';
				const toolCalls: OpenAIToolCall[] = [];

				for (const block of msg.content) {
					if (block.type === 'text' && block.text) {
						textContent += block.text;
					} else if (block.type === 'tool_use') {
						toolCalls.push({
							id: block.id || `call_${Date.now()}`,
							type: 'function',
							function: {
								name: block.name || '',
								arguments: JSON.stringify(block.input || {})
							}
						});
					}
				}

				if (toolCalls.length > 0) {
					messages.push({
						role: 'assistant',
						content: textContent || null as unknown as string,
						tool_calls: toolCalls
					});
				} else {
					messages.push({
						role: 'assistant',
						content: textContent
					});
				}
			} else {
				// 其他情况：提取文本内容
				const textContent = msg.content
					.filter(block => block.type === 'text' && block.text)
					.map(block => block.text)
					.join('\n');

				messages.push({
					role: msg.role,
					content: textContent || ''
				});
			}
		}
	}

	// 3. 构建 OpenAI 请求
	const openaiReq: OpenAIRequest = {
		model: mapAnthropicModelToOpenAI(anthropicReq.model),
		messages,
		max_tokens: anthropicReq.max_tokens,
		stream: anthropicReq.stream || false
	};

	// 4. 添加可选参数
	if (anthropicReq.temperature !== undefined) {
		openaiReq.temperature = anthropicReq.temperature;
	}

	if (anthropicReq.top_p !== undefined) {
		openaiReq.top_p = anthropicReq.top_p;
	}

	if (anthropicReq.stop_sequences) {
		openaiReq.stop = anthropicReq.stop_sequences;
	}

	// 5. 转换工具定义
	if (anthropicReq.tools && anthropicReq.tools.length > 0) {
		openaiReq.tools = anthropicReq.tools.map(tool => ({
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description || '',
				parameters: tool.input_schema
			}
		}));
	}

	// 6. 转换工具选择
	if (anthropicReq.tool_choice) {
		const choice = anthropicReq.tool_choice;
		if (choice.type === 'auto') {
			openaiReq.tool_choice = 'auto';
		} else if (choice.type === 'any') {
			openaiReq.tool_choice = 'required';
		} else if (choice.type === 'tool' && choice.name) {
			openaiReq.tool_choice = {
				type: 'function',
				function: { name: choice.name }
			};
		}
	}

	return openaiReq;
}

/**
 * 提取工具结果内容
 */
function extractToolResultContent(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}

	if (Array.isArray(content)) {
		return content.map(item => {
			if (typeof item === 'object' && item !== null && 'text' in item) {
				return (item as { text: string }).text;
			}
			return JSON.stringify(item);
		}).join('\n');
	}

	if (typeof content === 'object' && content !== null) {
		if ('text' in content) {
			return (content as { text: string }).text;
		}
		return JSON.stringify(content);
	}

	return String(content);
}

/**
 * 映射 Anthropic 模型名到对应的提供商模型
 */
function mapAnthropicModelToOpenAI(model: string): string {
	// 如果已经是其他提供商的模型名，直接返回
	if (model.startsWith('gpt-') || model.startsWith('o1-')) {
		return model; // OpenAI 模型
	}
	if (model.startsWith('grok-')) {
		return model; // XAI 模型
	}

	// Anthropic 模型保持原样（会通过 OpenAI 兼容的端点调用）
	return model;
}

// ============== OpenAI → Anthropic 转换 ==============

export interface OpenAIResponse {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: Array<{
		index: number;
		message: {
			role: string;
			content: string | null;
			tool_calls?: OpenAIToolCall[];
		};
		finish_reason: string | null;
	}>;
	usage: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

export interface AnthropicResponse {
	id: string;
	type: 'message';
	role: 'assistant';
	content: Array<{
		type: 'text' | 'tool_use';
		text?: string;
		id?: string;
		name?: string;
		input?: Record<string, unknown>;
	}>;
	model: string;
	stop_reason: string | null;
	stop_sequence: string | null;
	usage: {
		input_tokens: number;
		output_tokens: number;
	};
}

/**
 * 将 OpenAI 响应转换为 Anthropic 格式
 */
export function convertOpenAIToAnthropic(openaiResp: OpenAIResponse): AnthropicResponse {
	const choice = openaiResp.choices[0];
	const message = choice.message;

	const content: AnthropicResponse['content'] = [];

	// 添加文本内容
	if (message.content) {
		content.push({
			type: 'text',
			text: message.content
		});
	}

	// 添加工具调用
	if (message.tool_calls && message.tool_calls.length > 0) {
		for (const toolCall of message.tool_calls) {
			content.push({
				type: 'tool_use',
				id: toolCall.id,
				name: toolCall.function.name,
				input: JSON.parse(toolCall.function.arguments || '{}')
			});
		}
	}

	// 映射 finish_reason
	let stopReason: string | null = null;
	if (choice.finish_reason === 'stop') {
		stopReason = 'end_turn';
	} else if (choice.finish_reason === 'length') {
		stopReason = 'max_tokens';
	} else if (choice.finish_reason === 'tool_calls') {
		stopReason = 'tool_use';
	}

	return {
		id: openaiResp.id,
		type: 'message',
		role: 'assistant',
		content,
		model: openaiResp.model,
		stop_reason: stopReason,
		stop_sequence: null,
		usage: {
			input_tokens: openaiResp.usage.prompt_tokens,
			output_tokens: openaiResp.usage.completion_tokens
		}
	};
}

/**
 * 转换流式响应的数据块
 */
export function convertOpenAIStreamToAnthropic(chunk: string): string {
	// OpenAI 流式格式: data: {"choices":[{"delta":{"content":"text"},...}],...}
	// Anthropic 流式格式: event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"text"},...}

	if (!chunk.startsWith('data: ')) {
		return chunk;
	}

	const dataStr = chunk.slice(6).trim();

	if (dataStr === '[DONE]') {
		return 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
	}

	try {
		const data = JSON.parse(dataStr);
		const delta = data.choices?.[0]?.delta;

		if (!delta) {
			return '';
		}

		// 如果有 content，转换为 content_block_delta
		if (delta.content) {
			const anthropicChunk = {
				type: 'content_block_delta',
				index: 0,
				delta: {
					type: 'text_delta',
					text: delta.content
				}
			};
			return `event: content_block_delta\ndata: ${JSON.stringify(anthropicChunk)}\n\n`;
		}

		// 如果是开始，返回 message_start
		if (delta.role) {
			return 'event: message_start\ndata: {"type":"message_start"}\n\n';
		}

		return '';
	} catch (e) {
		console.error('解析流式数据失败:', e);
		return '';
	}
}
