/**
 * Committable workspace-manifest value safety policy.
 *
 * A25-5d2: rejects secrets, tenancy identifiers, unsafe object keys, control
 * characters, local paths, credential-bearing URIs, and token-shaped values
 * without depending on filesystem or profile selection.
 */
import path from 'node:path';
import { WORKSPACE_MANIFEST_MAX_STRING_BYTES } from '../contracts.js';

const WORKSPACE_MANIFEST_MAX_PERCENT_DECODE_PASSES = 16;
const UNSAFE_OBJECT_KEYS = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);
const SENSITIVE_EXTRA_KEYS = new Set([
  'secret',
  'secrets',
  'token',
  'tokens',
  'password',
  'passwd',
  'credential',
  'credentials',
  'authorization',
  'cookie',
  'cookies',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'privatekey',
  'sessionkey',
  'userid',
  'orgid',
  'organizationid',
  'projectid',
  'workspaceid',
]);
const SENSITIVE_EXTRA_KEY_SUFFIXES = [
  'secret',
  'secrets',
  'token',
  'tokens',
  'password',
  'passwords',
  'credential',
  'credentials',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'privatekey',
  'sessionkey',
  'userid',
  'userids',
  'orgid',
  'orgids',
  'organizationid',
  'organizationids',
  'projectid',
  'projectids',
  'workspaceid',
  'workspaceids',
];
const SENSITIVE_EXTRA_KEY_WORDS = new Set([
  'secret',
  'secrets',
  'token',
  'tokens',
  'password',
  'passwords',
  'passwd',
  'credential',
  'credentials',
  'authorization',
  'cookie',
  'cookies',
  'apikey',
]);
const SENSITIVE_EXTRA_KEY_FRAGMENTS = [
  'secret',
  'password',
  'passwd',
  'credential',
  'authorization',
  'cookie',
  'apikey',
  'token',
  'privatekey',
  'sessionkey',
];
const SAFE_SENSITIVE_METADATA_SUFFIXES = [
  'algorithm',
  'algorithms',
  'budget',
  'budgets',
  'count',
  'counts',
  'enabled',
  'endpoint',
  'endpoints',
  'expiresat',
  'expiry',
  'length',
  'lengths',
  'limit',
  'limits',
  'name',
  'names',
  'policy',
  'policies',
  'required',
  'status',
  'ttl',
  'type',
  'types',
  'url',
  'urls',
  'uri',
  'uris',
];
const SAFE_TOKEN_METADATA_KEYS = [
  /^(?:max|input|output|context|estimated|used|total|prompt|completion|cached)tokens?$/,
  /^tokens?(?:budget|count|limit|length|usage)$/,
  /^(?:de)?tokenizer(?:model|name|type|config|configuration|version)?$/,
];

export function isBoundedString(value: string): boolean {
  return value.length <= WORKSPACE_MANIFEST_MAX_STRING_BYTES &&
    Buffer.byteLength(value) <= WORKSPACE_MANIFEST_MAX_STRING_BYTES;
}

export function isSafeExtraKey(key: string): boolean {
  if (!isBoundedString(key)) return false;
  const decoded = decodePercentEscapesTolerantly(key);
  return !UNSAFE_OBJECT_KEYS.has(key) &&
    !UNSAFE_OBJECT_KEYS.has(decoded) &&
    !hasControlCharacters(key) &&
    !hasControlCharacters(decoded) &&
    !isSensitiveExtraKey(key) &&
    !isSensitiveExtraKey(decoded);
}

export function hasControlCharacters(value: string): boolean {
  return /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

export function stripControlCharacters(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');
}

export function isLocalAbsolutePath(value: string): boolean {
  const text = canonicalizeUriMaterial(value.trim());
  return text.startsWith('/') ||
    path.win32.isAbsolute(text) ||
    /^~[\\/]/.test(text) ||
    /\bfile:\/\//i.test(text) ||
    /(?:^|[^A-Za-z0-9_/])\/(?!\/)[^\s"']+/.test(text) ||
    /(?:^|[^A-Za-z0-9_])~[\\/][^\s"']+/.test(text) ||
    /(?:^|[^A-Za-z0-9_])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+[\\/])[^\s"']*/.test(
      text,
    );
}

export function isSensitiveValue(value: string): boolean {
  const text = canonicalizeUriMaterial(value.trim());
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) ||
    /\bBearer\s+\S+/i.test(text) ||
    /(?:sk-[A-Za-z0-9_-]{12,}|(?:gh[opusr]|github_pat)_[A-Za-z0-9_]{12,}|xox[baprs]-\S+|AKIA[A-Z0-9]{16})/.test(
      text,
    ) ||
    hasSensitiveUriMaterial(text) ||
    containsJwtLikeValue(text);
}

function isSensitiveExtraKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SENSITIVE_EXTRA_KEYS.has(normalized)) return true;
  if (SAFE_TOKEN_METADATA_KEYS.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  if (SAFE_SENSITIVE_METADATA_SUFFIXES.some((suffix) =>
    normalized.endsWith(suffix))) {
    return false;
  }
  if (SENSITIVE_EXTRA_KEY_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment))) {
    return true;
  }

  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.some((word) => SENSITIVE_EXTRA_KEY_WORDS.has(word))) return true;
  return SENSITIVE_EXTRA_KEY_SUFFIXES.some((suffix) =>
    normalized.endsWith(suffix));
}

