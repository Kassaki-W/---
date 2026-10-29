/**
 * 身份证号校验（FR-02）：18 位、出生日期合法、GB 11643 校验位。
 * 只做格式与校验位校验；是否通过平台实名核验由运行期确定。
 */

const WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CHECK_CODES = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

/** 校验通过返回 null，否则返回具体原因 */
export function validateIdCard(id) {
  if (typeof id !== 'string') return '证件号必须为字符串';
  const s = id.trim().toUpperCase();
  if (!/^\d{17}[\dX]$/.test(s)) return '必须是 18 位身份证号';

  const year = Number(s.slice(6, 10));
  const month = Number(s.slice(10, 12));
  const day = Number(s.slice(12, 14));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1900 || year > 2100 ||
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
  ) {
    return '出生日期不合法';
  }

  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(s[i]) * WEIGHTS[i];
  if (CHECK_CODES[sum % 11] !== s[17]) return '校验位不正确，请核对证件号';

  return null;
}

export function normalizeIdCard(id) {
  return String(id ?? '').trim().toUpperCase();
}
