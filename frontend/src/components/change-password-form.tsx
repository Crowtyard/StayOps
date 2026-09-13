"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { changePassword } from "@/lib/api/auth";

/**
 * 首次安装改密表单（D2）：
 * - 必须输入当前（初始）密码
 * - 新密码至少 8 位且两次一致
 * - 成功后跳转 /dashboard（后端已清除 must_change_password）
 */
export default function ChangePasswordForm({ username }: { username: string }) {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (next.length < 8) {
      setError("新密码至少 8 位");
      return;
    }
    if (next !== confirm) {
      setError("两次输入的新密码不一致");
      return;
    }
    if (next === current) {
      setError("新密码不能与当前密码相同");
      return;
    }
    setSubmitting(true);
    try {
      await changePassword(current, next);
      router.replace("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "修改密码失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md space-y-5 rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"
      >
        <header className="space-y-1">
          <h1 className="text-xl font-semibold text-slate-900">修改初始密码</h1>
          <p className="text-sm text-slate-500">
            这是首次启动生成的初始密码，必须先修改后才能使用 StayOps（账号：
            <span className="font-medium text-slate-700">{username}</span>）。
          </p>
        </header>

        <div className="space-y-4">
          <label className="block space-y-1">
            <span className="text-sm font-medium text-slate-700">当前密码</span>
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              required
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium text-slate-700">新密码（至少 8 位）</span>
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              required
              minLength={8}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium text-slate-700">确认新密码</span>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
              minLength={8}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
            />
          </label>
        </div>

        {error ? (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {submitting ? "正在修改…" : "修改密码并继续"}
        </button>
      </form>
    </main>
  );
}
