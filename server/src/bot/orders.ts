/**
 * 已购车票明细查询（需求：管理台「已购车票」主页面，包含已支付和待支付的）。
 *
 * 数据来源 = 12306 未完成订单（待支付/待出票）∪ 已完成订单（已支付/已出票）。
 * 与 reconcile.queryPurchasedTickets 的区别：后者只要「日期+车次」做对账查重，
 * 本模块保留完整订单明细（乘车人、席别、票价、支付截止时间）供管理台展示。
 *
 * 字段坑（与 reconcile.ts 一致，2026-09-20 实测订单 EQ61061412 / EQ96017972）：
 *  - 车次号在 ticket.stationTrainDTO.station_train_code
 *  - 乘车日期用 start_train_date_page（含上车时间），train_date 是 00:00:00 形态
 *  - 未完成订单里的票用 ticket_status_name 精确区分「待支付」
 *  - 支付截止时间在订单层 pay_limit_time（北京时间字符串，如 "2026-09-20 14:29"）
 */
import type { BrowserContext } from 'playwright';
import {
  fetchCompletedOrders,
  fetchIncompleteOrders,
  ticketYuan,
  warmOrderPage,
  type RawOrder,
  type RawTicket,
} from './orderApi.js';
import { Logger } from '../logger.js';
import { groupJourneys } from './journey.js';

import { fetchPersonalOrders, mergePersonalOrders } from './personal-orders.js';
const logger = new Logger('bot');

/** 同一订单的一个行程及票面状态（同程多人合并为一行） */
export interface OrderRow {
  orderNo: string;
  personalOnly?: boolean;
  /** unpaid=待支付；paid=已支付/已出票/已出站；refunded=已退票 */
  status: 'unpaid' | 'paid' | 'refunded';
  /** 12306 票面状态原文，如「待支付」/「已支付」/「已出票」 */
  statusText: string;
  /** 乘车日期+上车时间（北京时间，格式 YYYY-MM-DD HH:mm） */
  travelDateTime: string;
  /** 到达日期时间；接口缺失时不推算 */
  arrivalDateTime?: string | null;
  trainCode: string;
  fromStation: string;
  toStation: string;
  /** 乘车人姓名（多人） */
  passengers: string[];
  /** 席别+车厢座位（与 passengers 同长） */
  seats: string[];
  /** 总票价（元，所有票面价之和） */
  totalPrice: number | null;
  /** 未支付订单的支付截止时间（北京时间字符串） */
  payLimitTime: string | null;
  /** 支付截止时间的毫秒时间戳（前端据此做「确定刷新节点」） */
  payLimitTs: number | null;
  /** 同一换乘行程的几张票共用。单程为空。 */
  journeyId: string | null;
  /** 行程内第几程，从 1 开始。 */
  legIndex: number;
  /** 退票定位，每人一张。 */
  refundTickets: Array<{ passenger: string; batchNo: string; coachNo: string; seatNo: string }>;
}

/**
 * 把 12306 的时间字符串归一化为「YYYY-MM-DD HH:mm」。
 * start_train_date_page 形如 "2026-09-28 06:52"；train_date 形如 "2026-09-28 00:00:00"。
 */
