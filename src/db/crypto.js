import fs from 'node:fs';
import crypto from 'node:crypto';
import { KEY_PATH } from '../config.js';

/**
 * 敏感字段加密（6.5）：会话凭证、身份证号使用 AES-256-GCM 加密后落库。
 * 密钥文件只存本机 data/secret.key，首次启动自动生成。
 */

let key = null;

function loadOrCreateKey() {
  if (key) return key;
  if (fs.existsSync(KEY_PATH)) {
    key = fs.readFileSync(KEY_PATH);
  } else {
    key = crypto.randomBytes(32);
    fs.writeFileSync(KEY_PATH, key, { mode: 0o600 });
  }
  return key;
}

/** 加密 → base64(iv|tag|ciphertext) */
export function encrypt(plaintext) {
  const k = loadOrCreateKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

/** 解密；失败返回 null（如密钥更换后旧数据不可读） */
export function decrypt(b64) {
  try {
    const k = loadOrCreateKey();
    const raw = Buffer.from(b64, 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', k, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** 身份证号哈希：用于唯一性约束与比对，不落原文（6.5） */
export function hashId(idNumber) {
  return crypto.createHmac('sha256', loadOrCreateKey()).update(idNumber).digest('hex');
}
