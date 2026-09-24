<script setup lang="ts">
import type { usePlanEditor } from './use-plan-editor';
import type { usePlanDetail } from './use-plan-detail';
import CalendarDayHeader from '../../components/CalendarDayHeader.vue';
import PlanScheduleCalendar from '../../components/PlanScheduleCalendar.vue';
import { saleLabel } from '../../utils/plan-status';
import { sessionSyncing, syncPassengers } from '../../store/session';
import { todayCn, isPastDate } from '../../utils/time';

defineProps<{ editor: ReturnType<typeof usePlanEditor>; detail: ReturnType<typeof usePlanDetail> }>();
</script>

<template>
    <el-drawer
      v-model="detail.detailVisible"
      :title="detail.detailPlan ? `计划详情：${detail.detailPlan.name}` : '计划详情'"
      direction="rtl"
      size="min(760px, 100vw)"
      :before-close="detail.closeDetail"
    >
      <template v-if="detail.detailPlan">
        <!-- 当前动作 -->
        <el-card v-if="detail.activeTask" class="page-card detail-active" shadow="never">
          <div class="da-label">当前进行</div>
          <div class="da-row">
            <el-tag :type="(detail.taskStatusType[detail.activeTask.status] ?? 'info') as 'primary' | 'warning' | 'success' | 'danger' | 'info'" effect="dark" size="large">
              {{ detail.activeDetailStatus }}
            </el-tag>
            <span class="da-date">{{ detail.activeTask.travelDate }} {{ detail.activeTask.trainNumber ? `· ${detail.activeTask.trainNumber}` : '· 自动匹配车次' }}</span>
          </div>
          <div class="da-meta">
            <span v-if="detail.detailPlan.status === 'paused'">恢复计划后继续购票</span>
            <span v-else-if="detail.activeTask.status === 'queried' && !detail.loggedIn">请先连接 12306 账号</span>
            <span v-else-if="detail.activeTask.status === 'queried' && detail.activeTask.saleAt && Date.parse(detail.activeTask.saleAt) > detail.detailNow.getTime()">{{ detail.fmtSaleAt(detail.activeTask.saleAt) }} 开售后自动购票</span>
            <span v-else-if="detail.activeTask.status === 'queried'">已开售，等待购票</span>
            <span v-else-if="detail.activeTask.status === 'running'">已进入购票流程，请稍候…</span>
            <span v-else-if="detail.activeTask.status === 'queued'">已排队，即将开始</span>
          </div>
        </el-card>
        <el-card v-else class="page-card detail-active" shadow="never">
          <div class="da-label">当前进行</div>
          <div class="da-meta" style="margin: 6px 0">{{ detail.nextDetailRow ? `${detail.nextDetailRow.travelDate} · ${detail.detailStatus(detail.nextDetailRow)}` : '暂无待购票行程' }}</div>
        </el-card>

        <!-- 执行历史 -->
        <div class="detail-sec-title">
          购票安排 <span class="detail-count">共 {{ detail.detailRows.length }} 个乘车日期，已完成 {{ detail.doneCount }}</span>
          <el-button class="detail-refresh" size="small" :loading="detail.detailLoading" @click="detail.refreshDetail">刷新</el-button>
        </div>
        <el-radio-group v-model="detail.detailView" size="small" aria-label="购票安排显示方式" style="margin-bottom:12px">
          <el-radio-button value="calendar">日历</el-radio-button>
          <el-radio-button value="list">列表</el-radio-button>
        </el-radio-group>
        <PlanScheduleCalendar v-if="detail.detailView === 'calendar' && detail.detailRows.length > 0" :rows="detail.detailRows" :status="detail.detailStatus" :editable="detail.canSkipDate" :busy="detail.skippingDate" :cancelable="detail.canCancelDate" @skip="detail.toggleSkipDate" @cancel="detail.cancelAndSkipDate" />
        <el-table v-if="detail.detailView === 'list'" class="stretch-table" v-loading="detail.detailLoading" :data="detail.detailRows" border size="small" max-height="520">
          <el-table-column label="乘车日期" prop="travelDate" min-width="110" />
          <el-table-column label="开售情况" min-width="150" class-name="wrap-col">
            <template #default="{ row }">
              <div class="mono" style="font-size: 12px">
                {{ saleLabel(row, detail.detailNow) }}
              </div>
            </template>
          </el-table-column>
          <el-table-column label="购票状态" min-width="100">
            <template #default="{ row }">
              <el-tag
                :type="(detail.taskStatusType[row.task?.status] ?? 'info') as 'primary' | 'warning' | 'success' | 'danger' | 'info'"
                size="small"
              >
                {{ detail.detailStatus(row) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="结果" min-width="180" class-name="wrap-col">
            <template #default="{ row }">
              <div v-if="row.task?.status === 'success' && row.task.result" class="mono" style="color: #67c23a">
                <div>{{ row.task.result.trainCode }} · {{ row.task.result.seatInfoSource ? row.task.result.seatInfo : '席别待核实' }}<span v-if="row.task.result.seatInfoSource === 'submitted'">（下单席别）</span></div>
                <div v-if="row.task.result.orderNo">订单 {{ row.task.result.orderNo }}</div>
              </div>
              <div v-else-if="row.task?.error">
                <div class="mono" style="color: #f56c6c; font-size: 12px">{{ row.task.error }}</div>
                <el-button
                  v-if="!row.manuallySkipped && (row.task.status === 'failed' || row.task.status === 'skipped')"
                  size="small"
                  link
                  type="primary"
                  :loading="detail.retryingTaskId === row.task.id"
                  style="margin-top: 2px"
                  @click="void detail.retryTask(row)"
                >重试</el-button>
              </div>
              <div v-else style="color: #c0c4cc; font-size: 12px">—</div>
            </template>
          </el-table-column>
          <el-table-column label="安排" min-width="148">
            <template #default="{ row }">
              <el-button v-if="detail.canSkipDate(row)" link type="primary" size="small" :loading="detail.skippingDate" @click="detail.toggleSkipDate(row)">{{ row.manuallySkipped ? '恢复购票' : '跳过' }}</el-button>
              <el-button v-else-if="detail.canCancelDate(row)" link type="danger" size="small" :loading="detail.skippingDate" @click="detail.cancelAndSkipDate(row)">取消订单并跳过</el-button>
              <span v-else>—</span>
            </template>
          </el-table-column>
        </el-table>
        <div class="detail-tip">状态每 5 秒自动更新。“已开售”表示进入售票期，购票进度请看“购票状态”。</div>
      </template>
    </el-drawer>

    <el-dialog class="plan-editor-dialog" append-to-body top="4vh" v-model="editor.dialogVisible" :title="editor.editing.id ? '编辑计划' : editor.draftLegs.length > 1 ? `新建 ${editor.draftLegs.length} 个购票计划` : '新建购票计划'" width="660px" :close-on-click-modal="false">
      <el-alert v-if="editor.draftLegs.length > 1" type="info" :closable="false" style="margin-bottom: 12px" title="每一程一个计划，后一程等前一程支付成功再买。席别按该车实际有票的种类匹配。" />
      <el-form label-width="104px" label-position="right">
        <template v-if="editor.draftLegs.length > 1">
          <div class="form-section">全部行程</div>
          <div v-for="(leg, i) in editor.draftLegs" :key="i" class="form-hint">第 {{ i + 1 }} 程 {{ leg.date }} {{ leg.trainCode }} {{ leg.fromStation }} → {{ leg.toStation }}{{ leg.seatTypes?.length ? ` · ${editor.seatTypeName(leg.seatTypes)}` : '' }}</div>
        </template>
        <template v-if="editor.draftLegs.length <= 1">
        <!-- 基本信息 -->
        <div class="form-section">行程</div>
        <el-form-item label="计划名称">
          <el-input v-model="editor.editing.name" placeholder="如：南京到上海 每周一" maxlength="64" show-word-limit />
        </el-form-item>
        <el-form-item label="出发站">
          <el-autocomplete
            v-model="editor.editing.fromStation"
            :fetch-suggestions="editor.searchStations"
            placeholder="输入站名或拼音首字母，如 南京 / NJ"
            :trigger-on-focus="false"
            clearable
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="到达站">
          <el-autocomplete
            v-model="editor.editing.toStation"
            :fetch-suggestions="editor.searchStations"
            placeholder="输入站名或拼音首字母，如 上海 / SH"
            :trigger-on-focus="false"
            clearable
            style="width: 100%"
          />
        </el-form-item>

        <!-- 出行频率 -->
        <div class="form-section">出行频率</div>
        <el-form-item label="怎么走">
          <el-radio-group v-model="editor.editing.dateMode">
            <el-radio value="single">只走一次</el-radio>
            <el-radio value="recurring">每周固定周几</el-radio>
            <el-radio value="workweek">按工作周（自动跳节假日）</el-radio>
          </el-radio-group>
          <div class="form-hint">
            {{ editor.editing.dateMode === 'single' ? '一次性购票，指定具体乘车日期。'
              : editor.editing.dateMode === 'workweek' ? '系统按国务院工作日历推算：自动跳过法定节假日、识别调休补班日，数据未公布的年份按自然周推算。'
              : '纯按日历周期，逢节假日不跳过（如国庆周照常）。' }}
          </div>
        </el-form-item>
        <el-form-item v-if="editor.editing.dateMode === 'single'" label="乘车日期">
          <el-date-picker v-model="editor.editing.travelDate" type="date" value-format="YYYY-MM-DD" placeholder="选择乘车日期" :disabled-date="isPastDate" style="width: 100%" />
        </el-form-item>
        <template v-else-if="editor.editing.dateMode === 'workweek'">
          <el-form-item label="每周哪天">
            <el-radio-group v-model="editor.editing.weekEdge">
              <el-radio value="start">工作周第一天</el-radio>
              <el-radio value="end">工作周最后一天</el-radio>
            </el-radio-group>
            <div class="form-hint">取完整工作周的首个 / 最后一个工作日，包含节假日调整和调休补班；本周目标日已过则跳到下一周期。</div>
          </el-form-item>
          <el-form-item label="每几周走">
            <el-input-number v-model="editor.editing.weekInterval" :min="1" :max="4" />
            <span class="form-inline">周一次</span>
          </el-form-item>
          <el-form-item label="日期微调">
            <el-input-number v-model="editor.editing.offsetDays" :min="-6" :max="6" />
            <span class="form-inline">天（0=按日历，负=提前，正=延后）</span>
          </el-form-item>
        </template>
        <template v-else>
          <el-form-item label="每周周几">
            <el-select v-model="editor.editing.weekday" style="width: 120px">
              <el-option v-for="(n, i) in editor.weekdayNames" :key="i" :label="n" :value="i + 1" />
            </el-select>
          </el-form-item>
          <el-form-item label="每几周走">
            <el-input-number v-model="editor.editing.weekInterval" :min="1" :max="4" />
            <span class="form-inline">周一次</span>
          </el-form-item>
          <el-form-item label="日期微调">
            <el-input-number v-model="editor.editing.offsetDays" :min="-6" :max="6" />
            <span class="form-inline">天（0=按日历，负=提前，正=延后）</span>
          </el-form-item>
        </template>
        <el-form-item v-if="editor.editing.dateMode !== 'single'" label="开始日期">
          <el-date-picker v-model="editor.editing.validFrom" type="date" value-format="YYYY-MM-DD" placeholder="从哪天开始执行" style="width: 100%" />
          <div class="form-hint">仅限定生效范围，不代表首次乘车日期。预览和余票查询均按规则取有效出行日期。</div>
        </el-form-item>
        <el-form-item v-if="editor.editing.dateMode !== 'single'" label="结束日期">
          <el-date-picker v-model="editor.editing.validUntil" type="date" value-format="YYYY-MM-DD" placeholder="不填=一直执行" style="width: 100%" />
        </el-form-item>

        </template>
        <!-- 车次与座位 -->
        <div class="form-section">车次与座位</div>
        <template v-if="editor.draftLegs.length <= 1">
        <el-form-item label="出发时间段">
          <el-time-picker v-model="editor.editing.timeFrom" format="HH:mm" value-format="HH:mm" placeholder="如 08:00" />
          <span style="margin: 0 8px">至</span>
          <el-time-picker v-model="editor.editing.timeTo" format="HH:mm" value-format="HH:mm" placeholder="如 09:00" />
          <div class="form-hint">只买这个时间段内发车的车次。</div>
        </el-form-item>
        <el-form-item label="车次">
          <div class="train-row">
            <el-select
              v-model="editor.editing.trainNumbers"
              multiple
              filterable
              allow-create
              placeholder="不填=按时间段自动匹配"
              class="train-select"
            >
              <el-option v-for="code in editor.editing.trainNumbers ?? []" :key="code" :label="code" :value="code" />
            </el-select>
            <el-button plain type="primary" @click="editor.openTrainSearch">查车次余票</el-button>
          </div>
          <div class="form-hint">查询后可多选车次，也可直接输入车次号；不选则按时间段自动匹配。</div>
          <div v-for="segment in editor.editing.trainSegments ?? []" :key="editor.segmentKey(segment)" class="form-hint">{{ segment.trainCode }} · {{ segment.fromStation }} → {{ segment.toStation }}</div>
        </el-form-item>
        </template>
        <el-form-item label="座位位置">
          <el-select v-model="editor.editing.seatPositions" multiple placeholder="靠窗 / 过道偏好（可多选）">
            <el-option v-for="s in editor.seatOptions" :key="s" :label="`${s}（${editor.seatPositionHint[s]}）`" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="席别">
          <el-select v-model="editor.editing.seatTypes" multiple placeholder="想买哪种席别（可多选）">
            <el-option v-for="st in editor.seatTypeOptions" :key="st.code" :label="st.name" :value="st.code" />
          </el-select>
          <div class="form-hint">严格按所选席别买，售罄不回退到其他席别；不购买商务座。</div>
        </el-form-item>
        <el-form-item label="无座票">
          <el-switch v-model="editor.editing.allowNoSeat" />
          <span class="form-inline" style="margin-left: 10px">
            默认关闭：所选席别卖光就放弃并告警；开启后接受无座票。
          </span>
        </el-form-item>

        <!-- 乘车人 -->
        <div class="form-section">乘车人</div>
        <el-alert v-if="!editor.passengers.length" title="暂无乘车人，请先从 12306 同步联系人" type="warning" :closable="false" />
        <el-button text type="primary" :loading="sessionSyncing" :disabled="!editor.loggedIn" @click="async () => { await syncPassengers(); await editor.reload(); }">同步并刷新乘车人</el-button>
        <el-form-item label="乘车人">
          <el-select v-model="editor.editing.passengerIds" multiple placeholder="选择要购票的乘车人" style="width: 100%">
            <el-option v-for="p in editor.passengers" :key="p.id" :label="`${p.name}（${p.passengerType}）`" :value="p.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :loading="editor.previewing" @click="editor.preview">预览购票日期</el-button>
        <el-button @click="editor.dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="editor.saving" @click="editor.save">{{ editor.draftLegs.length > 1 ? `保存 ${editor.draftLegs.length} 个计划` : '保存计划' }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="editor.trainSearchVisible" title="选择车次" width="800px" top="6vh" append-to-body class="plan-editor-dialog train-picker-dialog" :close-on-click-modal="false">
      <div class="train-panel-bar">
        <div class="train-panel-cond">
          <strong>{{ editor.editing.fromStation }} → {{ editor.editing.toStation }}</strong>
          <div class="train-panel-date">{{ editor.searchDate ?? (editor.trainLoading ? '正在推算日期…' : '待查询') }} · {{ editor.editing.dateMode === 'single' ? '乘车日期' : '首个有效出行日' }}</div>
          <div class="train-panel-date">出发 {{ editor.editing.timeFrom || '00:00' }}–{{ editor.editing.timeTo || '23:59' }}<span v-if="!editor.trainLoading && editor.trainSearched && !editor.trainSearchError"> · {{ editor.visibleTrains.length }} 班</span></div>
        </div>
        <el-button :loading="editor.trainLoading" @click="editor.searchTrains">刷新余票</el-button>
      </div>
      <el-alert v-if="!editor.loggedIn" type="warning" :closable="false" title="请先连接 12306，再查询车次余票。" />
      <div v-if="editor.trainLoading" class="train-panel-empty" role="status">正在查询余票…</div>
      <div v-else-if="editor.visibleTrains.length" class="train-results" role="list" aria-label="车次余票">
        <div v-for="(train, index) in editor.visibleTrains" :key="`${train.trainCode}-${train.fromStation}-${train.toStation}-${index}`" class="train-result" :class="{ 'train-result-selected': editor.isTrainSelected(train) }" role="listitem">
          <div class="train-result-header">
            <el-checkbox :model-value="editor.isTrainSelected(train)" :aria-label="`选择 ${train.trainCode} ${train.fromStation}至${train.toStation}`" @change="editor.toggleTrain(train)">{{ train.trainCode }}</el-checkbox>
            <strong class="mono train-result-time">{{ train.departTime }} → {{ train.arriveTime }}</strong>
            <span class="train-result-duration">历时 {{ train.duration }}</span>
          </div>
          <div class="train-result-route">{{ train.fromStation }} → {{ train.toStation }}</div>
          <div class="seat-list" aria-label="各席别余票">
            <span v-for="(count, name) in (train.seats ?? {})" :key="name" class="seat-chip" :style="{ color: editor.seatColor(count) }">{{ name }} {{ count }}</span>
            <span v-if="!Object.keys(train.seats ?? {}).length" class="train-result-duration">暂无席别信息</span>
          </div>
        </div>
      </div>
      <div v-else-if="editor.loggedIn" class="train-panel-empty">{{ editor.trainSearchError || (editor.trainSearched ? '当前条件下暂无车次，请返回调整日期或出发时间段' : '点击刷新余票查询车次') }}</div>
      <template #footer>
        <div class="train-selection-summary">
          <span>已选 {{ editor.selectedTrainCount }} 项</span>
          <el-button v-if="editor.selectedTrainCount" link type="primary" @click="editor.clearTrainSelection">清空</el-button>
          <span v-else class="train-result-duration">不选则按时间段自动匹配</span>
        </div>
        <div v-if="editor.selectedTrainCount" class="train-selected-tags">
          <el-tag v-for="code in editor.selectedTrainCodes" :key="code" closable @close="editor.selectedTrainCodes = editor.selectedTrainCodes.filter((c: string) => c !== code)">{{ code }}（未限定站点）</el-tag>
          <el-tag v-for="segment in editor.selectedTrainSegments" :key="editor.segmentKey(segment)" closable @close="editor.toggleTrain(segment)">{{ segment.trainCode }} · {{ segment.fromStation }} → {{ segment.toStation }}</el-tag>
        </div>
        <div class="train-selection-actions">
          <el-button @click="editor.trainSearchVisible = false">取消</el-button>
          <el-button type="primary" @click="editor.confirmTrainSelection">确定</el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog class="plan-editor-dialog" append-to-body top="6vh" v-model="editor.previewVisible" title="购票日期推算结果" width="620px">
      <div class="pv-toolbar">
        <div class="pv-legend">
          共 <b style="color: #409eff">{{ editor.previewRows.length }}</b> 个购票日期
          <span class="pv-key"><i class="pv-dot pv-ok" />正常</span>
          <span class="pv-key"><i class="pv-dot pv-warn" />节假日顺延</span>
        </div>
        <div class="pv-nav">
          <el-button size="small" @click="editor.pvShift(-1)">‹</el-button>
          <span class="pv-title">{{ editor.pvTitle }}</span>
          <el-button size="small" @click="editor.pvShift(1)">›</el-button>
          <el-button size="small" text @click="editor.pvToFirst">首个日期</el-button>
        </div>
      </div>
      <el-alert
        v-if="editor.pvCalendarPending"
        class="pv-pending"
        type="warning"
        :closable="false"
        :title="`${editor.pvMonth.getFullYear()} 年的放假安排尚未公布，日历暂按自然周推算。国务院发布后系统会自动更新。`"
      />
      <div v-if="!editor.previewRows.length" class="pv-empty">该生效区间内没有可推算的购票日期</div>
      <template v-else>
        <div class="pv-grid pv-head">
          <div v-for="w in editor.WEEK_LABELS" :key="w" class="pv-cell pv-week">{{ w }}</div>
        </div>
        <div class="pv-grid">
          <template v-for="(cell, i) in editor.pvCells" :key="i">
            <div
              v-if="cell"
              class="pv-cell"
              :class="{
                'pv-has': cell.entry,
                'pv-post': cell.entry?.postponed,
              }"
            >
              <CalendarDayHeader :date="cell.date" :holiday="editor.pvHolidayOf(cell.date)" :today="cell.date === todayCn()" />
              <div v-if="cell.entry" class="pv-entry" :title="cell.entry.note || (cell.entry.originalDate !== cell.entry.travelDate ? `原始推算 ${cell.entry.originalDate}` : '')">
                <div class="pv-line">
                  <i class="pv-dot pv-ok" /><span>乘车</span>
                  <el-tag v-if="cell.entry.postponed" size="small" type="warning">顺延</el-tag>
                </div>
                <div class="pv-sale">起售 {{ cell.entry.estimatedSaleDate.slice(5) }}</div>
              </div>
            </div>
            <div v-else class="pv-cell pv-blank" />
          </template>
        </div>
        <div v-if="!editor.pvMonthEntries.length" class="pv-empty">本月没有购票日期，用 ‹ › 切换到其他月份</div>
      </template>
    </el-dialog>
</template>

<style scoped>
/* ---- 新建/编辑计划表单：分区标题与行内提示 ---- */
.form-section {
  font-weight: 700;
  font-size: 13px;
  color: #303133;
  margin: 4px 0 12px;
  padding-left: 8px;
  border-left: 3px solid #409eff;
}
.form-hint {
  font-size: 12px;
  color: #909399;
  line-height: 1.5;
  margin-top: 4px;
}
.form-inline {
  font-size: 12px;
  color: #909399;
  margin-left: 6px;
}

.pv-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}
.pv-legend {
  font-size: 12px;
  color: #909399;
}
.pv-key {
  margin-left: 10px;
}
.pv-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 4px;
}
.pv-ok {
  background: #67c23a;
}
.pv-warn {
  background: #e6a23c;
}
.pv-nav {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pv-title {
  min-width: 110px;
  text-align: center;
  font-weight: 600;
  font-size: 13px;
}
.pv-empty {
  color: #909399;
  padding: 24px 0;
  text-align: center;
  font-size: 13px;
}
.pv-pending {
  margin-bottom: 10px;
}
.pv-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 6px;
}
.pv-head {
  margin-bottom: 6px;
}
.pv-cell {
  min-height: 72px;
  border: 1px solid #ebeef5;
  border-radius: 6px;
  padding: 4px 6px;
  background: #fff;
}
.pv-week {
  min-height: auto;
  text-align: center;
  font-size: 12px;
  color: #909399;
  border: none;
  background: transparent;
  padding: 2px 0;
}
.pv-blank {
  background: #fafafa;
  border-color: #f5f5f5;
}
.pv-has {
  background: #f0f9eb;
  border-color: #c2e7b0;
}
.pv-post {
  background: #fdf6ec;
  border-color: #f5dab1;
}
.pv-entry {
  font-size: 11px;
}
.pv-line {
  display: flex;
  align-items: center;
  gap: 4px;
  color: #529b2e;
}
.pv-post .pv-line {
  color: #b88230;
}
.pv-post .pv-dot {
  background: #e6a23c;
}
.pv-sale {
  color: #909399;
  font-size: 10px;
  margin-top: 2px;
}

