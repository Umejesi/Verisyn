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

// Checks a password against HaveIBeenPwned's breach database using their
// k-anonymity API — only the first 5 chars of the SHA-1 hash are sent, so
// the actual password is never transmitted anywhere. Free, no API key.
export async function isPasswordBreached(password) {
  try {
    const hash = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`);
    if (!res.ok) return false; // fail open — don't block signup if the check service is down
    const text = await res.text();
    return text.split('\n').some(line => line.startsWith(suffix));
  } catch {
    return false; // fail open
  }
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
  return { email, isPro: !!user.isPro, plan: user.plan || null, isProPlus: user.plan === 'proplus' && !!user.isPro };
}

export async function getUserRecord(email) {
  return parseUser(await kv.get(`user:${email}`));
}

export async function saveUserRecord(email, record) {
  await kv.set(`user:${email}`, JSON.stringify(record));
}

// Used by passwordless flows (magic link, Google) — creates the account on
// first sign-in if it doesn't exist yet, with no password set.
export async function getOrCreateUser(email) {
  let record = await getUserRecord(email);
  if (!record) {
    record = { isPro: false, createdAt: Date.now(), authMethod: 'passwordless' };
    await saveUserRecord(email, record);
  }
  return record;
}

export function setShortCookie(res, name, value, maxAgeSeconds) {
  res.setHeader('Set-Cookie', `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`);
}

// Sends a magic sign-in link via Resend (free tier: 100 emails/day, no card).
// Requires RESEND_API_KEY env var. Silently no-ops with a console warning if
// it's not set yet, so local testing doesn't hard-crash before that's configured.
export async function sendMagicLinkEmail(email, link) {
  return sendEmail(email, 'Your Verisyn sign-in link',
    `<p>Click below to sign in to Verisyn:</p>
     <p><a href="${link}" style="background:#2451FF;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Sign in to Verisyn</a></p>
     <p style="color:#888;font-size:13px;">This link expires in 15 minutes. If you didn't request this, you can ignore this email.</p>`);
}

// Generic email sender used by both magic links and watchlist alerts.
export async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('RESEND_API_KEY not set — cannot send email:', subject);
    return false;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.MAGIC_LINK_FROM || 'Verisyn <onboarding@resend.dev>',
      to, subject, html
    })
  });
  return res.ok;
}

export function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, used so quotas reset daily
}

// Returns the real client IP behind Vercel's proxy. Used for rate limiting.
export function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Generic fixed-window rate limiter. Returns true if the action is allowed,
// false if the limit has been hit. Each call increments the counter.
export async function checkRateLimit(key, limit, windowSeconds) {
  const count = await kv.incr(key);
  if (count === 1) await kv.expire(key, windowSeconds);
  return count <= limit;
}

// SITE_URL must be set explicitly rather than falling back to the request's
// Host header — that header is client-controlled and shouldn't be trusted
// for building redirect URLs or links sent in emails.
export function requireSiteUrl() {
  const url = process.env.SITE_URL;
  if (!url) throw new Error('SITE_URL environment variable is not set.');
  return url;
}
