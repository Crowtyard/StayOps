/**
 * 登录表单：成功跳转 /dashboard、失败提示可读错误、网络失败显示服务不可用。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { replaceMock, routerMock } = vi.hoisted(() => {
  const replaceMock = vi.fn();
  return {
    replaceMock,
    routerMock: { replace: replaceMock, refresh: vi.fn() },
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

import LoginForm from "@/components/login-form";

const ME = {
  id: 1,
  username: "admin",
  display_name: null,
  email: null,
  phone: null,
  is_active: true,
  created_at: "x",
  updated_at: "x",
  roles: [],
  permissions: [],
};

async function submit(username: string, password: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("用户名"), username);
  await user.type(screen.getByLabelText("密码"), password);
  await user.click(screen.getByRole("button", { name: "登录" }));
}

describe("LoginForm", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    replaceMock.mockClear();
  });

  it("登录成功 → 跳转 /dashboard", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(ME), { status: 200 }),
    );
    render(<LoginForm />);
    await submit("admin", "Admin@123456");
    expect(replaceMock).toHaveBeenCalledWith("/dashboard");
  });

  it("凭据错误 → 显示「用户名或密码错误」", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ detail: "用户名或密码错误" }), {
        status: 401,
      }),
    );
    render(<LoginForm />);
    await submit("admin", "wrong");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "用户名或密码错误",
    );
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("网络失败 → 显示「服务暂时不可用」", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("fetch failed"));
    render(<LoginForm />);
    await submit("admin", "Admin@123456");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "服务暂时不可用",
    );
  });

  it("提交期间禁用按钮防止重复提交", async () => {
    let resolveFetch: (r: Response) => void = () => {};
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<LoginForm />);
    await user.type(screen.getByLabelText("用户名"), "admin");
    await user.type(screen.getByLabelText("密码"), "Admin@123456");
    const button = screen.getByRole("button", { name: "登录" });
    await user.click(button);
    expect(button).toBeDisabled();
    resolveFetch(new Response(JSON.stringify(ME), { status: 200 }));
    await screen.findByRole("button", { name: "登录" });
  });
});
