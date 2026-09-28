<script setup lang="ts">
import CalendarTicket from '../components/CalendarTicket.vue';
import CalendarDayHeader from '../components/CalendarDayHeader.vue';
import { CALENDAR_WEEK_LABELS } from '../utils/calendar-day';
import ShareImageDialog from '../components/ShareImageDialog.vue';
import type { ShareContent } from '../utils/share-image';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { notificationApi, taskApi, ordersApi, calendarApi, type OrderRow, type HolidayDay } from '../api';
import { sessionState } from '../store/session';

const activeChannels = ref(0);
const shareContent = ref<ShareContent | null>(null);
const stats = ref({ pending: 0, queried: 0, running: 0, success: 0, failed: 0 });
const loading = ref(false);

// ---- 车票日历：已支付车票按乘车日标记，支持乘车人筛选 ----
const orders = ref<OrderRow[]>([]);
const ordersError = ref('');
/** 日历当前展示的月份 */
const calMonth = ref(new Date());
/** 乘车人筛选：'' = 全部乘车人 */
const calPassenger = ref('');

/** 可选乘车人（全部订单去重） */
const passengers = computed(() => {
  const set = new Set<string>();
  for (const o of orders.value) for (const p of o.passengers ?? []) set.add(p);
  return [...set].sort();
});

/**
 * 乘车人默认选第一个（用户要求：不默认空白）。
 * 车票数据加载后，若用户还没选过，自动选第一个乘车人。
 */
watch(
  passengers,
  (list) => {
    if (!calPassenger.value && list.length) calPassenger.value = list[0];
  },
  { immediate: true },
);

/** 已支付车票（排除退票/未支付），按选中乘车人过滤 */
const paidOrders = computed(() =>
  orders.value.filter(
    (o) => o.status === 'paid' && (!calPassenger.value || (o.passengers ?? []).includes(calPassenger.value)),
  ),
);

/**
 * 车票数据缓存（按乘车人维度），避免每次打开/切月都重新请求。
 *
 * 策略（用户要求"实现缓存和异步刷新"）：
 *  - 首次加载某乘车人的车票：同步等待（日历要有数据才能渲染）
 *  - 之后再次进入：立即用缓存渲染，再后台静默刷新（用户无感）
 *  - 刷新时机：onMounted + 登录状态变化 + 每次打开页面（document.visibilitychange
 *    从隐藏切回可见时刷新——这是最佳时机：用户重新看页面时数据最新，且不重复刷）
 */
const ordersCache = new Map<string, { orders: OrderRow[]; fetchedAt: number }>();
/** 缓存有效期：10 分钟内的缓存直接用，超时才后台刷新 */
const CACHE_TTL_MS = 10 * 60 * 1000;
/** 是否正在后台刷新（控制加载提示，首次加载才显示 loading） */
const ordersBgRefreshing = ref(false);

/** 当前乘车人对应的缓存 key（'' = 全部乘车人） */
function cacheKey(): string {
  return calPassenger.value || '__all__';
}

