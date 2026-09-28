/**
 * 12306 订单接口的统一请求层（orders.ts「已购车票」与 reconcile.ts「对账」共用）。
 *
 * 为什么不能简单 GET（2026-09-20 实测定位）：
 *  1. queryMyOrder（已完成订单）必须 POST，且请求体要带完整表单字段
 *     （queryType/queryStartDate/queryEndDate/come_from_flag/pageSize/pageIndex/
 *      query_where/sequeue_train_name）——缺字段时 12306 的 CDN 不报错，
 *     而是返回 HTTP 200 + content-length:0 的空响应（响应头 ct:"unknow"），
 *     上层 JSON.parse('') 抛错被 catch 后静默降级，表现就是"已购票永远同步不过来"。
 *  2. 页面必须先停在 ORDER_INIT 上：fetch 的 Referer 由页面 URL 自动带上。
 *  3. 两个接口的列表字段名不同：未完成=orderDBList，已完成=OrderDTODataList。
 *
 * 字段口径以 12306 自己的前端代码为准：
 *  - /otn/resources/js/center/queryMyOrder.js（旧版订单页）
 *  - /otn/personalJS/dist/train_order/main_v30108.js（新版 train_order.html）
 *    其中 r.data.orderDBList（未完成）与 n.data.OrderDTODataList（已完成）。
 */
import type { Page } from 'playwright';
import { URLS } from './constants.js';
import { Logger } from '../logger.js';

const logger = new Logger('bot');

/** 订单接口的公共请求头（与 12306 前端 jquery.ajax 一致） */
const ORDER_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'X-Requested-With': 'XMLHttpRequest',
} as const;

/** 12306 原始票（未完成/已完成接口字段的并集） */
export interface RawTicket {
  personalOnly?: boolean;
  /** 乘车日期（00:00:00 形态），跨日车不是真正的上车日 */
  train_date?: string;
  /** 页面展示用的上车日期+时间，如 "2026-09-28 06:52"（跨日车以此为准） */
  start_train_date_page?: string;
  passenger_name?: string;
  /** 已完成订单的乘车人信息在这个子对象里（未完成订单直接在票层 passenger_name） */
  passengerDTO?: { passenger_name?: string };
  seat_type_name?: string;
  coach_name?: string;
  seat_name?: string;
  /** 退票定位：批次、车厢、席位。12306 退票接口按这三项加订单号提交。 */
  batch_no?: string;
  coach_no?: string;
  seat_no?: string;
  /** 未完成订单的票价（元）；已完成订单不返回此字段 */
  price?: number | string;
  /** 已完成订单的票价（分），如 13600 = ¥136.00 */
  ticket_price?: number | string;
  /** 已完成订单的页面票价字符串（元），如 "136.0" */
  str_ticket_price_page?: string;
  /** 票面状态：待支付 / 已支付 / 已出票 等 */
  ticket_status_name?: string;
  /** 支付截止时间；已完成订单此字段是 2099 哨兵值，不是真实截止时间 */
  pay_limit_time?: string;
  stationTrainDTO?: {
    /** 到达日期时间（北京时间），如 2026-09-25 18:32 */
    arrive_time?: string;
    /** 新版订单页优先使用的本地到达时间 */
    arrive_time_local?: string;
    station_train_code?: string;
    from_station_name?: string;
    to_station_name?: string;
    trainDTO?: { start_date_str?: string };
  };
}
/** 12306 原始订单 */
export interface RawOrder {
  sequence_no?: string;
  /** 订单层支付截止时间（未完成订单才有） */
  pay_limit_time?: string;
  ticket_status_name?: string;
  tickets?: RawTicket[];
}

/**
 * 预热订单接口所需的页面状态：先 initDc 跑 UAM 单点登录链，再停在订单查询页。
 * 之后页面内发起的 fetch 会自动带上正确的 Referer（=ORDER_INIT）。
 *
 * 稳定性要点（实测）：ORDER_INIT 必须等到 networkidle——queryMyOrder.js 的
 * document.ready 处理会触发额外请求/跳转，只等 domcontentloaded 会在 fetch
 * 中途遇到导航，报 "TypeError: Failed to fetch"（执行上下文被销毁）。
 * 最后校验页面仍停在订单页，被重定向到登录页则提前失败，不浪费一次请求。
 */
