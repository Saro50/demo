/**
 * 敏感信息脱敏工具
 * 
 * 自动检测并替换 data 字段中的敏感信息，防止日志泄漏用户隐私。
 * 
 * 脱敏规则：
 * - 手机号: 138****1234
 * - 邮箱: u***@example.com
 * - 身份证: 110***********1234
 * - token/accessKey: tok_*** (保留前4位)
 * - 银行卡号: 6222********1234
 * 
 * 影响范围：
 * - 在 SDK 上报前脱敏，后端不做二次脱敏（后端信任 SDK 已处理）
 * - 如果 SDK 配置 sanitize=false，后端仍会做一次兜底脱敏
 */

const SENSITIVE_PATTERNS: RegExp[] = [
  // 手机号: 1[3-9]开头 11位
  /1[3-9]\d{9}/g,
  // 邮箱
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  // 身份证（15或18位）
  /\d{15}(\d{2}[0-9Xx])?/g,
  // token/accessKey
  /(?:token|accessKey|secret|api[_-]?key)[=:]["']?[a-zA-Z0-9_\-]{8,}/gi,
  // 银行卡号（16-19位数字）
  /\b\d{16,19}\b/g,
];

function sanitizeValue(key: string, value: string): string {
  let result = value;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, (match) => {
      // token 类保留前缀
      if (/^(token|accessKey|secret)/i.test(key) || /^(token|accessKey|secret)/i.test(match)) {
        return match.length > 8 ? match.slice(0, 4) + '***' : '***';
      }
      // 手机号保留前3后4
      if (/^1[3-9]\d{9}$/.test(match)) {
        return match.slice(0, 3) + '****' + match.slice(-4);
      }
      // 邮箱
      if (/@/.test(match)) {
        const [name, domain] = match.split('@');
        return name[0] + '***@' + domain;
      }
      // 身份证保留前6后4
      if (/\d{15,18}/.test(match)) {
        return match.slice(0, 6) + '********' + match.slice(-4);
      }
      // 银行卡保留前4后4
      if (/^\d{16,19}$/.test(match)) {
        return match.slice(0, 4) + '********' + match.slice(-4);
      }
      return '***';
    });
  }
  return result;
}

/** 递归脱敏 data 对象中的所有字符串值（含嵌套数组） */
export function sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') {
      result[key] = sanitizeValue(key, value);
    } else if (Array.isArray(value)) {
      // 递归处理数组中的每个元素，防止数组内嵌敏感字符串
      result[key] = value.map(item =>
        typeof item === 'string' ? sanitizeValue(key, item) :
        typeof item === 'object' && item !== null ? sanitizeData(item as Record<string, unknown>) :
        item
      );
    } else if (typeof value === 'object' && value !== null) {
      result[key] = sanitizeData(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}
