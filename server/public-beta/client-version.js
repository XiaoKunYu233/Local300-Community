'use strict';
// The lobby version is protobuf field2 in the native public connect greeting.
const prefix=Buffer.from('00000000224e0000050000000100080110','hex');
function valid(v){return Number.isSafeInteger(v)&&v>=1&&v<=0x7fffffff;}
function greeting(version=8824){
  if(!valid(version))throw Error('服务端版本号必须是1至2147483647的整数。');
  const bytes=[];let n=version;do{bytes.push((n%128)+(n>=128?128:0));n=Math.floor(n/128);}while(n);
  const body=Buffer.concat([prefix,Buffer.from(bytes)]),out=Buffer.alloc(4+body.length);out.writeUInt32LE(out.length);body.copy(out,4);return out;
}
function isGreeting(frame,version){
  if(!Buffer.isBuffer(frame)||frame.length<22||frame.length>26)return false;
  let n=0,power=1;for(let at=21;at<frame.length;at++){const b=frame[at];n+=(b&127)*power;power*=128;if(!(b&128))return at===frame.length-1&&valid(n)&&(version===undefined||n===version)&&frame.equals(greeting(n));}return false;
}
module.exports={valid,greeting,isGreeting};
