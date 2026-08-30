"use client";

import React from "react";

/**
 * 安全 Markdown 子集渲染器（Sprint 9 §37/§38）。
 *
 * 安全原则：
 * - 纯 React 元素渲染，绝不使用 dangerouslySetInnerHTML(model_output)；
 *   所有内容以文本节点输出，XSS 天然免疫（<script>、onerror= 等原样显示为文本）。
 * - 支持子集：代码块（```）、行内代码（`）、粗体（**）、标题（#/##/###）、
 *   无序/有序列表、段落与换行。
 * - 不渲染链接/图片/HTML（避免钓鱼与脚本面）。
 */

interface InlinePart {
  kind: "text" | "code" | "bold";
  text: string;
}

/** 行内解析：`code` 与 **bold**（先 code 后 bold，避免重叠误判） */
function parseInline(line: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const regex = /(`[^`]+`)|(\*\*[^*]+\*\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    if (match.index > last) {
      parts.push({ kind: "text", text: line.slice(last, match.index) });
    }
    if (match[1] !== undefined) {
      parts.push({ kind: "code", text: match[1].slice(1, -1) });
    } else {
      parts.push({ kind: "bold", text: match[2].slice(2, -2) });
    }
    last = match.index + match[0].length;
  }
  if (last < line.length) {
    parts.push({ kind: "text", text: line.slice(last) });
  }
  return parts;
}

function InlineText({ line }: { line: string }) {
  const parts = parseInline(line);
  return (
    <>
      {parts.map((part, idx) => {
        if (part.kind === "code") {
          return (
            <code
              key={idx}
              className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[0.85em] text-gray-800"
            >
              {part.text}
            </code>
          );
        }
        if (part.kind === "bold") {
          return <strong key={idx}>{part.text}</strong>;
        }
        return <React.Fragment key={idx}>{part.text}</React.Fragment>;
      })}
    </>
  );
}

function Heading({ level, text }: { level: 1 | 2 | 3; text: string }) {
  const className =
    level === 1
      ? "text-lg font-semibold text-gray-900"
      : level === 2
        ? "text-base font-semibold text-gray-900"
        : "text-sm font-semibold text-gray-900";
  const Tag = level === 1 ? "h3" : level === 2 ? "h4" : "h5";
  return (
    <Tag className={`${className} mt-2 first:mt-0`}>
      <InlineText line={text} />
    </Tag>
  );
}

interface Block {
  kind: "code" | "ul" | "ol" | "para";
  lines: string[];
}

/** 块级解析：代码块 / 列表 / 段落（列表与段落按空行分组） */
function parseBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过结束 fence
      blocks.push({ kind: "code", lines: codeLines });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      blocks.push({ kind: "ul", lines: items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i += 1;
      }
      blocks.push({ kind: "ol", lines: items });
      continue;
    }
    // 段落：收集直到空行/代码块/列表
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    if (para.length > 0) {
      blocks.push({ kind: "para", lines: para });
    }
    while (i < lines.length && lines[i].trim() === "") {
      i += 1;
    }
  }
  return blocks;
}

/** 安全 Markdown 子集渲染（根组件） */
export default function Markdown({ content }: { content: string }) {
  const blocks = parseBlocks(content);
  return (
    <div className="space-y-2 text-sm leading-relaxed text-gray-800">
      {blocks.map((block, idx) => {
        if (block.kind === "code") {
          return (
            <pre
              key={idx}
              className="overflow-x-auto rounded-md bg-gray-900 p-3 font-mono text-xs text-gray-100"
            >
              {block.lines.join("\n")}
            </pre>
          );
        }
        if (block.kind === "ul") {
          return (
            <ul key={idx} className="list-disc space-y-1 pl-5">
              {block.lines.map((item, j) => (
                <li key={j}>
                  <InlineText line={item} />
                </li>
              ))}
            </ul>
          );
        }
        if (block.kind === "ol") {
          return (
            <ol key={idx} className="list-decimal space-y-1 pl-5">
              {block.lines.map((item, j) => (
                <li key={j}>
                  <InlineText line={item} />
                </li>
              ))}
            </ol>
          );
        }
        const first = block.lines[0];
        const heading = first.match(/^(#{1,3})\s+(.+)$/);
        if (heading && block.lines.length === 1) {
          return (
            <Heading
              key={idx}
              level={heading[1].length as 1 | 2 | 3}
              text={heading[2]}
            />
          );
        }
        return (
          <p key={idx}>
            {block.lines.map((line, j) => (
              <React.Fragment key={j}>
                {j > 0 ? <br /> : null}
                <InlineText line={line} />
              </React.Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
