'use strict';

const stateFiles=require('./persistence/state-files');
const fs = stateFiles.io;

function validId(id) { return Number.isInteger(id) && id > 0 && id <= 0xffffffff; }
function idSet(values) {
  if (!Array.isArray(values)) throw new Error('Invalid mail state IDs');
  const normalized = values.map(raw =>
    typeof raw === 'string' && /^(?:[0-9]+|0x[0-9a-f]+)$/i.test(raw) ? Number(raw) : raw);
  if (normalized.some(id => !validId(id))) throw new Error('Invalid mail state IDs');
  return new Set(normalized);
}

class MailState {
  constructor(file, io = fs) {
    this.file = file;
    this.io = io;
    this.reload();
  }

  reload() {
    const io=this.io,file=this.file;
    const load=()=>{
      for(let attempt=0;attempt<4;attempt++){
        const before=io===fs?stateFiles.changeToken(file):null;
        let data;
        try { data = JSON.parse(io.readFileSync(file, 'utf8')); }
        catch (error) {if (error.code !== 'ENOENT') throw error;data = {};}
        const after=io===fs?stateFiles.changeToken(file):null;
        if(before===after)return {data,token:after};
      }
      throw Error('Mail state changed during bounded read');
    };
    // A revision and its bytes must belong to one SQLite snapshot. JSON uses
    // before/after tokens, never adopts old bytes with a newer writer's token.
    const {data,token}=io===fs?stateFiles.readSnapshot(load):load();
    // Old state files contain only claimed. Never infer read from an unclaimed mail.
    this.deleted = idSet(data.deleted || []);
    this.claimed = idSet(data.claimed || []);
    this.read = idSet(data.read || []);
    this.notified = idSet(data.notified || []);
    this.pending = idSet(data.pending || []);
    this.pendingInfo = data.pendingInfo && typeof data.pendingInfo === 'object' && !Array.isArray(data.pendingInfo)
      ? {...data.pendingInfo} : {};
    for (const id of this.claimed) { this.read.add(id); this.pending.delete(id); delete this.pendingInfo[id]; }
    this.token=token;
  }

  refresh() { if(this.io===fs&&stateFiles.changeToken(this.file)!==this.token)this.reload(); }
  snapshot() {this.refresh();return {deleted:[...this.deleted],claimed:[...this.claimed],read:[...this.read],notified:[...this.notified],pending:[...this.pending],pendingInfo:JSON.parse(JSON.stringify(this.pendingInfo)),token:this.token};}
  restore(snapshot) {this.deleted=idSet(snapshot.deleted||[]);this.claimed=idSet(snapshot.claimed);this.read=idSet(snapshot.read);this.notified=idSet(snapshot.notified);this.pending=idSet(snapshot.pending);this.pendingInfo=JSON.parse(JSON.stringify(snapshot.pendingInfo));this.token=snapshot.token;}
  hasDeleted(id) {this.refresh();return this.deleted.has(id);}
  hasClaimed(id) { this.refresh();return this.claimed.has(id); }
  hasRead(id) { this.refresh();return this.read.has(id); }
  hasNotified(id) { this.refresh();return this.notified.has(id); }
  hasPending(id) { this.refresh();return this.pending.has(id); }
  hasOwnedRecord(id) {this.refresh();return this.deleted.has(id)||this.claimed.has(id)||this.read.has(id)||this.notified.has(id)||this.pending.has(id);}
  hasUnresolvedPending() { this.refresh();return this.pending.size > 0; }

  pendingDiagnostics() {
    this.refresh();
    return [...this.pending].sort((a,b)=>a-b).map(id => {
      const info = this.pendingInfo[id];
      return {id, hex:`0x${id.toString(16)}`, stage:info?.stage || 'unknown',
        failedContainer:info?.failedContainer || null, paths:info?.paths ? {...info.paths} : null};
    });
  }