.train-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.train-select {
  min-width: 0;
  flex: 1;
}

/* ---- 选择车次：紧凑列表，底部固定保留选择和确认操作 ---- */
.train-panel-bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding-bottom: 12px; }
.train-panel-cond { min-width: 0; line-height: 1.6; font-size: 14px; color: #303133; }
.train-panel-bar > .el-button { flex-shrink: 0; }
.train-panel-date { color: #909399; font-size: 12px; }
.train-panel-empty { padding: 40px 12px; text-align: center; font-size: 13px; color: #909399; }
.train-results { min-height: 0; max-height: 60dvh; overflow-y: auto; overscroll-behavior: contain; border-top: 1px solid #ebeef5; }
.stretch-table { width: 100%; }
.stretch-table :deep(table) { min-width: 720px; }
.stretch-table :deep(.wrap-col .cell) { white-space: normal; text-overflow: clip; overflow: visible; line-height: 1.45; }
.train-result { padding: 8px 10px; border-bottom: 1px solid #ebeef5; line-height: 1.5; }
.train-result-selected { background: #f0f7ff; }
.train-result-header { display: flex; align-items: center; gap: 20px; }
.train-result-header .el-checkbox { margin-right: 0; height: 22px; min-width: 90px; }
.train-result-header :deep(.el-checkbox__label) { font-size: 14px; font-weight: 600; }
.train-result-time { font-size: 14px; color: #303133; white-space: nowrap; }
.train-result-duration { color: #909399; font-size: 12px; }
.train-result-header > .train-result-duration { margin-left: auto; }
.train-result-route { margin: 2px 0 2px 22px; font-size: 12px; color: #606266; overflow-wrap: anywhere; }
.seat-list { display: flex; flex-wrap: wrap; gap: 2px 12px; margin-left: 22px; }
.seat-chip { font-size: 12px; white-space: nowrap; }
.train-selection-summary { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; font-size: 13px; color: #606266; }
.train-selected-tags { display: flex; flex-wrap: wrap; gap: 6px; max-height: 64px; overflow-y: auto; margin-top: 8px; }
.train-selection-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 12px; }
.train-selection-actions > .el-button { margin-left: 0; }
@media (max-width: 560px) {
  .train-result-header { flex-wrap: wrap; gap: 4px 12px; }
  .train-result-header .el-checkbox { min-width: 78px; }
  .train-result-header > .train-result-duration { margin-left: 22px; }
}

/* ---- 计划详情抽屉 ---- */
.detail-active {
  margin-bottom: 14px;
}
.detail-active :deep(.el-card__body) {
  padding: 12px 14px;
}
.da-label {
  font-size: 12px;
  color: #909399;
  margin-bottom: 6px;
}
.da-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.da-date {
  font-weight: 600;
  font-size: 14px;
  color: #303133;
}
.da-meta {
  margin-top: 8px;
  font-size: 12px;
  color: #909399;
}
.detail-sec-title {
  display: flex;
  align-items: center;
  font-weight: 700;
  font-size: 14px;
  margin: 4px 0 10px;
}
.detail-refresh {
  margin-left: auto;
}
.detail-count {
  font-weight: 400;
  font-size: 12px;
  color: #909399;
  margin-left: 6px;
}
.detail-tip {
  margin-top: 10px;
  font-size: 12px;
  color: #c0c4cc;
}
</style>
