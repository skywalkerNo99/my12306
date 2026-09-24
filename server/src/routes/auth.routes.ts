import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes, createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { UsersRepo } from '../db/repo.js';
import { getDb } from '../db/index.js';
import { MULTI_USER, SYSTEM_USER_ID } from '../config.js';
import { logContext, Logger } from '../logger.js';
import { wsHub } from '../ws/hub.js';
import type { AuthUser } from '../types.js';
export { SYSTEM_USER_ID };
declare module 'fastify' { interface FastifyRequest { authUser?: AuthUser; authExpires?: number } }
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const token = (r: FastifyRequest) => (r.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('my12306_session='))?.slice(16) || '';
const password = z.string().min(12).refine(s => Buffer.byteLength(s) <= 72, '密码最多 72 字节');
const username = z.string().regex(/^[a-zA-Z0-9_.-]{3,40}$/);
const logger = new Logger('auth');
const cookiePath = process.env.MY12306_COOKIE_PATH || '/';
if (!/^\/[a-zA-Z0-9/_-]*$/.test(cookiePath)) throw new Error('Invalid cookie path');
export function currentUser(request?: FastifyRequest): AuthUser {
  if (!MULTI_USER) return UsersRepo.findById(SYSTEM_USER_ID) ?? UsersRepo.createBuiltIn(SYSTEM_USER_ID);
  if (!request?.authUser) throw Object.assign(new Error('请先登录管理台'), { statusCode: 401 });
  return request.authUser;
}
export function revokeUserSessions(id: string): void {
  getDb().prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(id);
  wsHub.disconnectUser(id);
}
/** 必须在根实例注册，让 API 和 WebSocket 共用鉴权。 */
export function registerAuth(app: FastifyInstance): void {
  const attempts = new Map<string, { count: number; until: number }>();
  app.addHook('onRequest', (request, reply, done) => {
    const path = request.url.split('?')[0];
    if (!path.startsWith('/api/') && path !== '/ws') return done();
    // 拒绝跨站写操作与 WebSocket 握手，Cookie 同时使用 SameSite=Strict。
    const origin = request.headers.origin;
    if (origin && (path === '/ws' || !['GET', 'HEAD'].includes(request.method))) {
      try { if (new URL(origin).host !== request.headers.host) { void reply.code(403).send({ error: '不允许跨站请求' }); return; } }
      catch { void reply.code(403).send({ error: '请求来源无效' }); return; }
    }
    if (['/api/auth/mode', '/api/auth/login', '/api/health'].includes(path)) return done();
    if (MULTI_USER) {
      const row = getDb().prepare('SELECT user_id, expires_at FROM auth_sessions WHERE token_hash = ? AND expires_at > ?').get(hash(token(request)), Date.now()) as { user_id: string; expires_at: number } | undefined;
      const user = row && UsersRepo.findById(row.user_id);
      if (!user || user.disabled) { void reply.code(401).send({ error: '登录已过期，请重新登录管理台' }); return; }
      request.authUser = user;
      request.authExpires = row!.expires_at;
    } else request.authUser = currentUser();
    logContext.run(request.authUser.id, done);
  });
  app.get('/api/auth/mode', async () => ({ multiUser: MULTI_USER }));
  app.get('/api/auth/me', async request => currentUser(request));
  app.post('/api/auth/login', async (request, reply) => {
    if (!MULTI_USER) return reply.code(400).send({ error: '当前为本地单用户模式' });
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const rate = attempts.get(request.ip) ?? { count: 0, until: now + 15 * 60_000 };
    if (rate.count >= 10) return reply.code(429).send({ error: '尝试次数过多，请 15 分钟后重试' });
    rate.count++; attempts.set(request.ip, rate);
    const parsed = z.object({ username, password: z.string().min(1).max(100) }).safeParse(request.body);
    const user = parsed.success ? UsersRepo.findByUsername(parsed.data.username) : null;
    if (!parsed.success || !user || user.disabled || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) return reply.code(401).send({ error: '账号或密码错误，或账号已停用' });
    attempts.delete(request.ip);
    const sessionToken = randomBytes(32).toString('hex');
    getDb().prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
    getDb().prepare('INSERT INTO auth_sessions VALUES (?, ?, ?)').run(hash(sessionToken), user.id, now + 7 * 86400_000);
    reply.header('Set-Cookie', `my12306_session=${sessionToken}; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=604800${(request.protocol === 'https' || process.env.MY12306_SECURE_COOKIE === '1') ? '; Secure' : ''}`);
    logger.info('管理台登录成功', { userId: user.id });
    return UsersRepo.findById(user.id);
  });
  app.post('/api/auth/logout', async (request, reply) => {
    if (MULTI_USER) { getDb().prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hash(token(request))); wsHub.disconnectUser(currentUser(request).id); }
    reply.header('Set-Cookie', `my12306_session=; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=0`);
    return { ok: true };
  });
  app.post('/api/auth/password', async (request, reply) => {
    if (!MULTI_USER) return reply.code(404).send({ error: '未启用多用户模式' });
    const parsed = z.object({ oldPassword: z.string().max(100), password }).safeParse(request.body);
    const user = UsersRepo.findByUsername(currentUser(request).username)!;
    if (!parsed.success || !(await bcrypt.compare(parsed.data.oldPassword, user.passwordHash))) return reply.code(400).send({ error: '原密码错误，或新密码不足 12 字符 / 超过 72 字节' });
    UsersRepo.updatePassword(user.id, await bcrypt.hash(parsed.data.password, 12));
    revokeUserSessions(user.id);
    return { ok: true };
  });
  app.register(async admin => {
    admin.addHook('preHandler', async (request, reply) => {
      if (!MULTI_USER || currentUser(request).role !== 'admin') return reply.code(403).send({ error: '仅多用户模式管理员可用' });
    });
    admin.get('/api/admin/users', async () => UsersRepo.list());
    admin.post('/api/admin/users', async (request, reply) => {
      const parsed = z.object({ username, password, displayName: z.string().trim().min(1).max(60), role: z.enum(['admin', 'user']) }).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: '账号格式不正确或密码不足 12 字符 / 超过 72 字节' });
      const p = parsed.data;
      if (UsersRepo.findByUsername(p.username)) return reply.code(409).send({ error: '账号已存在' });
      const result = UsersRepo.create(p.username, await bcrypt.hash(p.password, 12), p.role, p.displayName);
      logger.info('创建管理台用户', { targetUserId: result.id });
      return result;
    });
    admin.patch('/api/admin/users/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = z.object({ displayName: z.string().trim().min(1).max(60).optional(), role: z.enum(['admin', 'user']).optional(), disabled: z.boolean().optional(), password: password.optional() }).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: '参数错误，密码须为至少 12 字符、最多 72 字节' });
      const old = UsersRepo.findById(id);
      if (!old) return reply.code(404).send({ error: '用户不存在' });
      const p = parsed.data;
      if (id === currentUser(request).id && (p.disabled || p.role === 'user')) return reply.code(400).send({ error: '不能停用或降级当前管理员' });
      const passwordHash = p.password ? await bcrypt.hash(p.password, 12) : null;
      const fresh = UsersRepo.findById(id)!;
      const enabledAdmins = UsersRepo.list().filter(u => u.role === 'admin' && !u.disabled).length;
      if (fresh.role === 'admin' && !fresh.disabled && (p.disabled || p.role === 'user') && enabledAdmins <= 1) return reply.code(409).send({ error: '至少保留一位已启用的管理员' });
      getDb().prepare("UPDATE users SET display_name = ?, role = ?, disabled = ?, password_hash = coalesce(?, password_hash), updated_at = datetime('now') WHERE id = ?").run(p.displayName ?? old.displayName, p.role ?? old.role, Number(p.disabled ?? old.disabled ?? false), passwordHash, id);
      revokeUserSessions(id);
      if (p.disabled) { const { closeSession, cancelQrLogin } = await import('../bot/session.js'); cancelQrLogin(id); await closeSession(id); }
      logger.info('更新管理台用户', { targetUserId: id, disabled: p.disabled, role: p.role, passwordReset: !!p.password });
      return UsersRepo.findById(id);
    });
  });
}