function normDateTime(s: string | null | undefined): string {
  if (!s) return '';
  const m = /^(\d{4})\D(\d{1,2})\D(\d{1,2})(?:\D+(\d{1,2}):?(\d{2}))?/.exec(s);
  if (!m) return s;
  const [, y, mo, d, h, mi] = m;
  const hh = (h ?? '').padStart(2, '0');
  return h ? `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')} ${hh}:${(mi ?? '00').padStart(2, '0')}` : `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/** 校验北京时间字符串，非法日期（如 2 月 30 日）返回 null。 */
function validBeijing(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) return null;
  const instant = new Date(value.replace(' ', 'T') + ':00+08:00');
  if (!Number.isFinite(instant.getTime())) return null;
  const normalized = new Date(instant.getTime() + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
  return normalized === value ? value : null;
}

function nextCalendarDay(date: string): string {
  const d = new Date(date + 'T12:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** 从「HH:mm」或「日期 + 时刻」里取出钟点。 */
function clockOf(raw: string): { hh: string; mi: string } | null {
  const hm = /(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(raw.trim());
  if (!hm) return null;
  const hh = Number(hm[1]);
  const mi = Number(hm[2]);
  if (hh > 23 || mi > 59) return null;
  return { hh: String(hh).padStart(2, '0'), mi: hm[2] };
}

/**
 * 到达时间。真实到达日（不早于乘车日，含跨多日）直接采用。
 * 12306 常把到达时刻放在 1970-01-01 上，或只给 HH:mm：丢掉占位日期，用乘车日拼时刻；早于出发则算次日。
 */
function arrivalDateTime(ticket: RawTicket): string | null {
  const raw = String(ticket.stationTrainDTO?.arrive_time ?? '').trim();
  const depart = normDateTime(ticket.start_train_date_page ?? ticket.train_date);
  const dm = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/.exec(depart);
  const dated = validBeijing(normDateTime(raw));
  if (dated && (!dm || dated.slice(0, 10) >= dm[1])) return dated;
  const timeOnly = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.test(raw);
  const clock = clockOf(timeOnly ? raw : (dated ?? ''));
  if (!clock || !dm) return null;
  const date = `${clock.hh}:${clock.mi}` < `${dm[2]}:${dm[3]}` ? nextCalendarDay(dm[1]) : dm[1];
  return validBeijing(`${date} ${clock.hh}:${clock.mi}`);
}

/**
 * 把北京时间的「YYYY-MM-DD HH:mm」解析为毫秒时间戳。
 * 12306 下发的是无时区本地时间，统一按东八区(+08:00)解析。
 */
export function parseCnTimestamp(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})\D(\d{1,2})\D(\d{1,2})(?:\D+(\d{1,2}):?(\d{2}))?/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0'] = m;
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00+08:00`;
  const ts = new Date(iso).getTime();
  return Number.isNaN(ts) ? null : ts;
}

interface AccumOrder {
  orderNo: string;
  personalOnly?: boolean;
  fromIncomplete: boolean;
  statusText: string;
  travelDateTime: string;
  /** 到达日期时间；接口缺失时不推算 */
  arrivalDateTime?: string | null;
  trainCode: string;
  fromStation: string;
  toStation: string;
  passengers: string[];
  seats: string[];
  totalPrice: number | null;
  payLimitTime: string | null;
  payLimitTs: number | null;
  refundTickets: OrderRow['refundTickets'];
}

/** 同一订单按乘车日期、车次、区间和票面状态分组，避免串票价。 */
function ingestOrders(
  orders: RawOrder[],
  map: Map<string, AccumOrder>,
  fromIncomplete: boolean,
): void {
  for (const o of orders) {
    const orderNo = String(o.sequence_no ?? '').trim();
    if (!orderNo) continue;
    if (fromIncomplete) {
      for (const [key, row] of map) if (row.orderNo === orderNo) map.delete(key);
    }
    const groups = new Map<string, RawTicket[]>();
    for (const ticket of o.tickets ?? []) {
      const key = JSON.stringify([orderNo, normDateTime(ticket.start_train_date_page ?? ticket.train_date),
        ticket.stationTrainDTO?.station_train_code ?? '', ticket.stationTrainDTO?.from_station_name ?? '',
        ticket.stationTrainDTO?.to_station_name ?? '', cleanStatusText(String(ticket.ticket_status_name ?? o.ticket_status_name ?? ''))]);
      const group = groups.get(key) ?? [];
      group.push(ticket); groups.set(key, group);
    }
    for (const [key, tickets] of groups) {
      if (map.has(key) && !fromIncomplete) continue;
      const t0 = tickets[0];
      const statusText = String(t0.ticket_status_name ?? o.ticket_status_name ?? (fromIncomplete ? '未完成' : '已完成'));
      const payLimitTime = normPayLimit(o.pay_limit_time) ?? normPayLimit(tickets.find((t) => t.pay_limit_time)?.pay_limit_time);

      const prices = tickets.map(ticketYuan);
      const total = prices.every((price): price is number => price != null)
        ? prices.reduce((sum, price) => sum + Math.round(price * 100), 0) / 100 : null;

      map.set(key, {
        orderNo,
        personalOnly: tickets.some(t => t.personalOnly),
        fromIncomplete,
        statusText,
        travelDateTime: normDateTime(t0.start_train_date_page ?? t0.train_date),
        arrivalDateTime: arrivalDateTime(t0),
        trainCode: String(t0.stationTrainDTO?.station_train_code ?? '').trim(),
        fromStation: String(t0.stationTrainDTO?.from_station_name ?? '').trim(),
        toStation: String(t0.stationTrainDTO?.to_station_name ?? '').trim(),
        passengers: tickets.map((t) => String(t.passenger_name ?? t.passengerDTO?.passenger_name ?? '').trim()).filter(Boolean),
        seats: tickets
          .map((t) => {
            const bits = [t.coach_name, t.seat_name].filter(Boolean).join('车');
            return [t.seat_type_name, bits].filter(Boolean).join(' ');
          })
          .filter(Boolean),
        totalPrice: total,
        payLimitTime,
        payLimitTs: parseCnTimestamp(payLimitTime),
        refundTickets: tickets.map((t) => ({
          passenger: String(t.passenger_name ?? t.passengerDTO?.passenger_name ?? '').trim(),
          batchNo: String(t.batch_no ?? '').trim(),
          coachNo: String(t.coach_no ?? '').trim(),
          seatNo: String(t.seat_no ?? '').trim(),
        })).filter((t) => t.passenger),
      });
    }
  }
}

