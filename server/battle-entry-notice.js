'use strict';
const W=require('./battle-wire');
const ENTER_TEXT=Buffer.from('bdf8c8ebd5bdb3a1','hex'); // GBK: 进入战场
// Original-server MSG_SHOWBROADCAST (1104): actor source in payload, broadcast
// recipient 0xffffffff, type zero, fixed 256-byte NUL-terminated text.
function entryNotice(actorId){
 if(!Number.isInteger(actorId)||actorId<=0||actorId>0xffffffff)throw Error('Invalid entry actor');
 const payload=Buffer.alloc(266);
 payload.writeUInt32LE(actorId,0);payload.writeUInt32LE(0xffffffff,4);
 ENTER_TEXT.copy(payload,10);
 return W.frame(1104,0,payload);
}
module.exports={entryNotice};

