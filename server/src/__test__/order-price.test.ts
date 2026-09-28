import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrders } from '../bot/orders.js';
import { fmtDay, ticketYuan, type RawTicket } from '../bot/orderApi.js';
import { parseTransferList, saleAtFromApi } from '../bot/tickets.js';
// Synthetic prices; these are not a claim about G1716's actual fare.
const ticket = (extra: Partial<RawTicket> = {}): RawTicket => ({ start_train_date_page:'2026-09-24 10:00', ticket_status_name:'已支付', passenger_name:'测试甲', seat_type_name:'二等座', ticket_price:31000, stationTrainDTO:{station_train_code:'G1716',from_station_name:'常州北',to_station_name:'信阳东'}, ...extra });
test('prices stay with their own journey and ticket status', () => {
 const rows=normalizeOrders([{sequence_no:'TEST',tickets:[ticket(),ticket({stationTrainDTO:{station_train_code:'GTEST',from_station_name:'甲站',to_station_name:'乙站'}}),ticket({ticket_status_name:'已退票'})]}],[]);
 assert.equal(rows.length,3);
 assert.deepEqual(rows.map(r=>r.totalPrice),[310,310,310]);
 assert.equal(rows.filter(r=>r.status==='refunded').length,1);
});
test('same journey totals people, while missing fares never yield a misleading partial total', () => {
 const rows=normalizeOrders([{sequence_no:'TEST',tickets:[ticket(),ticket({passenger_name:'测试乙'})]}],[]);
 assert.equal(rows.length,1);assert.equal(rows[0].totalPrice,620);assert.equal(rows[0].passengers.length,2);
 assert.equal(normalizeOrders([{sequence_no:'TEST',tickets:[ticket(),ticket({ticket_price:undefined})]}],[])[0].totalPrice,null);
});
test('API overlap and repeated completed orders do not double count', () => {
 const order={sequence_no:'TEST',tickets:[ticket()]};
 assert.equal(normalizeOrders([order,order],[{...order,tickets:[ticket({ticket_status_name:'待支付'})]}])[0].totalPrice,310);
 assert.equal(normalizeOrders([order,order],[]).length,1);
});
test('price fields use their declared units and reject invalid numbers', () => {
 assert.equal(ticketYuan({str_ticket_price_page:'310.0',ticket_price:31000}),310);
 assert.equal(ticketYuan({ticket_price:31000}),310);assert.equal(ticketYuan({price:'310.5'}),310.5);
 assert.equal(ticketYuan({price:'Infinity'}),null);assert.equal(ticketYuan({price:-1}),null);
});

test('changed-destination history is separate from the current G1716 ticket', () => {
 // Current 346 yuan fare comes from the reported screenshot; 274 is a synthetic
 // historical fare chosen to reproduce the old 620-yuan aggregation failure.
 const current=ticket({ticket_status_name:'变更到站票',coach_name:'07',seat_name:'17A号',ticket_price:34600,str_ticket_price_page:'346.0'});
 const history=ticket({ticket_status_name:'已变更到站',coach_name:'08',seat_name:'04F号',ticket_price:27400,str_ticket_price_page:'274.0'});
 const rows=normalizeOrders([{sequence_no:'TEST_CHANGED_DESTINATION',tickets:[current,history]}],[]);
 assert.equal(rows.length,2);
 assert.equal(rows.find(r=>r.statusText==='变更到站票')?.totalPrice,346);
 assert.equal(rows.find(r=>r.statusText==='已变更到站')?.totalPrice,274);
 assert.ok(rows.every(r=>r.totalPrice!==620));
 assert.ok(rows.every(r=>r.passengers.length===1 && r.seats.length===1));
 assert.deepEqual(rows.find(r=>r.statusText==='变更到站票')?.seats,['二等座 07车17A号']);
});