/**
 * 归一化支付截止时间，并过滤 12306 的哨兵值。
 * 已完成订单的票层 pay_limit_time 是 "2099-01-01 01:01:01"（表示无需支付），
 * 直接展示会变成一个吓人的 2099 截止时间，要丢弃。
 */
function normPayLimit(s: string | null | undefined): string | null {
  const v = normDateTime(s);
  if (!v) return null;
  if (/^(19|20)\d{2}-/.test(v) === false) return null;
  if (/^2099-/.test(v)) return null;
  return v;
}

/** 清理 12306 票面状态里的噪音：去掉「已退票(业务流水号:2EQ…)」的流水号部分 */
function cleanStatusText(s: string): string {
  return s.replace(/[（(].*?[）)]\s*$/, '').trim() || s;
}

/** AccumOrder → 对外 OrderRow（推导 status） */
function toRow(a: AccumOrder): OrderRow {
  const statusText = cleanStatusText(a.statusText);
  let status: OrderRow['status'];
  if (a.fromIncomplete && /待支付/.test(statusText)) {
    status = 'unpaid';
  } else if (/退票/.test(statusText)) {
    status = 'refunded';
  } else {
    status = 'paid';
  }
  return {
    orderNo: a.orderNo,
    personalOnly: a.personalOnly,
    status,
    statusText,
    travelDateTime: a.travelDateTime,
    arrivalDateTime: a.arrivalDateTime ?? null,
    trainCode: a.trainCode,
    fromStation: a.fromStation,
    toStation: a.toStation,
    passengers: a.passengers,
    seats: a.seats,
    totalPrice: a.totalPrice,
    payLimitTime: a.payLimitTime,
    payLimitTs: a.payLimitTs,
    journeyId: null,
    legIndex: 1,
    refundTickets: a.refundTickets,
  };
}

/** Pure normalization shared by network queries and offline regression checks. */
export function normalizeOrders(completed: RawOrder[], incomplete: RawOrder[]): OrderRow[] {
  const map = new Map<string, AccumOrder>();
  ingestOrders(completed, map, false);
  ingestOrders(incomplete, map, true);
  return groupJourneys([...map.values()].map(toRow));
}

/**
 * 查询当前账户的全部订单明细（未完成 + 已完成）。
 *
 * 排序：待支付在前（按支付截止时间升序，最紧急的在最上面），其余按乘车时间倒序。
 * 两个接口任一失败都 fail-open（返回能拿到的部分）；都失败时抛错让调用方提示用户。
 */
