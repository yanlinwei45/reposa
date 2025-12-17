import Anthropic from '@anthropic-ai/sdk';
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
 * 使用场景：
 * - OpenAI SDK 等习惯 /api/ 前缀的客户端
 * - 需要与其他 API 保持路径一致性的场景
 */
export async function POST(req: Request) {
	try {
		// 1. 解析请求体
		const body = await req.json();
		console.log('[/api/compatible/v1/messages] 收到请求:', {
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
			console.error('[/api/compatible/v1/messages] 错误: ANTHROPIC_API_KEY 未配置');
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
			// 流式响应
			console.log('[/api/compatible/v1/messages] 使用流式响应模式');

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
							const data = `data: ${JSON.stringify(event)}\n\n`;
							controller.enqueue(new TextEncoder().encode(data));
						}
						controller.close();
					} catch (error) {
						console.error('[/api/compatible/v1/messages] 流式响应错误:', error);
						controller.error(error);
					}
				},
			});

			return new Response(readable, {
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					'Connection': 'keep-alive',
				},
			});

		} else {
			// 6. 非流式响应
			console.log('[/api/compatible/v1/messages] 使用标准响应模式');

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

			console.log('[/api/compatible/v1/messages] 请求成功, ID:', message.id);

			return NextResponse.json(message);
		}

	} catch (error: any) {
		// 7. 错误处理
		console.error('[/api/compatible/v1/messages] 错误:', error);

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
