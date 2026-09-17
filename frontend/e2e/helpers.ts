/**
 * E2E 共用工具：UI 登录（经 /api/auth/login BFF，浏览器不接触 Token）。
 */

import {
  expect,
  type APIResponse,
  type Page,
  type Response,
} from "@playwright/test";

export function adminUsername(): string {
  const v = process.env.E2E_ADMIN_USERNAME;
  if (!v) throw new Error("缺少 E2E_ADMIN_USERNAME 环境变量（检查凭据文件）");
  return v;
}

export function adminPassword(): string {
  const v = process.env.E2E_ADMIN_PASSWORD;
  if (!v) throw new Error("缺少 E2E_ADMIN_PASSWORD 环境变量（检查凭据文件）");
  return v;
}

export function frontdeskUsername(): string {
  const v = process.env.E2E_FRONT_DESK_USERNAME;
  if (!v) throw new Error("缺少 E2E_FRONT_DESK_USERNAME 环境变量");
  return v;
}

export function frontdeskPassword(): string {
  const v = process.env.E2E_FRONT_DESK_PASSWORD;
  if (!v) throw new Error("缺少 E2E_FRONT_DESK_PASSWORD 环境变量");
  return v;
}

export function housekeepingUsername(): string {
  const v = process.env.E2E_HOUSEKEEPING_USERNAME;
  if (!v) throw new Error("缺少 E2E_HOUSEKEEPING_USERNAME 环境变量");
  return v;
}

export function housekeepingPassword(): string {
  const v = process.env.E2E_HOUSEKEEPING_PASSWORD;
  if (!v) throw new Error("缺少 E2E_HOUSEKEEPING_PASSWORD 环境变量");
  return v;
}

export function managerUsername(): string {
  const v = process.env.E2E_MANAGER_USERNAME;
  if (!v) throw new Error("缺少 E2E_MANAGER_USERNAME 环境变量");
  return v;
}

export function managerPassword(): string {
  const v = process.env.E2E_MANAGER_PASSWORD;
  if (!v) throw new Error("缺少 E2E_MANAGER_PASSWORD 环境变量");
  return v;
}

export function maintenanceUsername(): string {
  const v = process.env.E2E_MAINTENANCE_USERNAME;
  if (!v) throw new Error("缺少 E2E_MAINTENANCE_USERNAME 环境变量");
  return v;
}

export function maintenancePassword(): string {
  const v = process.env.E2E_MAINTENANCE_PASSWORD;
  if (!v) throw new Error("缺少 E2E_MAINTENANCE_PASSWORD 环境变量");
  return v;
}

export function financeUsername(): string {
  const v = process.env.E2E_FINANCE_USERNAME;
  if (!v) throw new Error("缺少 E2E_FINANCE_USERNAME 环境变量");
  return v;
}

export function financePassword(): string {
  const v = process.env.E2E_FINANCE_PASSWORD;
  if (!v) throw new Error("缺少 E2E_FINANCE_PASSWORD 环境变量");
  return v;
}

const LOGIN_PAGE = "/login";
const LOGIN_ENDPOINT = "/api/auth/login";
const SESSION_ENDPOINT = "/api/auth/me";
const LOGOUT_ENDPOINT = "/api/auth/logout";

