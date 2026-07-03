// api/_lib.js
// Shared helpers used by auth.js, scan.js, and redeem.js.
// NOTE: files starting with "_" inside /api are NOT exposed as routes by Vercel —
// this is a plain library file other functions import from, not an endpoint itself.

import { Redis } from '@upstash/redis';
import crypto from 'crypto';

export const kv = Redis.fromEnv();

export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > -1) {
      cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
    }
  });
  return cookies;
}

export function setSessionCookie(res, token) {
  const maxAge = 60 * 60 * 24 * 30; // 30 days
  res.setHeader('Set-Cookie', `verisyn_session=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `verisyn_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch { return false; }
}

export function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function parseUser(raw) {
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

export async function getSessionUser(req) {
  const token = parseCookies(req)['verisyn_session'];
  if (!token) return null;
  const email = await kv.get(`session:${token}`);
  if (!email) return null;
  const user = parseUser(await kv.get(`user:${email}`));
  if (!user) return null;
  return { email, isPro: !!user.isPro };
}

export async function getUserRecord(email) {
  return parseUser(await kv.get(`user:${email}`));
}

export async function saveUserRecord(email, record) {
  await kv.set(`user:${email}`, JSON.stringify(record));
}

export function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, used so quotas reset daily
}
