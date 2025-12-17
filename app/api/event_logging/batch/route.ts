import { NextResponse } from 'next/server';

/**
 * /api/event_logging/batch - 事件日志批量端点
 *
 * 功能说明：
 * Claude CLI 客户端会自动发送事件日志到这个端点用于遥测和分析
 *
 * 这个端点的作用：
 * 1. 接收 Claude CLI 发送的使用统计和事件数据
 * 2. 可以用于监控、分析、调试
 * 3. 帮助了解 API 使用情况
 *
 * 数据包含：
 * - 请求/响应的元数据
 * - 性能指标
 * - 错误信息
 * - 使用模式
 *
 * 当前实现：
 * - 简单记录日志（可以扩展为发送到日志服务、数据库等）
 * - 返回 200 状态表示接收成功
 */
export async function POST(req: Request) {
	try {
		const body = await req.json();

		// 记录事件日志（开发环境显示详细信息）
		if (process.env.LOG_LEVEL === 'debug') {
			console.log('[Event Logging] 收到批量事件:', {
				eventCount: Array.isArray(body) ? body.length : 'unknown',
				timestamp: new Date().toISOString(),
			});
			console.log('[Event Logging] 事件详情:', JSON.stringify(body, null, 2));
		} else {
			// 生产环境只记录简要信息
			console.log('[Event Logging] 收到', Array.isArray(body) ? body.length : 0, '个事件');
		}

		// TODO: 未来可以扩展为：
		// - 发送到日志聚合服务 (Datadog, Sentry, etc.)
		// - 存储到数据库进行分析
		// - 发送到消息队列进行异步处理
		// - 触发告警或监控

		// 返回成功响应
		return NextResponse.json({
			success: true,
			received: Array.isArray(body) ? body.length : 1,
			timestamp: new Date().toISOString(),
		});

	} catch (error: any) {
		console.error('[Event Logging] 处理事件日志错误:', error);

		// 即使处理失败也返回 200，避免影响客户端
		return NextResponse.json({
			success: false,
			error: 'Failed to process events',
		}, { status: 200 });
	}
}
