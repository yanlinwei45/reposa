import { NextResponse } from 'next/server';
import { countTokens } from '@/lib/token-counter';

/**
 * /api/compatible/v1/messages/count_tokens - 兼容性 Token 计数端点
 *
 * 功能说明：
 * 这是一个与 /v1/messages/count_tokens 功能完全相同的兼容端点
 *
 * 为什么需要这个端点？
 * 1. 某些客户端库默认使用 /api/* 路径格式
 * 2. 提供多种 URL 格式选择，增强兼容性
 *
 * 功能特性：
 * 1. 使用本地实现估算 token 数量
 * 2. 快速响应，无网络延迟
 * 3. 支持消息、系统提示、工具定义的 token 计数
 */

export async function POST(req: Request) {
	try {
		// 1. 解析请求体
		const body = await req.json();

		console.log('[/api/compatible/v1/messages/count_tokens] ========== 请求开始 ==========');
		console.log('[/api/compatible/v1/messages/count_tokens] Model:', body.model);
		console.log('[/api/compatible/v1/messages/count_tokens] Messages 数量:', body.messages?.length || 0);
		console.log('[/api/compatible/v1/messages/count_tokens] 包含 System:', !!body.system);
		console.log('[/api/compatible/v1/messages/count_tokens] 包含 Tools:', body.tools?.length || 0);

		// 2. 验证必需字段
		if (!body.model || !body.messages) {
			console.error('[/api/compatible/v1/messages/count_tokens] 验证失败: 缺少必需字段');
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

		// 3. 使用本地 token 计数器
		const startTime = Date.now();
		const result = countTokens(body);
		const duration = Date.now() - startTime;

		console.log('[/api/compatible/v1/messages/count_tokens] 计算完成');
		console.log('[/api/compatible/v1/messages/count_tokens] 估算 Input Tokens:', result.input_tokens);
		console.log('[/api/compatible/v1/messages/count_tokens] 耗时:', duration, 'ms');
		console.log('[/api/compatible/v1/messages/count_tokens] ========== 请求结束 ==========');

		return NextResponse.json(result);

	} catch (error: unknown) {
		const err = error as Error;
		console.error('[/api/compatible/v1/messages/count_tokens] ========== 错误发生 ==========');
		console.error('[/api/compatible/v1/messages/count_tokens] 错误类型:', err.constructor?.name);
		console.error('[/api/compatible/v1/messages/count_tokens] 错误信息:', err.message);
		console.error('[/api/compatible/v1/messages/count_tokens] 错误堆栈:', err.stack);
		console.error('[/api/compatible/v1/messages/count_tokens] ========== 错误结束 ==========');

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
