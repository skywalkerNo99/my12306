import { computed, reactive, ref, watch, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { Router } from 'vue-router';
import {
  planApi,
  calendarApi,
  metaApi,
  type PlanForm,
  type HolidayDay,
  type SeatTypeOption,
  type TrainOption,
} from '../../api';
import { sessionState } from '../../store/session';
import { filterDepartureRange } from '../../utils/train-filter';
import { resolvePlanSearchTarget } from '../../utils/plan-search-date';
import { trainSearchErrorMessage } from '../../utils/train-query-error';
import { todayCn } from '../../utils/time';
import { CALENDAR_WEEK_LABELS } from '../../utils/calendar-day';

export interface Passenger {
  id: string;
  name: string;
  idNo: string;
  passengerType: string;
}
export interface Plan extends PlanForm {
  id: string;
  status: string;
}
interface PvCell {
  day: number;
  date: string;
  entry?: PreviewEntry;
}
interface PreviewEntry {
  travelDate: string;
  originalDate: string;
  weekday: number;
  postponed: boolean;
  isWorkday: boolean;
  note?: string;
  estimatedSaleDate: string;
}
export interface DraftLeg { trainCode: string; fromStation: string; toStation: string; date: string; seatTypes?: string[] }

export function usePlanEditor(deps: { passengers: Ref<Passenger[]>; reload: () => Promise<void> }) {
  const passengers = deps.passengers;
  /** 席别选项（后端来自 12306 余票字段映射） */
  const seatTypeOptions = ref<SeatTypeOption[]>([]);
  /** 席别代码 → 中文名映射（由透传的选项派生，不在前端写死） */
  const seatTypeNameMap = computed<Record<string, string>>(() =>
    Object.fromEntries(seatTypeOptions.value.map((s) => [s.code, s.name])),
  );

  const dialogVisible = ref(false);
  const TRANSFER_DRAFT_KEY = 'my12306-transfer-draft';
  const draftLegs = ref<DraftLeg[]>([]);
  const previewVisible = ref(false);
  const previewRows = ref<PreviewEntry[]>([]);
  const editing = reactive<PlanForm>(emptyForm());

  // ---- 预览日历：按月展示推算出的购票日期 ----
  /** 预览日历当前展示的月份 */
  const pvMonth = ref(new Date());
  const WEEK_LABELS = CALENDAR_WEEK_LABELS;

  const pvTitle = computed(() => `${pvMonth.value.getFullYear()} 年 ${pvMonth.value.getMonth() + 1} 月`);

  /** 本月在推算结果中的条目 */
  const pvMonthEntries = computed(() => {
    const y = pvMonth.value.getFullYear();
    const m = pvMonth.value.getMonth();
    const prefix = `${y}-${String(m + 1).padStart(2, '0')}-`;
    return previewRows.value.filter((e) => e.travelDate.startsWith(prefix));
  });

  const pvCells = computed<(PvCell | null)[]>(() => {
    const y = pvMonth.value.getFullYear();
    const m = pvMonth.value.getMonth();
    const startWeekday = (new Date(y, m, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const cells: (PvCell | null)[] = [];
    for (let i = 0; i < startWeekday; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      cells.push({ day: d, date: dateStr, entry: pvMonthEntries.value.find((e) => e.travelDate === dateStr) });
    }
    return cells;
  });

  /**
   * 翻月（带范围控制 + 节假日加载前提）。
   *
   * - 范围：只能翻到推算结果覆盖的月份（第一个到最后一个推算日期之间），
   *   超出范围的月份没有任何推算数据，翻了也没意义。
   * - 前提：目标月份所在年的节假日数据必须加载成功。接口失败时阻止翻页
   *   并提示用户（而不是静默渲染一个无节假日标记的日历，误导推算）。
   */
  async function pvShift(delta: number): Promise<void> {
    if (!previewRows.value.length) return;
    const first = previewRows.value[0].travelDate;
    const last = previewRows.value[previewRows.value.length - 1].travelDate;
    const target = new Date(pvMonth.value.getFullYear(), pvMonth.value.getMonth() + delta, 1);
    const targetEnd = new Date(target.getFullYear(), target.getMonth() + 1, 0); // 目标月最后一天
    // 越界：目标月整体早于首个推算日期 或 晚于末个推算日期
    if (targetEnd < new Date(first) || target > new Date(last)) {
      ElMessage.info('已到推算日期范围边界');
      return;
    }
    // 节假日加载前提：目标年份必须先加载成功才允许翻过去
    const y = target.getFullYear();
    if (!pvHolidaysByYear.has(y)) {
      try {
        const res = await calendarApi.holidaysOfYear(y);
        pvHolidaysByYear.set(y, res.days);
        pvPendingYears.set(y, res.calendarPending);
      } catch {
        ElMessage.error(`${y} 年节假日数据加载失败，暂无法查看该月日历`);
        return;
      }
    }
    pvMonth.value = target;
  }

  // ---- 预览日历的节假日标记（按自然年缓存，切月份零延迟）----
  /** 当前展示月份的节假日数据（从年度缓存里切片得到） */
  const pvHolidays = ref<HolidayDay[]>([]);
  /** 按自然年缓存：year -> 全年节假日数据。只有首次访问某年时才调接口 */
  const pvHolidaysByYear = new Map<number, HolidayDay[]>();
  /** 按自然年缓存"该年放假安排是否尚未公布" */
  const pvPendingYears = new Map<number, boolean>();
  /** 预览日历当前年放假安排尚未公布 */
  const pvCalendarPending = ref(false);

  async function reloadPvHolidays(): Promise<void> {
    const y = pvMonth.value.getFullYear();
    const m = pvMonth.value.getMonth() + 1;
    const prefix = `${y}-${String(m).padStart(2, '0')}-`;
    // 年度缓存命中：同步切片返回，无网络延迟
    const cached = pvHolidaysByYear.get(y);
    if (cached) {
      pvHolidays.value = cached.filter((h) => h.date.startsWith(prefix));
      pvCalendarPending.value = pvPendingYears.get(y) ?? false;
      return;
    }
    // 首次访问该年：一次接口拿全年数据，之后该年内切月份不再请求
    // 失败时清空该年标记并提示——节假日数据是工作周推算的前提，不能静默吞掉
    try {
      const res = await calendarApi.holidaysOfYear(y);
      pvHolidaysByYear.set(y, res.days);
      pvPendingYears.set(y, res.calendarPending);
      pvHolidays.value = res.days.filter((h) => h.date.startsWith(prefix));
      pvCalendarPending.value = res.calendarPending;
    } catch {
      pvHolidaysByYear.delete(y);
      pvHolidays.value = [];
      pvCalendarPending.value = false;
      ElMessage.error(`${y} 年节假日数据加载失败，日历标记暂不可用`);
    }
  }

  function pvHolidayOf(dateStr: string): HolidayDay | undefined {
    return pvHolidays.value.find((h) => h.date === dateStr);
  }

  watch(pvMonth, () => void reloadPvHolidays());

  /** 跳到第一个推算日期所在的月份（先确保该年节假日已加载） */
  async function pvToFirst(): Promise<void> {
    const first = previewRows.value[0];
    if (!first) return;
    const y = Number(first.travelDate.slice(0, 4));
    if (!pvHolidaysByYear.has(y)) {
      try {
        const res = await calendarApi.holidaysOfYear(y);
        pvHolidaysByYear.set(y, res.days);
        pvPendingYears.set(y, res.calendarPending);
      } catch {
        ElMessage.error(`${y} 年节假日数据加载失败，日历标记暂不可用`);
      }
    }
    pvMonth.value = new Date(y, Number(first.travelDate.slice(5, 7)) - 1, 1);
  }

  /** 席别代码 → 中文名（由后端透传的席别选项派生，不写死） */
  function seatTypeName(codes?: string[] | null): string {
    if (!codes || !codes.length) return '未指定';
    return codes.map((c) => seatTypeNameMap.value[c] ?? c).join('/');
  }

  function emptyForm(): PlanForm {
    return {
      id: undefined,
      name: '',
      fromStation: '',
      toStation: '',
      dateMode: 'recurring',
      travelDate: null,
      weekday: 1,
      weekEdge: 'start',
      weekInterval: 1,
      offsetDays: 0,
      validFrom: todayCn(),
      validUntil: null,
      timeFrom: '08:00',
      timeTo: '09:00',
      trainNumbers: null,
      trainSegments: [],
      seatPositions: ['A', 'F'],
      seatTypes: ['ZE'],
      allowNoSeat: false,
      passengerIds: [],
    };
  }

  const weekdayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const seatOptions = ['A', 'B', 'C', 'D', 'F'];
  const seatPositionHint: Record<string, string> = { A: '靠窗', B: '中间', C: '过道', D: '过道', F: '靠窗' };


  /** 站点远程搜索（12306 真实站点库，支持拼音/缩写） */
  const stationLoading = ref(false);
  async function searchStations(keyword: string, cb: (items: Array<{ value: string }>) => void): Promise<void> {
    if (!keyword) return cb([]);
    stationLoading.value = true;
    try {
      const list = await planApi.stations(keyword);
      cb(list.map((s: { name: string }) => ({ value: s.name })));
    } catch {
      cb([]);
    } finally {
      stationLoading.value = false;
    }
  }

  /** A separate selection draft keeps cancel/close from modifying the plan. */
  const trainSearchVisible = ref(false);
  const selectedTrainCodes = ref<string[]>([]);
  type TrainSegment = NonNullable<PlanForm['trainSegments']>[number];
  const selectedTrainSegments = ref<TrainSegment[]>([]);
  const selectedTrainCount = computed(() => selectedTrainCodes.value.length + selectedTrainSegments.value.length);
  const segmentKey = (train: TrainSegment) => JSON.stringify([train.trainCode, train.fromStation, train.toStation]);
  const isTrainSelected = (train: TrainSegment) => selectedTrainSegments.value.some(s => segmentKey(s) === segmentKey(train));
  function clearTrainSelection(): void { selectedTrainCodes.value = []; selectedTrainSegments.value = []; }
  watch(() => editing.trainNumbers, codes => {
    editing.trainSegments = editing.trainSegments?.filter(s => codes?.includes(s.trainCode)) ?? [];
  }, { deep: true });
  watch(() => [editing.fromStation, editing.toStation], () => { editing.trainSegments = []; }, { flush: 'sync' });
  const trainLoading = ref(false);
  const trainResults = ref<TrainOption[]>([]);
  const visibleTrains = computed(() => filterDepartureRange(trainResults.value, editing.timeFrom, editing.timeTo)
    .sort((a, b) => a.departTime.localeCompare(b.departTime)));
  /** 12306 是否已登录（车次查询需要登录态） */
  const loggedIn = computed(() => !!sessionState.value.loggedIn);
  const trainSearchError = ref('');
  const trainSearched = ref(false);
  const searchDate = ref<string | null>(null);
  const dateRule = computed(() => [editing.dateMode, editing.travelDate, editing.validFrom, editing.validUntil, editing.weekEdge, editing.weekday, editing.weekInterval, editing.offsetDays]);
  let trainSearchVersion = 0;
  let editorVersion = 0;
  watch(dialogVisible, () => {
    editorVersion++;
    previewing.value = false;
    if (!dialogVisible.value) { previewVisible.value = false; trainSearchVisible.value = false; draftLegs.value = []; }
  }, { flush: 'sync' });
  watch(trainSearchVisible, visible => {
    if (!visible) { trainSearchVersion++; trainLoading.value = false; }
  }, { flush: 'sync' });
  watch(() => [editing.fromStation, editing.toStation, ...dateRule.value, dialogVisible.value], () => {
    trainSearchVersion++;
    searchDate.value = null;
    trainResults.value = [];
    trainSearchError.value = '';
    trainSearched.value = false;
    trainLoading.value = false;
  }, { flush: 'sync' });

  /** 余票文本 → 颜色：有票绿、无票灰 */
  function seatColor(text: string | undefined): string {
    if (!text || text === '无' || text === '') return '#c0c4cc';
    if (text === '有') return '#67c23a';
    const n = Number(text);
    return Number.isFinite(n) && n > 0 ? '#67c23a' : '#c0c4cc';
  }

  function openTrainSearch(): void {
    if (!validateDates()) return;
    if (!editing.fromStation || !editing.toStation) { ElMessage.warning('请先填写出发站和到达站'); return; }
    selectedTrainSegments.value = (editing.trainSegments ?? []).map(s => ({ ...s }));
    selectedTrainCodes.value = [...new Set(editing.trainNumbers ?? [])].filter(code => !selectedTrainSegments.value.some(s => s.trainCode === code));
    trainSearchVisible.value = true;
    void searchTrains();
  }

  async function searchTrains(): Promise<void> {
    if (trainLoading.value || !validateDates()) return;
    if (!editing.fromStation || !editing.toStation) {
      ElMessage.warning('请先填写出发站和到达站');
      return;
    }
    if (!loggedIn.value) {
      ElMessage.warning('请先在顶栏扫码登录 12306 后再查询车次');
      return;
    }
    const version = ++trainSearchVersion;
    trainLoading.value = true;
    trainSearched.value = true;
    trainSearchError.value = '';
    trainResults.value = [];
    searchDate.value = null;
    try {
      const form = JSON.parse(JSON.stringify(editing)) as PlanForm;
      const target = await resolvePlanSearchTarget(form, planApi.previewDates);
      if (version !== trainSearchVersion) return;
      if (!target) {
        trainSearchError.value = '该生效区间内没有符合规则的出行日期，请调整日期或工作周规则';
        return;
      }
      searchDate.value = target.travelDate;
      if (target.estimatedSaleDate > todayCn()) {
        trainSearchError.value = `${target.travelDate} 尚未开售，预计 ${target.estimatedSaleDate} 开售。可先保存计划，开售后自动查询；也可返回手动填写车次。`;
        return;
      }
      const res = await metaApi.trains(form.fromStation, form.toStation, target.travelDate);
      if (version !== trainSearchVersion) return;
      trainResults.value = res.trains;
      if (!visibleTrains.value.length) {
        ElMessage.warning('当前日期、区间和出发时间段内暂无车次，请调整条件');
      }
    } catch (e) {
      if (version !== trainSearchVersion) return;
      trainResults.value = [];
      trainSearchError.value = trainSearchErrorMessage(e);
    } finally {
      if (version === trainSearchVersion) trainLoading.value = false;
    }
  }

  function toggleTrain(train: TrainSegment): void {
    selectedTrainCodes.value = selectedTrainCodes.value.filter(code => code !== train.trainCode);
    selectedTrainSegments.value = isTrainSelected(train)
      ? selectedTrainSegments.value.filter(s => segmentKey(s) !== segmentKey(train))
      : [...selectedTrainSegments.value, { trainCode: train.trainCode, fromStation: train.fromStation, toStation: train.toStation }];
  }

  function confirmTrainSelection(): void {
    const codes = [...new Set([...selectedTrainCodes.value, ...selectedTrainSegments.value.map(s => s.trainCode)])];
    editing.trainNumbers = codes.length ? codes : null;
    editing.trainSegments = selectedTrainSegments.value.map(s => ({ ...s }));
    trainSearchVisible.value = false;
  }

  function openNew(): void {
    Object.assign(editing, emptyForm());
    editing.passengerIds = passengers.value.length ? [passengers.value[0].id] : [];
    trainResults.value = [];
    trainSearchVisible.value = false;
    dialogVisible.value = true;
  }

  function openEdit(p: Plan): void {
    Object.assign(editing, JSON.parse(JSON.stringify(p)));
    trainResults.value = [];
    trainSearchVisible.value = false;
    dialogVisible.value = true;
  }

  const saving = ref(false);
  const previewing = ref(false);
  watch(() => [...dateRule.value, editing.timeFrom, editing.timeTo], () => {
    editorVersion++;
    previewing.value = false;
    previewVisible.value = false;
  }, { flush: 'sync' });
  watch(() => [editing.timeFrom, editing.timeTo], () => {
    // 时间修改可能使当日目标失效，也不能接收按旧时间窗口推算的在途响应。
    if (!trainLoading.value && searchDate.value !== todayCn()) return;
    trainSearchVersion++;
    searchDate.value = null;
    trainResults.value = [];
    trainLoading.value = false;
    trainSearched.value = false;
    trainSearchError.value = '';
  }, { flush: 'sync' });

  function validateDates(): boolean {
    const error = editing.dateMode === 'single' && !editing.travelDate ? '请选择乘车日期'
      : editing.dateMode === 'single' && editing.travelDate! < todayCn() ? '乘车日期不能早于今天'
      : editing.dateMode !== 'single' && !editing.validFrom ? '请选择开始日期'
      : editing.validUntil && editing.validUntil < editing.validFrom ? '结束日期不能早于开始日期'
      : editing.timeFrom && editing.timeTo && editing.timeFrom > editing.timeTo ? '出发时间段的结束时间不能早于开始时间'
      : '';
    if (error) ElMessage.warning(error);
    return !error;
  }

  async function save(): Promise<void> {
    if (saving.value || !validateDates()) return;
    editing.name = editing.name.trim();
    editing.fromStation = editing.fromStation.trim();
    editing.toStation = editing.toStation.trim();
    if (editing.fromStation && editing.fromStation === editing.toStation) {
      ElMessage.warning('出发站和到达站不能相同');
      return;
    }
    if (!editing.name || !editing.fromStation || !editing.toStation) {
      ElMessage.warning('请填写计划名称与出发站、到达站');
      return;
    }
    if (!editing.passengerIds.length) {
      ElMessage.warning('请至少选择一名乘车人');
      return;
    }
    if (!editing.seatTypes || !editing.seatTypes.length) {
      ElMessage.warning('请至少选择一种席别');
      return;
    }
    saving.value = true;
    try {
      if (draftLegs.value.length > 1) {
        let previousId: string | undefined;
        for (const leg of draftLegs.value) {
          const onThisTrain = (leg.seatTypes ?? []).filter((code) => editing.seatTypes.includes(code));
          const seatTypes = onThisTrain.length ? onThisTrain : (leg.seatTypes?.length ? leg.seatTypes : editing.seatTypes);
          const saved = await planApi.save({
            ...editing,
            id: undefined,
            name: `${leg.fromStation} → ${leg.toStation} ${leg.trainCode}`,
            fromStation: leg.fromStation,
            toStation: leg.toStation,
            trainNumbers: [leg.trainCode],
            trainSegments: [{ trainCode: leg.trainCode, fromStation: leg.fromStation, toStation: leg.toStation }],
            dateMode: 'single',
            travelDate: leg.date,
            timeFrom: null,
            timeTo: null,
            seatTypes,
            dependsOnPlanId: previousId ?? null,
          });
          previousId = saved.id as string;
        }
        ElMessage.success(`已保存 ${draftLegs.value.length} 个行程计划`);
      } else {
        await planApi.save(editing);
        ElMessage.success('计划已保存');
      }
      dialogVisible.value = false;
      await deps.reload();
    } catch (e) {
      ElMessage.error((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? '保存失败');
    } finally {
      saving.value = false;
    }
  }

  async function preview(): Promise<void> {
    if (previewing.value || !validateDates()) return;
    previewing.value = true;
    const version = editorVersion;
    try {
      const rows = (await planApi.previewDates(editing)) as PreviewEntry[];
      if (version !== editorVersion || !dialogVisible.value) return;
      previewRows.value = rows;
      await pvToFirst();
      await reloadPvHolidays();
      if (version !== editorVersion || !dialogVisible.value) return;
      previewVisible.value = true;
    } catch (e) {
      if (version !== editorVersion || !dialogVisible.value) return;
      const msg = (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? String(e);
      ElMessage.error('推算失败：' + msg);
    } finally {
      if (version === editorVersion) previewing.value = false;
    }
  }

  async function loadSeatTypes(): Promise<void> {
    try {
      seatTypeOptions.value = await metaApi.seatTypes();
    } catch {
      seatTypeOptions.value = [
        { code: 'ZE', name: '二等座' },
        { code: 'ZY', name: '一等座' },
        { code: 'TZ', name: '特等座' },
        { code: 'YW', name: '硬卧' },
        { code: 'RW', name: '软卧' },
        { code: 'GR', name: '高级软卧' },
        { code: 'RZ', name: '软座' },
        { code: 'YZ', name: '硬座' },
      ];
    }
  }

  function consumeQuery(router: Router): void {
    const q = router.currentRoute.value.query;
    const TRANSFER_DRAFT_KEY = 'my12306-transfer-draft';
    if (q.transfer === '1') {
      const raw = sessionStorage.getItem(TRANSFER_DRAFT_KEY);
      sessionStorage.removeItem(TRANSFER_DRAFT_KEY);
      let legs: DraftLeg[] = [];
      try { legs = raw ? JSON.parse(raw) as DraftLeg[] : []; } catch { legs = []; }
      if (Array.isArray(legs) && legs.length) {
        draftLegs.value = legs;
        const first = legs[0];
        Object.assign(editing, emptyForm());
        editing.fromStation = first.fromStation;
        editing.toStation = first.toStation;
        editing.trainNumbers = [first.trainCode];
        editing.trainSegments = [{ trainCode: first.trainCode, fromStation: first.fromStation, toStation: first.toStation }];
        editing.timeFrom = null;
        editing.timeTo = null;
        editing.name = legs.map((leg) => leg.trainCode).join(' + ');
        editing.dateMode = 'single';
        editing.travelDate = first.date;
        editing.passengerIds = passengers.value.length ? [passengers.value[0].id] : [];
        dialogVisible.value = true;
        void router.replace({ path: '/plans', query: {} });
        return;
      }
    }
    const from = q.from ? String(q.from) : '';
    const to = q.to ? String(q.to) : '';
    const date = q.date ? String(q.date) : '';
    const train = q.train ? String(q.train) : '';
    if (from || to || train) {
      Object.assign(editing, emptyForm());
      if (from) editing.fromStation = from;
      if (to) editing.toStation = to;
      if (train) {
        editing.trainNumbers = [train];
        editing.timeFrom = null;
        editing.timeTo = null;
        editing.name = `${from} → ${to} ${train}`;
      }
      if (date) {
        editing.dateMode = 'single';
        editing.travelDate = date;
      }
      editing.passengerIds = passengers.value.length ? [passengers.value[0].id] : [];
      dialogVisible.value = true;
      void router.replace({ path: '/plans', query: {} });
    }
  }

  return reactive({
    passengers, seatTypeOptions, seatTypeName, dialogVisible, draftLegs, previewVisible, previewRows, editing,
    pvMonth, WEEK_LABELS, pvTitle, pvMonthEntries, pvCells, pvShift, pvCalendarPending, pvHolidayOf, pvToFirst,
    weekdayNames, seatOptions, seatPositionHint, searchStations, trainSearchVisible, selectedTrainCodes,
    selectedTrainSegments, selectedTrainCount, segmentKey, isTrainSelected, clearTrainSelection, trainLoading,
    visibleTrains, loggedIn, trainSearchError, trainSearched, searchDate, seatColor, openTrainSearch, searchTrains,
    toggleTrain, confirmTrainSelection, openNew, openEdit, saving, previewing, preview, save, loadSeatTypes, consumeQuery,
    reload: deps.reload,
  });
}
