'use strict';
// Server ownership is explicit: never discover/kill processes by port.
function installLifecycle({servers,extraServers=()=>[],log=()=>{},timeoutMs=3000,exit=code=>process.exit(code),signals=true,onReady=()=>{}}) {
  const sockets=new Set();let stopping=false,finished=false,timer=null,exitCode=0;
  const owned=()=>[...new Set([...servers,...extraServers()].filter(Boolean))];
  const connection=socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));if(stopping)socket.destroy();};
  for(const server of owned())server.on('connection',connection);
  function finish(){if(finished)return;finished=true;if(timer)clearTimeout(timer);if(signals){process.off('SIGINT',onInt);process.off('SIGTERM',onTerm);process.off('message',onMessage);process.off('disconnect',onDisconnect);}exit(exitCode);}
  function stop(reason='requested',code=0){
    exitCode=Math.max(exitCode,code);if(stopping)return;stopping=true;log(`Runtime shutdown: ${reason}`);
    const list=owned();let remaining=list.length;
    timer=setTimeout(()=>{for(const socket of sockets)socket.destroy();for(const server of list)server.closeAllConnections?.();finish();},timeoutMs);
    if(!remaining){finish();return;}
    for(const server of list){
      server.once('listening',()=>{if(stopping)server.close();});
      server.close(()=>{if(--remaining===0)finish();});
      server.closeIdleConnections?.();
    }
    for(const socket of sockets)socket.end();
  }
  const onInt=()=>stop('SIGINT'),onTerm=()=>stop('SIGTERM');
  const onMessage=message=>{if(message?.type==='runtime-stop')stop('supervisor');},onDisconnect=()=>stop('supervisor disconnected');
  if(signals){process.on('SIGINT',onInt);process.on('SIGTERM',onTerm);if(process.connected){process.on('message',onMessage);process.on('disconnect',onDisconnect);}}
  for(const server of owned())server.on('error',e=>stop(`listener failure: ${e.code||e.message}`,1));
  let ready=false;const checkReady=()=>{const list=owned();if(!ready&&!stopping&&list.length&&list.every(s=>s.listening)){ready=true;onReady(list.map(s=>s.address().port));}};
  for(const server of owned())server.on('listening',checkReady);checkReady();
  return {stop,get stopping(){return stopping;}};
}
module.exports={installLifecycle};
