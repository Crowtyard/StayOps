import { describe, expect, it } from "vitest";
import { classifyMigration, parseCurrent, parseHeads } from "../migration";

describe("migration: alembic 输出解析（与 dev_runtime 同口径）", () => {
  const CURRENT_OUTPUT = [
    "INFO  [alembic.runtime.migration] Context impl PostgresqlImpl.",
    "INFO  [alembic.runtime.migration] Will assume transactional DDL.",
    "f5d3b9e7a2c4 (head)",
  ].join("\n");

  const HEADS_OUTPUT = [
    "INFO  [alembic.runtime.migration] Context impl PostgresqlImpl.",
    "f5d3b9e7a2c4 (head)",
  ].join("\n");

  it("解析 current 最后一行 revision", () => {
    expect(parseCurrent(CURRENT_OUTPUT)).toBe("f5d3b9e7a2c4");
    expect(parseCurrent("INFO  no migrations present")).toBeNull();
    expect(parseCurrent("")).toBeNull();
  });

  it("解析 heads 全部 revision", () => {
    expect(parseHeads(HEADS_OUTPUT)).toEqual(["f5d3b9e7a2c4"]);
    expect(
      parseHeads(["abc123456789 (head)", "def123456789 (head)"].join("\n")),
    ).toEqual(["abc123456789", "def123456789"]);
    expect(parseHeads("")).toEqual([]);
  });

  it("只认 12 位字母数字 revision，忽略其它行", () => {
    expect(parseHeads("INFO  [alembic] 15:00:00\nxyz\nf5d3b9e7a2c4 (head)")).toEqual([
      "f5d3b9e7a2c4",
    ]);
  });
});

describe("migration: 状态分类（D1 §13 Fail Safe）", () => {
  it("current == 唯一 head → ok", () => {
    expect(classifyMigration("f5d3b9e7a2c4", ["f5d3b9e7a2c4"])).toBe("ok");
  });

  it("current != head → behind", () => {
    expect(classifyMigration("e3a91f5c8d24", ["f5d3b9e7a2c4"])).toBe("behind");
  });

  it("多 head → multi-head（Fail Safe，禁止自动升级）", () => {
    expect(
      classifyMigration("abc123456789", ["abc123456789", "def123456789"]),
    ).toBe("multi-head");
  });

  it("解析失败 → unknown", () => {
    expect(classifyMigration(null, [])).toBe("unknown");
    expect(classifyMigration(null, ["f5d3b9e7a2c4"])).toBe("unknown");
    expect(classifyMigration("f5d3b9e7a2c4", [])).toBe("unknown");
  });
});
