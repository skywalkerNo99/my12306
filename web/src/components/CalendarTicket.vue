<script setup lang="ts">
import type { OrderRow } from '../api';
defineProps<{ ticket: OrderRow }>();
</script>

<template>
  <div class="cal-ticket" :title="`${ticket.trainCode} ${ticket.fromStation} → ${ticket.toStation}`">
    <b>{{ ticket.trainCode || '车次待确认' }}</b>
    <span>{{ ticket.travelDateTime?.slice(11, 16) || '时间待定' }}</span>
  </div>
</template>

<style scoped>
.cal-ticket {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 6px;
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.cal-ticket span { color: #606266; }
</style>
