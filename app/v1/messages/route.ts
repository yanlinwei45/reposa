import axios from 'axios';
import { NextResponse } from 'next/server';

/**
 * /v1/messages - Anthropic Messages API 代理端点
 *
 * 功能说明：
 * 1. 接收客户端的 Anthropic API 请求
 * 2. 转发到真实的 Anthropic API
 * 3. 支持流式响应（SSE - Server-Sent Events）
 * 4. 返回 Anthropic 的响应给客户端
 *
 * 使用场景：
 * - 作为中间代理层，隐藏真实 API Key
 * - 添加请求日志、监控、速率限制等
 * - 统一管理 API 调用
 */
export async function POST(req: Request) {
	try {
		// 1. 解析请求体
		const body = await req.json();

		// 打印完整的入参
		console.log('[/v1/messages] ========== 请求开始 ==========');
		console.log('[/v1/messages] 完整入参:', JSON.stringify(body, null, 2));

		// 2. 验证必需字段
		if (!body.model || !body.messages) {
			console.error('[/v1/messages] 验证失败: 缺少必需字段');
			return NextResponse.json(
				{
					type: 'error',
					error: {
						message: 'Missing required fields: model and messages are required'
					}
				},
				{ status: 400 }
			);
		}

		// 3. 从环境变量获取 API Key
		const apiKey = process.env.ANTHROPIC_API_KEY;
		if (!apiKey) {
			console.error('[/v1/messages] 错误: ANTHROPIC_API_KEY 未配置');
			return NextResponse.json(
				{
					type: 'error',
					error: {
						message: 'Server configuration error: ANTHROPIC_API_KEY not set'
					}
				},
				{ status: 500 }
			);
		}

		// 4. 配置 Anthropic API 请求
		const baseURL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com';
		const apiUrl = `${baseURL}/v1/messages`;

		console.log('[/v1/messages] API URL:', apiUrl);
		console.log('[/v1/messages] API Key (前10位):', apiKey.substring(0, 10) + '...');

		// 5. 检查是否需要流式响应
		const isStreaming = body.stream === true;
		console.log('[/v1/messages] 响应模式:', isStreaming ? '流式' : '标准');

		if (isStreaming) {
			// 流式响应 - 使用 Server-Sent Events (SSE)
			console.log('[/v1/messages] 使用流式响应模式');

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
				stream: true,
			};

			console.log('[/v1/messages] 发送到 Anthropic API 的请求配置:', JSON.stringify(requestConfig, null, 2));

			// 使用 axios 发送流式请求
			const response = await axios.post(apiUrl, requestConfig, {
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': apiKey,
					'anthropic-version': '2023-06-01',
				},
				responseType: 'stream',
			});

			console.log('[/v1/messages] 流式响应已开始，状态码:', response.status);
			console.log('[/v1/messages] 响应头:', JSON.stringify(response.headers, null, 2));

			// 用于收集完整的流式数据（调试用）
			let streamData = '';

			// 创建可读流
			const readable = new ReadableStream({
				async start(controller) {
					try {
						response.data.on('data', (chunk: Buffer) => {
							const chunkStr = chunk.toString();
							streamData += chunkStr;
							console.log('[/v1/messages] 流式数据块:', chunkStr);
							controller.enqueue(chunk);
						});

						response.data.on('end', () => {
							console.log('[/v1/messages] 流式响应完成');
							console.log('[/v1/messages] 完整流式数据:', streamData);
							console.log('[/v1/messages] ========== 请求结束 ==========');
							controller.close();
						});

						response.data.on('error', (error: Error) => {
							console.error('[/v1/messages] 流式响应错误:', error);
							controller.error(error);
						});
					} catch (error) {
						console.error('[/v1/messages] 流式响应错误:', error);
						controller.error(error);
					}
				},
			});

			// 返回流式响应
			return new Response(readable, {
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					'Connection': 'keep-alive',
				},
			});

		} else {
			// 6. 非流式响应 - 一次性返回完整结果
			console.log('[/v1/messages] 使用标准响应模式');

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
			};

			console.log('[/v1/messages] 发送到 Anthropic API 的请求配置:', JSON.stringify(requestConfig, null, 2));

			const response = await axios.post(apiUrl, requestConfig, {
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': apiKey,
					'anthropic-version': '2023-06-01',
				},
			});

			console.log('[/v1/messages] 请求成功, 状态码:', response.status);
			console.log('[/v1/messages] 响应头:', JSON.stringify(response.headers, null, 2));
			console.log('[/v1/messages] 完整出参:', JSON.stringify(response.data, null, 2));
			console.log('[/v1/messages] ========== 请求结束 ==========');

			// 返回 Anthropic 的响应
			return NextResponse.json(response.data);
		}

	} catch (error: any) {
		// 7. 错误处理
		console.error('[/v1/messages] ========== 错误发生 ==========');
		console.error('[/v1/messages] 错误类型:', error.constructor.name);
		console.error('[/v1/messages] 错误信息:', error.message);
		console.error('[/v1/messages] 错误堆栈:', error.stack);

		// 如果是 axios 错误
		if (axios.isAxiosError(error) && error.response) {
			console.error('[/v1/messages] Axios 错误状态码:', error.response.status);
			console.error('[/v1/messages] Axios 错误响应头:', JSON.stringify(error.response.headers, null, 2));
			console.error('[/v1/messages] Axios 错误响应体:', JSON.stringify(error.response.data, null, 2));
			console.error('[/v1/messages] ========== 错误结束 ==========');

			return NextResponse.json(
				{
					type: 'error',
					error: {
						message: error.response.data?.error?.message || error.message,
						type: error.response.data?.error?.type || 'api_error',
						status: error.response.status,
					},
				},
				{ status: error.response.status }
			);
		}

		console.error('[/v1/messages] ========== 错误结束 ==========');

		// 其他错误
		return NextResponse.json(
			{
				type: 'error',
				error: {
					message: error.message || 'Internal server error',
				},
			},
			{ status: 500 }
		);
	}
}
