import axios from 'axios';
import { NextResponse } from 'next/server';

/**
 * /api/compatible/v1/messages - 兼容性 API 端点
 *
 * 功能说明：
 * 这是一个与 /v1/messages 功能完全相同的兼容端点
 *
 * 为什么需要这个端点？
 * 1. 某些客户端库默认使用 /api/* 路径格式
 * 2. 提供多种 URL 格式选择，增强兼容性
 * 3. 方便不同团队/项目使用不同的路径约定
 *
 * 功能特性：
 * 1. 支持流式响应（SSE）
 * 2. 支持重试机制（指数退避）
 * 3. 支持 Beta 功能（context-management）
 * 4. 自动调整 thinking 参数
 */

// 重试配置
const MAX_RETRIES = 3;
const BASE_DELAY = 1000; // 1 秒
const MAX_DELAY = 60000; // 60 秒

// 可重试的 400 错误模式
const RETRYABLE_400_PATTERNS = [
	'neptune alias',
	'bug bounty program',
	'red teaming'
];

/**
 * 延迟函数
 */
function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 计算重试延迟时间（指数退避 + 随机抖动）
 */
function calculateRetryDelay(attempt: number): number {
	const exponentialDelay = Math.min(BASE_DELAY * Math.pow(2, attempt), MAX_DELAY);
	const jitter = exponentialDelay * 0.2 * (2 * Math.random() - 1);
	return exponentialDelay + jitter;
}

/**
 * 判断错误是否可重试
 */
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
 * 验证和调整 thinking 参数
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function adjustThinkingParams(body: any): any {
	if (body.thinking && typeof body.thinking === 'object') {
		const maxTokens = body.max_tokens;
		const budgetTokens = body.thinking.budget_tokens;

		if (maxTokens && budgetTokens && budgetTokens > maxTokens) {
			const newMaxTokens = 64000;
			console.log(`[/api/compatible/v1/messages] 检测到 budget_tokens (${budgetTokens}) > max_tokens (${maxTokens})，自动调整 max_tokens 为 ${newMaxTokens}`);
			return {
				...body,
				max_tokens: newMaxTokens
			};
		}
	}

	return body;
}

