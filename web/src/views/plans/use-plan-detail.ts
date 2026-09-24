import { computed, onUnmounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { planApi, ordersApi, type PlanDateEntry, type TaskSnapshot } from '../../api';
import { sessionState } from '../../store/session';
import { todayCn } from '../../utils/time';
import { planDateStatus } from '../../utils/plan-status';
import type { Plan } from './use-plan-editor';

export function usePlanDetail() {
  const loggedIn = computed(() => !!sessionState.value.loggedIn);
  // ---- 计划详情抽屉：执行历史 + 当前动作 ----
  const detailVisible = ref(false);
  const detailPlan = ref<Plan | null>(null);
  const detailRows = ref<PlanDateEntry[]>([]);
  const detailView = ref('calendar');
  const skippingDate = ref(false);
  function canSkipDate(row: PlanDateEntry): boolean {
    return !row.cancellationPending && row.travelDate >= todayCn() && detailPlan.value?.status !== 'deleted' && !['running', 'success'].includes(row.task?.status ?? '');
  }
  function canCancelDate(row: PlanDateEntry): boolean {
    return row.task?.status === 'success' && row.task.result?.paid !== true && !!row.task.result?.orderNo;
  }
  async function cancelAndSkipDate(row: PlanDateEntry): Promise<void> {
    if (!detailPlan.value || !row.task || skippingDate.value) return;
    const id = detailPlan.value.id;
    try {
      await ElMessageBox.confirm(`确认取消 ${row.travelDate} 的整笔未支付订单 ${row.task.result?.orderNo}（包含该订单全部乘车人），并跳过当天购票？`, '取消订单并跳过', { confirmButtonText:'取消订单并跳过',cancelButtonText:'保留订单',type:'warning' });
      skippingDate.value = true;
      await planApi.cancelAndSkip(id,row.task.id);
      ElMessage.success('订单已取消，该日期已跳过');
    } catch (e) {
      if (e !== 'cancel' && e !== 'close') ElMessage.error((e as {response?:{data?:{error?:string}}}).response?.data?.error ?? '取消结果未确认，请刷新查看状态');
    } finally {
      if (skippingDate.value) await loadDetail(id);
      skippingDate.value = false;
    }
  }
  async function toggleSkipDate(row: PlanDateEntry): Promise<void> {
    if (!detailPlan.value || skippingDate.value) return;
    const id = detailPlan.value.id;
    const skipped = !row.manuallySkipped;
    try {
      await ElMessageBox.confirm(skipped ? `跳过 ${row.travelDate}？该日期将不再自动购票，其他日期不受影响。` : `恢复 ${row.travelDate} 的购票安排？如果已开售，启用中的计划可能立即开始购票。`, skipped ? '跳过这一天' : '恢复购票', { confirmButtonText: skipped ? '确认跳过' : '确认恢复', cancelButtonText: '取消', type: 'warning' });
      skippingDate.value = true;
      await planApi.skipDate(id, row.travelDate, skipped);
      await loadDetail(id);
      ElMessage.success(skipped ? '已跳过该日期' : '已恢复购票安排');
    } catch (e) {
      if (e !== 'cancel' && e !== 'close') ElMessage.error((e as {response?:{data?:{error?:string}}}).response?.data?.error ?? '修改失败，请重试');
    } finally { skippingDate.value = false; }
  }
  /** 计划详情数据是否正在加载（也用于刷新按钮的 loading 态） */
  const detailLoading = ref(false);
  let detailRequestVersion = 0;
  let detailRefreshing = false;
  let detailPoll: ReturnType<typeof setInterval> | undefined;
  watch(detailVisible, visible => {
    clearInterval(detailPoll);
    if (visible) detailPoll = setInterval(() => {
      if (detailPlan.value && !detailRefreshing) void loadDetail(detailPlan.value.id, true);
    }, 5000);
    else { ++detailRequestVersion; detailRefreshing = false; detailLoading.value = false; }
  });
  onUnmounted(() => { clearInterval(detailPoll); ++detailRequestVersion; });
  const detailNow = ref(new Date());
  function detailStatus(row: PlanDateEntry): string {
    return planDateStatus(row, detailPlan.value?.status ?? 'active', loggedIn.value, detailNow.value);
  }
  const nextDetailRow = computed(() => detailRows.value.find(row => row.travelDate >= todayCn(detailNow.value)
    && !row.manuallySkipped && !['success', 'failed', 'skipped', 'cancelled'].includes(row.task?.status ?? '')));

  const taskStatusType: Record<string, string> = {
    pending: 'info',
    queried: 'info',
    queued: 'warning',
    running: 'warning',
    success: 'success',
    failed: 'danger',
    skipped: 'info',
    cancelled: 'info',
  };

  /** 起售时间 → 北京时间可读串（接口返回 ISO，可能是 +08:00 或 Z） */
  function fmtSaleAt(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const cn = new Date(d.getTime() + (8 * 60 + d.getTimezoneOffset()) * 60_000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${cn.getFullYear()}-${p(cn.getMonth() + 1)}-${p(cn.getDate())} ${p(cn.getHours())}:${p(cn.getMinutes())}`;
  }

  /** 当前正在执行的任务（running / queried 中最近一条） */
  const activeTask = computed<TaskSnapshot | null>(() => {
    const running = detailRows.value.map((r) => r.task).filter(Boolean) as TaskSnapshot[];
    return (
      running.find((t) => t.status === 'running') ??
      running.find((t) => t.status === 'queued') ??
      running.find((t) => t.status === 'queried') ??
      null
    );
  });
  const activeDetailStatus = computed(() => {
    const row = detailRows.value.find(row => row.task?.id === activeTask.value?.id && row.task);
    return row ? detailStatus(row) : '';
  });

  /** 已完成只统计已成功购票的日期。 */
  const doneCount = computed(
    () => detailRows.value.filter((r) => r.task?.status === 'success').length,
  );

  async function openDetail(p: Plan): Promise<void> {
    detailRows.value = [];
    detailPlan.value = p;
    detailVisible.value = true;
    await loadDetail(p.id);
  }

  /** 手动刷新当前打开的详情 */
  function refreshDetail(): void {
    if (detailPlan.value) void loadDetail(detailPlan.value.id);
  }

  async function loadDetail(id: string, quiet = false): Promise<void> {
    const version = ++detailRequestVersion;
    detailRefreshing = true;
    detailLoading.value = !quiet;
    try {
      const rows = await planApi.dates(id);
      if (detailPlan.value?.id !== id || version !== detailRequestVersion) return;
      detailNow.value = new Date();
      detailRows.value = rows;
      if (!quiet && loggedIn.value && rows.some(row => row.task?.status === 'success' || row.task?.status === 'failed')) {
        // Refresh payment status and repair legacy seat summaries without purchasing.
        try {
          await ordersApi.list();
          const fresh = await planApi.dates(id);
          if (detailPlan.value?.id === id && version === detailRequestVersion) detailRows.value = fresh;
        } catch { /* Keep the unverified label when official order details are unavailable. */ }
      }
    } catch (e) {
      if (version !== detailRequestVersion || quiet) return;
      ElMessage.error('加载执行历史失败：' + String(e));
      detailRows.value = [];
    } finally {
      if (version === detailRequestVersion) { detailLoading.value = false; detailRefreshing = false; }
    }
  }

  /** 手动重试失败/已跳过的任务（如登录失效导致 failed 后，重新扫码登录再来一次） */
  const retryingTaskId = ref<string | null>(null);
  async function retryTask(row: PlanDateEntry): Promise<void> {
    if (!row.task || !detailPlan.value) return;
    retryingTaskId.value = row.task.id;
    try {
      await planApi.retryTask(detailPlan.value.id, row.task.id);
      ElMessage.success('已安排重新购票，触发器马上执行');
      await loadDetail(detailPlan.value.id);
    } catch (e) {
      ElMessage.error((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? '重试失败');
    } finally {
      retryingTaskId.value = null;
    }
  }

  function closeDetail(): void {
    detailVisible.value = false;
  }

  return reactive({
    detailVisible, detailPlan, detailRows, detailView, skippingDate, canSkipDate, canCancelDate,
    cancelAndSkipDate, toggleSkipDate, detailLoading, detailNow, detailStatus, nextDetailRow,
    taskStatusType, fmtSaleAt, activeTask, activeDetailStatus, doneCount, openDetail, refreshDetail,
    retryingTaskId, retryTask, closeDetail, loggedIn,
  });
}