interface DayCell {
  day: number;
  date: string;
  tickets: OrderRow[];
  /** 该日节假日信息（预算好，模板直接读，不重复查表） */
  hol: HolidayDay | undefined;
  /** 是否今天（预算好，模板不算日期） */
  isToday: boolean;
}
/** 月份网格（前置空位用 null 占位） */
const calendarCells = computed<(DayCell | null)[]>(() => {
  const y = calMonth.value.getFullYear();
  const m = calMonth.value.getMonth();
  const startWeekday = (new Date(y, m, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const hmap = holidayMap.value;
  const today = todayStr.value;
  const visible = orders.value.filter(
    (o) => o.status !== 'refunded' && (!calPassenger.value || (o.passengers ?? []).includes(calPassenger.value)),
  );
  const cells: (DayCell | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({
      day: d,
      date: dateStr,
      tickets: visible.filter((o) => (o.travelDateTime ?? '').slice(0, 10) === dateStr),
      hol: hmap.get(dateStr),
      isToday: dateStr === today,
    });
  }
  return cells;
});

/** 日历格子按票面状态分行。待支付单独成行，已变更、已改签不并进已支付。 */
const STATUS_RANK = ['待支付', '已支付', '已变更', '已改签'];
function statusName(ticket: OrderRow): string {
  const text = ticket.statusText || '';
  if (ticket.status === 'unpaid' || text.includes('待支付')) return '待支付';
  if (text.includes('变更')) return '已变更';
  if (text.includes('改签')) return '已改签';
  if (ticket.status === 'refunded' || text.includes('退票')) return '已退票';
  return '已支付';
}
function statusLines(tickets: OrderRow[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const ticket of tickets) counts.set(statusName(ticket), (counts.get(statusName(ticket)) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (STATUS_RANK.indexOf(a.name) < 0 ? 99 : STATUS_RANK.indexOf(a.name)) - (STATUS_RANK.indexOf(b.name) < 0 ? 99 : STATUS_RANK.indexOf(b.name)));
}
function departClock(ticket: OrderRow): string {
  const clock = (ticket.travelDateTime ?? '').slice(11, 16);
  return /^\d{2}:\d{2}$/.test(clock) ? clock : '时间待定';
}

const calTitle = computed(() => `${calMonth.value.getFullYear()} 年 ${calMonth.value.getMonth() + 1} 月`);
const monthTicketCount = computed(() => calendarCells.value.reduce((n, c) => n + (c?.tickets.length ?? 0), 0));
const paidCount = computed(() => orders.value.filter((o) => o.status === 'paid').length);

/** 今天（本地时区，YYYY-MM-DD）——不能用 toISOString，那是 UTC，东八区凌晨会差一天 */
const todayStr = computed(() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
});

/** 点格子打开当天列表，列表按出发时刻分段。点其中一张再看详情。 */
const dayTickets = ref<OrderRow[]>([]);
const dayDate = ref('');
const dayOpen = ref(false);
const dayGroups = computed(() => {
  const groups = new Map<string, OrderRow[]>();
  for (const ticket of dayTickets.value) {
    const clock = departClock(ticket);
    const rows = groups.get(clock) ?? [];
    rows.push(ticket);
    groups.set(clock, rows);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([time, tickets]) => ({ time, tickets }));
});
function openDay(cell: DayCell): void {
  if (!cell.tickets.length) return;
  dayDate.value = cell.date;
  dayTickets.value = cell.tickets;
  dayOpen.value = true;
}

/** 点击车票弹出详情 */
const ticketDetail = ref<OrderRow | null>(null);
const ticketDetailVisible = ref(false);
function openTicketDetail(t: OrderRow): void {
  ticketDetail.value = t;
  ticketDetailVisible.value = true;
}

function shiftMonth(delta: number): void {
  calMonth.value = new Date(calMonth.value.getFullYear(), calMonth.value.getMonth() + delta, 1);
}

/** 切换乘车人：有缓存立即渲染，否则加载（切月不重新请求，车票数据与月份无关） */
watch(calPassenger, () => {
  void reloadOrders();
});

// ---- 节假日标记：按自然年缓存，切月份零延迟 ----
/** 当前展示月份的节假日数据（从年度缓存里切片得到） */
const holidays = ref<HolidayDay[]>([]);
/** 按自然年缓存：year -> 全年节假日数据。只有首次访问某年时才调接口 */
const holidaysByYear = new Map<number, HolidayDay[]>();
/** 按自然年缓存"该年放假安排是否尚未公布"，切月份时零延迟 */
const pendingYears = new Map<number, boolean>();
/** 当前展示年放假安排尚未公布（日历按自然周兜底，公布后自动更新） */
const calendarPending = ref(false);

async function reloadHolidays(): Promise<void> {
  const y = calMonth.value.getFullYear();
  const m = calMonth.value.getMonth() + 1;
  const prefix = `${y}-${String(m).padStart(2, '0')}-`;
  // 年度缓存命中：同步切片返回，无网络延迟
  const cached = holidaysByYear.get(y);
  if (cached) {
    holidays.value = cached.filter((h) => h.date.startsWith(prefix));
    calendarPending.value = pendingYears.get(y) ?? false;
    return;
  }
  // 首次访问该年：一次接口拿全年数据，之后该年内切月份不再请求
  try {
    const res = await calendarApi.holidaysOfYear(y);
    holidaysByYear.set(y, res.days);
    pendingYears.set(y, res.calendarPending);
    holidays.value = res.days.filter((h) => h.date.startsWith(prefix));
    calendarPending.value = res.calendarPending;
  } catch {
    holidays.value = [];
    calendarPending.value = false;
  }
}

/** date -> 节假日信息 的查表 Map（一次构建，模板 O(1) 查询） */
const holidayMap = computed(() => {
  const map = new Map<string, HolidayDay>();
  for (const h of holidays.value) map.set(h.date, h);
  return map;
});

/** 某日期的节假日信息（放假/补班），用于日历格子标记 */
function holidayOf(dateStr: string): HolidayDay | undefined {
  return holidayMap.value.get(dateStr);
}

watch(calMonth, () => void reloadHolidays(), { immediate: false });

const WEEK_LABELS = CALENDAR_WEEK_LABELS;

/**
 * 车票日历数据（12306 未登录时优雅降级为空日历）。
 *
 * 首次加载同步等待（页面要有数据）；有缓存时立即渲染缓存 + 后台静默刷新。
 * 后台刷新失败不清空已有数据（缓存里的是有效票，只是可能不是最新）。
 */
async function reloadOrders(): Promise<void> {
  const key = cacheKey();
  const cached = ordersCache.get(key);
  // 有缓存：立即渲染，再后台刷新（用户无感，页面不闪）
  if (cached) {
    orders.value = cached.orders;
    ordersError.value = '';
    void refreshOrdersInBackground();
    return;
  }
  // 首次加载：显示 loading 同步等待
  await fetchOrders(true);
}

/** 后台静默拉取最新车票并更新缓存与视图 */
async function refreshOrdersInBackground(): Promise<void> {
  if (ordersBgRefreshing.value) return;
  ordersBgRefreshing.value = true;
  try {
    await fetchOrders(false);
  } finally {
    ordersBgRefreshing.value = false;
  }
}

/** 实际请求车票接口；first=true 时错误写入 ordersError，后台刷新失败只静默记录 */
async function fetchOrders(first: boolean): Promise<void> {
  try {
    const data = await ordersApi.list();
    const list = data.orders ?? [];
    orders.value = list;
    ordersError.value = '';
    ordersCache.set(cacheKey(), { orders: list, fetchedAt: Date.now() });
  } catch (e) {
    if (first) {
      orders.value = [];
      ordersError.value = (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? '车票数据加载失败';
    }
    // 后台刷新失败：保留缓存数据，不报错给用户看
  }
}

/**
 * 统计卡数据（飞书 + 任务）：两个接口互相独立，并行拉取。
 * 与车票/节假日解耦，不再被 12306 车票查询拖住。
 */
async function reloadStats(): Promise<void> {
  try {
    const [channels, tasks] = (await Promise.all([notificationApi.list(), taskApi.list()])) as [
      Array<{ enabled: boolean }>,
      Array<{ status: string }>,
    ];
    activeChannels.value = channels.filter(c => c.enabled).length;
    stats.value = {
      pending: tasks.filter((t) => t.status === 'pending').length,
      queried: tasks.filter((t) => t.status === 'queried').length,
      running: tasks.filter((t) => t.status === 'running').length,
      success: tasks.filter((t) => t.status === 'success').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
    };
  } catch {
    // 统计卡失败不应影响日历：保留默认值，下次可见性刷新时重试
  }
}

/**
 * 12306 登录/退出后立即刷新车票日历：扫码登录成功时用户通常正停在仪表盘上，
 * 只更新会话状态不重拉车票，日历就会一直空着。
 */
watch(
  () => sessionState.value.loggedIn,
  (loggedIn, prev) => {
    if (loggedIn === prev) return;
    if (loggedIn) {
      // 登录成功：清掉旧缓存强制拉新数据（之前可能是未登录的空结果）
      ordersCache.clear();
      void reloadOrders();
    } else {
      ordersCache.clear();
      orders.value = [];
      ordersError.value = '';
    }
  },
);

onMounted(() => {
  // 关键优化：三路并行，互不阻塞——
  //  - 节假日走本地 holidays.json，毫秒级返回，日历立刻有工作日/节假日着色
  //  - 统计卡（飞书 + 任务）本地 DB，也快
  //  - 车票要走 12306 浏览器，最慢，独立加载不挡着日历渲染，到了再填进去
  // 之前是 await 链：feishu → tasks → orders 全部跑完才查节假日，
  // 日历着色被秒级车票接口拖住，体感「卡一下才亮」。
  void reloadHolidays();
  void reloadStats();
  void reloadOrders();
  // 页面从隐藏切回可见时静默刷新车票（用户重新看页面 = 最佳刷新时机）
  // 10 分钟内已有缓存则跳过，避免频繁请求
  document.addEventListener('visibilitychange', onVisible);
});

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisible);
});

