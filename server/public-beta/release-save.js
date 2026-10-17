'use strict';
// Public local-test snapshot provider. Business receipts retain their original
// structural UID/PID; login/display identity and protocol recipes are generated.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const S=require('../player-account-state'),R=require('../roledata'),F=require('./reference-feature-frames');
const ROOT=path.join(__dirname,'release-template'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const uint=n=>Number.isSafeInteger(n)&&n>0&&n<=0xffffffff;
function relative(file){if(typeof file!=='string'||!file||file.includes('\\')||path.posix.isAbsolute(file)||file.split('/').some(x=>!x||x==='.'||x==='..'||x.includes(':')||x.includes('\0')))throw Error('Invalid release template file boundary');return file;}
function source(file){const target=path.join(ROOT,...relative(file).split('/')),s=fs.lstatSync(target);if(!s.isFile()||s.isSymbolicLink()||!fs.realpathSync(target).toLowerCase().startsWith(fs.realpathSync(ROOT).toLowerCase()+path.sep))throw Error('Invalid release template source');return target;}
function bytes(row){if(!row||!Number.isSafeInteger(row.bytes)||row.bytes<0||!/^[a-f0-9]{64}$/.test(row.sha256))throw Error('Invalid release template checksum');const b=fs.readFileSync(source(row.file));if(b.length!==row.bytes||sha(b)!==row.sha256)throw Error('Release template source changed');return b;}
let cached;
function manifest(){
 if(cached)return structuredClone(cached);const m=JSON.parse(fs.readFileSync(source('manifest.json'))),i=m?.identity;
 if(m.version!==1||m.kind!=='public-release-save'||m.privateOnly!==false||!i||!uint(i.uid)||!uint(i.playerId)||i.name!=='admin'||i.loginHash!==S.loginKey('admin')||i.worldId!==20034)throw Error('Invalid public release snapshot identity');
 for(const key of ['accountFiles','captureFiles']){if(!Array.isArray(m[key])||!m[key].length)throw Error('Release snapshot is incomplete');const seen=new Set();for(const row of m[key]){relative(row.file);relative(row.target);if(seen.has(row.target.toLowerCase()))throw Error('Release template destination collision');seen.add(row.target.toLowerCase());}}
 if(!m.accountFiles.some(r=>r.target==='player-accounts.json')||m.captureFiles.map(r=>r.target).sort().join('|')!==['c2s-release.frames.bin','events.jsonl','s2c-release.frames.bin'].sort().join('|'))throw Error('Unreviewed public release replay layout');
 const ledger=S.validate(JSON.parse(bytes(m.accountFiles.find(r=>r.target==='player-accounts.json'))));assertOwner(ledger.accounts[i.uid],i);if(Object.keys(ledger.accounts).length!==1||ledger.accounts[i.uid].name!=='admin')throw Error('Public release snapshot must contain one anonymous account');
 bytes(m.role);bytes(m.charlist);F.create({featureFramesHex:m.featureFramesHex,playerId:i.playerId});
 // Keep the checked manifest independent of callers that consume options.
 cached=JSON.parse(JSON.stringify(m));return structuredClone(cached);
}
function assertOwner(a,i=manifest().identity){if(!a||a.uid!==i.uid||a.playerId!==i.playerId||a.loginHash!==S.loginKey('admin')||a.publicBetaIdentity!==undefined)throw Error('Public release local owner mismatch');return a;}
function findAccount(store,login){if(typeof login!=='string'||S.loginKey(login)!==S.loginKey('admin'))return null;return assertOwner(store.get(manifest().identity.uid));}
function requireWorld(worldId){if(worldId!==20034)throw Error('请从“十二试炼 / SESL”区进入本地测试。');}
function role(){const m=manifest(),b=bytes(m.role),i=m.identity;if(b.length!==288458||b.readUInt32LE(0)!==288540||b.readUInt16LE(8)!==1013||b[12]!==1||b.readUInt32LE(22)!==i.playerId||b.readUInt32LE(26)!==i.uid||b.subarray(34,49).toString('hex')!==Buffer.concat([Buffer.from('admin\0'),Buffer.alloc(9)]).toString('hex'))throw Error('Public release native role changed');return b;}
function charlist(world=20034){requireWorld(world);const m=manifest(),f=bytes(m.charlist),i=m.identity;if(f.length!==256||f.readUInt32LE(0)!==256||f.readUInt16LE(8)!==1287||f[14]!==1||f.readUInt32LE(17)!==i.uid||f.readUInt32LE(149)!==i.playerId||f.readUInt16LE(198)!==20034||f.subarray(21,149).toString('hex')!==Buffer.concat([Buffer.from('admin\0'),Buffer.alloc(122)]).toString('hex'))throw Error('Public release character list changed');return f;}
function bindCharlistWorld(frame,world){requireWorld(world);const expected=charlist(world);if(!Buffer.isBuffer(frame)||!frame.equals(expected))throw Error('Public release character list identity mismatch');return frame;}
function copyRows(rows,directory){const root=path.resolve(directory);fs.mkdirSync(root,{recursive:true});if(fs.lstatSync(root).isSymbolicLink())throw Error('Release destination cannot be a link');const real=fs.realpathSync(root).toLowerCase();const prepared=rows.map(row=>({row,value:bytes(row)}));for(const {row,value}of prepared){const target=path.join(root,...relative(row.target).split('/'));fs.mkdirSync(path.dirname(target),{recursive:true});const parent=fs.realpathSync(path.dirname(target)).toLowerCase();if(parent!==real&&!parent.startsWith(real+path.sep))throw Error('Release destination escapes folder');fs.writeFileSync(target,value,{flag:'wx'});}}
function initialize(directory){const file=path.join(directory,'player-accounts.json'),m=manifest();if(fs.existsSync(file)){if(fs.lstatSync(file).isSymbolicLink())throw Error('Local release save cannot be a link');const value=S.validate(JSON.parse(fs.readFileSync(file)));if(Object.keys(value.accounts).length!==1)throw Error('Local release save must retain one owner');return assertOwner(value.accounts[m.identity.uid]);}if(fs.existsSync(directory)&&fs.readdirSync(directory).length)throw Error('Refusing to overwrite an existing release save');copyRows(m.accountFiles,directory);return initialize(directory);}
function createCapture(directory){if(fs.existsSync(directory)&&fs.readdirSync(directory).length)throw Error('Refusing to overwrite a release protocol recipe');copyRows(manifest().captureFiles,directory);}
function runtimeOptions(){const value=manifest().runtimeOptions;if(!value||typeof value!=='object'||Array.isArray(value)||Object.entries(value).some(([key,v])=>!/^[a-z][a-z0-9-]*$/.test(key)||typeof v!=='string'||/[\r\n\0]/.test(v)))throw Error('Invalid release runtime options');return value;}
function featureFrames(){return F.create({featureFramesHex:manifest().featureFramesHex,playerId:manifest().identity.playerId});}
const API={isPublicSnapshot:true,hasRuntimeOptions:true,manifest,initialize,createCapture,role,charlist,bindCharlistWorld,requireWorld,findAccount,featureFrames};
Object.defineProperties(API,{UID:{enumerable:true,get:()=>manifest().identity.uid},PLAYER_ID:{enumerable:true,get:()=>manifest().identity.playerId},runtimeOptions:{enumerable:true,get:runtimeOptions}});
module.exports=API;
