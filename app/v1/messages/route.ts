import Anthropic from '@anthropic-ai/sdk';
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
		console.log('[/v1/messages] 收到请求:', {
			model: body.model,
			messageCount: body.messages?.length,
			stream: body.stream,
		});

		// 2. 验证必需字段
		if (!body.model || !body.messages) {
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

		// 4. 初始化 Anthropic 客户端
		const client = new Anthropic({
			apiKey: apiKey,
			baseURL: process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com',
		});

		// 5. 检查是否需要流式响应
		const isStreaming = body.stream === true;

		if (isStreaming) {
			// 流式响应 - 使用 Server-Sent Events (SSE)
			console.log('[/v1/messages] 使用流式响应模式');

			const stream = await client.messages.stream({
				model: body.model,
				messages: body.messages,
				max_tokens: body.max_tokens || 4096,
				temperature: body.temperature,
				top_p: body.top_p,
				top_k: body.top_k,
				system: body.system,
				stop_sequences: body.stop_sequences,
				metadata: body.metadata,
			});

			// 创建可读流
			const readable = new ReadableStream({
				async start(controller) {
					try {
						for await (const event of stream) {
							// 将事件转换为 SSE 格式
							const data = `data: ${JSON.stringify(event)}\n\n`;
							controller.enqueue(new TextEncoder().encode(data));
						}
						controller.close();
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

			const message = await client.messages.create({
				model: body.model,
				messages: body.messages,
				max_tokens: body.max_tokens || 4096,
				temperature: body.temperature,
				top_p: body.top_p,
				top_k: body.top_k,
				system: body.system,
				stop_sequences: body.stop_sequences,
				metadata: body.metadata,
			});

			console.log('[/v1/messages] 请求成功, ID:', message.id);

			// 返回 Anthropic 的响应
			return NextResponse.json(message);
		}

	} catch (error: any) {
		// 7. 错误处理
		console.error('[/v1/messages] 错误:', error);

		// 如果是 Anthropic SDK 的错误
		if (error instanceof Anthropic.APIError) {
			return NextResponse.json(
				{
					type: 'error',
					error: {
						message: error.message,
						type: error.type,
						status: error.status,
					},
				},
				{ status: error.status || 500 }
			);
		}

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
