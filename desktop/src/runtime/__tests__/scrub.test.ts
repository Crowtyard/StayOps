import { describe, expect, it } from "vitest";
import { scrubLine, scrubText } from "../scrub";

describe("scrub: 秘密清洗（Desktop D1 §21）", () => {
  it("清洗 DATABASE_URL 密码", () => {
    expect(
      scrubLine("postgresql://stayops:SuperSecret!@localhost:5432/stayops"),
    ).toBe("postgresql://stayops:****@localhost:5432/stayops");
    expect(
      scrubLine("psycopg2: postgresql+psycopg2://u:pw@127.0.0.1:5432/db failed"),
    ).toContain("postgresql+psycopg2://u:****@127.0.0.1:5432/db failed");
  });

  it("清洗 DeepSeek API Key（sk-*）", () => {
    expect(scrubLine("using key sk-abcdef1234567890 for request")).toBe(
      "using key sk-abcd**** for request",
    );
  });

  it("清洗 AI_ENCRYPTION_KEY 赋值", () => {
    expect(scrubLine("AI_ENCRYPTION_KEY=supersecretvalue123")).toBe(
      "AI_ENCRYPTION_KEY=****",
    );
  });

  it("清洗 Authorization Bearer", () => {
    expect(scrubLine("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.token")).toBe(
      "Authorization: Bearer ****",
    );
  });

  it("清洗 api_key/apikey 键值", () => {
    expect(scrubLine("apikey=abc123def456")).toBe("apikey=****");
    // 值内 & 等字符一并掩码（整值不可读）
    expect(scrubLine("api_key=abc123def456&x=1")).toBe("api_key=****");
    // 引号包裹的 sk- 值：sk- 规则先掩码，剩余密钥片段绝不明文
    const quoted = scrubLine('api_key="sk-live-1234"');
    expect(quoted).toContain("sk-live****");
    expect(quoted).not.toContain("1234");
  });

  it("多行文本保持行结构", () => {
    const input = [
      "line one",
      "postgresql://u:pass@h/db",
      "sk-abcdefg12345",
    ].join("\n");
    const out = scrubText(input);
    expect(out.split("\n")).toHaveLength(3);
    expect(out).toContain("postgresql://u:****@h/db");
    expect(out).toContain("sk-abcd****");
  });

  it("普通文本不受影响（无 false positive）", () => {
    const normal = "StayOps backend started on 127.0.0.1:8100, 28 rooms ready";
    expect(scrubLine(normal)).toBe(normal);
    expect(scrubLine("INFO:     Application startup complete.")).toBe(
      "INFO:     Application startup complete.",
    );
  });

  it("不输出任何明文密码片段", () => {
    const out = scrubText(
      "connect postgresql://admin:MyPassw0rd!@db:5432/stayops with sk-abcdefghij123456 and AI_ENCRYPTION_KEY=fernet-key-xyz",
    );
    expect(out).not.toMatch(/MyPassw0rd|abcdefghij123456|fernet-key-xyz/);
  });
});