function onVisible(): void {
  if (document.visibilityState !== 'visible') return;
  const cached = ordersCache.get(cacheKey());
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return; // 缓存未过期，不刷
  void reloadOrders();
}
</script>

<template>
  <div class="dash">
    <el-row :gutter="14" class="stat-row">
      <el-col :span="6">
        <el-card class="page-card stat-card">
          <div class="stat-title">本月车票</div>
          <div class="stat-value" style="color: #67c23a">{{ monthTicketCount }}</div>
          <div class="stat-sub">共 {{ paidCount }} 张已支付车票</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card class="page-card stat-card">
          <div class="stat-title">通知通道</div>
          <div class="stat-value" :style="{ color: activeChannels > 0 ? '#67c23a' : '#909399' }">
            {{ activeChannels ? `${activeChannels} 个已启用` : '未启用' }}
          </div>
          <div class="stat-sub">购票成功将提醒付款</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card class="page-card stat-card">
          <div class="stat-title">待触发任务</div>
          <div class="stat-value" style="color: #409eff">{{ stats.queried }}</div>
          <div class="stat-sub">等待起售时刻到点购票</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card class="page-card stat-card">
          <div class="stat-title">累计成功</div>
          <div class="stat-value" style="color: #67c23a">{{ stats.success }}</div>
          <div class="stat-sub">失败 {{ stats.failed }} 次</div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="14" class="main-row">
      <!-- 左：车票日历（紧凑，固定一屏） -->
      <el-col :span="17" class="main-col">
        <el-card class="page-card cal-card">
          <template #header>
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px">
              <b>车票日历</b>
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
                <el-select v-model="calPassenger" placeholder="全部乘车人" clearable size="small" style="width: 130px">
                  <el-option v-for="p in passengers" :key="p" :label="p" :value="p" />
                </el-select>
                <el-button size="small" @click="shiftMonth(-1)">‹</el-button>
                <span style="min-width: 104px; text-align: center; font-weight: 600; font-size: 13px">{{ calTitle }}</span>
                <el-button size="small" @click="shiftMonth(1)">›</el-button>
                <el-button size="small" text @click="calMonth = new Date()">今天</el-button>
                <el-button size="small" plain :disabled="!!ordersError" @click="shareContent = { kind: 'calendar', year: calMonth.getFullYear(), month: calMonth.getMonth() + 1, tickets: paidOrders }">分享日历</el-button>
              </div>
            </div>
          </template>

          <div v-if="ordersError" style="color: #e6a23c; margin-bottom: 6px; font-size: 12px">
            {{ ordersError }}（连接后刷新本页即可同步已购车票）
          </div>
          <el-alert
            v-if="calendarPending"
            type="warning"
            :closable="false"
            style="margin-bottom: 6px; padding: 6px 10px"
          >
            <span style="font-size: 12px">
              {{ calMonth.getFullYear() }} 年的放假安排尚未公布，日历暂按自然周显示。国务院发布后系统会自动更新。
            </span>
          </el-alert>
          <div style="font-size: 12px; color: #909399; margin-bottom: 6px">
            本月已标记 <b style="color: #409eff">{{ monthTicketCount }}</b> 张车票{{ calPassenger ? `（乘车人：${calPassenger}）` : '' }}。点有票的日期查看当天全部车票。
          </div>

          <!-- 星期表头 -->
          <div class="cal-grid cal-head">
            <div v-for="w in WEEK_LABELS" :key="w" class="cal-cell cal-week">{{ w }}</div>
          </div>
          <!-- 日期网格 -->
          <div class="cal-grid">
            <template v-for="(cell, i) in calendarCells" :key="i">
              <div
                v-if="cell"
                class="cal-cell"
                :class="{ 'cal-today': cell.isToday, 'cal-has-tickets': cell.tickets.length }"
                :role="cell.tickets.length ? 'button' : undefined"
                :tabindex="cell.tickets.length ? 0 : undefined"
                @click="openDay(cell)"
                @keydown.enter="openDay(cell)"
              >
                <CalendarDayHeader :date="cell.date" :holiday="cell.hol" :today="cell.isToday" />
                <CalendarTicket v-for="(ticket, index) in cell.tickets" :key="index" :ticket="ticket" />
                <div v-for="line in statusLines(cell.tickets)" :key="line.name" class="cal-status">{{ line.name }} {{ line.count }}</div>
              </div>
              <div v-else class="cal-cell cal-blank" />
            </template>
          </div>
        </el-card>
      </el-col>

      <!-- 右：系统说明 -->
      <el-col :span="7" class="main-col">
        <el-card class="page-card note-card">
          <template #header><b>系统说明</b></template>
          <ol class="note-list">
            <li>点击顶部「连接 12306」用 12306 APP 扫码登录一次（全程不保存密码），之后自动保持在线。</li>
            <li>在「购票计划」创建计划：指定乘车人、日期规则、时间范围、车次与座位偏好。</li>
            <li>系统自动推算购票日期（节假日顺延并标注），并在<b>车票起售时刻</b>触发购买。</li>
            <li>购票成功后<b>不会自动付款</b>，已启用的通知通道会提醒你登录 12306 完成支付。</li>
            <li>点击计划名称可查看它的执行历史和当前进度。</li>
          </ol>
          <el-alert type="warning" :closable="false" style="margin-top: 10px">
            <span style="font-size: 12px">全程<b>不保存 12306 密码</b>：用 12306 APP 扫码确认即可，登录后自动保持在线。</span>
          </el-alert>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="dayOpen" :title="`${dayDate} 的车票`" width="520px">
      <div v-for="group in dayGroups" :key="group.time" class="day-group">
        <div class="day-time">{{ group.time }}</div>
        <button v-for="ticket in group.tickets" :key="ticket.orderNo + ticket.fromStation + ticket.toStation + ticket.statusText" type="button" class="day-ticket" @click="openTicketDetail(ticket)">
          <span>
            <b>{{ ticket.trainCode }}</b>
            {{ ticket.fromStation }} → {{ ticket.toStation }}
          </span>
          <span class="day-ticket-side">{{ ticket.statusText || statusName(ticket) }}<template v-if="ticket.totalPrice != null"> · ¥{{ ticket.totalPrice.toFixed(2) }}</template></span>
        </button>
      </div>
    </el-dialog>
    <!-- 车票详情 -->
    <el-dialog v-model="ticketDetailVisible" title="车票详情" width="460px">
      <div v-if="ticketDetail" class="tk-detail">
        <div class="tk-head">
          <span class="tk-train">{{ ticketDetail.trainCode }}</span>
          <el-tag :type="ticketDetail.status === 'paid' ? 'success' : ticketDetail.status === 'unpaid' ? 'warning' : 'info'">
            {{ ticketDetail.statusText }}
          </el-tag>
        </div>
        <div class="tk-route">{{ ticketDetail.fromStation }} → {{ ticketDetail.toStation }}</div>
        <div class="tk-row"><span>出发时间</span><span class="mono">{{ ticketDetail.travelDateTime }}</span></div>
        <div class="tk-row"><span>到达时间</span><span class="mono">{{ ticketDetail.arrivalDateTime || '待确认' }}</span></div>
        <div class="tk-row"><span>乘车人</span><span>{{ (ticketDetail.passengers ?? []).join('、') }}</span></div>
        <div class="tk-row"><span>座位</span><span>{{ (ticketDetail.seats ?? []).join('、') || '—' }}</span></div>
        <div class="tk-row"><span>订单号</span><span class="mono">{{ ticketDetail.orderNo }}</span></div>
        <div class="tk-row"><span>票价</span><span>{{ ticketDetail.totalPrice != null ? '¥' + ticketDetail.totalPrice.toFixed(2) + (ticketDetail.passengers.length > 1 ? '（' + ticketDetail.passengers.length + ' 人合计）' : '') : '—' }}</span></div>
        <div v-if="ticketDetail.payLimitTime" class="tk-row tk-warn">
          <span>支付截止</span><span class="mono">{{ ticketDetail.payLimitTime }}</span>
        </div>
      </div>
      <template #footer><el-button v-if="ticketDetail" type="primary" plain @click="shareContent = { kind: 'ticket', ticket: ticketDetail }">分享到微信</el-button></template>
    </el-dialog>
    <ShareImageDialog :content="shareContent" @close="shareContent = null" />
  </div>
