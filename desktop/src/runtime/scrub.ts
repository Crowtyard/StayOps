/**
 * 日志秘密清洗（纯函数）：desktop/backend/frontend 日志写入前统一 scrub。
 *
 * 覆盖（Desktop D1 §21）：
 * - DATABASE_URL 中的密码
 * - DeepSeek API Key（sk-*）
 * - AI_ENCRYPTION_KEY 赋值
 * - Authorization Bearer / api key 类键值
 */

const URL_CREDENTIALS =
  /(postgres(?:ql)?(?:\+[a-z0-9]+)?:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi;
const DEEPSEEK_KEY = /\b(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g;
const ENCRYPTION_KEY_ASSIGN = /(\bAI_ENCRYPTION_KEY\s*=\s*)[^\s]+/g;
const AUTHORIZATION = /(\bAuthorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/-]+/gi;
const API_KEY_ASSIGN =
  /(\b(?:api[_-]?key|apikey|api_token)\s*[:=]\s*)[^\s,"']+/gi;

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // $2 是 URL 中的 @ 分隔符，必须保留
  [URL_CREDENTIALS, "$1****$2"],
  [DEEPSEEK_KEY, "$1****"],
  [ENCRYPTION_KEY_ASSIGN, "$1****"],
  [AUTHORIZATION, "$1****"],
  [API_KEY_ASSIGN, "$1****"],
];

function apply(line: string): string {
  let out = line;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** 清洗单行文本。 */
export function scrubLine(line: string): string {
  return apply(line);
}

/** 清洗多行文本（保持行结构）。 */
export function scrubText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => apply(line))
    .join("\n");
}
