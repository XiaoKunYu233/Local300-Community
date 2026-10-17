'use strict';
function buildTable(legacy,current){
  const out=new Map();
  for(const row of [...legacy,...current]){
    const id=Number(row[1]),price=Number(row[7]);
    if(Number.isInteger(id)&&id>0&&id<65535)out.set(id,Number.isFinite(price)&&price>0?Math.floor(price/5):0);
  }
  return out;
}
const refunds=buildTable(require('./logs/cfg/item_item.json'),require('../data/current-client/item_item.json'));
module.exports={refunds,buildTable};
