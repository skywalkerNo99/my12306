import axios from 'axios';

export const http = axios.create({
  baseURL: typeof document === 'undefined' ? '/api' : new URL('api', document.baseURI).pathname,
  timeout: 30000,
  // XHR rejects custom schemes; Electron's protocol handler supports Fetch.
  adapter: typeof location !== 'undefined' && location.protocol === 'my12306:' ? 'fetch' : undefined,
});

// Bodyless actions still use JSON: Axios Fetch otherwise supplies a form Content-Type,
// which Fastify does not parse. Keep explicit payloads and their media types untouched.
http.interceptors.request.use(config => {
  if (config.method?.toLowerCase() === 'post' && config.data === undefined) {
    config.data = {};
    config.headers.set('Content-Type', 'application/json');
  }
  return config;
});

// ---- 乘车人 ----
export const passengerApi = {
  list: () => http.get('/passengers').then((r) => r.data),
  save: (data: Record<string, unknown>) => http.post('/passengers', data).then((r) => r.data),
  remove: (id: string) => http.delete(`/passengers/${id}`).then((r) => r.data),
};

// ---- 计划详情：推算日期 + 关联任务执行历史 ----
export interface TaskSnapshot {
  id: string;
  travelDate: string;
  trainNumber: string | null;
  /** 起售时刻（ISO） */
  saleAt: string | null;
  status: string;
  attempts: number;
  error: string | null;
  result: { paid?: boolean; trainCode?: string; seatInfo?: string; seatInfoSource?: 'submitted' | 'order'; orderNo?: string } | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface PlanDateEntry {
  manuallySkipped?: boolean;
  cancellationPending?: boolean;
  travelDate: string;
  originalDate: string;
  weekday: number;
  postponed: boolean;
  isWorkday: boolean;
  note?: string;
  /** 该年放假安排尚未公布，按自然周降级推算 */
  calendarPending?: boolean;
  estimatedSaleDate: string;
  /** 关联的购票任务（可能还没生成） */
  task: TaskSnapshot | null;
}

// ---- 计划 ----
export interface PlanForm {
  id?: string;
  name: string;
  fromStation: string;
  toStation: string;
  dateMode: 'single' | 'recurring' | 'workweek';
  travelDate: string | null;
  weekday: number | null;
  weekEdge: 'start' | 'end' | null;
  weekInterval: number;
  offsetDays: number;
  validFrom: string;
  validUntil: string | null;
  timeFrom: string | null;
  timeTo: string | null;
  trainNumbers: string[] | null;
  trainSegments?: Array<{ trainCode: string; fromStation: string; toStation: string }>;
  seatPositions: string[] | null;
  /** 席别（必选多选）：订票时严格按所选席别匹配，不回退未选席别 */
  seatTypes: string[];
  /** 是否允许购买无座票（默认 false：不买站票，除非明确勾选） */
  allowNoSeat: boolean;
  passengerIds: string[];
  /** 换乘后一程依赖的前一程计划。省略则保留原值。 */
  dependsOnPlanId?: string | null;
}

export const planApi = {
  cancelAndSkip: (id: string, taskId: string) => http.post(`/plans/${id}/tasks/${taskId}/cancel-and-skip`, { confirmed: true }, { timeout: 90000 }).then(r => r.data),
  skipDate: (id: string, date: string, skipped: boolean) => http.put(`/plans/${id}/dates/${date}/skip`, { skipped }).then(r => r.data),
  list: () => http.get('/plans').then((r) => r.data),
  save: (data: PlanForm) => http.post('/plans', data).then((r) => r.data),
  setStatus: (id: string, status: 'active' | 'paused' | 'deleted') =>
    http.post(`/plans/${id}/status`, { status }).then((r) => r.data),
  previewDates: (data: PlanForm) => http.post('/plans/preview-dates', data).then((r) => r.data),
  dates: (id: string) => http.get(`/plans/${id}/dates`).then((r) => r.data as PlanDateEntry[]),
  stations: (keyword: string) => http.get('/stations', { params: { keyword } }).then((r) => r.data),
  /** 手动重试失败/已跳过的任务（重置为 queued 立即重跑） */
  retryTask: (planId: string, taskId: string) =>
    http.post(`/plans/${planId}/tasks/${taskId}/retry`).then((r) => r.data as TaskSnapshot),
};

// ---- 会话（扫码登录，不保存密码） ----
export interface QrSnapshot {
  attemptId: string; phase: 'loading' | 'ready' | 'scanned' | 'expired' | 'refreshing' | 'error' | 'cancelled' | 'success';
  image: string | null; status: string; autoRefresh: boolean; revision: number;
}
export const sessionApi = {
  state: () => http.get('/session').then((r) => r.data),
  login: (attemptId: string, autoRefresh: boolean) => http.post<QrSnapshot>('/session/login', { attemptId, autoRefresh }).then(r => r.data),
  qr: (attemptId: string) => http.get<QrSnapshot>('/session/qr', { params: { attemptId } }).then(r => r.data),
  refreshQr: (attemptId: string) => http.post<QrSnapshot>('/session/refresh-qr', { attemptId }).then(r => r.data),
  qrOptions: (attemptId: string, autoRefresh: boolean) => http.post<QrSnapshot>('/session/qr-options', { attemptId, autoRefresh }).then(r => r.data),
  cancelLogin: (attemptId: string) => http.post('/session/cancel-login', { attemptId }).then(r => r.data),
  check: () => http.post('/session/check').then((r) => r.data),
  logout: () => http.post('/session/logout').then((r) => r.data),
  syncPassengers: () => http.post('/session/sync-passengers').then((r) => r.data),
};

// ---- 节假日日历（供两个日历标记节假日/调休补班） ----
export interface HolidayDay {
  date: string;
  isWorkday: boolean;
  holiday: string | null;
}

/** 节假日日历响应：days 为日期列表，calendarPending 表示该年放假安排尚未发布（按自然周兜底） */
export interface HolidayResponse {
  days: HolidayDay[];
  /** 该年放假安排尚未公布，工作日判定退回自然周；数据就绪后后端会自动重算 */
  calendarPending: boolean;
}

export const calendarApi = {
  /** 指定年月，返回该月每天的节假日信息 */
  holidays: (year: number, month: number) =>
    http.get('/calendar/holidays', { params: { year, month } }).then((r) => r.data as HolidayResponse),
  /** 指定自然年，返回全年 12 个月的节假日信息（供前端按年缓存，切月份时零延迟） */
  holidaysOfYear: (year: number) =>
    http.get('/calendar/holidays', { params: { year } }).then((r) => r.data as HolidayResponse),
};

// ---- 席别与车次（从 12306 透传，不在前端写死） ----
export interface SeatTypeOption {
  code: string;
  name: string;
}

export interface TrainOption {
  trainCode: string;
  fromStation: string;
  toStation: string;
  departTime: string;
  arriveTime: string;
  duration: string;
  /** 该车次余票里出现的席别代码列表 */
  seatTypes: string[];
  /** 各席别余票文本（席别中文名 → 余票数量/「有」「无」） */
  seats?: Record<string, string>;
}

export interface TravelScheme {
  kind: 'transfer' | 'same-train' | 'supplement';
  label: string;
  fromStation: string;
  middleStation: string;
  toStation: string;
  departTime: string;
  arriveTime: string;
  duration: string;
  waitTime: string;
  legs: Array<{
    trainCode: string;
    fromStation: string;
    toStation: string;
    departTime: string;
    arriveTime: string;
    duration: string;
    date?: string;
    seats: Record<string, string>;
    seatTypes?: string[];
  }>;
}

export const metaApi = {
  seatTypes: () => http.get('/meta/seat-types').then((r) => r.data as SeatTypeOption[]),
  trains: (from: string, to: string, date: string) =>
    http.get('/trains/search', { params: { from, to, date } }).then((r) => r.data as { trains: TrainOption[]; schemes?: TravelScheme[] }),
};

// ---- 任务与日志 ----
export const taskApi = {
  list: () => http.get('/tasks').then((r) => r.data),
};

// ---- 已购车票（已支付 + 待支付） ----
export interface OrderRow {
  personalOnly?: boolean;
  orderNo: string;
  /** unpaid=待支付；paid=已支付/已出票/已出站；refunded=已退票 */
  status: 'unpaid' | 'paid' | 'refunded';
  statusText: string;
  /** 乘车日期+上车时间（北京时间 YYYY-MM-DD HH:mm） */
  travelDateTime: string;
  arrivalDateTime?: string | null;
  trainCode: string;
  fromStation: string;
  toStation: string;
  passengers: string[];
  seats: string[];
  totalPrice: number | null;
  /** 支付截止时间（北京时间字符串） */
  payLimitTime: string | null;
  /** 支付截止时间戳（毫秒），前端据此做「确定刷新节点」 */
  payLimitTs: number | null;
  /** 换乘几张票合成一条时共用。单程为空。 */
  journeyId?: string | null;
  legIndex?: number;
  refundTickets?: Array<{ passenger: string; batchNo: string; coachNo: string; seatNo: string }>;
}

export interface ChangeOption {
  kind: 'direct' | 'transfer' | 'same-train' | 'supplement';
  label: string;
  fromStation: string;
  toStation: string;
  departTime: string;
  arriveTime: string;
  duration: string;
  trains: string[];
  reason: string;
  legs: Array<{ trainCode: string; fromStation: string; toStation: string; departTime: string; arriveTime: string; date: string; seatTypes: string[] }>;
}

export interface OrdersResponse {
  warning?: string;
  orders: OrderRow[];
  fetchedAt: number;
  cached?: boolean;
  stale?: boolean;
  error?: string;
}

export const ordersApi = {
  list: () => http.get('/orders').then((r) => r.data as OrdersResponse),
  refund: (legs: Array<{ orderNo: string; trainCode: string; fromStation: string; toStation: string }>) =>
    http.post('/orders/refund', { legs }).then((r) => r.data as { ok: boolean }),
  changeOptions: (body: { mode: 'to-direct' | 'to-transfer'; fromStation: string; toStation: string; date: string; departTime: string; currentTrains: string[] }) =>
    http.post('/orders/change-options', body).then((r) => r.data as { options: ChangeOption[] }),
};

/** WebSocket 实时通道（日志/会话/任务/扫码二维码） */
export class WsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeDesktop: (() => void) | null = null;

