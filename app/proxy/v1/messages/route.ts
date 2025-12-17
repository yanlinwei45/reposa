import axios from 'axios';
import { NextResponse } from 'next/server';
import {
	convertAnthropicToOpenAI,
	convertOpenAIToAnthropic,
	convertOpenAIStreamToAnthropic,
	type AnthropicRequest
} from '@/lib/format-converter';

/**
 * /proxy/v1/messages - Anthropic 格式代理端点（支持多提供商）
 *
 * 功能说明：
 * 1. 接收 Anthropic Messages API 格式的请求
 * 2. 转换为 OpenAI Chat Completions 格式
 * 3. 调用配置的模型提供商（OpenAI、Anthropic、XAI 等）
 * 4. 将响应转换回 Anthropic 格式
 * 5. 支持流式和非流式响应
 * 6. 支持工具调用（Function Calling）
 *
 * 支持的模型提供商：
 * - OpenAI (gpt-4, gpt-3.5-turbo, etc.)
 * - Anthropic (claude-3-*, claude-sonnet-*, etc.) 通过兼容端点
 * - XAI (grok-*)
 * - 其他 OpenAI 兼容的 API
 *
 * 环境变量配置：
 * - OPENAI_API_KEY: OpenAI API Key
 * - OPENAI_BASE_URL: OpenAI API 基础 URL（可选，默认 https://api.openai.com/v1）
 * - XAI_API_KEY: XAI API Key（可选）
 * - XAI_BASE_URL: XAI API 基础 URL（可选）
 */

// 重试配置
const MAX_RETRIES = 3;
const BASE_DELAY = 1000;
const MAX_DELAY = 60000;

const RETRYABLE_400_PATTERNS = [
	'neptune alias',
	'bug bounty program',
	'red teaming'
];

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function calculateRetryDelay(attempt: number): number {
	const exponentialDelay = Math.min(BASE_DELAY * Math.pow(2, attempt), MAX_DELAY);
	const jitter = exponentialDelay * 0.2 * (2 * Math.random() - 1);
	return exponentialDelay + jitter;
}

function isRetryableError(error: unknown): boolean {
	if (axios.isAxiosError(error)) {
		const status = error.response?.status;

		if (status === 429 || (status && status >= 500)) {
			return true;
		}

		if (status === 400) {
			const errorMessage = JSON.stringify(error.response?.data || '').toLowerCase();
			return RETRYABLE_400_PATTERNS.some(pattern => errorMessage.includes(pattern));
		}
	}

	return false;
}

/**
 * 根据模型名称获取 API 配置
 */
function getProviderConfig(model: string): { baseURL: string; apiKey: string; provider: string } {
	// OpenAI 模型
	if (model.startsWith('gpt-') || model.startsWith('o1-')) {
		return {
			baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
			apiKey: process.env.OPENAI_API_KEY || '',
			provider: 'openai'
		};
	}

	// XAI (Grok) 模型
	if (model.startsWith('grok-')) {
		return {
			baseURL: process.env.XAI_BASE_URL || 'https://api.x.ai/v1',
			apiKey: process.env.XAI_API_KEY || '',
			provider: 'xai'
		};
	}

	// Anthropic 模型 - 通过 OpenAI 兼容端点
	if (model.startsWith('claude-')) {
		// 如果有 Anthropic API Key，使用官方端点
		if (process.env.ANTHROPIC_API_KEY) {
			return {
				baseURL: process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1',
				apiKey: process.env.ANTHROPIC_API_KEY,
				provider: 'anthropic'
			};
		}
	}

	// 默认使用 OpenAI
	return {
		baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
		apiKey: process.env.OPENAI_API_KEY || '',
		provider: 'openai'
	};
}

