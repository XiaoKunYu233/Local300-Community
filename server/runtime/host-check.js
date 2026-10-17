'use strict';
function checkHost({sqlite=false}={}){
  const checks=[];const check=(name,operation)=>{try{operation();checks.push({name,ok:true});}catch(error){checks.push({name,ok:false,error:error.message});}};
  check('GBK decoder',()=>{if(new TextDecoder('gbk').decode(Buffer.from([0xd6,0xd0]))!=='中')throw Error('GBK ICU support required');});
  check('crypto UUID',()=>{if(!/^[a-f0-9-]{36}$/.test(require('node:crypto').randomUUID()))throw Error('UUID support unavailable');});
  if(sqlite)check('native SQLite transaction and strict blob support',()=>{
    const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(':memory:');
    try{db.exec('PRAGMA foreign_keys=ON; CREATE TABLE probe(id INTEGER PRIMARY KEY, content BLOB NOT NULL) STRICT; BEGIN IMMEDIATE;');
      db.prepare('INSERT INTO probe VALUES(?,?)').run(1,Buffer.from('probe'));db.exec('ROLLBACK;');
      if(db.prepare('SELECT COUNT(*) count FROM probe').get().count!==0)throw Error('Rollback check failed');
      if(db.prepare('PRAGMA foreign_keys').get().foreign_keys!==1)throw Error('Foreign keys unavailable');
    }finally{db.close();}
  });
  return {ok:checks.every(row=>row.ok),node:process.version,platform:process.platform,architecture:process.arch,checks,scope:'Host capability smoke checks; no live state or listeners opened'};
}
if(require.main===module){const result=checkHost({sqlite:process.argv.includes('--sqlite')});console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;}
module.exports={checkHost};
