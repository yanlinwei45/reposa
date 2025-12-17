import { NextResponse } from 'next/server';
import { countTokens } from '@/lib/token-counter';

/**
 * /v1/messages/count_tokens - Token 计数端点
 *
 * 功能说明：
 * 1. 接收客户端的 token 计数请求
 * 2. 使用本地实现估算 token 数量
 * 3. 返回 token 使用量估算
 *
 * 实现方式：
 * - 基于启发式规则的本地估算
 * - 不依赖上游 API
 * - 快速响应，无网络延迟
 *
 * 准确度：
 * - 估算值可能有 ±10-20% 的误差
 * - 对于成本预估和规划已经足够准确
 *
 * 用途：
 * - 在发送请求前预估 token 使用量
 * - 避免超出 max_tokens 限制
 * - 成本控制和预算管理
 */

export async function POST(req: Request) {
	try {
		// 1. 解析请求体
		const body = await req.json();

		console.log('[Count Tokens] ========== 请求开始 ==========');
		console.log('[Count Tokens] Model:', body.model);
		console.log('[Count Tokens] Messages 数量:', body.messages?.length || 0);
		console.log('[Count Tokens] 包含 System:', !!body.system);
		console.log('[Count Tokens] 包含 Tools:', body.tools?.length || 0);

		// 2. 验证必需字段
		if (!body.model || !body.messages) {
			console.error('[Count Tokens] 验证失败: 缺少必需字段');
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

		console.log('[Count Tokens] 计算完成');
		console.log('[Count Tokens] 估算 Input Tokens:', result.input_tokens);
		console.log('[Count Tokens] 耗时:', duration, 'ms');
		console.log('[Count Tokens] ========== 请求结束 ==========');

		return NextResponse.json(result);

	} catch (error: unknown) {
		const err = error as Error;
		console.error('[Count Tokens] ========== 错误发生 ==========');
		console.error('[Count Tokens] 错误类型:', err.constructor?.name);
		console.error('[Count Tokens] 错误信息:', err.message);
		console.error('[Count Tokens] 错误堆栈:', err.stack);
		console.error('[Count Tokens] ========== 错误结束 ==========');

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