export async function POST(req: Request) {
	try {
		// 1. 解析 Anthropic 格式的请求
		const anthropicReq = await req.json() as AnthropicRequest;

		console.log('[/proxy/v1/messages] ========== 请求开始 ==========');
		console.log('[/proxy/v1/messages] 原始 Anthropic 格式:', JSON.stringify(anthropicReq, null, 2));

		// 2. 验证必需字段
		if (!anthropicReq.model || !anthropicReq.messages) {
			console.error('[/proxy/v1/messages] 验证失败: 缺少必需字段');
			return NextResponse.json(
				{
					type: 'error',
					error: {
						type: 'invalid_request_error',
						message: 'Missing required fields: model and messages are required'
					}
				},
				{ status: 400 }
			);
		}

		// 3. 转换为 OpenAI 格式
		const openaiReq = convertAnthropicToOpenAI(anthropicReq);
		console.log('[/proxy/v1/messages] 转换后的 OpenAI 格式:', JSON.stringify(openaiReq, null, 2));

		// 4. 获取提供商配置
		const config = getProviderConfig(anthropicReq.model);
		console.log('[/proxy/v1/messages] 使用提供商:', config.provider);
		console.log('[/proxy/v1/messages] API 基础 URL:', config.baseURL);

		if (!config.apiKey) {
			console.error('[/proxy/v1/messages] 错误: API Key 未配置');
			return NextResponse.json(
				{
					type: 'error',
					error: {
						type: 'api_error',
						message: `${config.provider.toUpperCase()}_API_KEY not configured`
					}
				},
				{ status: 500 }
			);
		}

		// 5. 准备请求头
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${config.apiKey}`
		};

		// 6. 检查是否流式响应
		const isStreaming = anthropicReq.stream === true;
		console.log('[/proxy/v1/messages] 响应模式:', isStreaming ? '流式' : '标准');

		if (isStreaming) {
			return handleStreamingRequest(openaiReq, config.baseURL, headers);
		} else {
			return handleNonStreamingRequest(openaiReq, config.baseURL, headers, anthropicReq.model);
		}

	} catch (error: unknown) {
		const err = error as Error;
		console.error('[/proxy/v1/messages] ========== 错误发生 ==========');
		console.error('[/proxy/v1/messages] 错误类型:', err.constructor?.name);
		console.error('[/proxy/v1/messages] 错误信息:', err.message);
		console.error('[/proxy/v1/messages] 错误堆栈:', err.stack);
		console.error('[/proxy/v1/messages] ========== 错误结束 ==========');

		return NextResponse.json(
			{
				type: 'error',
				error: {
					type: 'api_error',
					message: err.message || 'Internal server error',
				},
			},
			{ status: 500 }
		);
	}
}

/**
 * 处理非流式请求
 */
async function handleNonStreamingRequest(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	openaiReq: any,
	baseURL: string,
	headers: Record<string, string>,
	originalModel: string
): Promise<NextResponse> {
	console.log('[/proxy/v1/messages] 使用标准响应模式');

	const apiUrl = `${baseURL}/chat/completions`;
	let lastError: unknown = null;
	const startTime = Date.now();

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await axios.post(apiUrl, openaiReq, {
				headers,
				timeout: 600000,
			});

			const duration = Date.now() - startTime;
			console.log('[/proxy/v1/messages] OpenAI 响应成功, 状态码:', response.status);
			console.log('[/proxy/v1/messages] 耗时:', duration, 'ms');
			console.log('[/proxy/v1/messages] OpenAI 原始响应:', JSON.stringify(response.data, null, 2));

			// 转换回 Anthropic 格式
			const anthropicResp = convertOpenAIToAnthropic(response.data);

			// 保持原始模型名称
			anthropicResp.model = originalModel;

			console.log('[/proxy/v1/messages] 转换后的 Anthropic 响应:', JSON.stringify(anthropicResp, null, 2));
			console.log('[/proxy/v1/messages] ========== 请求结束 ==========');

			return NextResponse.json(anthropicResp);

		} catch (error: unknown) {
			lastError = error;

			if (!isRetryableError(error)) {
				console.error('[/proxy/v1/messages] 不可重试的错误，直接返回');
				break;
			}

			if (attempt < MAX_RETRIES) {
				const retryDelay = calculateRetryDelay(attempt);
				const err = error as Error;
				console.warn(`[/proxy/v1/messages] 第 ${attempt + 1} 次重试失败: ${err.message}, ${retryDelay.toFixed(0)}ms 后重试`);
				await delay(retryDelay);
			} else {
				console.error(`[/proxy/v1/messages] 重试 ${MAX_RETRIES} 次后仍失败`);
			}
		}
	}

	// 处理错误
	if (axios.isAxiosError(lastError) && lastError.response) {
		console.error('[/proxy/v1/messages] API 错误状态码:', lastError.response.status);
		console.error('[/proxy/v1/messages] API 错误响应体:', JSON.stringify(lastError.response.data, null, 2));
		console.error('[/proxy/v1/messages] ========== 错误结束 ==========');

		return NextResponse.json(
			{
				type: 'error',
				error: {
					message: lastError.response.data?.error?.message || lastError.message,
					type: 'api_error',
				},
			},
			{ status: lastError.response.status }
		);
	}

	console.error('[/proxy/v1/messages] ========== 错误结束 ==========');
	const err = lastError as Error;
	return NextResponse.json(
		{
			type: 'error',
			error: {
				type: 'api_error',
				message: err?.message || 'Request failed after retries',
			},
		},
		{ status: 500 }
	);
}

/**
 * 处理流式请求
 */
async function handleStreamingRequest(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	openaiReq: any,
	baseURL: string,
	headers: Record<string, string>
): Promise<Response> {
	console.log('[/proxy/v1/messages] 使用流式响应模式');

	const apiUrl = `${baseURL}/chat/completions`;
	let lastError: unknown = null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let response: any = null;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			response = await axios.post(apiUrl, openaiReq, {
				headers,
				responseType: 'stream',
				timeout: 600000,
			});

			console.log('[/proxy/v1/messages] 流式响应已开始，状态码:', response.status);
			break;

		} catch (error: unknown) {
			lastError = error;

			if (!isRetryableError(error)) {
				console.error('[/proxy/v1/messages] 流式请求不可重试的错误');
				throw error;
			}

			if (attempt < MAX_RETRIES) {
				const retryDelay = calculateRetryDelay(attempt);
				const err = error as Error;
				console.warn(`[/proxy/v1/messages] 流式请求第 ${attempt + 1} 次重试失败: ${err.message}, ${retryDelay.toFixed(0)}ms 后重试`);
				await delay(retryDelay);
			} else {
				console.error(`[/proxy/v1/messages] 流式请求重试 ${MAX_RETRIES} 次后仍失败`);
				throw lastError;
			}
		}
	}

	if (!response) {
		throw lastError || new Error('Failed to establish streaming connection');
	}

	// 流式数据统计
	const isDebugMode = process.env.LOG_LEVEL === 'debug';
	let chunkCount = 0;
	let byteCount = 0;

	// 创建转换流
	const readable = new ReadableStream({
		async start(controller) {
			let clientDisconnected = false;

			try {
				response.data.on('data', (chunk: Buffer) => {
					if (clientDisconnected) {
						return;
					}

					try {
						const chunkStr = chunk.toString();
						chunkCount++;
						byteCount += chunk.length;

						if (isDebugMode) {
							console.log('[/proxy/v1/messages] OpenAI 流式数据块 #', chunkCount, ':', chunkStr);
						} else {
							if (chunkCount % 10 === 0) {
								console.log(`[/proxy/v1/messages] 已传输 ${chunkCount} 个数据块, ${byteCount} 字节`);
							}
						}

						// 转换为 Anthropic 格式
						const lines = chunkStr.split('\n');
						for (const line of lines) {
							if (line.trim()) {
								const anthropicChunk = convertOpenAIStreamToAnthropic(line);
								if (anthropicChunk) {
									if (isDebugMode) {
										console.log('[/proxy/v1/messages] Anthropic 流式数据块:', anthropicChunk);
									}
									controller.enqueue(new TextEncoder().encode(anthropicChunk));
								}
							}
						}
					} catch (error) {
						console.error('[/proxy/v1/messages] 处理数据块错误:', error);
						clientDisconnected = true;
					}
				});

				response.data.on('end', () => {
					if (!clientDisconnected) {
						console.log('[/proxy/v1/messages] 流式响应完成');
						console.log(`[/proxy/v1/messages] 总计传输: ${chunkCount} 个数据块, ${byteCount} 字节`);
						console.log('[/proxy/v1/messages] ========== 请求结束 ==========');
						controller.close();
					}
				});

				response.data.on('error', (error: Error) => {
					if (error.message.includes('aborted') || (error as NodeJS.ErrnoException).code === 'ECONNRESET') {
						console.warn('[/proxy/v1/messages] 客户端断开连接（正常）');
						clientDisconnected = true;
					} else {
						console.error('[/proxy/v1/messages] 流式响应错误:', error);
					}
					console.log('[/proxy/v1/messages] ========== 请求结束 ==========');

					try {
						if (!clientDisconnected) {
							controller.error(error);
						} else {
							controller.close();
						}
					} catch (e) {
						// 控制器已关闭，忽略错误
					}
				});

				response.data.on('close', () => {
					if (!clientDisconnected) {
						console.log('[/proxy/v1/messages] 连接关闭');
						clientDisconnected = true;
					}
				});

			} catch (error) {
				console.error('[/proxy/v1/messages] 流式响应初始化错误:', error);
				console.error('[/proxy/v1/messages] ========== 错误结束 ==========');
				try {
					controller.error(error);
				} catch (e) {
					// 控制器已关闭，忽略错误
				}
			}
		},
		cancel() {
			console.log('[/proxy/v1/messages] 客户端取消流式传输');
			try {
				response.data.destroy();
			} catch (e) {
				// 忽略销毁错误
			}
		}
	});

	return new Response(readable, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
			'X-Accel-Buffering': 'no',
		},
	});
}
