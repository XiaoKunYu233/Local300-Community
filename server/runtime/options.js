'use strict';
const {validLimits}=require('../inventory-capacity');
function parseOptions(args){
  const values=new Map();
  for(const arg of args){const m=/^--([a-z][a-z0-9-]*)=(.*)$/s.exec(arg);if(m&&!values.has(m[1]))values.set(m[1],m[2]);}
  const argOf=(key,fallback)=>values.has(key)?values.get(key):fallback;
  const integer=(key,fallback,min,max)=>{const value=argOf(key,String(fallback));
    if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<min||Number(value)>max)throw Error('Invalid --'+key);
    return Number(value);};
  const cap=argOf('cap','');if(!cap)throw Error('Required --cap=<capture directory>');
  const visibleCapacity=integer('bag-capacity',192,1,352),recordCapacity=integer('bag-records',visibleCapacity,1,552);
  if(!validLimits(visibleCapacity,recordCapacity))throw Error('Invalid bag capacity/record space');
  const portText=argOf('ports','30000,30001');
  if(!/^\d+(,\d+)*$/.test(portText))throw Error('Invalid --ports');
  const ports=portText.split(',').map(Number);
  if(ports.some(n=>n<0||n>65535)||new Set(ports.filter(Boolean)).size!==ports.filter(Boolean).length)throw Error('Invalid --ports');
  const safety=integer('safety',6000,0,2147483647);
  const gmPort=values.has('gm-port')?integer('gm-port',0,0,65535):null;
  if(gmPort&&ports.includes(gmPort))throw Error('GM port collides with lobby port');
  const matchPort=integer('match-port',9004,1,65535);
  const host=argOf('host','0.0.0.0');
  if(!['0.0.0.0','127.0.0.1'].includes(host))throw Error('Invalid --host');
  return {argOf,cap,ports,safety,visibleCapacity,recordCapacity,gmPort,matchPort,host};
}
module.exports={parseOptions};
