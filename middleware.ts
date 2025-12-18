import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Next.js 中间件
 * 功能：验证请求头中的 x-api-key
 */
export function middleware(request: NextRequest) {
  // 检查请求路径是否是 API 端点
  // 只对 /v1/* 和 /api/* 路径应用 API Key 验证
  const isApiRoute = request.nextUrl.pathname.startsWith('/v1/') || request.nextUrl.pathname.startsWith('/api/');

  if (isApiRoute) {
    // 获取请求头中的 x-api-key
    const apiKey = request.headers.get('x-api-key');

    // 验证 API Key 是否存在
    // 这里可以根据需要修改验证逻辑，比如对比环境变量中的密钥
    if (!apiKey) {
      return NextResponse.json(
        {
          type: 'error',
          error: {
            type: 'unauthorized',
            message: 'Missing API key in x-api-key header'
          }
        },
        { status: 401 }
      );
    }

    // 可以在这里添加更严格的验证，比如对比固定密钥或从数据库查询
    // const validApiKey = process.env.CLIENT_API_KEY;
    // if (apiKey !== validApiKey) {
    //   return NextResponse.json(
    //     { error: 'Invalid API key' },
    //     { status: 401 }
    //   );
    // }
  }

  // 允许请求继续
  return NextResponse.next();
}

/**
 * 配置中间件的匹配规则
 */
export const config = {
  matcher: ['/v1/:path*', '/api/:path*'],
};
