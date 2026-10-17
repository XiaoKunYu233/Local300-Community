'use strict';
// One public lobby entry, with a fixed account worker for the lifetime of each
// connection. Workers must be loopback-only and own disjoint state scopes.
const net=require('node:net');
const {decoder,encoder}=require('./battle-transport');
const {loginKey}=require('./player-account-state');
function loginIdentity(frame){
  if(!Buffer.isBuffer(frame)||frame.length<21||frame.readUInt32LE()!==frame.length||frame.readUInt16LE(8)!==20002||frame[18]!==10)
    throw Error('Invalid account login frame');
  const count=frame[19],bytes=frame.subarray(20,20+count);
  if(!count||count>64||bytes.length!==count||bytes.some(b=>b<33||b>126))throw Error('Invalid account login name');
  return loginKey(bytes.toString('ascii'));
}
function validateRoutes(routes){
  if(!Array.isArray(routes)||!routes.length)throw Error('Explicit account routes required');
  const logins=new Map(),uids=new Set(),players=new Set(),endpoints=new Set();
  for(const route of routes){
    const {loginHash,uid,playerId,port}=route;
    if(!/^[a-f0-9]{64}$/.test(loginHash)||![uid,playerId].every(n=>Number.isSafeInteger(n)&&n>0&&n<=0xffffffff)||
      !Number.isInteger(port)||port<1||port>65535)throw Error('Invalid account route');
    if(logins.has(loginHash)||uids.has(uid)||players.has(playerId)||endpoints.has(port))throw Error('Account routes must have unique identities and workers');
    logins.set(loginHash,Object.freeze({loginHash,uid,playerId,port}));uids.add(uid);players.add(playerId);endpoints.add(port);
  }
  return logins;
}
async function start({routes,port=0,host='127.0.0.1',loginTimeoutMs=10000,connectTimeoutMs=5000,maxConnections=256,greeting,clientVersion=8824,verifyLogin}={}){
  const byLogin=validateRoutes(routes),clients=new Set();let closing=false,closePromise;
  const greetings=require('./player-account-greeting');
  if(greeting!==undefined&&!require('./public-beta/client-version').isGreeting(greeting,clientVersion))throw Error('Unknown public account greeting');
  const publicGreeting=greeting===undefined?null:Buffer.from(greeting);
  const server=net.createServer(socket=>{
    if(closing||clients.size>=maxConnections){socket.destroy();return;}
    clients.add(socket);socket.setNoDelay(true);
    const decode=decoder({maxFrame:256*1024}),encode=encoder(),downstreamEncode=encoder();
    let route=null,worker=null,queued=[],queuedBytes=0,connected=false,timer;
    const stop=()=>{clearTimeout(timer);socket.destroy();worker?.destroy();};
    timer=setTimeout(stop,loginTimeoutMs);
    socket.on('error',stop);socket.once('close',()=>{clients.delete(socket);clearTimeout(timer);worker?.destroy();});
    socket.on('end',()=>worker?.end());
    function forward(frame){
      const bytes=encode([frame]);
      if(!connected){queuedBytes+=bytes.length;if(queuedBytes>512*1024)throw Error('Account connection queue limit');queued.push(bytes);return;}
      if(!worker.write(bytes))socket.pause();
      if(worker.writableLength>1024*1024)throw Error('Account worker backpressure limit');
    }
    socket.on('data',chunk=>{
      try{
        for(const frame of decode(chunk)){
          const id=frame.readUInt16LE(8);
          if(!route){
            route=byLogin.get(loginIdentity(frame));if(!route||verifyLogin&&!verifyLogin(frame))throw Error('Unknown account or password');
            clearTimeout(timer);timer=setTimeout(stop,connectTimeoutMs);
            worker=net.connect({host:'127.0.0.1',port:route.port});worker.setNoDelay(true);
            worker.on('error',stop);worker.on('close',stop);
            worker.on('drain',()=>socket.resume());
            const workerDecode=publicGreeting?decoder():null;let needsGreeting=!!publicGreeting;
            worker.on('data',bytes=>{
              try{
                if(!workerDecode){if(!socket.write(bytes))worker.pause();return;}
                const frames=workerDecode(bytes);
                if(needsGreeting&&frames.length){
                  const workerGreeting=frames.shift();
                  if(!workerGreeting.equals(publicGreeting))throw Error('Account worker public greeting mismatch');
                  needsGreeting=false;clearTimeout(timer);
                }
                // The front greeting advanced this direction's XOR chain.
                // Decode the worker's independent chain, omit only its first
                // validated duplicate, and continue the front encoder.
                if(frames.length&&!socket.write(downstreamEncode(frames)))worker.pause();
              }catch{stop();}
            });
            socket.on('drain',()=>worker.resume());
            worker.on('connect',()=>{
              if(socket.destroyed){stop();return;}
              if(!needsGreeting)clearTimeout(timer);connected=true;
              for(const bytes of queued)if(!worker.write(bytes))socket.pause();
              queued=[];queuedBytes=0;
            });
          }else if(id===20002&&loginIdentity(frame)!==route.loginHash)throw Error('Account switching requires a new connection');
          if(id===1012&&(frame.length<21||frame.readUInt32LE(13)!==route.playerId||frame.readUInt32LE(17)!==route.uid))throw Error('Account role mismatch');
          forward(frame);
        }
      }catch{stop();} // Never log credential-bearing login bytes.
    });
    if(publicGreeting)socket.write(downstreamEncode([publicGreeting]));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  return {server,port:server.address().port,close(){
    if(closePromise)return closePromise;closing=true;
    closePromise=new Promise(resolve=>server.close(resolve));for(const client of clients)client.destroy();return closePromise;
  }};
}
module.exports={start,loginIdentity,validateRoutes};
