'use strict';
const W=require('./battle-wire');

// Installed client: 27114 -> bfe360 -> b220e0. The final byte is the
// camera-follow request; zero updates motion queues and position without
// writing the local follow flag at b221cb. Never use revive attributes here.
function instantPosition(id,x,z){
  if(!Number.isInteger(id)||id<=0||id>0xffffffff||![x,z].every(Number.isFinite)||x<0||z<0||x>655.35||z>655.35)
    throw new Error('Invalid instant position');
  const payload=Buffer.alloc(9);
  payload.writeUInt32LE(Math.round(x*100));payload.writeUInt32LE(Math.round(z*100),4);
  payload[8]=0;
  return W.frame(27114,id,payload);
}
module.exports={instantPosition};
