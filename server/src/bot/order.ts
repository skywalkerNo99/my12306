/**
 * 订单提交（需求 5）——只到"提交订单成功"，绝不进入支付环节。
 *
 * 完整链路（2026-09-18 实测验证通过）：
 *  1. queryZ API 查余票 → 选有余票的目标车次
 *  2. UAM 预热：goto initDc 触发 uamtk + uamauthclient（不做这步，点"预订"会卡在 checkUser flag:false）
 *  3. 查票页：URL 只填显示文本（南京/上海），隐藏电报码域 #fromStation/#toStation/#train_date
 *     必须手动填入电报码，否则点查询不触发 queryZ
 *  4. 点击目标车次"预订"按钮（a.btn72，即 checkG1234）→ checkUser flag:true →
 *     POST initDc?N + getPassengerDTOs → 确认页 SPA 渲染
 *  5. 轮询 globalRepeatSubmitToken（新版变量名，经典 REPEAT_SUBMIT_TOKEN 已不存在）
 *  6. checkOrderInfo → confirmSingleForQueue → resultOrderForQueue（不调起支付）
 *
 * 关键坑：
 *  - secretStr 本身已是 URL 编码形态，拼接时不能再 encodeURIComponent（双重编码返回空壳页）
 *  - 直接 GET 导航 initDc?secretStr 返回空壳页，必须通过"预订"按钮进入
 *  - 乘客字符串多人的用 _ 拼接成一个字段，不是 passengerTicketStr0/1 索引形式
 */
import type { BrowserContext, Page } from 'playwright';
import { URLS, SEAT_NAMES } from './constants.js';
import { Logger } from '../logger.js';
import { queryTrains, seatCount } from './tickets.js';
import { queryPurchasedTickets } from './reconcile.js';
import { existingTicket } from './existing-ticket.js';
import { queryOrders, parseCnTimestamp } from './orders.js';
import { submittedSeatNames } from './seat-result.js';
import type { Passenger, TrainInfo, TrainSegment } from '../types.js';

const logger = new Logger('bot');

export interface PurchaseParams {
  trainDate: string;
  fromStation: string;
  toStation: string;
  /** 指定车次；为空则按时间范围自动匹配 */
  trainNumbers: string[] | null;
  trainSegments?: TrainSegment[];
  /** 出发时间范围（含），如 08:00 / 09:00 */
  timeFrom?: string | null;
  timeTo?: string | null;
  /** 座位偏好 A/B/C/D/F（多选或空） */
  seatPositions?: string[] | null;
  /** 席别（必选多选，如 ZE 二等座 / ZY 一等座）：严格按所选席别匹配，不回退未选席别 */
  seatTypes?: string[] | null;
  /**
   * 是否允许购买无座票。默认 false：用户明确要求"除非计划里指定允许无座，
   * 否不要买无座票"。无座票也是正常可购票（长途车常有余票），但站着几小时
   * 不符合预期，所以必须由计划显式开启。
   */
  allowNoSeat?: boolean;
  /** 乘车人 */
  passengers: Passenger[];
}

export interface PurchaseResult {
  ok: boolean;
  trainCode: string;
  passengers: string[];
  seatInfo?: string;
  seatInfoSource?: 'submitted' | 'order';
  payDeadline?: string;
  /** 支付截止时间戳（毫秒，北京时间解析）；调度器据此设定"支付到期定时器" */
  payDeadlineTs?: number;
  orderNo?: string;
  error?: string;
  /** 查重命中：已购车票中已含目标车次，未实际下单，当日计划应标记完成 */
  duplicated?: boolean;
  /** 查重命中时，命中订单是否已支付（真实下单恒为未支付：本系统不付款） */
  paid?: boolean;
}

function inTimeRange(depart: string, from?: string | null, to?: string | null): boolean {
  if (!from || !to) return true;
  return depart >= from && depart <= to;
}

/**
 * 计算席别优先级。
 *
 * 优先用计划显式选择的 seatTypes（必选多选，严格按所选匹配，不回退未选席别）。
 * 没有时退化到旧逻辑：按座位位置 A/F 靠窗 → 二等座优先。
 *
 * 无论哪条路径都**不含 SWZ（商务座）**：用户明确要求不买商务座，
 * 常规席别售罄即失败告警，绝不静默回退商务座。
 */