</template>

<style scoped>
.dash {
  display: flex;
  flex-direction: column;
}
.stat-row {
  margin-bottom: 14px;
}
.stat-card {
  width: 100%;
  height: 100%;
  margin-bottom: 0;
  box-sizing: border-box;
}
:deep(.stat-card .el-card__body) {
  padding: 10px 14px;
}
.stat-title {
  color: #909399;
  font-size: 12px;
}
.stat-value {
  font-size: 22px;
  font-weight: 700;
  margin: 2px 0;
}
.stat-sub {
  color: #909399;
  font-size: 11px;
}
.main-row {
  margin-bottom: 0;
}
/* 两列均为 flex 列：日历卡与「系统说明」卡撑满列高，底部对齐 */
.main-col {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.main-col > .el-card {
  margin-bottom: 0;
  flex: 0 0 auto;
}
.main-col > .el-card.cal-card,
.main-col > .el-card.note-card {
  flex: 1 1 auto;
}
/* ---- 车票日历（紧凑，保证一屏装下） ---- */
.cal-card :deep(.el-card__body) {
  padding: 12px 14px;
}
.cal-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 5px;
}
.cal-head {
  margin-bottom: 5px;
}
.cal-cell {
  min-height: 64px;
  height: auto;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  padding: 3px 5px;
  background: #fff;
}
.cal-has-tickets {
  cursor: pointer;
}
.cal-has-tickets:hover {
  border-color: #409eff;
}
.cal-status {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.4;
  color: #409eff;
}
.cal-week {
  min-height: auto;
  text-align: center;
  font-size: 11px;
  color: #909399;
  border: none;
  background: transparent;
  padding: 1px 0;
}
.cal-blank {
  background: #fafafa;
  border-color: #f5f5f5;
}
.cal-today {
  border-color: #409eff;
  box-shadow: inset 0 0 0 1px #409eff;
}
.day-group + .day-group {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #ebeef5;
}
.day-time {
  font-weight: 700;
  margin-bottom: 6px;
}
.day-ticket {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  margin: 0 0 6px;
  padding: 8px 0;
  border: 0;
  background: transparent;
  text-align: left;
  color: #303133;
  cursor: pointer;
}
.day-ticket:hover {
  color: #409eff;
}
.day-ticket-side {
  flex: none;
  color: #909399;
  font-size: 12px;
}
/* ---- 右侧说明卡片 ---- */
.note-card :deep(.el-card__body) {
  padding: 10px 14px;
}
.note-list {
  margin: 0;
  padding-left: 18px;
  line-height: 1.7;
  font-size: 12px;
  color: #606266;
}
.tk-detail {
  font-size: 14px;
}
.tk-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 4px;
}
.tk-train {
  font-size: 20px;
  font-weight: 700;
  color: #303133;
}
.tk-route {
  font-size: 15px;
  font-weight: 600;
  color: #409eff;
  margin-bottom: 14px;
}
.tk-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid #f0f0f0;
}
.tk-row span:first-child {
  color: #909399;
  font-size: 13px;
}
.tk-warn {
  color: #e6a23c;
}
</style>
