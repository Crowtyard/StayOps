import { cookies } from "next/headers";
import { AUTH_COOKIE } from "@/lib/server/auth";

/** POST /api/auth/logout — 清除 HttpOnly Cookie（JWT 无状态，无需通知后端） */
export async function POST() {
  const cookieStore = await cookies();
  cookieStore.delete(AUTH_COOKIE);
  return Response.json({ ok: true });
}