function preferSeatTypes(params: PurchaseParams): string[] {
  // 计划显式选了席别：严格按用户选择，只过滤掉无效代码
  const chosen = params.seatTypes?.filter((c) => SEAT_NAMES[c]) ?? [];
  if (chosen.length) return chosen;
  // 兼容旧计划（无 seatTypes）：按座位位置推断
  const positions = params.seatPositions;
  if (!positions || !positions.length) return ['ZE', 'ZY', 'YW', 'RW', 'TZ'];
  const hasWindow = positions.some((p) => p === 'A' || p === 'F');
  return hasWindow ? ['ZE', 'ZY', 'YW', 'RW', 'TZ'] : ['ZY', 'ZE', 'YW', 'RW', 'TZ'];
}

/** 从余票结果中挑选目标车次（所选席别必须真有余票，不能只看字段非空） */
export function pickTrain(trains: TrainInfo[], params: PurchaseParams): TrainInfo | null {
  const wanted = params.trainNumbers?.map((t) => t.toUpperCase());
  const pref = preferSeatTypes(params);
  // 无座是否算"可接受的席别"：未显式允许时一律排除，避免买站票
  const noSeatOk = !!params.allowNoSeat;
  // 该车次是否有任一目标席别真有余票（"有"/数字>0），无座看开关
  const anySeat = (t: TrainInfo) =>
    Object.entries(t.seats).some(([name, v]) => {
      if (name === '无座' && !noSeatOk) return false;
      return v && v !== '无' && v !== '' && seatCount(v) > 0;
    });
  // 该车次的"偏好席别"是否真有余票（严格匹配，不含商务座/无座）
  const hasPrefSeat = (t: TrainInfo) => pref.some((code) => seatCount(t.seats[SEAT_NAMES[code]]) > 0);
  // 选出"有余票席别"集合，供后续提交时使用
  const candidates = trains
    .filter(t => {
      const segments = params.trainSegments?.filter(s => s.trainCode.toUpperCase() === t.trainCode.toUpperCase()) ?? [];
      return !segments.length || segments.some(s => s.fromStation === t.fromStation && s.toStation === t.toStation);
    })
    .filter((t) => t.departTime !== '--' && t.departTime !== '24:00')
    .filter((t) => inTimeRange(t.departTime, params.timeFrom, params.timeTo))
    .filter(anySeat)
    .sort((a, b) => a.departTime.localeCompare(b.departTime));
  if (wanted && wanted.length) {
    // 优先选"偏好席别有余票"的目标车次；都没有则仍返回目标车次，
    // 由 pickSeat 严格校验后失败并触发飞书告警（错误信息能精确到席别）
    return (
      candidates.find((t) => wanted.includes(t.trainCode.toUpperCase()) && hasPrefSeat(t)) ??
      candidates.find((t) => wanted.includes(t.trainCode.toUpperCase())) ??
      null
    );
  }
  // 自动匹配：优先选"偏好席别有余票"的最早一班；都没有再取最早一班（由 pickSeat 拦截并告警）
  return candidates.find(hasPrefSeat) ?? candidates[0] ?? null;
}

/** 从车次中按席别优先级挑出真正有余票的席别。
 *  严格匹配，不回退：常规席别（二等/一等/硬卧/软卧/特等）全部售罄即返回 null，
 *  由调用方失败告警。绝不静默回退到商务座——用户明确要求不买商务座，
 *  也不回退无座（除非计划显式开启 allowNoSeat，走下方单独分支）。 */
function pickSeat(train: TrainInfo, params: PurchaseParams): { code: string; name: string } | null {
  const ordered = preferSeatTypes(params);
  for (const code of ordered) {
    const name = SEAT_NAMES[code];
    const left = seatCount(train.seats[name]);
    if (left > 0) return { code, name };
  }
  // 计划显式允许无座时，无座才作为可接受的最后选择
  if (params.allowNoSeat && seatCount(train.seats['无座']) > 0) {
    return { code: 'WZ', name: '无座' };
  }
  return null;
}