test('arrival uses the official destination date, including overnight and multi-day trips', () => {
 for (const arrival of ['2026-09-24 18:32:00','2026-09-25 06:15:00','2026-09-26 08:00:00']) {
  const rows=normalizeOrders([{sequence_no:'ARRIVAL',tickets:[ticket({stationTrainDTO:{station_train_code:'G1716',arrive_time:arrival}})]}],[]);
  assert.equal(rows[0].arrivalDateTime,arrival.slice(0,16));
 }
 for (const arrival of [undefined,'','invalid','2026-02-30 06:15','2026-09-25 25:00']) {
  assert.equal(normalizeOrders([{sequence_no:'UNKNOWN',tickets:[ticket({stationTrainDTO:{arrive_time:arrival}})]}],[])[0].arrivalDateTime,null);
 }
 const sameDay=normalizeOrders([{sequence_no:'CLOCK',tickets:[ticket({stationTrainDTO:{station_train_code:'G1716',arrive_time:'18:32'}})]}],[]);
 assert.equal(sameDay[0].arrivalDateTime,'2026-09-24 18:32');
 const overnight=normalizeOrders([{sequence_no:'CLOCK',tickets:[ticket({stationTrainDTO:{station_train_code:'G1716',arrive_time:'06:15'}})]}],[]);
 assert.equal(overnight[0].arrivalDateTime,'2026-09-25 06:15');
 const epoch=normalizeOrders([{sequence_no:'EPOCH',tickets:[ticket({start_train_date_page:'2026-09-25 13:03',stationTrainDTO:{station_train_code:'G1716',arrive_time:'1970-01-01 18:32:00'}})]}],[]);
 assert.equal(epoch[0].arrivalDateTime,'2026-09-25 18:32');
 const epochOvernight=normalizeOrders([{sequence_no:'EPOCH',tickets:[ticket({start_train_date_page:'2026-09-25 13:03',stationTrainDTO:{station_train_code:'G1716',arrive_time:'1970-01-01 06:15:00'}})]}],[]);
 assert.equal(epochOvernight[0].arrivalDateTime,'2026-09-26 06:15');
});

test('transfer list keeps a connection, a same-train ride, and a marked supplement', () => {
 const schemes=parseTransferList([
  {from_station_name:'上海',middle_station_name:'郑州',end_station_name:'信阳',start_time:'08:00',arrive_time:'14:20',all_lishi:'06:20',wait_time:'00:25',same_train:'0',fullList:[
    {station_train_code:'G1',from_station_name:'上海虹桥',to_station_name:'郑州东',start_time:'08:00',arrive_time:'12:10',lishi:'04:10',ze_num:'有'},
    {station_train_code:'G2',from_station_name:'郑州东',to_station_name:'信阳东',start_time:'12:35',arrive_time:'14:20',lishi:'01:45',ze_num:'3'},
  ]},
  {from_station_name:'上海',middle_station_name:'南京南',end_station_name:'信阳',same_train:'1',middle_date:'2026-09-26',fullList:[
    {station_train_code:'K1107',from_station_name:'上海',to_station_name:'南京',start_time:'13:06',arrive_time:'16:00',lishi:'02:54',start_date:'2026-09-25',yz_num:'有'},
    {station_train_code:'K1107',from_station_name:'南京',to_station_name:'信阳',start_time:'16:20',arrive_time:'02:17',lishi:'09:57',yw_num:'5'},
  ]},
  {is_bu_piao:'1',from_station_name:'上海',middle_station_name:'驻马店',end_station_name:'信阳',fullList:[
    {station_train_code:'G3822',from_station_name:'上海松江',to_station_name:'驻马店',start_time:'13:49',arrive_time:'19:00',lishi:'05:11'},
  ]},
 ]);
 assert.deepEqual(schemes.map(s=>s.label),['换乘','同车接续','补票']);
 assert.equal(schemes[0].legs.length,2);
 assert.equal(schemes[0].legs[0].seats['二等座'],'有');
 assert.deepEqual(schemes[0].legs[0].seatTypes,['ZE']);
 assert.equal(schemes[1].legs[1].date,'2026-09-26');
 assert.deepEqual(schemes[1].legs[1].seatTypes,['YW']);
 assert.equal(schemes[1].legs[0].date,'2026-09-25');
});

test('sale clock is not attached to the travel date, and order dates use Beijing time', () => {
 assert.equal(saleAtFromApi('2026-09-28','08:00','2026-09-14'),'2026-09-14T08:00:00+08:00');
 assert.equal(saleAtFromApi('2026-09-28','08:30','2026-09-28'),'2026-09-14T08:30:00+08:00');
 assert.equal(saleAtFromApi('2026-09-28','2026-09-14 08:00'),'2026-09-14T08:00:00+08:00');
 assert.equal(fmtDay(new Date('2026-09-21T16:01:00Z')),'2026-09-22');
});

test('arrival accepts the official local arrival field and falls back when it is empty', () => {
 const local = ticket({stationTrainDTO:{arrive_time_local:'1970-01-01 18:32:00',arrive_time:''}});
 assert.equal(normalizeOrders([{sequence_no:'LOCAL',tickets:[local]}],[])[0].arrivalDateTime,'2026-09-24 18:32');
 const overnight = ticket({stationTrainDTO:{arrive_time_local:'2026-09-26 06:15:00',arrive_time:'1970-01-01 06:15:00'}});
 assert.equal(normalizeOrders([{sequence_no:'LOCAL',tickets:[overnight]}],[])[0].arrivalDateTime,'2026-09-26 06:15');
 const fallback = ticket({stationTrainDTO:{arrive_time_local:'',arrive_time:'18:32'}});
 assert.equal(normalizeOrders([{sequence_no:'LOCAL',tickets:[fallback]}],[])[0].arrivalDateTime,'2026-09-24 18:32');
});
