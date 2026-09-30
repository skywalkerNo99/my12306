import type { BrowserContext } from 'playwright';
import { URLS } from './constants.js';
export type SessionCheck = { status: 'active' | 'invalid' | 'unknown'; reason: string };
/** 网络或格式错误不等同于服务端明确拒绝登录。 */
export async function inspectSession(context: BrowserContext, now?: Date): Promise<SessionCheck> {
  const page = await context.newPage();
  try {
    await page.goto(URLS.CONFIRM_INIT_DC, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);
    const raw = await page.evaluate(async (url: string) => {
      const res = await fetch(url, { method: 'POST', credentials: 'include', signal: AbortSignal.timeout(15000) });
      return { ok: res.ok, status: res.status, body: await res.text() };
    }, URLS.CHECK_USER);
    if (!raw.ok) return { status: 'unknown', reason: `登录检查 HTTP ${raw.status}` };
    const data = JSON.parse(raw.body) as { data?: { flag?: boolean } };
    if (data.data?.flag === true) return { status: 'active', reason: '登录检查通过' };
    if (data.data?.flag === false) {
      // 售票暂停时 initDc/checkUser 也会返回未登录，05:00 后可自行恢复。
      // 服务时间以北京时间为准，不能使用运行机器的本地时区。
      // https://kyfw.12306.cn/otn/gonggao/onlineBooking.html
      const beijing = new Date((now ?? new Date()).getTime() + 8 * 60 * 60 * 1000);
      const hour = beijing.getUTCHours();
      const closed = hour < 5 && (hour >= 1 || beijing.getUTCDay() === 3);
      if (closed) return { status: 'unknown', reason: '12306 非售票时段，暂无法确认会话，05:00 后复查' };
      return { status: 'invalid', reason: '12306 明确返回未登录' };
    }
    return { status: 'unknown', reason: '登录检查返回格式异常' };
  } catch {
    return { status: 'unknown', reason: '登录检查网络异常或超时' };
  } finally { await page.close().catch(() => undefined); }
}

export function confirmedInvalid(previous: number, check: SessionCheck): number {
  return check.status === 'invalid' ? previous + 1 : 0;
}
