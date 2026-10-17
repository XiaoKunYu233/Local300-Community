'use strict';
const {mkFrame}=require('./bag');
// Native bec2ed consumes every byte of the registered 20-byte reply. The
// request and full snapshot use one-based selectors; this small reply alone
// uses a zero-based selector at +15. No failure code meaning is inferred.
function levelUpReplies(request,result,playerId){
  if(request?.operation!=='bulkLevelUp'||!result?.ok||!Number.isInteger(request.page)||request.page<0||request.page>4||!Number.isInteger(request.category)||request.category<1||request.category>4||!Array.isArray(result.results)||!Number.isInteger(playerId)||playerId<1||playerId>0xffffffff)throw Error('Invalid war-soul level acknowledgement');
  return result.results.map(entry=>{
    if(!request.unitIds.includes(entry.unitId)||entry.category!==request.category||!Number.isInteger(entry.unitId)||entry.unitId<1||entry.unitId>1280||!Number.isInteger(entry.level)||entry.level<1||entry.level>5)throw Error('Invalid war-soul level acknowledgement entry');
    const body=Buffer.alloc(8);body[1]=request.page;body[2]=request.category-1;body.writeUInt32LE(entry.unitId-1,3);body[7]=entry.level;
    return mkFrame(36268,body,{flags:0x0d,stream:playerId});
  });
}
module.exports={levelUpReplies};
