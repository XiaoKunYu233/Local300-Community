'use strict';
const fs=require('fs'),path=require('path'),{segmentClear}=require('./battle-navigation');
// Map 252's native 512x512 BGRA mask, 0.64 world units/cell. TGA origin is
// bottom-left. All 3,072 captured route points are outside red cells with this
// orientation; the opposite orientation places 329 route points in blockers.
class Terrain {
  constructor(file=path.join(__dirname,'../map/data/world/lm4jjcmap_mask.tga')){
    const b=fs.readFileSync(file);
    if(b[2]!==2||b.readUInt16LE(12)!==512||b.readUInt16LE(14)!==512||b[16]!==32||b[17]!==8||b.length<18+512*512*4)throw Error('Unsupported terrain mask');
    this.size=512;this.cell=.64;this.blocked=new Uint8Array(512*512);this.cache=new Map();
    for(let z=0;z<512;z++)for(let x=0;x<512;x++)this.blocked[z*512+x]=b[18+((511-z)*512+x)*4+2]?1:0;
  }
  clear(p,r=0){
    const c=this.cell,n=this.size;
    if(p.x-r<0||p.z-r<0||p.x+r>=n*c||p.z+r>=n*c)return false;
    for(let z=Math.floor((p.z-r)/c);z<=Math.floor((p.z+r)/c);z++)for(let x=Math.floor((p.x-r)/c);x<=Math.floor((p.x+r)/c);x++){
      if(!this.blocked[z*n+x])continue;
      const dx=Math.max(x*c-p.x,0,p.x-(x+1)*c),dz=Math.max(z*c-p.z,0,p.z-(z+1)*c);
      if(dx*dx+dz*dz<=r*r+1e-10)return false;
    }
    return true;
  }
  segment(a,b,r=0){
    const steps=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.z-a.z)/.16));
    for(let i=0;i<=steps;i++)if(!this.clear({x:a.x+(b.x-a.x)*i/steps,z:a.z+(b.z-a.z)*i/steps},r))return false;
    return true;
  }
  route(start,end,r,circles,{maxVisited=Infinity}={}){
    const clear=p=>this.clear(p,r)&&circles.every(o=>Math.hypot(p.x-o.x,p.z-o.z)>=o.r);
    const line=(a,b)=>this.segment(a,b,r)&&segmentClear(a,b,circles);
    if(!this.clear(start,r))return null;
    let goal={...end};
    if(!clear(goal)){
      let best=null,cost=Infinity;
      for(let ring=1;ring<=24&&!best;ring++)for(let x=-ring;x<=ring;x++)for(const z of [-ring,ring]){
        const p={x:(Math.floor(end.x/.64)+x+.5)*.64,z:(Math.floor(end.z/.64)+z+.5)*.64};
        const d=Math.hypot(p.x-end.x,p.z-end.z);
        if(d<cost&&clear(p)){best=p;cost=d;}
      }
      // Include vertical ring edges (the loop above scans horizontal edges).
      for(let x=-24;x<=24;x++)for(let z=-24;z<=24;z++){
        const p={x:(Math.floor(end.x/.64)+x+.5)*.64,z:(Math.floor(end.z/.64)+z+.5)*.64},d=Math.hypot(p.x-end.x,p.z-end.z);
        if(d<cost&&clear(p)){best=p;cost=d;}
      }
      if(!best)return null;goal=best;
    }
    if(line(start,goal))return [goal];
    const n=512,id=p=>Math.floor(p.z/.64)*n+Math.floor(p.x/.64),point=i=>({x:(i%n+.5)*.64,z:(Math.floor(i/n)+.5)*.64});
    const source=id(start),target=id(goal),cost=new Map([[source,0]]),parent=new Map(),done=new Set(),heap=[];
    const h=i=>Math.hypot(point(i).x-goal.x,point(i).z-goal.z);
    const push=(i,f)=>{let k=heap.length;heap.push({i,f});while(k){const p=(k-1)>>1;if(heap[p].f<=f)break;[heap[k],heap[p]]=[heap[p],heap[k]];k=p;}};
    const pop=()=>{const first=heap[0],last=heap.pop();if(heap.length){heap[0]=last;let k=0;for(;;){let v=k,l=k*2+1;if(l<heap.length&&heap[l].f<heap[v].f)v=l;if(l+1<heap.length&&heap[l+1].f<heap[v].f)v=l+1;if(v===k)break;[heap[v],heap[k]]=[heap[k],heap[v]];k=v;}}return first.i;};
    // The requested point can be clear while its grid-cell center is blocked.
    // In that case finish from a neighboring cell through the same exact
    // terrain/body checks, rather than searching for an impossible center.
    const blockedTargetCenter=!clear(point(target));
    push(source,h(source));
    while(heap.length){
      const u=pop();if(done.has(u))continue;if(done.size>=maxVisited)return null;done.add(u);
      const from=u===source?start:point(u);
      const adjacentGoal=blockedTargetCenter&&Math.abs(u%n-target%n)<=1&&Math.abs(Math.floor(u/n)-Math.floor(target/n))<=1;
      if((u===target||adjacentGoal)&&line(from,goal)){
        const raw=[goal];for(let v=u;v!==source;v=parent.get(v))raw.unshift(point(v));
        const out=[];let at=start;
        for(let i=0;i<raw.length;){let j=i;while(j+1<raw.length&&line(at,raw[j+1]))j++;out.push(raw[j]);at=raw[j];i=j+1;}
        return out;
      }
      for(let dz=-1;dz<=1;dz++)for(let dx=-1;dx<=1;dx++){
        if(!dx&&!dz)continue;const x=u%n+dx,z=Math.floor(u/n)+dz;
        if(x<0||z<0||x>=n||z>=n)continue;const v=z*n+x,to=point(v);
        if(done.has(v)||!clear(to)||!line(from,to))continue;
        const next=cost.get(u)+Math.hypot(from.x-to.x,from.z-to.z);
        if(next<(cost.get(v)??Infinity)){cost.set(v,next);parent.set(v,u);push(v,next+h(v));}
      }
    }
    return null;
  }
}
module.exports={Terrain};