export async function queryOrders(context: BrowserContext, onPersonalError?: (message: string) => void): Promise<OrderRow[]> {
  const page = await context.newPage();
  try {
    // 先 initDc 预热 UAM 链，再停在订单查询页（fetch 的 Referer 由页面 URL 决定，
    // 且已完成订单接口必须 POST 带完整表单字段，否则 CDN 返回空响应）
    await warmOrderPage(page);

    const map = new Map<string, AccumOrder>();
    let anyOk = false;
    let completedOk = false;

    // 1) 已完成订单先入表（已支付/已出票）——POST 分页查询，列表在 OrderDTODataList
    try {
      let list = await fetchCompletedOrders(page, 90, true);
      completedOk = true;
      try { if (onPersonalError) list = mergePersonalOrders(list, await fetchPersonalOrders(context)); }
      catch (error) {
        const message = error instanceof Error ? error.message : '本人车票同步失败';
        onPersonalError?.(message);
        logger.warn('本人车票同步未完成', { message });
      }
      ingestOrders(list, map, false);
      logger.info('已完成订单入表', { count: list.length });
      anyOk = true;
    } catch (e) {
      logger.warn('已购票：已完成订单查询失败', e instanceof Error ? e.message : String(e));
    }

    // 2) 未完成订单覆盖入表（待支付/待出票）——POST，列表在 orderDBList
    let incompleteOk = false;
    try {
      // 空响应不能当成「没有待支付」。未确认就抛错，让页面保留旧数据，而不是把待支付藏掉。
      const list = await fetchIncompleteOrders(page, true);
      ingestOrders(list, map, true);
      logger.info('未完成订单入表', { count: list.length });
      incompleteOk = true;
      anyOk = true;
    } catch (e) {
      logger.warn('已购票：未完成订单查询失败', e instanceof Error ? e.message : String(e));
    }

    if (!anyOk) throw new Error('12306 订单查询失败（未完成与已完成接口均无响应，可能登录已失效）');
    if (!incompleteOk) throw new Error('未完成订单查询未确认');
    if (!completedOk) throw new Error('已完成订单查询未确认，暂不判断是否需要购票');

    const rows = groupJourneys([...map.values()].map(toRow));
    rows.sort((a, b) => {
      // 待支付置顶，按支付截止时间升序
      if (a.status === 'unpaid' && b.status !== 'unpaid') return -1;
      if (b.status === 'unpaid' && a.status !== 'unpaid') return 1;
      if (a.status === 'unpaid' && b.status === 'unpaid') return (a.payLimitTs ?? Infinity) - (b.payLimitTs ?? Infinity);
      // 其余按乘车时间倒序（最近的在前）
      return b.travelDateTime.localeCompare(a.travelDateTime);
    });
    return rows;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** 拦截型未支付订单（用户要求：有未支付订单时不下新单，等支付或失效） */
export interface UnpaidBlock {
  orderNo: string;
  /** 人类可读描述：乘车日期时间 + 车次 */
  describe: string;
  /** 支付截止时间戳（未知时为 null） */
  payLimitTs: number | null;
}

/**
 * 检查账户是否存在"拦截型"未支付订单：12306 每个账户同时只允许一个未支付订单，
 * 强行下新单会在点"预订"时被静默拦截。
 *
 * 不算拦截的情况：同日同车次的未支付订单——那是已购查重，交给 purchaseTicket
 * 内部的 dedup 处理（没指定车次时，同日任意车次都算查重）。
 * 注意同日不同车次的未支付订单仍会拦截：12306 限制的是"账户只能有一个未支付
 * 订单"，与日期无关，那张废票一样占着唯一名额。
 *
 * 查询失败时 fail-open 返回 null（放行到购票流程，由 purchaseTicket 自身检测兜底），
 * 与 checkOrders 的容错策略保持一致。
 */
export async function findBlockingUnpaid(
  context: BrowserContext,
  travelDate: string,
  trainCode: string | null,
): Promise<UnpaidBlock | null> {
  try {
    const rows = await queryOrders(context);
    const day = travelDate.replace(/\D/g, '').slice(0, 8);
    const code = trainCode ? trainCode.replace(/\s/g, '').toUpperCase() : null;
    const block = rows.find((r) => {
      if (r.status !== 'unpaid') return false;
      const rDay = r.travelDateTime.replace(/\D/g, '').slice(0, 8);
      const rCode = r.trainCode.replace(/\s/g, '').toUpperCase();
      // 同日（且同车次，若指定了车次）视为已购查重，不拦截
      if (rDay === day && (code === null || rCode === code)) return false;
      return true;
    });
    if (!block) return null;
    return {
      orderNo: block.orderNo,
      describe: `${block.travelDateTime} ${block.trainCode}`,
      payLimitTs: block.payLimitTs,
    };
  } catch (e) {
    logger.warn('未支付订单预检失败，放行到购票流程', e);
    return null;
  }
}
