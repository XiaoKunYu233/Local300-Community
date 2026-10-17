'use strict';
// Native 16811 button handlers fb5730..fbb960; balances: fa33e0,
// bf6880 (1045), bcdc9d (1394), fa3cae..fa3d66 (material IDs).
const currencies = Object.freeze({
  1:{name:'钻石',attr:72,scale:100},
  3:{name:'金币',attr:50,scale:1},
  4:{name:'VIP点',attr:52,scale:1},
  6:{name:'功勋',attr:131,scale:1},
  7:{name:'荣誉',walletKey:'honour',message:1394,scale:1},
  11:{name:'挑战币',attr:156,scale:1},
  12:{name:'绑定钻石',attr:157,scale:100},
  14:{name:'zen币',attr:181,scale:1},
  15:{name:'灯笼',resource:7814,scale:1},
  16:{name:'灵石',resource:7865,scale:1},
  17:{name:'高级灵石',resource:9007,scale:1},
  18:{name:'皮肤币',resource:9017,scale:1},
});
function offers(row) {
  const p=row.page,result={};
  const add=(code,price)=>{if(Number.isSafeInteger(price)&&price>0)result[code]=price;};
  if([1,2,4,8,16,32,64,512].includes(p)){add(1,row.diamond);add(3,row.gold);}
  if(p===128)add(4,row.gold);
  if(p===1024)add(11,row.gold);
  if(p===2048){add(1,row.diamond);add(12,row.diamond);}
  if(p===2050)add(14,row.gold);
  if(p===2051)add(15,row.gold);
  if(p===2052&&row.group<=2)add(16+row.group,row.gold);
  add(6,Number(row.config?.[12]||0));
  if(p===16)add(7,row.extra);
  // No invented currency code for Mobius: its native exchange is a separate
  // protocol. Legacy honour/guild price fields are not gold substitutes.
  return result;
}
module.exports={currencies,offers};
