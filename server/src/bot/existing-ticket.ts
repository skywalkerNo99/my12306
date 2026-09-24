import type { OrderRow } from './orders.js';
import type { PurchaseParams, PurchaseResult } from './order.js';
export function existingTicket(params: PurchaseParams, orders: OrderRow[]): PurchaseResult | null {
 const names=params.passengers.map(p=>p.name).sort();
 if(!names.length || names.some(n=>!n))return null;
 const hits=orders.filter(o=>o.status!=='refunded' && !/已改签|已变更到站|已作废/.test(o.statusText)
  && o.travelDateTime.slice(0,10)===params.trainDate
  && names.every(n=>o.passengers.includes(n))
  && (!params.trainNumbers?.length || params.trainNumbers.some(n=>n.toUpperCase()===o.trainCode.toUpperCase()))
  && (params.trainSegments?.length ? params.trainSegments.some(s=>s.trainCode===o.trainCode && s.fromStation===o.fromStation && s.toStation===o.toStation) : o.fromStation===params.fromStation && o.toStation===params.toStation)
  && (!params.timeFrom || o.travelDateTime.slice(11,16)>=params.timeFrom)
  && (!params.timeTo || o.travelDateTime.slice(11,16)<=params.timeTo));
 if(hits.length!==1)return null;
 const o=hits[0];
 return {ok:true,duplicated:true,paid:o.status==='paid',trainCode:o.trainCode,passengers:names,orderNo:o.orderNo,seatInfo:o.seats.join('；'),payDeadlineTs:o.payLimitTs??undefined,payDeadline:o.payLimitTime??undefined};
}
