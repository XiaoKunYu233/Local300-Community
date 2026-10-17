'use strict';

// Observed wire shape for the blessing-attribute reforge button. This module
// does not generate candidates, debit resources or apply equipment changes.
function guidOf(payload, length) {
  if (!Buffer.isBuffer(payload) || payload.length !== length)
    throw new RangeError(`expected ${length}-byte payload`);
  const guid=payload.subarray(0,8).toString('hex');
  if (/^0{16}$/.test(guid)) throw new RangeError('zero equipment GUID');
  return guid;
}
function parseReforgeRequest(payload) {
  const guid=guidOf(payload,12);
  return {guid, luckyItemId:payload.readUInt32LE(8),
    trailingRaw:payload.subarray(8).toString('hex')};
}
function parseApplyRequest(payload) { return {guid:guidOf(payload,8)}; }
function parseCandidateReply(payload) {
  if (!Buffer.isBuffer(payload) || payload.length!==42)
    throw new RangeError('expected 42-byte candidate reply');
  return Array.from({length:6},(_,i)=>{
    const offset=i*7;
    return Object.freeze({slot:i,attributeCode:payload[offset],
      value:payload.readUInt32LE(offset+1),flag:payload.readUInt16LE(offset+5),
      rawHex:payload.subarray(offset,offset+7).toString('hex')});
  });
}
module.exports={parseReforgeRequest,parseApplyRequest,parseCandidateReply};
