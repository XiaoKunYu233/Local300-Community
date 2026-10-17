'use strict';

const http = require('http');
const fs = require('./persistence/state-files').io;
const path = require('path');
const crypto = require('crypto');
const GBK = require('./gbk');
const catalog = require('./current-item-catalog');
const {containerOf} = require('./item-containers');

function renameWithRetry(from,to,attempts=24) {
  let last;
  for(let i=0;i<attempts;i++) {
    try { fs.renameSync(from,to); return; }
    catch(error) {
      last=error;
      if(!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;
      const wait=Atomics.wait?new Int32Array(new SharedArrayBuffer(4)):null;
      if(wait)Atomics.wait(wait,0,0,50*(i+1));
    }
  }
  throw last;
}

const CURRENCIES = Object.freeze({
  50: {name:'金币', scale:1},
  72: {name:'钻石', scale:100},
  157: {name:'绑定钻石', scale:100},
  141: {name:'莫比乌斯币', scale:1},
  156: {name:'挑战币', scale:1},
});

function startGmTool({port, tokenFile, mailFile, wallet, itemNames, mailExists,
  reloadMail, isFrozen, onCurrency, onMail, log, auditFile}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('invalid GM port');
  if (!wallet?.ok || !mailFile) throw Error('GM tool requires wallet and --mail-extra');
  let token;
  try { token = fs.readFileSync(tokenFile, 'utf8').trim(); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    token = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(tokenFile), {recursive:true});
    try { fs.writeFileSync(tokenFile, token + '\n', {flag:'wx', mode:0o600}); }
    catch (race) { if (race.code !== 'EEXIST') throw race; token = fs.readFileSync(tokenFile, 'utf8').trim(); }
  }
  if (!/^[a-f0-9]{64}$/i.test(token)) throw Error('invalid GM token file');
  const page = fs.readFileSync(path.join(__dirname, 'gm-tool.html'));
  const client = fs.readFileSync(path.join(__dirname, 'gm-tool-client.js'));
  const catalogRows = Object.values(itemNames || {});
  const catalogStatus = {currentCount:catalogRows.filter(item=>item.catalogSource==='current-client').length,
    legacyOnlyCount:catalogRows.filter(item=>item.catalogSource==='legacy').length};
  const audit = (kind, detail) => {
    try { fs.appendFileSync(auditFile, JSON.stringify({time:new Date().toISOString(),kind,...detail}) + '\n'); }
    catch (e) { log(`GM audit write failed: ${e.message}`); }
  };
  const reply = (res, code, body) => {
    res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
      'X-Content-Type-Options':'nosniff'});
    res.end(JSON.stringify(body));
  };
  const fail = (res, code, message) => reply(res, code, {ok:false,error:message});
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
        'X-Content-Type-Options':'nosniff'});
      res.end(page); return;
    }
    if (req.method === 'GET' && req.url === '/gm-tool.js') {
      res.writeHead(200, {'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'no-store',
        'X-Content-Type-Options':'nosniff'});
      res.end(client); return;
    }
    const supplied = req.headers.authorization?.replace(/^Bearer /, '') || '';
    const a = Buffer.from(supplied), b = Buffer.from(token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a,b)) return fail(res,401,'需要 GM 密钥');
    if (req.method === 'GET' && req.url === '/api/status') {
      const balances = Object.entries(CURRENCIES).map(([attr,c]) => ({attr:+attr,name:c.name,
        scale:c.scale,raw:wallet.attrs[attr] ?? null}));
      return reply(res,200,{ok:true,scope:'当前大厅共享测试存档',frozen:isFrozen(),balances,catalog:catalogStatus});
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/items?')) {
      const params = new URL(req.url, 'http://127.0.0.1').searchParams;
      const query = params.get('q') || '';
      if (query.length > 100) return fail(res,400,'道具搜索内容过长');
      return reply(res,200,{ok:true,...catalog.search(itemNames,query)});
    }
    if (req.method !== 'POST' || !['/api/currency','/api/mail'].includes(req.url)) return fail(res,404,'未知操作');
    const expectedOrigin = `http://127.0.0.1:${server.address().port}`;
    if (req.headers.origin !== expectedOrigin || req.headers['content-type']?.split(';')[0] !== 'application/json')
      return fail(res,403,'只接受本机 GM 页面操作');
    let data = '';
    try {
      for await (const chunk of req) {
        data += chunk;
        if (data.length > 16384) return fail(res,413,'内容过长');
      }
      const body = JSON.parse(data);
      if (isFrozen()) return fail(res,409,'邮件领取待核对，当前禁止修改经济数据');
      if (req.url === '/api/currency') {
        const attr = body.attr;
        const spec = CURRENCIES[attr];
        if (!Number.isInteger(attr) || !spec) return fail(res,400,'货币类型无效');
        const entered = String(body.amount ?? '');
        const pattern = spec.scale === 100 ? /^(?:[1-9]\d{0,7})(?:\.\d{1,2})?$/ : /^[1-9]\d{0,9}$/;
        if (!pattern.test(entered)) return fail(res,400,'请输入正数；钻石最多两位小数');
        const amount = spec.scale === 100 ? Math.round(Number(entered)*100) : Number(entered);
        const before = wallet.attrs[attr];
        if (!Number.isInteger(before) || before < 0 || !Number.isSafeInteger(amount) || amount < 1 ||
            before + amount > 0xffffffff) return fail(res,400,'余额基线缺失或充值后超出上限');
        const prior = {state:{...wallet.state},attrs:{...wallet.attrs},gold:wallet.gold};
        wallet.attrs[attr] = before + amount;
        if (attr === 50) wallet.gold = wallet.attrs[attr];
        try { wallet.save(true); }
        catch (e) {
          wallet.attrs = prior.attrs; wallet.gold = prior.gold;
          wallet.state = {...prior.state,attrs:prior.attrs};
          throw e;
        }
        try { onCurrency(attr,wallet.attrs[attr]); }
        catch (e) { log(`GM online balance push failed: ${e.message}`); }
        audit('currency',{attr,amount,before,after:wallet.attrs[attr]});
        log(`GM 充值 ${spec.name} +${amount}，余额 ${wallet.attrs[attr]}`);
        return reply(res,200,{ok:true,name:spec.name,added:amount/spec.scale,balance:wallet.attrs[attr]/spec.scale});
      }
      if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 60 ||
          typeof body.message !== 'string' || body.message.length > 500 ||
          GBK.decode(GBK.encode(body.title)) !== body.title || GBK.decode(GBK.encode(body.message)) !== body.message)
        return fail(res,400,'标题或正文过长，或含有客户端不支持的字符');
      if (!Array.isArray(body.attachments) || body.attachments.length > 8) return fail(res,400,'最多添加 8 项附件');
      const attachments = [];
      for (const a of body.attachments) {
        const itemId = Number(a?.itemId), count = Number(a?.count);
        if (!Number.isInteger(itemId) || itemId < 1 || itemId >= 0xffff || !itemNames?.[itemId])
          return fail(res,400,`附件道具 ID ${String(a?.itemId ?? '')} 不在当前道具表中`);
        if (!Number.isInteger(count) || count < 1 || count > 1000)
          return fail(res,400,`附件 ${itemId} 数量无效，请输入 1–1000 的整数`);
        // Native 17015 carries one u8 quantity. Split slotted rewards before
        // writing mail so quantities accepted by the form remain claimable.
        const perEntry = containerOf(itemId)==='slot' ? 255 : 1000;
        for (let remaining = count; remaining > 0; remaining -= perEntry)
          attachments.push({itemId,count:Math.min(remaining,perEntry)});
        if (attachments.length > 8) return fail(res,400,'道具数量拆分后超过 8 项附件，请分成多封邮件发送');
      }
      const raw = JSON.parse(fs.readFileSync(mailFile,'utf8'));
      const list = Array.isArray(raw) ? raw : raw.mails;
      if (!Array.isArray(list)) return fail(res,500,'邮件配置格式错误');
      let id;
      do { id = crypto.randomInt(0x14000000,0x70000000); }
      while (mailExists(id) || list.some(m => m.id === id));
      const nextMail = {id,title:body.title.trim(),body:body.message,attachments,
        createdAt:new Date().toISOString()};
      const next = Array.isArray(raw) ? [...list,nextMail] : {...raw,mails:[...list,nextMail]};
      const temp = `${mailFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      try { fs.writeFileSync(temp,JSON.stringify(next,null,2)); renameWithRetry(temp,mailFile); }
      finally { try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {} }
      reloadMail('GM 发送',true);
      if (!mailExists(id)) return reply(res,500,{ok:false,
        error:'邮件已保存但未加载，请检查大厅日志；请勿重复发送',id});
      audit('mail',{id,title:nextMail.title,attachments});
      try { onMail?.(id); } catch (e) { log(`GM mail notification failed: ${e.message}`); }
      log(`GM 邮件 ${id} ${nextMail.title}，附件 ${attachments.map(a=>`${a.itemId}×${a.count}`).join(',') || '无'}`);
      return reply(res,200,{ok:true,id});
    } catch (e) {
      log(`GM operation failed: ${e.message}`);
      return fail(res,500,'操作失败，未确认写入；请检查状态后重试');
    }
  });
  server.listen(port,'127.0.0.1',()=>log(`GM 页面已监听 http://127.0.0.1:${server.address().port}/（仅本机）`));
  return server;
}

module.exports = {startGmTool,CURRENCIES};