/** 登录页表单可见后仍需等待 React hydrate 的上限 */
const HYDRATION_TIMEOUT_MS = 15_000;
/** 点击「登录」后等待 BFF 响应的上限 */
const LOGIN_RESPONSE_TIMEOUT_MS = 20_000;

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function safeText(res: APIResponse | Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * [alpha.9.6 QA DEF-2] 会话探针：直接问服务端 Cookie 是否仍然有效。
 *
 * - 200 → 已登录；401 → 确认未登录
 * - 其它状态码：环境异常，**抛错而不是当成"未登录"**（探针失效必须暴露）
 *
 * 说明：只读探测，不依赖页面渲染，因此不会与正在进行的客户端导航相互影响。
 */
async function sessionIsActive(page: Page): Promise<boolean> {
  const res = await page.request.get(SESSION_ENDPOINT);
  const status = res.status();
  if (status === 200) return true;
  if (status === 401) return false;
  throw new Error(
    `会话探针 GET ${SESSION_ENDPOINT} 返回 ${status}（预期 200 / 401）：` +
      truncate(await safeText(res)),
  );
}

/**
 * 确保浏览器上下文处于**未登录**状态（切换账号 / 新建上下文登录前统一调用）。
 *
 * 为什么需要：`/login` 在已登录态会服务端 redirect 回 `/dashboard`，
 * 若上一账号 Cookie 未清干净，就会填不到表单；
 * 反之若 Cookie 已清但客户端导航未落地，登录后的跳转可能被"迟到的导航"改写。
 * 这里用真实退出端点清理并**复核**，不靠 sleep / 盲目重试。
 */
async function ensureLoggedOut(page: Page): Promise<void> {
  if (!(await sessionIsActive(page))) return;

  const res = await page.request.post(LOGOUT_ENDPOINT);
  if (!res.ok()) {
    throw new Error(
      `退出登录失败：POST ${LOGOUT_ENDPOINT} 返回 ${res.status()}：` +
        truncate(await safeText(res)),
    );
  }
  if (await sessionIsActive(page)) {
    throw new Error("退出登录后会话仍然有效：Cookie 未被清除");
  }
}

/** 打开登录页并等到表单真正可交互 */
async function openLoginForm(page: Page): Promise<void> {
  await page.goto(LOGIN_PAGE);
  await expect(page.getByLabel("用户名")).toBeVisible();

  // 关键：[DEF-2] 等候 React hydrate。
  // LoginForm 的输入框是受控组件，若在 hydrate 前 fill，React 首次渲染会用
  // 空 state 覆盖 DOM value —— 随后提交等于提交空账号密码（BFF 422），
  // 页面停在 /login，表现为"登录偶尔不跳转"的假象。
  // 判定依据：React 会在其接管的 DOM 节点上挂 `__react*` 内部属性。
  try {
    await page.waitForFunction(
      () => {
        const el = document.querySelector("#username");
        return el !== null && Object.keys(el).some((k) => k.startsWith("__react"));
      },
      undefined,
      { timeout: HYDRATION_TIMEOUT_MS },
    );
  } catch {
    throw new Error(
      `登录页 ${HYDRATION_TIMEOUT_MS}ms 内未完成 React hydrate` +
        `（#username 未挂载 React 事件，表单提交不会触发）——当前 URL：${page.url()}`,
    );
  }
}

/** 登录失败时的可读诊断：HTTP 状态 + 页面错误文案 + 当前 URL（绝不输出密码） */
async function describeLoginFailure(
  page: Page,
  username: string,
  response: Response | null,
): Promise<string> {
  const lines = [
    `UI 登录未成功（用户 ${username}；诊断信息不含密码）`,
  ];

  if (response === null) {
    lines.push(
      `点击「登录」后 ${LOGIN_RESPONSE_TIMEOUT_MS}ms 内未收到 POST ${LOGIN_ENDPOINT} 请求`,
    );
  } else {
    lines.push(`POST ${LOGIN_ENDPOINT} → HTTP ${response.status()}`);
    const body = await safeText(response);
    if (body) lines.push(`响应体：${truncate(body)}`);
  }

  lines.push(`当前 URL：${page.url()}`);

  try {
    const alert = page.getByRole("alert").first();
    if ((await alert.count()) > 0) {
      const text = (await alert.innerText()).trim();
      if (text) lines.push(`页面错误文案：${truncate(text)}`);
    }
  } catch {
    // 页面已跳走 / 元素已卸载：忽略，前面的 URL 已足够定位
  }

  try {
    lines.push(`服务端会话状态：${(await sessionIsActive(page)) ? "仍有效" : "未登录"}`);
  } catch {
    lines.push("服务端会话状态：探针不可用");
  }

  return lines.join("\n");
}

/**
 * UI 登录（经 /api/auth/login BFF，浏览器不接触 Token）。
 *
 * [alpha.9.6 QA DEF-2] 全流程**状态可判定**，不依赖隐式时序：
 * ① 会话探针确认当前未登录 → ② 打开 /login 并等 React hydrate →
 * ③ 填凭据 → ④ 等待登录响应并校验 HTTP 200（非 200 立即抛出含状态/文案/URL 的
 * 诊断）→ ⑤ 断言进入 /dashboard 且应用外壳已渲染。
 */
export async function login(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  await ensureLoggedOut(page);
  await openLoginForm(page);

  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码").fill(password);

  // 先挂等待、再点击，避免响应早于监听而漏收
  const loginResponse = page.waitForResponse(
    (res) =>
      res.url().includes(LOGIN_ENDPOINT) && res.request().method() === "POST",
    { timeout: LOGIN_RESPONSE_TIMEOUT_MS },
  );
  await page.getByRole("button", { name: "登录" }).click();

  let response: Response;
  try {
    response = await loginResponse;
  } catch {
    throw new Error(await describeLoginFailure(page, username, null));
  }
  if (response.status() !== 200) {
    throw new Error(await describeLoginFailure(page, username, response));
  }

  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  // URL 变化不足以证明进入应用：首页标题必须真实渲染
  await expect(page.getByRole("heading", { name: /房态概览/ })).toBeVisible();
}

/** 顶栏退出登录：确认回到登录页**且服务端会话已清除**（切换账号前调用）。 */
export async function logout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "退出" }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 20_000 });
  await ensureLoggedOut(page);
}

/** 打开侧边导航中的房态棋盘并进入指定房号详情 */
export async function openRoomDetail(page: Page, roomNumber: string) {
  await page.getByRole("link", { name: "房态", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "房态棋盘" }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: new RegExp(`^${roomNumber}\\s`) })
    .click();
  await expect(
    page.getByRole("heading", { name: `房间 ${roomNumber}` }),
  ).toBeVisible();
}