function hasSensitiveUriMaterial(value: string): boolean {
  const decoded = canonicalizeUriMaterial(value);
  return hasUriUserInfo(decoded) ||
    (decoded.includes('=') && hasSensitiveUriParameter(decoded));
}

function canonicalizeUriMaterial(value: string): string {
  return stripControlCharacters(decodePercentEscapesTolerantly(value));
}

function decodePercentEscapesTolerantly(value: string): string {
  let decoded = value;
  for (
    let pass = 0;
    pass < WORKSPACE_MANIFEST_MAX_PERCENT_DECODE_PASSES;
    pass += 1
  ) {
    const next = decoded.replace(
      /(?:%[0-9A-Fa-f]{2})+/gu,
      (encoded) =>
        Buffer.from(encoded.replaceAll('%', ''), 'hex').toString('utf8'),
    );
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function hasSensitiveUriParameter(value: string): boolean {
  const firstEquals = value.indexOf('=');
  if (firstEquals >= 0) {
    const leadingKey = value.slice(0, firstEquals).trim();
    if (/^[A-Za-z0-9_.-]{1,512}$/u.test(leadingKey) &&
        isSensitiveUriParameterKey(leadingKey)) {
      return true;
    }
  }

  const parameter = /[?&#;]\s*([^=&#;]{1,512})\s*=/gu;
  for (const match of value.matchAll(parameter)) {
    if (isSensitiveUriParameterKey(match[1] ?? '')) return true;
  }
  return false;
}

function isSensitiveUriParameterKey(value: string): boolean {
  const key = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return key === 'sig' || key === 'token' || key.endsWith('token') ||
    [
      'apikey',
      'accesskey',
      'privatekey',
      'sessionkey',
      'accesstoken',
      'refreshtoken',
      'idtoken',
      'authtoken',
      'securitytoken',
      'bearertoken',
      'clientsecret',
      'authorization',
      'credential',
      'password',
      'passwd',
      'secret',
      'signature',
    ].some((fragment) => key.includes(fragment));
}

function hasUriUserInfo(value: string): boolean {
  let marker = value.indexOf('//');
  while (marker >= 0) {
    const authorityStart = marker + 2;
    let authorityEnd = authorityStart;
    while (
      authorityEnd < value.length &&
      !'/ ?#\t\r\n'.includes(value[authorityEnd]!)
    ) {
      authorityEnd += 1;
    }
    const at = value.indexOf('@', authorityStart);
    if (at >= 0 && at < authorityEnd) return true;
    marker = value.indexOf('//', Math.max(authorityEnd, authorityStart + 1));
  }
  return false;
}

function containsJwtLikeValue(value: string): boolean {
  if (!value.includes('.')) return false;
  const segments = value.split('.');
  for (let index = 0; index + 2 < segments.length; index += 1) {
    const middle = segments[index + 1]!;
    if (middle.length >= 8 && isTokenSegment(middle) &&
        trailingTokenCharacters(segments[index]!) >= 8 &&
        leadingTokenCharacters(segments[index + 2]!) >= 8) {
      return true;
    }
  }
  return false;
}

function isTokenSegment(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!isTokenCharacter(value.charCodeAt(index))) return false;
  }
  return true;
}

function leadingTokenCharacters(value: string): number {
  let index = 0;
  while (index < value.length && isTokenCharacter(value.charCodeAt(index))) {
    index += 1;
  }
  return index;
}

function trailingTokenCharacters(value: string): number {
  let index = value.length - 1;
  while (index >= 0 && isTokenCharacter(value.charCodeAt(index))) index -= 1;
  return value.length - index - 1;
}

function isTokenCharacter(code: number): boolean {
  return (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 45 ||
    code === 95;
}
