'use strict';
// Native bcdb8b..bcdb9f: 1015 +12 -> player+46dec (attribute131).
// Registration115047a..115048f fixes32B. The remaining four words and
// S2C flags are opaque; captures demonstrate multiple flag values.
const TAG=1015,BYTES=32,valid=n=>Number.isInteger(n)&&n>0&&n<=0xffffffff;
function identity(account){if(!account||!valid(account.uid)||!valid(account.playerId))throw Error('Verified merits UID and role required');}
function decode(frame,account){identity(account);if(!Buffer.isBuffer(frame)||frame.length!==BYTES||frame.readUInt32LE(0)!==BYTES||frame.readUInt16LE(8)!==TAG||frame.readUInt32LE(4)!==account.playerId)throw Error('Invalid or foreign merits frame');return {uid:account.uid,playerId:account.playerId,header:Buffer.from(frame.subarray(0,12)),merits:frame.readUInt32LE(12),opaqueTail:Buffer.from(frame.subarray(16))};}
function encode(value){identity(value);if(!Buffer.isBuffer(value.header)||value.header.length!==12||!Buffer.isBuffer(value.opaqueTail)||value.opaqueTail.length!==16||!Number.isInteger(value.merits)||value.merits<0||value.merits>0xffffffff)throw Error('Invalid merits wire model');const payload=Buffer.alloc(4);payload.writeUInt32LE(value.merits);const frame=Buffer.concat([Buffer.from(value.header),payload,Buffer.from(value.opaqueTail)]);decode(frame,value);return frame;}
function patch(frame,account,merits){const value=decode(frame,account);if(merits===undefined||merits===null)return null;return encode({...value,merits});}
module.exports={TAG,BYTES,decode,encode,patch};