  constructor() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.url = `${proto}//${location.host}${new URL('ws', document.baseURI).pathname}`;
  }

  connect(handlers: {
    onConnection?: (connected: boolean) => void;
    onLog?: (m: unknown) => void;
    onSession?: (m: unknown) => void;
    onTask?: (m: unknown) => void;
    onQrCode?: (m: QrSnapshot) => void;
  }): void {
    this.close();
    this.stopped = false;
    const receive = (msg: { type: string; payload: unknown }) => {
      try {
        if (msg.type === 'log') handlers.onLog?.(msg.payload);
        if (msg.type === 'session') handlers.onSession?.(msg.payload);
        if (msg.type === 'task') handlers.onTask?.(msg.payload);
        if (msg.type === 'qr_code') handlers.onQrCode?.(msg.payload as QrSnapshot);
      } catch {
        // ignore
      }
    };
    const desktop = (window as Window & { my12306Desktop?: { onEvent?: (callback: typeof receive) => () => void } }).my12306Desktop;
    if (desktop?.onEvent && location.protocol === 'my12306:') {
      this.unsubscribeDesktop = desktop.onEvent(receive);
      handlers.onConnection?.(true);
      return;
    }
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => handlers.onConnection?.(true);
    this.ws.onmessage = ev => { try { receive(JSON.parse(ev.data)); } catch { /* Ignore malformed messages. */ } };
    this.ws.onclose = () => {
      // 断线 3 秒后重连
      handlers.onConnection?.(false);
      if (!this.stopped) this.reconnectTimer = setTimeout(() => this.connect(handlers), 3000);
    };
  }

  sendQrCancel(attemptId: string): void {
    if (this.unsubscribeDesktop) { void sessionApi.cancelLogin(attemptId).catch(() => undefined); return; }
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'qr_cancel', payload: { attemptId } }));
  }

  close(): void {
    this.unsubscribeDesktop?.();
    this.unsubscribeDesktop = null;
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) this.ws.onclose = null;
    this.ws?.close();
    this.ws = null;
  }
}

http.interceptors.response.use(r => r, error => {
  if (error.response?.status === 401 && !String(error.config?.url).startsWith('/auth/')) {
    location.hash = '#/login'; location.reload();
  }
  return Promise.reject(error);
});
export function apiError(e: unknown): string { return (e as { response?: { data?: { error?: string } } }).response?.data?.error || '操作失败，请检查网络后重试'; }
export interface NotificationChannel {
  id: string; name: string; type: string; enabled: boolean; events: string[];
  config: Record<string, string>; configured: Record<string, boolean>; lastStatus?: string; lastSentAt?: string;
}
export const notificationApi = { list: () => http.get<NotificationChannel[]>('/notifications').then(r => r.data) };
