'use strict';
const net=require('net');
function encoder(seed=0xcd) {
  let previous=seed;
  return frames=>{const p=Buffer.concat(frames),w=Buffer.alloc(p.length);for(let i=0;i<p.length;i++){w[i]=p[i]^previous;previous=p[i];}return w;};
}
function decoder({maxFrame=1024*1024}={}) {
  let previous=0xcd,pending=Buffer.alloc(0);
  return chunk=>{
    const p=Buffer.alloc(chunk.length);
    for(let i=0;i<chunk.length;i++){p[i]=chunk[i]^previous;previous=p[i];}
    pending=Buffer.concat([pending,p]);const frames=[];let offset=0;
    while(pending.length-offset>=12) {
      const n=pending.readUInt32LE(offset);
      if(n<12||n>maxFrame)throw new Error('Invalid network frame length');
      if(offset+n>pending.length)break;
      frames.push(Buffer.from(pending.subarray(offset,offset+n)));offset+=n;
    }
    pending=Buffer.from(pending.subarray(offset));
    if(pending.length>maxFrame)throw new Error('Network input limit');
    return frames;
  };
}
async function serve(factory,{port=0,host='127.0.0.1',tickMs=50,onResult=()=>{}}={}) {
  const clients=new Set();let stopping=false,closePromise;
  const closeSession=client=>{if(client.closed)return;client.closed=true;
    try{client.session?.close();}catch(error){try{onResult({type:'session-close-error',message:error.message});}catch{}}
  };
  const server=net.createServer(socket=>{
    if(stopping){socket.destroy();return;}
    const encode=encoder(),decode=decoder();
    const client={socket,session:null};clients.add(client);
    const send=frames=>{
      if(!frames.length||socket.destroyed)return;
      if(socket.writableLength>4*1024*1024){socket.destroy(new Error('Slow battle client'));return;}
      socket.write(encode(frames));
    };
    try{client.session=factory(send);}catch(error){socket.destroy();clients.delete(client);return;}
    socket.setNoDelay(true);socket.on('error',error=>{gemRemovals.close();onResult({type:'socket-error',message:error.message});});
    const gemRemovals=new(require('./gem-removal-batch').GemRemovalBatch)({deliver:frames=>{
      try {for(const frame of frames) {
        const result=client.session.receive(frame),tag=frame.readUInt16LE(8);
        // Preserve small gameplay requests for native-client regressions. This
        // excludes login/identity packets and bounds the recorded payload.
        const input=[23442,11003,11018,11043,20102].includes(tag)
          ?{actor:frame.readUInt32LE(4),payloadHex:frame.subarray(12,140).toString('hex'),payloadLength:frame.length-12}:undefined;
        onResult({type:'request',tag,phase:client.session.phase,...input,result});
        if(result.close){socket.end();break;}
      }}catch(error){onResult({type:'invalid-input',message:error.message});socket.destroy();}
    }});
    socket.on('data',chunk=>{
      try{gemRemovals.push(decode(chunk));}catch(error){onResult({type:'invalid-input',message:error.message});socket.destroy();}
    });
    socket.on('end',()=>gemRemovals.close());
    socket.on('close',()=>{gemRemovals.close();closeSession(client);clients.delete(client);});
  });
  let previous=performance.now();
  const timer=setInterval(()=>{
    const now=performance.now(),dt=Math.min(0.25,(now-previous)/1000);previous=now;
    for(const client of clients) {
      try {client.session.tick(dt);const notes=client.session.drainNotes();if(notes.length)onResult({type:'world',notes});}
      catch(error){onResult({type:'world-error',message:error.message,stack:error.stack});client.socket.destroy();}
    }
  },tickMs);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);}).catch(e=>{clearInterval(timer);throw e;});
  return {server,clients,port:server.address().port,close:()=>{
    if(closePromise)return closePromise;stopping=true;clearInterval(timer);
    closePromise=new Promise(resolve=>server.close(resolve));
    for(const c of clients){closeSession(c);c.socket.destroy();}
    return closePromise;
  }};
}
module.exports={encoder,decoder,serve};