/**
 * 下单前查重 + 冲突检测：在"已购"集合（未完成订单 ∪ 已完成订单）中查找。
 *
 * 1) 同日期 + 同车次 → 已购得（无论已支付还是未支付），无需再下单，直接标记当日计划完成。
 * 2) 存在其他未支付订单（含同日不同车次）→ 12306 每个账户同时只允许一个未支付订单，
 *    此时点"预订"不会跳确认页（页面弹窗提示先支付/取消），必须等用户处理掉才能继续。
 *
 * 查重失败时 fail-open（返回 null 继续走下单流程）：真有未支付订单时，
 * 下单流程自身也会被服务端拦截（点预订后不跳转），不会重复成交。
 */
interface OrderCheck {
  /** 拦截型冲突：账户存在其他未支付订单，新车票买不了 */
  blockingUnpaid?: { orderNo: string; date: string; trainCode: string };
}

async function checkOrders(context: BrowserContext): Promise<OrderCheck | null> {
  const purchased = await queryPurchasedTickets(context);
  if (!purchased) return null;
  // 精确已购匹配在查余票前完成，这里阻止剩余的未支付订单冲突。
  for (const [k, v] of purchased) {
    if (v.status !== 'unpaid') continue;

    const [d, c] = k.split('|');
    return { blockingUnpaid: { orderNo: v.orderNo, date: d.slice(0, 8), trainCode: c } };
  }
  return null;
}

/**
 * 乘车人字符串不能手拼！新版 12306 的 passengerTicketStr 末尾带服务端下发的
 * allEncStr 加密串（格式：seat,0,type,name,idType,idNo,phone,N,<allEncStr>），
 * 手拼的串会被服务端拒绝（统一返回"余票不足"）。
 * 正确做法：在确认页勾选对应乘客后，调用页面自己的 getpassengerTickets()/getOldPassengers()。
 */

interface NativeStrings {
  ticketStr: string;
  oldStr: string;
}

/** 在确认页勾选目标乘客，再用页面原生函数取出含加密串的字符串 */
async function pickPassengersAndGetStrings(page: Page, passengers: Passenger[]): Promise<NativeStrings | null> {
  // 勾选常用联系人 checkbox（按姓名匹配）
  const picked = await page.evaluate((names: string[]) => {
    const w = globalThis as unknown as {
      document?: {
        querySelectorAll?: (s: string) => Array<{
          checked?: boolean;
          click?: () => void;
          closest?: (s: string) => { textContent?: string } | null;
          getAttribute?: (s: string) => string | null;
        }>;
      };
    };
    const boxes = w.document?.querySelectorAll?.('#normal_passenger_id input[type="checkbox"]') ?? [];
    let hit = 0;
    for (const cb of boxes) {
      // checkbox 所在行/标签的文本
      const row = cb.closest?.('tr, li, label, .passenger-row');
      const txt = row?.textContent ?? cb.getAttribute?.('aria-label') ?? '';
      if (names.some((n) => txt.includes(n))) {
        if (!cb.checked) cb.click?.();
        hit++;
      }
    }
    return { total: boxes.length, hit };
  }, passengers.map((p) => p.name));
  logger.info('勾选乘车人', { ...picked });
  if (!picked.hit) {
    logger.warn('未在确认页找到任何目标乘车人', { names: passengers.map((p) => p.name) });
    return null;
  }
  await page.waitForTimeout(1000);

  // 调用页面原生函数，拿到含 allEncStr 的字符串
  const strs = await page.evaluate(() => {
    const w = globalThis as unknown as {
      getpassengerTickets?: () => string;
      getOldPassengers?: () => string;
    };
    try {
      return {
        ticketStr: w.getpassengerTickets?.() ?? '',
        oldStr: w.getOldPassengers?.() ?? '',
      };
    } catch {
      return { ticketStr: '', oldStr: '' };
    }
  });
  if (!strs.ticketStr || !strs.oldStr) {
    logger.warn('页面原生乘客字符串为空', strs);
    return null;
  }
  return strs;
}

/** 确认页渲染后的页面状态（token + 页面特征） */
interface ConfirmPageState {  token: string;
  hasSubmit: boolean;
  textLen: number;
}

async function readConfirmState(page: Page): Promise<ConfirmPageState> {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      globalRepeatSubmitToken?: unknown;
      document?: { body?: { textContent?: string } };
    };
    const g = w.globalRepeatSubmitToken;
    const txt = w.document?.body?.textContent ?? '';
    return {
      token: typeof g === 'string' ? g : '',
      hasSubmit: /提交订单/.test(txt),
      textLen: txt.length,
    };
  });
}

