import { NextRequest, NextResponse } from 'next/server'

/**
 * Next.js Middleware - 全局请求拦截器
 *
 * 功能说明：
 * 1. 在请求到达路由处理器之前进行拦截
 * 2. 验证请求的有效性（如 API Key、请求格式等）
 * 3. 添加日志记录
 * 4. 设置 CORS 头（如果需要跨域访问）
 *
 * 执行顺序：
 * 客户端请求 -> Middleware -> 路由处理器 -> 返回响应
 *
 * 使用场景：
 * - API 认证和授权
 * - 请求日志
 * - 速率限制
 * - 请求/响应修改
 */
export function middleware(request: NextRequest) {
	const { pathname } = request.nextUrl;

	// 记录请求信息（简化版，避免过多日志）
	console.log(`[Middleware] ${request.method} ${pathname}`);

	// 如果是 API 路由，记录更多信息
	if (pathname.startsWith('/v1/') || pathname.startsWith('/api/')) {
		const apiKey = request.headers.get('x-api-key') || request.headers.get('authorization');

		console.log('[Middleware] API 请求详情:', {
			path: pathname,
			method: request.method,
			hasApiKey: !!apiKey,
			contentType: request.headers.get('content-type'),
			userAgent: request.headers.get('user-agent'),
		});

		// TODO: 可以在这里添加 API Key 验证
		// 示例：
		// if (!apiKey) {
		//   return NextResponse.json(
		//     { error: 'Missing API key' },
		//     { status: 401 }
		//   );
		// }
	}

	// 继续处理请求
	const response = NextResponse.next();

	// 添加 CORS 头（如果需要允许跨域访问）
	// 在生产环境中，应该限制允许的来源
	if (pathname.startsWith('/v1/') || pathname.startsWith('/api/')) {
		response.headers.set('Access-Control-Allow-Origin', '*');
		response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
		response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
	}

	return response;
}

/**
 * Matcher 配置 - 指定 middleware 应用的路由
 *
 * 说明：
 * - 只对 /v1/* 和 /api/* 路径应用 middleware
 * - 静态资源、图片、字体等不会经过 middleware
 * - 提高性能，避免不必要的处理
 */
export const config = {
	matcher: [
		'/v1/:path*',
		'/api/:path*',
	],
}
