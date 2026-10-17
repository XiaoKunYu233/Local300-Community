'use strict';
// Compatibility storage keeps complete legacy documents, including unknown
// fields. It is a separate backend from the normalized equipment prototype.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const APPLICATION_ID=0x48524453;
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const validKey=v=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v);
class DocumentStore {
  constructor(file,{readOnly=false}={}){
    if(file!==':memory:'&&!path.isAbsolute(file))throw Error('Absolute database path required');
    if(!readOnly&&file!==':memory:')fs.mkdirSync(path.dirname(file),{recursive:true});
    this.file=file;this.readOnly=readOnly;this.active=false;this.activeScope=null;this.readActive=false;this.failedError=null;this.changes=new Set();
    this.db=new DatabaseSync(file,{readOnly,timeout:5000});
    try{
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      const id=this.db.prepare('PRAGMA application_id').get().application_id;
      const version=this.db.prepare('PRAGMA user_version').get().user_version;
      if(id!==APPLICATION_ID&&(id!==0||version!==0))throw Error('Not a legacy-document database');
      if(readOnly&&(id!==APPLICATION_ID||version!==1))throw Error('Uninitialized document database');
      if(version!==0&&version!==1)throw Error('Unsupported document schema');
      if(!readOnly){
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
        if(version===0)this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE scopes(scope TEXT PRIMARY KEY, provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json))) STRICT;
          CREATE TABLE documents(scope TEXT NOT NULL REFERENCES scopes(scope), name TEXT NOT NULL, content BLOB NOT NULL, sha256 TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1), PRIMARY KEY(scope,name)) STRICT;
          CREATE TABLE commits(sequence INTEGER PRIMARY KEY, scope TEXT NOT NULL REFERENCES scopes(scope), kind TEXT NOT NULL, changes_json TEXT NOT NULL CHECK(json_valid(changes_json)), created_at TEXT NOT NULL) STRICT;
          PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1; COMMIT;`);
      }
    }catch(e){this.db.close();throw e;}
  }
  close(){this.db.close();}
  assertScope(scope){if(!validKey(scope)||!this.db.prepare('SELECT 1 FROM scopes WHERE scope=?').get(scope))throw Error('Unknown storage scope');}
  has(scope,name){return !!this.db.prepare('SELECT 1 FROM documents WHERE scope=? AND name=?').get(scope,name);}
  read(scope,name){const row=this.db.prepare('SELECT content FROM documents WHERE scope=? AND name=?').get(scope,name);
    if(!row)throw Object.assign(Error('Document not found: '+name),{code:'ENOENT'});return Buffer.from(row.content);}
  record(scope,name){const row=this.db.prepare('SELECT content,revision FROM documents WHERE scope=? AND name=?').get(scope,name);
    return row?{bytes:Buffer.from(row.content),revision:row.revision}:null;}
  changeToken(scope,name){const row=this.db.prepare('SELECT revision,sha256 FROM documents WHERE scope=? AND name=?').get(scope,name);
    return row?`${row.revision}:${row.sha256}`:'missing';}
  transaction(scope,kind,operation){
    this.assertScope(scope);if(this.readOnly||this.active||this.readActive)throw Error('Read-only or nested document transaction');
    this.db.exec('BEGIN IMMEDIATE');this.active=true;this.activeScope=scope;this.failedError=null;this.changes=new Set();
    try{
      const result=operation();if(result&&typeof result.then==='function')throw Error('Document transaction must be synchronous');
      if(this.failedError)throw this.failedError;
      const changes=[...this.changes].sort().map(name=>{const row=this.db.prepare('SELECT sha256,revision FROM documents WHERE scope=? AND name=?').get(scope,name);return {name,...(row||{deleted:true})};});
      if(changes.length)this.db.prepare('INSERT INTO commits(scope,kind,changes_json,created_at) VALUES(?,?,?,?)').run(scope,kind,JSON.stringify(changes),new Date().toISOString());
      this.db.exec('COMMIT');return result;
    }catch(e){this.db.exec('ROLLBACK');throw e;}finally{this.active=false;this.activeScope=null;this.failedError=null;this.changes.clear();}
  }
  poison(error){if(this.active&&!this.failedError)this.failedError=error;return error;}
  readSnapshot(operation){if(this.active||this.readActive)return operation();this.db.exec('BEGIN');this.readActive=true;
    try{const value=operation();if(value&&typeof value.then==='function')throw Error('Snapshot callback must be synchronous');this.db.exec('COMMIT');return value;}
    catch(e){this.db.exec('ROLLBACK');throw e;}finally{this.readActive=false;}}
  put(scope,name,bytes,{expectedRevision}={}){
    this.assertScope(scope);if(!validKey(name))throw Error('Invalid document key');
    if(this.active&&scope!==this.activeScope)throw this.poison(Error('Cross-scope write rejected'));
    if(this.readActive)throw Error('Cannot mutate a read snapshot');
    bytes=Buffer.from(bytes);
    const write=()=>{const revision=this.db.prepare('SELECT revision FROM documents WHERE scope=? AND name=?').get(scope,name)?.revision||0;
      if(expectedRevision!==undefined&&revision!==expectedRevision)throw Object.assign(Error('Stale state revision: '+name),{code:'ESTALE'});
      this.db.prepare('INSERT INTO documents VALUES(?,?,?,?,1) ON CONFLICT(scope,name) DO UPDATE SET content=excluded.content,sha256=excluded.sha256,revision=documents.revision+1')
      .run(scope,name,bytes,digest(bytes));this.changes.add(name);};
    try{if(this.active)write();else this.transaction(scope,'save:'+name,write);}catch(e){throw this.poison(e);}
  }
  delete(scope,name,{expectedRevision}={}){if(this.active&&scope!==this.activeScope)throw this.poison(Error('Cross-scope write rejected'));
    if(this.readActive)throw Error('Cannot mutate a read snapshot');const write=()=>{
    const revision=this.db.prepare('SELECT revision FROM documents WHERE scope=? AND name=?').get(scope,name)?.revision||0;
    if(expectedRevision!==undefined&&revision!==expectedRevision)throw Object.assign(Error('Stale state revision: '+name),{code:'ESTALE'});
    this.db.prepare('DELETE FROM documents WHERE scope=? AND name=?').run(scope,name);this.changes.add(name);};
    try{if(this.active)write();else this.transaction(scope,'delete:'+name,write);}catch(e){throw this.poison(e);}}
  importScope(scope,documents,provenance){
    if(!validKey(scope)||this.readOnly||this.active||this.readActive)throw Error('Invalid import scope');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.db.prepare('INSERT INTO scopes VALUES(?,?)').run(scope,JSON.stringify(provenance));
      for(const {name,bytes} of documents){if(!validKey(name))throw Error('Invalid document key');
        const data=Buffer.from(bytes);JSON.parse(data.toString('utf8'));
        this.db.prepare('INSERT INTO documents VALUES(?,?,?,?,1)').run(scope,name,data,digest(data));}
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  exportScope(scope){return this.readSnapshot(()=>{this.assertScope(scope);
    const documents=this.db.prepare('SELECT name,content,sha256,revision FROM documents WHERE scope=? ORDER BY name').all(scope)
      .map(r=>({...r,content:Buffer.from(r.content)}));
    const provenance=JSON.parse(this.db.prepare('SELECT provenance_json FROM scopes WHERE scope=?').get(scope).provenance_json);
    return {scope,provenance,documents};
  });}
  verify(){const integrity=this.db.prepare('PRAGMA integrity_check').all().map(r=>r.integrity_check),foreignKeys=this.db.prepare('PRAGMA foreign_key_check').all();
    const broken=this.db.prepare('SELECT scope,name,content,sha256 FROM documents').all().filter(r=>digest(r.content)!==r.sha256).map(r=>({scope:r.scope,name:r.name}));
    return {ok:integrity.length===1&&integrity[0]==='ok'&&!foreignKeys.length&&!broken.length,integrity,foreignKeys,broken};}
}
module.exports={DocumentStore,APPLICATION_ID,digest};