/**
 * 执行一次购票（提交订单，不付款）。
 * @param context 已登录的浏览器上下文
 */
export async function purchaseTicket(context: BrowserContext, params: PurchaseParams): Promise<PurchaseResult> {
  const names = params.passengers.map((p) => p.name);
  const page = await context.newPage();
  try {
    // 已购核对先于余票判断：已有票即完成，售罄不应掩盖已购事实。
    const owned = await queryOrders(context, message => logger.warn('购票前本人车票未完整同步', { message }));
    const existing = existingTicket(params, owned);
    if (existing) return existing;
    // 1) 查询余票，选车
    const trains = await queryTrains(context, {
      trainDate: params.trainDate,
      fromStation: params.fromStation,
      toStation: params.toStation,
    });
    const train = pickTrain(trains, params);
    if (!train) {
      return { ok: false, trainCode: params.trainNumbers?.[0] ?? '(自动匹配)', passengers: names, error: '未找到符合车次/时间条件的可购票车次' };
    }
    const secret = train.raw[0];
    if (!secret) {
      return { ok: false, trainCode: train.trainCode, passengers: names, error: '车次密钥缺失，可能不可购买' };
    }
    // 二次校验：所选车次的目标席别必须真有余票（queryZ 缓存与实际可能有时间差）
    const seat = pickSeat(train, params);
    if (!seat) {
      const wantedNames = preferSeatTypes(params).map((c) => SEAT_NAMES[c]).join('/');
      const reason = params.allowNoSeat
        ? `${train.trainCode} 所选席别（${wantedNames}）及无座均已无余票`
        : `${train.trainCode} 所选席别（${wantedNames}）已无余票（且计划未允许购买无座），严格匹配不回退商务座`;
      return { ok: false, trainCode: train.trainCode, passengers: names, error: reason };
    }

    // 1.5) 查重 + 未支付订单冲突检测
    //   - 同日同车次已购 → 跳过下单，当日计划标记完成
    //   - 存在其他日期的未支付订单 → 12306 拦截新订单，必须先处理掉
    const orderCheck = await checkOrders(context);
    if (orderCheck?.blockingUnpaid) {
      const b = orderCheck.blockingUnpaid;
      logger.warn('账户存在未支付订单，新订单被 12306 拦截', { train: train.trainCode, blockingOrder: b.orderNo, blockingDate: b.date, blockingTrain: b.trainCode });
      return {
        ok: false,
        trainCode: train.trainCode,
        passengers: names,
        error: `账户存在未支付订单 ${b.orderNo}（${b.date} ${b.trainCode}），12306 限制同一账户只能有一个未支付订单，请先支付或取消后再试`,
      };
    }

    // 2) UAM 预热：先访问确认页触发 uamtk + uamauthclient 单点登录链
    //    不做这步，后续点"预订"会在 checkUser 处被拦（flag:false）
    //    必须用 networkidle 等待异步登录链跑完，domcontentloaded 会在 uamtk 发出前返回
    logger.info('UAM 预热', { train: train.trainCode });
    await page.goto(URLS.CONFIRM_INIT_DC, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500);

    // 3) 查票页：URL 参数填显示文本，隐藏电报码域手动填
    const queryUrl =
      `${URLS.LEFT_TICKET_INIT}?linktypeid=dc` +
      `&fs=${encodeURIComponent(train.fromStation)}` +
      `&ts=${encodeURIComponent(train.toStation)}` +
      `&date=${params.trainDate}&flag=0`;
    await page.goto(queryUrl, { waitUntil: 'networkidle', timeout: 40000 });
    const { stationCode } = await import('./stations.js');
    const fromCode = await stationCode(train.fromStation);
    const toCode = await stationCode(train.toStation);
    if (!fromCode || !toCode) {
      return { ok: false, trainCode: train.trainCode, passengers: names, error: `车站电报码解析失败：${params.fromStation}/${params.toStation}` };
    }
    await page.evaluate(
      (args: { fc: string; tc: string; date: string }) => {
        const w = globalThis as unknown as {
          document?: { querySelector?: (s: string) => { value?: string } | null };
        };
        const set = (id: string, v: string) => {
          const el = w.document?.querySelector?.(`#${id}`);
          if (el) el.value = v;
        };
        set('fromStation', args.fc);
        set('toStation', args.tc);
        set('train_date', args.date);
      },
      { fc: fromCode, tc: toCode, date: params.trainDate },
    );
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        document?: { querySelector?: (s: string) => { click?: () => void } | null };
      };
      w.document?.querySelector?.('#query_ticket')?.click?.();
    });
    // 等车次列表渲染
    await page.waitForTimeout(5000);

    // 4) 点击目标车次的"预订"按钮（checkG1234）
    const clicked = await page.evaluate((target: { trainCode: string; fromStation: string; toStation: string; departTime: string; arriveTime: string }) => {
      const w = globalThis as unknown as {
        document?: {
          querySelectorAll?: (s: string) => Array<{
            click?: () => void;
            closest?: (s: string) => { textContent?: string; querySelectorAll?: (s: string) => Array<{ textContent?: string }> } | null;
          }>;
        };
      };
      const btns = Array.from(w.document?.querySelectorAll?.('a.btn72') ?? []);
      const matches = btns.filter(x => {
        const row = x.closest?.('tr');
        const labels = new Set(Array.from(row?.querySelectorAll?.('*') ?? []).map(el => el.textContent?.trim()));
        return [target.trainCode, target.fromStation, target.toStation, target.departTime, target.arriveTime].every(label => labels.has(label));
      });
      const btn = matches.length === 1 ? matches[0] : null;
      if (btn) {
        btn.click?.();
        return true;
      }
      return false;
    }, { trainCode: train.trainCode, fromStation: train.fromStation, toStation: train.toStation, departTime: train.departTime, arriveTime: train.arriveTime });
    if (!clicked) {
      return { ok: false, trainCode: train.trainCode, passengers: names, error: `查票页未找到 ${train.trainCode} 的预订按钮（可能已售罄或为候补）` };
    }
    logger.info('已点击预订按钮', { train: train.trainCode });

    // 4.5) 等待跳转到确认页（点击会触发 checkG1234 → checkUser → POST initDc → 页面跳转）
    //      若 UAM 未预热成功，checkUser 返回 flag:false 会停在原页面不跳转
    try {
      await page.waitForURL(/confirmPassenger\/initDc/, { waitUntil: 'domcontentloaded', timeout: 12000 });
    } catch {
      // 抓页面可见文本（12306 拦截未支付订单时弹窗写的是"您有未完成的订单"之类）
      const diag = await page
        .evaluate(() => {
          const w = globalThis as unknown as { document?: { body?: { textContent?: string } } };
          return (w.document?.body?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 400);
        })
        .catch(() => '');
      const s0 = await readConfirmState(page);
      logger.warn('点击预订后未跳转到确认页', { train: train.trainCode, url: page.url().slice(0, 80), textLen: s0.textLen, diag: diag.slice(0, 200) });
      // 未支付订单拦截：不是登录态问题，重试也没用，必须用户先处理
      if (/未完成|未支付|先.*支付|取消订单/.test(diag)) {
        return {
          ok: false,
          trainCode: train.trainCode,
          passengers: names,
          error: '点击预订后被 12306 拦截：账户存在未完成订单，请先支付或取消未支付订单',
        };
      }
      return {
        ok: false,
        trainCode: train.trainCode,
        passengers: names,
        error: '点击预订后未进入确认页（UAM 预热可能未生效或登录态异常）',
      };
    }

    // 5) 等确认页渲染（token 由页面 JS 异步写入全局变量，需轮询）
    let token = '';
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1000);
      const s = await readConfirmState(page);
      if (s.token && s.hasSubmit) {
        token = s.token;
        logger.info('确认页已渲染', { train: train.trainCode, textLen: s.textLen });
        break;
      }
    }
    if (!token) {
      const s = await readConfirmState(page);
      const snippet = await page
        .evaluate(() => {
          const w = globalThis as unknown as { document?: { body?: { textContent?: string } } };
          return (w.document?.body?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 300);
        })
        .catch(() => '');
      logger.warn('确认页未渲染', { train: train.trainCode, textLen: s.textLen, hasSubmit: s.hasSubmit, url: page.url().slice(0, 80), snippet: snippet.slice(0, 200) });
      const looksLikeLogin = /扫码登录|账号登录/.test(snippet);
      return {
        ok: false,
        trainCode: train.trainCode,
        passengers: names,
        error: looksLikeLogin ? '12306 登录已失效，请重新扫码登录' : `订单确认页令牌获取失败（textLen=${s.textLen}）`,
      };
    }

    // 6) 勾选乘客并取出原生字符串（含服务端下发的 allEncStr，手拼会被拒）
    const strs = await pickPassengersAndGetStrings(page, params.passengers);
    if (!strs) {
      return { ok: false, trainCode: train.trainCode, passengers: names, error: '确认页未找到目标乘车人，请检查常用联系人是否已同步' };
    }

    // The submitted passenger rows are authoritative; never read a seat name from page-wide text.
    const selectedLabels = await page.locator('select[id^="seatType_"] option:checked').allTextContents().catch(() => []);
    const actualSeats = submittedSeatNames(strs.ticketStr, selectedLabels);
    const allowed = new Set(preferSeatTypes(params).map(code => SEAT_NAMES[code]).filter(name => name !== '商务座'));
    if (params.allowNoSeat) allowed.add('无座');
    if (!actualSeats || actualSeats.length !== params.passengers.length || actualSeats.some(name => !allowed.has(name))) {
      return { ok: false, trainCode: train.trainCode, passengers: names,
        error: `${train.trainCode} 确认页席别无法核实或不符合计划，已停止提交，请检查席别设置` };
    }
    logger.info('订单参数就绪', { train: train.trainCode, seatQuery: seat.name, seatActual: actualSeats });

    // 7) checkOrderInfo（官方参数结构）
    const check = await page.evaluate(
      async (args: { url: string; token: string; pax: string; old: string }) => {
        const fd = new FormData();
        fd.append('cancel_flag', '2');
        fd.append('bed_level_order_num', '000000000000000000000000000000');
        fd.append('passengerTicketStr', args.pax);
        fd.append('oldPassengerStr', args.old);
        fd.append('tour_flag', 'dc');
        fd.append('randCode', '');
        fd.append('whatsSelect', '1');
        fd.append('sessionId', '');
        fd.append('REPEAT_SUBMIT_TOKEN', args.token);
        const res = await fetch(args.url, { method: 'POST', body: fd, credentials: 'include' });
        return { status: res.status, body: await res.text() };
      },
      { url: URLS.CHECK_ORDER_INFO, token, pax: strs.ticketStr, old: strs.oldStr },
    );
    const checkData = JSON.parse(check.body) as { data?: { submitStatus?: boolean; errMsg?: string }; messages?: string[] };
    if (checkData.data?.submitStatus !== true) {
      return {
        ok: false,
        trainCode: train.trainCode,
        passengers: names,
        error: `订单校验失败：${checkData.data?.errMsg ?? JSON.stringify(checkData.messages ?? check.body.slice(0, 200))}`,
      };
    }
    logger.info('checkOrderInfo 通过', { train: train.trainCode });

    // 8) 提交订单（confirmSingleForQueue，官方参数：从 ticketInfoForPassengerForm 取真实值）
    const submit = await page.evaluate(
      async (args: { url: string; token: string; pax: string; old: string }) => {
        const f = (globalThis as unknown as { ticketInfoForPassengerForm?: Record<string, unknown> })
          .ticketInfoForPassengerForm ?? {};
        const fd = new FormData();
        fd.append('passengerTicketStr', args.pax);
        fd.append('oldPassengerStr', args.old);
        fd.append('randCode', '');
        fd.append('purpose_codes', String(f.purpose_codes ?? 'ADULT'));
        fd.append('key_check_isChange', String(f.key_check_isChange ?? '1'));
        fd.append('leftTicketStr', String(f.leftTicketStr ?? ''));
        fd.append('train_location', String(f.train_location ?? ''));
        fd.append('whatsSelect', '1');
        fd.append('dwAll', 'N');
        fd.append('roomType', '00');
        fd.append('REPEAT_SUBMIT_TOKEN', args.token);
        const res = await fetch(args.url, { method: 'POST', body: fd, credentials: 'include' });
        return { status: res.status, body: await res.text() };
      },
      { url: URLS.CONFIRM_SINGLE, token, pax: strs.ticketStr, old: strs.oldStr },
    );
    const submitData = JSON.parse(submit.body) as {
      data?: { submitStatus?: boolean; isAsync?: string; errMsg?: string };
      messages?: string[];
    };
    if (submitData.data?.submitStatus !== true) {
      return {
        ok: false,
        trainCode: train.trainCode,
        passengers: names,
        error: `提交订单失败：${submitData.data?.errMsg ?? JSON.stringify(submitData.messages ?? submit.body.slice(0, 200))}`,
      };
    }
    logger.info('订单已提交，等待出票', { train: train.trainCode, isAsync: submitData.data?.isAsync });

    // 9) 异步排队时轮询订单结果（isAsync=1 时 12306 后台出票，需轮询）
    let orderNo: string | undefined;
    /** 支付截止时间（12306 下发的北京时间字符串，如 "2026-09-20 15:25:51"） */
    let payLimitRaw: string | undefined;
    const takePayLimit = (s: unknown): void => {
      if (typeof s !== 'string' || !s) return;
      // 只接受形如 "2026-09-20 15:25" / "2026-09-20 15:25:51" 的时间串，避免误吃脏数据
      if (/^\d{4}\D\d{1,2}\D\d{1,2}\D+\d{1,2}:\d{2}/.test(s)) payLimitRaw = s;
    };
    for (let i = 0; i < 20; i++) {
      const result = await page.evaluate(
        async (args: { url: string; tok: string }) => {
          const fd = new FormData();
          fd.append('REPEAT_SUBMIT_TOKEN', args.tok);
          fd.append('orderSequence', '');
          const res = await fetch(args.url, { method: 'POST', body: fd, credentials: 'include' });
          return res.text();
        },
        { url: URLS.RESULT_ORDER, tok: token },
      );
      try {
        const rd = JSON.parse(result) as {
          data?: {
            orderSequenceDTO?: { sequence_no?: string };
            submitStatus?: boolean;
            errMsg?: string;
            /** 支付截止时间（订单层） */
            pay_limit_time?: string;
          };
        };
        const seq = rd.data?.orderSequenceDTO?.sequence_no;
        if (seq) {
          orderNo = seq;
          takePayLimit(rd.data?.pay_limit_time);
          break;
        }
      } catch {
        // 排队期间可能返回非 JSON，继续轮询
      }
      await page.waitForTimeout(1500);
    }

    // 兜底：轮询未拿到订单号时，查未完成订单列表
    if (!orderNo || !payLimitRaw) {
      const noComplete = await page.evaluate(async (url: string) => {
        const res = await fetch(url, { credentials: 'include' });
        return res.text();
      }, 'https://kyfw.12306.cn/otn/queryOrder/queryMyOrderNoComplete');
      try {
        const nd = JSON.parse(noComplete) as {
          data?: { orderDBList?: Array<{ sequence_no?: string; pay_limit_time?: string }> };
        };
        const list = nd.data?.orderDBList ?? [];
        const hit = orderNo ? list.find((o) => o.sequence_no === orderNo) : list[0];
        if (!orderNo) orderNo = hit?.sequence_no;
        takePayLimit(hit?.pay_limit_time);
      } catch {
        // 忽略
      }
    }

    // 支付截止时间以 12306 下发为准（未支付订单通常保留 30/45 分钟，但以实际为准），
    // 拿不到时不编造——前端会显示"请尽快支付"而不给错误时限。
    const payDeadlineTs = parseCnTimestamp(payLimitRaw) ?? undefined;
    const payDeadline = payDeadlineTs
      ? new Date(payDeadlineTs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      : undefined;

    const seatSummary = [...new Set(actualSeats)].join('、');

    logger.info('订单已提交（未支付）', { train: train.trainCode, orderNo });

    return {
      ok: true,
      trainCode: train.trainCode,
      passengers: names,
      seatInfo: seatSummary,
      seatInfoSource: 'submitted',
      orderNo,
      // 12306 下发的实际支付截止时间（北京时间），拿不到时为 undefined——绝不编造
      payDeadline,
      payDeadlineTs,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('购票流程异常', e);
    return { ok: false, trainCode: params.trainNumbers?.[0] ?? '(自动匹配)', passengers: names, error: msg };
  } finally {
    await page.close().catch(() => undefined);
  }
}

// 保留 seatCount 引用（本模块通过车次信息汇总席别时使用）
void seatCount;