export async function warmOrderPage(page: Page): Promise<void> {
  await page.goto(URLS.CONFIRM_INIT_DC, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => undefined);
  await page.waitForTimeout(1200);
  await page.goto(URLS.ORDER_INIT, { waitUntil: 'networkidle', timeout: 25000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  // 页面稳定校验：仍在订单页且未跳登录
  const url = page.url();
  if (!url.includes('/otn/queryOrder/init')) {
    logger.warn('订单预热后页面不在订单页（可能登录失效）', { url: url.slice(0, 80) });
    throw new Error('12306 登录可能已失效，页面被重定向（请重新扫码登录）');
  }
}

/** 页面内 POST（同源、带 cookie），返回响应原文；遇导航中断自动重试一次 */
async function postText(page: Page, url: string, body: string): Promise<string> {
  const doFetch = (): Promise<string> =>
    page.evaluate(
      async (args: { u: string; b: string }) => {
        const res = await fetch(args.u, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: args.b,
          credentials: 'include',
        });
        return res.text();
      },
      { u: url, b: body },
    );
  try {
    return await doFetch();
  } catch (e) {
    // 页面发生导航会中断 evaluate（"Failed to fetch"），等页面稳定后重试一次
    logger.warn('订单接口 fetch 中断，等待页面稳定后重试', { error: e instanceof Error ? e.message : String(e) });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
    await page.waitForTimeout(1000);
    return await doFetch();
  }
}

/**
 * 未完成订单（待支付/待出票）。
 * 请求体固定 `_json_att=`（12306 前端原样）；无未完成订单时响应里没有 data 字段。
 */
export async function fetchIncompleteOrders(page: Page, strict = false): Promise<RawOrder[]> {
  const raw = await postText(page, URLS.MY_ORDER_NO_COMPLETE, '_json_att=');
  if (!raw.trim()) {
    if (strict) throw new Error('未完成订单查询未确认');
    logger.warn('未完成订单接口返回空');
    return [];
  }
  const data = JSON.parse(raw) as { status?: boolean; messages?: string[]; data?: { existError?: string; orderDBList?: RawOrder[] } };
  if (strict && (data.status !== true || data.data?.existError === 'Y' || (data.messages?.length ?? 0) > 0 || (data.data?.orderDBList != null && !Array.isArray(data.data.orderDBList)))) throw new Error('未完成订单查询未确认');
  return data.data?.orderDBList ?? [];
}

/** 日期格式化为 12306 订单查询用的 YYYY-MM-DD（北京时间，不跟进程时区） */
export function fmtDay(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${day}`;
}

/**
 * 已完成订单（已支付/已出票）。POST 分页查询，自动翻页直到取完。
 *
 * @param days 查询最近多少天的订单（默认 90 天，覆盖整个预售期）
 * @returns 全部已完成订单（已按页顺序合并）
 */
export async function fetchCompletedOrders(page: Page, days = 90, strict = false): Promise<RawOrder[]> {
  const start = fmtDay(new Date(Date.now() - days * 86400_000));
  const end = fmtDay(new Date());
  const pageSize = 50;
  const all: RawOrder[] = [];

  for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
    const body =
      `queryType=1&queryStartDate=${start}&queryEndDate=${end}` +
      `&come_from_flag=my_order&pageSize=${pageSize}&pageIndex=${pageIndex}` +
      `&query_where=G&sequeue_train_name=`;
    const raw = await postText(page, URLS.MY_ORDER_COMPLETE, body);
    if (!raw.trim()) {
      if (strict) throw new Error('已完成订单查询未确认');
      logger.warn('已完成订单接口返回空（可能缺表单字段或登录失效）', { pageIndex });
      break;
    }
    const data = JSON.parse(raw) as {
      status?: boolean;
      data?: { OrderDTODataList?: RawOrder[]; order_total_number?: number | string };
    };
    if (strict && (data.status !== true || !Array.isArray(data.data?.OrderDTODataList))) throw new Error('已完成订单查询未确认');
    const list = data.data?.OrderDTODataList ?? [];
    all.push(...list);
    const total = Number(data.data?.order_total_number ?? 0);
    logger.info('已完成订单', { page: pageIndex, count: list.length, total });
    // 不满一页说明已是最后一页
    if (list.length < pageSize) break;
    if (strict && pageIndex === 19) throw new Error('订单过多，无法完整核对');
  }
  return all;
}

/**
 * 把一条票的票价统一换算成元。
 * - 已完成订单：ticket_price 是分（13600 → 136），str_ticket_price_page 是元的字符串
 * - 未完成订单：price 直接是元
 */
export function ticketYuan(t: RawTicket): number | null {
  if (t.str_ticket_price_page) {
    const v = Number(t.str_ticket_price_page);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  if (t.ticket_price != null && t.ticket_price !== '') {
    const v = Number(t.ticket_price);
    if (Number.isFinite(v) && v >= 0) return v / 100;
  }
  if (t.price != null && t.price !== '') {
    const v = Number(t.price);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  return null;
}
