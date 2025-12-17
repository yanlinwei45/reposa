import { NextResponse } from 'next/server';

/**
 * /api/event_logging/batch - 事件日志批量端点
 *
 * 功能说明：
 * Claude CLI 和其他客户端会自动发送事件日志到这个端点用于遥测和分析
 *
 * 这个端点的作用：
 * 1. 接收客户端发送的使用统计和事件数据
 * 2. 记录 API 使用情况、性能指标、错误信息
 * 3. 可以用于监控、分析、调试
 * 4. 支持批量事件处理
 *
 * 事件数据包含：
 * - 请求/响应的元数据
 * - 性能指标（延迟、token 使用量等）
 * - 错误信息和堆栈
 * - 使用模式和统计
 *
 * 扩展方向：
 * - 发送到日志服务（Datadog, Sentry, CloudWatch 等）
 * - 存储到数据库进行分析
 * - 发送到消息队列进行异步处理
 * - 触发监控告警
 * - 生成使用报告和图表
 */

// 事件类型定义
interface Event {
	event_type?: string;
	timestamp?: string;
	user_id?: string;
	session_id?: string;
	request_id?: string;
	model?: string;
	provider?: string;
	duration_ms?: number;
	tokens?: {
		input?: number;
		output?: number;
		total?: number;
	};
	error?: {
		type?: string;
		message?: string;
		stack?: string;
	};
	metadata?: Record<string, unknown>;
	[key: string]: unknown;
}

// 统计事件分类
function categorizeEvents(events: Event[]): {
	total: number;
	byType: Record<string, number>;
	errors: number;
	successRate: number;
	totalDuration: number;
	averageDuration: number;
} {
	const stats = {
		total: events.length,
		byType: {} as Record<string, number>,
		errors: 0,
		successRate: 0,
		totalDuration: 0,
		averageDuration: 0,
	};

	events.forEach(event => {
		// 按类型统计
		const eventType = event.event_type || 'unknown';
		stats.byType[eventType] = (stats.byType[eventType] || 0) + 1;

		// 错误统计
		if (event.error) {
			stats.errors++;
		}

		// 耗时统计
		if (event.duration_ms) {
			stats.totalDuration += event.duration_ms;
		}
	});

	// 计算成功率
	stats.successRate = stats.total > 0
		? Math.round(((stats.total - stats.errors) / stats.total) * 100)
		: 100;

	// 计算平均耗时
	stats.averageDuration = stats.total > 0
		? Math.round(stats.totalDuration / stats.total)
		: 0;

	return stats;
}

// 格式化日志输出
function formatEventLog(event: Event, index: number): string {
	const parts: string[] = [];

	parts.push(`[Event ${index + 1}]`);

	if (event.event_type) {
		parts.push(`Type: ${event.event_type}`);
	}

	if (event.model) {
		parts.push(`Model: ${event.model}`);
	}

	if (event.duration_ms) {
		parts.push(`Duration: ${event.duration_ms}ms`);
	}

	if (event.tokens) {
		const { input, output, total } = event.tokens;
		if (total) {
			parts.push(`Tokens: ${total} (in: ${input || 0}, out: ${output || 0})`);
		}
	}

	if (event.error) {
		parts.push(`❌ Error: ${event.error.type || 'unknown'} - ${event.error.message || 'no message'}`);
	}

	return parts.join(' | ');
}

export async function POST(req: Request) {
	try {
		// 安全地解析 JSON，处理空请求体的情况
		let body;
		try {
			const text = await req.text();
			if (!text || text.trim() === '') {
				// 空请求体，使用空数组
				body = [];
			} else {
				body = JSON.parse(text);
			}
		} catch (parseError) {
			console.warn('[Event Logging] JSON 解析失败，使用空数组:', parseError);
			body = [];
		}

		const timestamp = new Date().toISOString();

		// 确保是数组格式
		const events: Event[] = Array.isArray(body) ? body : (body ? [body] : []);
		const eventCount = events.length;

		console.log('[Event Logging] ========== 接收事件日志 ==========');
		console.log('[Event Logging] 时间:', timestamp);
		console.log('[Event Logging] 事件数量:', eventCount);

		// 获取日志级别配置
		const logLevel = process.env.LOG_LEVEL || 'info';
		const isDebugMode = logLevel === 'debug';

		// 统计事件
		const stats = categorizeEvents(events);

		console.log('[Event Logging] 统计信息:');
		console.log('  - 总事件数:', stats.total);
		console.log('  - 错误数:', stats.errors);
		console.log('  - 成功率:', stats.successRate + '%');
		console.log('  - 总耗时:', stats.totalDuration + 'ms');
		console.log('  - 平均耗时:', stats.averageDuration + 'ms');

		// 按类型统计
		if (Object.keys(stats.byType).length > 0) {
			console.log('  - 事件类型分布:');
			Object.entries(stats.byType).forEach(([type, count]) => {
				console.log(`    * ${type}: ${count}`);
			});
		}

		// Debug 模式下输出详细日志
		if (isDebugMode) {
			console.log('[Event Logging] 详细事件列表:');
			events.forEach((event, index) => {
				console.log('  ' + formatEventLog(event, index));
			});

			console.log('[Event Logging] 完整原始数据:');
			console.log(JSON.stringify(body, null, 2));
		} else {
			// 非 Debug 模式只记录重要事件
			const errorEvents = events.filter(e => e.error);
			if (errorEvents.length > 0) {
				console.log('[Event Logging] 错误事件:');
				errorEvents.forEach((event, index) => {
					console.log('  ' + formatEventLog(event, index));
				});
			}
		}

		console.log('[Event Logging] ========== 处理完成 ==========');

		// TODO: 未来可以扩展为：
		// 1. 发送到日志聚合服务 (Datadog, Sentry, CloudWatch)
		//    - 使用 SDK 直接上报
		//    - 通过 HTTP API 发送
		//
		// 2. 存储到数据库进行分析
		//    - PostgreSQL, MongoDB, ClickHouse
		//    - 生成使用报告和图表
		//
		// 3. 发送到消息队列进行异步处理
		//    - RabbitMQ, Kafka, AWS SQS
		//    - 实现解耦和可扩展性
		//
		// 4. 触发告警或监控
		//    - 错误率超过阈值时告警
		//    - 性能下降时通知
		//    - 异常使用模式检测
		//
		// 示例实现:
		// if (stats.errors > 0) {
		//   await sendToSentry(errorEvents);
		// }
		// await saveToDatabase(events);
		// await publishToQueue(events);

		// 返回成功响应
		return NextResponse.json({
			success: true,
			received: eventCount,
			timestamp: timestamp,
			stats: {
				total: stats.total,
				errors: stats.errors,
				success_rate: stats.successRate,
				average_duration_ms: stats.averageDuration,
			},
		});

	} catch (error: unknown) {
		const err = error as Error;
		console.error('[Event Logging] ========== 处理失败 ==========');
		console.error('[Event Logging] 错误类型:', err.constructor?.name || 'unknown');
		console.error('[Event Logging] 错误信息:', err.message || 'no message');
		console.error('[Event Logging] 错误堆栈:', err.stack || 'no stack');
		console.error('[Event Logging] ========== 错误结束 ==========');

		// 即使处理失败也返回 200，避免影响客户端
		// 事件日志不应该影响主要业务流程
		return NextResponse.json({
			success: false,
			error: 'Failed to process events',
			message: err.message,
		}, { status: 200 });
	}
}
