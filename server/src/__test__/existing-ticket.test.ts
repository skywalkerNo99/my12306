import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {BrowserContext} from 'playwright';
import {purchaseTicket,type PurchaseParams} from '../bot/order.js';
import {existingTicket} from '../bot/existing-ticket.js';
import {normalizeOrders} from '../bot/orders.js';
const raw={sequence_no:'TEST_EXISTING',tickets:[{start_train_date_page:'2026-09-28 06:53',ticket_status_name:'已支付',passenger_name:'测试甲',seat_type_name:'二等座',stationTrainDTO:{station_train_code:'G1509',from_station_name:'南京南',to_station_name:'上海虹桥'}}]};
const params={trainDate:'2026-09-28',fromStation:'南京南',toStation:'上海虹桥',trainNumbers:['G1509'],passengers:[{name:'测试甲'}]} as PurchaseParams;
test('existing paid ticket succeeds before inventory access or purchase submission',async()=>{
 const page={goto:async()=>{},waitForTimeout:async()=>{},url:()=> 'https://kyfw.12306.cn/otn/queryOrder/init',close:async()=>{},evaluate:async(_:unknown,args:{u:string})=>{
  assert.ok(args.u.includes('queryOrder'), 'must not query inventory or submit an order');
  return JSON.stringify({status:true,data:args.u.includes('NoComplete')?{orderDBList:[]}:{OrderDTODataList:[raw]}});
 }};
 const context={newPage:async()=>page,request:{post:async()=>({ok:()=>true,json:async()=>({status:true,data:{psr:{results:[],total:0}}})})}} as unknown as BrowserContext;
 const result=await purchaseTicket(context,params);
 assert.equal(result.ok,true);assert.equal(result.duplicated,true);assert.equal(result.orderNo,'TEST_EXISTING');
});
test('wrong passenger, date, segment or departure window never marks purchased',()=>{
 const rows=normalizeOrders([raw],[]);
 assert.ok(existingTicket(params,rows));
 for(const change of [{trainDate:'2026-09-29'},{toStation:'上海'},{timeFrom:'08:00'},{trainNumbers:['G1']},{passengers:[{name:'其他乘客'}]}])assert.equal(existingTicket({...params,...change} as PurchaseParams,rows),null);
 assert.equal(existingTicket(params,[{...rows[0],status:'refunded'}]),null);
});
