"use client";

import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50 px-4 text-center">
      <p className="text-5xl font-semibold text-gray-300">404</p>
      <p className="text-base font-medium text-gray-900">页面未找到</p>
      <p className="max-w-sm text-sm text-gray-500">
        您访问的页面不存在或已被移动。
      </p>
      <Link
        href="/dashboard"
        className="mt-2 rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
      >
        返回首页
      </Link>
    </div>
  );
}