export async function POST(req: Request) {
	try {
		// 1. 解析请求体
		let body = await req.json();

		console.log('[/api/compatible/v1/messages] ========== 请求开始 ==========');
		console.log('[/api/compatible/v1/messages] 完整入参:', JSON.stringify(body, null, 2));

		// 2. 验证必需字段
		if (!body.model || !body.messages) {
			console.error('[/api/compatible/v1/messages] 验证失败: 缺少必需字段');
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

		// 3. 优先使用环境变量中的 model
		const envModel = process.env.ANTHROPIC_MODEL;
		if (envModel) {
			console.log(`[/api/compatible/v1/messages] 使用环境变量 model: ${envModel} (原始 model: ${body.model})`);
			body.model = envModel;
		}

		// 4. 调整 thinking 参数
		body = adjustThinkingParams(body);

		// 6. 配置 Anthropic API 请求
		const baseURL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com';
		const apiUrl = `${baseURL}/v1/messages`;

		console.log('[/api/compatible/v1/messages] API URL:', apiUrl);

		// 7. 准备请求头
		const requestHeaders: Record<string, string> = {
			'Content-Type': 'application/json',
			'anthropic-version': req.headers.get('anthropic-version') || '2023-06-01',
		};

		// 添加 beta 头（如果有）
		const betaHeader = req.headers.get('anthropic-beta');
		if (betaHeader) {
			requestHeaders['anthropic-beta'] = betaHeader;
			console.log('[/api/compatible/v1/messages] 使用 Beta 功能:', betaHeader);
		}

		// 8. 检查是否需要流式响应
		const isStreaming = body.stream === true;
		console.log('[/api/compatible/v1/messages] 响应模式:', isStreaming ? '流式' : '标准');

		if (isStreaming) {
			return handleStreamingRequest(body, apiUrl, requestHeaders);
		} else {
			return handleNonStreamingRequest(body, apiUrl, requestHeaders);
		}

	} catch (error: unknown) {
		const err = error as Error;
		console.error('[/api/compatible/v1/messages] ========== 错误发生 ==========');
		console.error('[/api/compatible/v1/messages] 错误类型:', err.constructor?.name);
		console.error('[/api/compatible/v1/messages] 错误信息:', err.message);
		console.error('[/api/compatible/v1/messages] 错误堆栈:', err.stack);
		console.error('[/api/compatible/v1/messages] ========== 错误结束 ==========');

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
 * 处理非流式请求（带重试机制）
 */
async function handleNonStreamingRequest(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	body: any,
	apiUrl: string,
	headers: Record<string, string>
): Promise<NextResponse> {
	console.log('[/api/compatible/v1/messages] 使用标准响应模式');

	// 构建请求配置
	const requestConfig = {
		model: body.model,
		messages: body.messages,
		max_tokens: body.max_tokens || 4096,
		...(body.temperature !== undefined && { temperature: body.temperature }),
		...(body.top_p !== undefined && { top_p: body.top_p }),
		...(body.top_k !== undefined && { top_k: body.top_k }),
		...(body.system !== undefined && { system: body.system }),
		...(body.stop_sequences !== undefined && { stop_sequences: body.stop_sequences }),
		...(body.metadata !== undefined && { metadata: body.metadata }),
		...(body.thinking !== undefined && { thinking: body.thinking }),
		...(body.tools !== undefined && { tools: body.tools }),
		...(body.tool_choice !== undefined && { tool_choice: body.tool_choice }),
	};

	console.log('[/api/compatible/v1/messages] 发送到 Anthropic API 的请求配置:', JSON.stringify(requestConfig, null, 2));

	// 重试逻辑
	let lastError: unknown = null;
	const startTime = Date.now();

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await axios.post(apiUrl, requestConfig, {
				headers: {
					...headers,
					'x-api-key': process.env.API_KEY,
				},
				timeout: 600000, // 10 分钟超时
			});

			const duration = Date.now() - startTime;
			console.log('[/api/compatible/v1/messages] 请求成功, 状态码:', response.status);
			console.log('[/api/compatible/v1/messages] 耗时:', duration, 'ms');
			console.log('[/api/compatible/v1/messages] 响应头:', JSON.stringify(response.headers, null, 2));
			console.log('[/api/compatible/v1/messages] 完整出参:', JSON.stringify(response.data, null, 2));
			console.log('[/api/compatible/v1/messages] ========== 请求结束 ==========');

			return NextResponse.json(response.data);

		} catch (error: unknown) {
			lastError = error;

			// 判断是否可重试
			if (!isRetryableError(error)) {
				console.error('[/api/compatible/v1/messages] 不可重试的错误，直接返回');
				break;
			}

			// 如果还有重试次数
			if (attempt < MAX_RETRIES) {
				const retryDelay = calculateRetryDelay(attempt);
				const err = error as Error;
				console.warn(`[/api/compatible/v1/messages] 第 ${attempt + 1} 次重试失败: ${err.message}, ${retryDelay.toFixed(0)}ms 后重试`);
				await delay(retryDelay);
			} else {
				console.error(`[/api/compatible/v1/messages] 重试 ${MAX_RETRIES} 次后仍失败`);
			}
		}
	}

	// 所有重试都失败，返回错误
	if (axios.isAxiosError(lastError) && lastError.response) {
		console.error('[/api/compatible/v1/messages] Axios 错误状态码:', lastError.response.status);
		console.error('[/api/compatible/v1/messages] Axios 错误响应体:', JSON.stringify(lastError.response.data, null, 2));
		console.error('[/api/compatible/v1/messages] ========== 错误结束 ==========');

		return NextResponse.json(
			{
				type: 'error',
				error: {
					message: lastError.response.data?.error?.message || lastError.message,
					type: lastError.response.data?.error?.type || 'api_error',
					status: lastError.response.status,
				},
			},
			{ status: lastError.response.status }
		);
	}

	console.error('[/api/compatible/v1/messages] ========== 错误结束 ==========');

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
 * 处理流式请求（带重试机制）
 */
async function handleStreamingRequest(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	body: any,
	apiUrl: string,
	headers: Record<string, string>
): Promise<Response> {
	console.log('[/api/compatible/v1/messages] 使用流式响应模式');

	// 构建请求配置
	const requestConfig = {
		model: body.model,
		messages: body.messages,
		max_tokens: body.max_tokens || 4096,
		...(body.temperature !== undefined && { temperature: body.temperature }),
		...(body.top_p !== undefined && { top_p: body.top_p }),
		...(body.top_k !== undefined && { top_k: body.top_k }),
		...(body.system !== undefined && { system: body.system }),
		...(body.stop_sequences !== undefined && { stop_sequences: body.stop_sequences }),
		...(body.metadata !== undefined && { metadata: body.metadata }),
		...(body.thinking !== undefined && { thinking: body.thinking }),
		...(body.tools !== undefined && { tools: body.tools }),
		...(body.tool_choice !== undefined && { tool_choice: body.tool_choice }),
		stream: true,
	};

	console.log('[/api/compatible/v1/messages] 发送到 Anthropic API 的请求配置:', JSON.stringify(requestConfig, null, 2));

	// 重试逻辑：尝试建立流式连接
	let lastError: unknown = null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let response: any = null;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			response = await axios.post(apiUrl, requestConfig, {
				headers: {
					...headers,
					'x-api-key': process.env.API_KEY,
				},
				responseType: 'stream',
				timeout: 600000, // 10 分钟超时
			});

			console.log('[/api/compatible/v1/messages] 流式响应已开始，状态码:', response.status);
			console.log('[/api/compatible/v1/messages] 响应头:', JSON.stringify(response.headers, null, 2));
			break; // 成功建立连接，跳出重试循环

		} catch (error: unknown) {
			lastError = error;

			// 判断是否可重试
			if (!isRetryableError(error)) {
				console.error('[/api/compatible/v1/messages] 流式请求不可重试的错误，直接返回');
				throw error;
			}

			// 如果还有重试次数
			if (attempt < MAX_RETRIES) {
				const retryDelay = calculateRetryDelay(attempt);
				const err = error as Error;
				console.warn(`[/api/compatible/v1/messages] 流式请求第 ${attempt + 1} 次重试失败: ${err.message}, ${retryDelay.toFixed(0)}ms 后重试`);
				await delay(retryDelay);
			} else {
				console.error(`[/api/compatible/v1/messages] 流式请求重试 ${MAX_RETRIES} 次后仍失败`);
				throw lastError;
			}
		}
	}

	// 如果没有成功建立连接
	if (!response) {
		throw lastError || new Error('Failed to establish streaming connection');
	}

	// 流式数据统计（避免收集所有数据）
	const isDebugMode = process.env.LOG_LEVEL === 'debug';
	let chunkCount = 0;
	let byteCount = 0;

	// 创建可读流
	const readable = new ReadableStream({
		async start(controller) {
			let clientDisconnected = false;

			try {
				response.data.on('data', (chunk: Buffer) => {
					if (clientDisconnected) {
						return;
					}

					try {
						chunkCount++;
						byteCount += chunk.length;

						if (isDebugMode) {
							console.log('[/api/compatible/v1/messages] 流式数据块 #', chunkCount, ':', chunk.toString());
						} else {
							if (chunkCount % 10 === 0) {
								console.log(`[/api/compatible/v1/messages] 已传输 ${chunkCount} 个数据块, ${byteCount} 字节`);
							}
						}

						controller.enqueue(chunk);
					} catch (error) {
						console.error('[/api/compatible/v1/messages] 处理数据块错误:', error);
						clientDisconnected = true;
					}
				});

				response.data.on('end', () => {
					if (!clientDisconnected) {
						console.log('[/api/compatible/v1/messages] 流式响应完成');
						console.log(`[/api/compatible/v1/messages] 总计传输: ${chunkCount} 个数据块, ${byteCount} 字节`);
						console.log('[/api/compatible/v1/messages] ========== 请求结束 ==========');
						controller.close();
					}
				});

				response.data.on('error', (error: Error) => {
					if (error.message.includes('aborted') || (error as NodeJS.ErrnoException).code === 'ECONNRESET') {
						console.warn('[/api/compatible/v1/messages] 客户端断开连接（正常）');
						clientDisconnected = true;
					} else {
						console.error('[/api/compatible/v1/messages] 流式响应错误:', error);
					}
					console.log('[/api/compatible/v1/messages] ========== 请求结束 ==========');

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
						console.log('[/api/compatible/v1/messages] 连接关闭');
						clientDisconnected = true;
					}
				});

			} catch (error) {
				console.error('[/api/compatible/v1/messages] 流式响应初始化错误:', error);
				console.error('[/api/compatible/v1/messages] ========== 错误结束 ==========');
				try {
					controller.error(error);
				} catch (e) {
					// 控制器已关闭，忽略错误
				}
			}
		},
		cancel() {
			console.log('[/api/compatible/v1/messages] 客户端取消流式传输');
			try {
				response.data.destroy();
			} catch (e) {
				// 忽略销毁错误
			}
		}
	});

	// 返回流式响应
	return new Response(readable, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
			'X-Accel-Buffering': 'no',
		},
	});
}
