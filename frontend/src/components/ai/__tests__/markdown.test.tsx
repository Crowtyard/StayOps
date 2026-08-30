/**
 * Markdown 安全渲染器测试（Sprint 9 §37/§38）：
 * - 支持子集：代码块 / 行内代码 / 粗体 / 标题 / 列表 / 段落
 * - XSS 安全：HTML/脚本原样显示为文本（纯 React 文本节点，无
 *   dangerouslySetInnerHTML）
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import Markdown from "@/components/ai/markdown";

describe("Markdown renderer", () => {
  it("renders plain paragraphs and line breaks", () => {
    render(<Markdown content={"第一行\n第二行"} />);
    expect(screen.getByText(/第一行/)).toBeTruthy();
    expect(screen.getByText(/第二行/)).toBeTruthy();
  });

  it("renders code fences as pre blocks", () => {
    render(<Markdown content={"```sql\nSELECT 1\n```"} />);
    expect(screen.getByText("SELECT 1")).toBeTruthy();
    expect(document.querySelector("pre code") ?? document.querySelector("pre")).toBeTruthy();
  });

  it("renders inline code", () => {
    render(<Markdown content={"用 `get_analytics` 查询"} />);
    expect(screen.getByText("get_analytics")).toBeTruthy();
    expect(document.querySelector("code")).toBeTruthy();
  });

  it("renders bold", () => {
    render(<Markdown content={"**入住率** 为 10%"} />);
    expect(screen.getByText("入住率")).toBeTruthy();
    expect(document.querySelector("strong")).toBeTruthy();
  });

  it("renders headings", () => {
    render(<Markdown content={"# 标题一\n\n## 标题二"} />);
    expect(screen.getByText("标题一")).toBeTruthy();
    expect(screen.getByText("标题二")).toBeTruthy();
  });

  it("renders unordered and ordered lists", () => {
    render(<Markdown content={"- 甲\n- 乙\n\n1. 一\n2. 二"} />);
    expect(screen.getByText("甲")).toBeTruthy();
    expect(screen.getByText("乙")).toBeTruthy();
    expect(screen.getByText("一")).toBeTruthy();
    expect(screen.getByText("二")).toBeTruthy();
  });

  it("is XSS-safe: script and HTML render as plain text", () => {
    const payload = '<script>window.__pwned = true</script>';
    const { container } = render(<Markdown content={payload} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("window.__pwned");
  });

  it("is XSS-safe: event handlers and links are not rendered as HTML", () => {
    const payload = '<img src=x onerror="alert(1)"> [click](javascript:alert(1))';
    const { container } = render(<Markdown content={payload} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("onerror");
    expect(container.textContent).toContain("javascript:alert");
  });

  it("never uses dangerouslySetInnerHTML", () => {
    const { container } = render(<Markdown content={"**加粗** 和 `代码`"} />);
    expect(container.querySelector("[dangerouslySetInnerHTML]")).toBeNull();
    expect(container.innerHTML).not.toContain("dangerouslySetInnerHTML");
  });

  it("renders combined blocks", () => {
    render(
      <Markdown
        content={"## 总结\n\n- 入住率 62%\n- ADR 428 元\n\n```sql\nSELECT 1\n```"}
      />,
    );
    expect(screen.getByText("总结")).toBeTruthy();
    expect(screen.getByText(/入住率 62%/)).toBeTruthy();
    expect(screen.getByText("SELECT 1")).toBeTruthy();
  });
});