  persist(read, claimed, pending, pendingInfo = this.pendingInfo, notified = this.notified, deleted = this.deleted) {
    if(this.io===fs&&stateFiles.changeToken(this.file)!==this.token)throw Error('Mail state changed before save');
    const tmp = `${this.file}.${process.pid}.tmp`;
    const data = JSON.stringify({deleted:[...deleted],read: [...read], claimed: [...claimed], notified:[...notified], pending: [...pending],
      pendingInfo, updatedAt: new Date().toISOString()}, null, 2);
    try {
      this.io.writeFileSync(tmp, data);
      this.io.renameSync(tmp, this.file);
    } catch (error) {
      try { this.io.unlinkSync(tmp); } catch { /* original write error is authoritative */ }
      throw error;
    }
    this.deleted=deleted;this.read = read; this.claimed = claimed; this.notified=notified;
    this.pending = pending; this.pendingInfo = pendingInfo;
    this.token=this.io===fs?stateFiles.changeToken(this.file):null;
  }

  markDeleted(id,{hasAttachments}={}) {
    this.refresh();if(!validId(id)||typeof hasAttachments!=='boolean')throw Error('Invalid mail deletion');
    if(this.deleted.has(id))return false;
    if(this.pending.has(id)||(hasAttachments&&!this.claimed.has(id)))throw Error('Mail attachments must be claimed before deletion');
    const deleted=new Set(this.deleted);deleted.add(id);
    this.persist(new Set(this.read),new Set(this.claimed),new Set(this.pending),this.pendingInfo,new Set(this.notified),deleted);return true;
  }
  markNotified(id) {
    this.refresh();
    if (!validId(id)) throw new Error('Invalid mail ID');
    if (this.notified.has(id)) return false;
    const notified=new Set(this.notified);notified.add(id);
    this.persist(new Set(this.read),new Set(this.claimed),new Set(this.pending),this.pendingInfo,notified);
    return true;
  }

  markRead(id) {
    this.refresh();
    if (!validId(id)) throw new Error('Invalid mail ID');
    if (this.read.has(id)) return false;
    const read = new Set(this.read); read.add(id);
    this.persist(read, new Set(this.claimed), new Set(this.pending));
    return true;
  }

  // A durable pending marker blocks repeat grants if another state file or the
  // final claimed write fails. Recovery requires inspecting the reward files.
  beginClaim(id, paths = {}) {
    this.refresh();
    if (!validId(id) || this.deleted.has(id) || this.claimed.has(id) || this.pending.has(id)) return false;
    const pending = new Set(this.pending); pending.add(id);
    const info = {...this.pendingInfo,[id]:{stage:'prepared',paths:{...paths}}};
    this.persist(new Set(this.read), new Set(this.claimed), pending, info);
    return true;
  }

  updatePending(id, stage, failedContainer = null) {
    this.refresh();
    if (!this.pending.has(id)) throw new Error('Mail claim has no pending marker');
    const info = {...this.pendingInfo,[id]:{...this.pendingInfo[id],stage,failedContainer}};
    this.persist(new Set(this.read), new Set(this.claimed), new Set(this.pending), info);
  }

  finishClaim(id) {
    this.refresh();
    if (!this.pending.has(id)) throw new Error('Mail claim was not prepared');
    const read = new Set(this.read), claimed = new Set(this.claimed), pending = new Set(this.pending);
    read.add(id); claimed.add(id); pending.delete(id);
    const info = {...this.pendingInfo}; delete info[id];
    this.persist(read, claimed, pending, info);
  }
}

function inspectMailState(file) {
  if (!fs.existsSync(file)) throw new Error(`Mail state file does not exist: ${file}`);
  const state = new MailState(file);
  return {file, pending:state.pendingDiagnostics()};
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node mail-state.js <mail-state.json>'); process.exitCode = 2; }
  else {
    try { console.log(JSON.stringify(inspectMailState(file), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}

module.exports = {MailState,inspectMailState};
