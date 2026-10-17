'use strict';
// Checkpointed main-file bytes only. No file SQLite connection is opened.
// https://sqlite.org/c3ref/deserialize.html documents the in-memory WAL header
// conversion; original bytes and their hashes remain unchanged.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{DatabaseSync}=require('node:sqlite'),{DocumentStore,APPLICATION_ID}=require('./document-store');
function open(file){
  if(!path.isAbsolute(file)||file===':memory:')throw Error('Absolute checkpointed database required');
  const auxiliaries=['-wal','-shm','-journal'];if(auxiliaries.some(s=>fs.existsSync(file+s)))throw Error('Offline database has journal metadata');
  const fold=s=>process.platform==='win32'?s.toLowerCase():s;for(let cursor=path.resolve(file);;){if(fs.lstatSync(cursor).isSymbolicLink()||fold(fs.realpathSync.native(cursor))!==fold(cursor))throw Error('Offline database alias rejected');const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;}
  const st=fs.lstatSync(file);if(!st.isFile()||st.nlink!==1||st.size>128*1024*1024)throw Error('Offline database file rejected');const original=fs.readFileSync(file),memory=Buffer.from(original),sourceSha256=crypto.createHash('sha256').update(original).digest('hex');
  if(memory.length<100||!memory.subarray(0,16).equals(Buffer.from('SQLite format 3\0'))||![1,2].includes(memory[18])||memory[18]!==memory[19])throw Error('Offline database header rejected');memory[18]=memory[19]=1;
  const db=new DatabaseSync(':memory:');try{if(typeof db.deserialize!=='function')throw Error('SQLite deserialize unavailable');db.deserialize(memory);db.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON;');if(db.prepare('PRAGMA application_id').get().application_id!==APPLICATION_ID||db.prepare('PRAGMA user_version').get().user_version!==1)throw Error('Offline document schema rejected');if(auxiliaries.some(s=>fs.existsSync(file+s))||!fs.readFileSync(file).equals(original))throw Error('Offline database changed while reading');const store=Object.create(DocumentStore.prototype);Object.assign(store,{file,sourceSha256,db,readOnly:true,active:false,activeScope:null,readActive:false,failedError:null,changes:new Set()});if(!store.verify().ok)throw Error('Offline document integrity rejected');return store;}catch(e){db.close();throw e;}
}
module.exports={open};
