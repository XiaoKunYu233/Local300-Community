'use strict';
const fs=require('node:fs'),path=require('node:path');
const MAX_ATTEMPTS=6,DELAYS_MS=Object.freeze([10,20,40,80,160]);
const RETRYABLE=new Set(['EPERM','EACCES','EBUSY']),waitCell=new Int32Array(new SharedArrayBuffer(4));
const fold=value=>process.platform==='win32'?value.toLowerCase():value;
// JSON writers use a closed same-directory temporary file. Retrying this
// primitive does not remove the destination or weaken atomic replacement.
// Database-backed virtual renames must bypass this helper entirely.
function replace(from,to,renameSync=fs.renameSync){
  if(typeof from!=='string'||typeof to!=='string'||!path.isAbsolute(from)||!path.isAbsolute(to)||typeof renameSync!=='function')throw Error('Absolute atomic rename paths required');
  const source=path.resolve(from),target=path.resolve(to),normalizedSource=fold(source),normalizedTarget=fold(target);
  if(target===path.parse(target).root||fold(path.dirname(source))!==fold(path.dirname(target))||!normalizedSource.startsWith(normalizedTarget+'.')||
    !/^\.[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.tmp$/i.test(source.slice(target.length)))throw Error('Atomic rename requires the destination temporary file in the same directory');
  for(let attempt=0;;attempt++){
    try{return renameSync(source,target);}
    catch(error){
      if(process.platform!=='win32'||!RETRYABLE.has(error?.code)||attempt+1>=MAX_ATTEMPTS)throw error;
      Atomics.wait(waitCell,0,0,DELAYS_MS[attempt]);
    }
  }
}
module.exports={replace,MAX_ATTEMPTS,DELAYS_MS};
