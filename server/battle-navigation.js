'use strict';
const dist=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
function segmentClear(a,b,circles){
 const dx=b.x-a.x,dz=b.z-a.z,n=dx*dx+dz*dz;
 const minX=Math.min(a.x,b.x),maxX=Math.max(a.x,b.x),minZ=Math.min(a.z,b.z),maxZ=Math.max(a.z,b.z);
 for(const c of circles){
  // This rejection is conservative: a circle disjoint from the segment's
  // bounding box cannot block it. Keep the exact directed escape test below.
  if(c.x+c.r<minX||c.x-c.r>maxX||c.z+c.r<minZ||c.z-c.r>maxZ)continue;
  const t=n?Math.max(0,Math.min(1,((c.x-a.x)*dx+(c.z-a.z)*dz)/n)):0;
  const px=a.x+t*dx-c.x,pz=a.z+t*dz-c.z,d2=px*px+pz*pz,limit=Math.max(0,c.r-1e-6);
  const ax=a.x-c.x,az=a.z-c.z,from2=ax*ax+az*az;
  if(from2<limit*limit){const bx=b.x-c.x,bz=b.z-c.z;if(!(ax*dx+az*dz>=0&&bx*bx+bz*bz>from2))return false;}
  else if(!(d2>=limit*limit))return false;
 }
 return true;
}
function outside(p,circles){
 for(const c of circles){
  if(Math.abs(p.x-c.x)>c.r||Math.abs(p.z-c.z)>c.r)continue;
  if(!(dist(p,c)>=c.r))return false;
 }
 return true;
}
function route(start,end,circles){
 let goal={x:end.x,z:end.z};
 // Clicks inside buildings end at their outside edge.
 for(let pass=0;pass<8;pass++){
  let changed=false;
  for(const c of circles)if(dist(goal,c)<c.r+.01){
   let dx=goal.x-c.x,dz=goal.z-c.z,d=Math.hypot(dx,dz);
   if(d<1e-9){dx=start.x-c.x;dz=start.z-c.z;d=Math.hypot(dx,dz);}
   if(d<1e-9){dx=1;dz=0;d=1;}
   goal={x:c.x+dx/d*(c.r+.02),z:c.z+dz/d*(c.r+.02)};changed=true;
  }
  if(!changed)break;
 }
 if(segmentClear(start,goal,circles))return [goal];
 // Every intermediate visibility vertex is outside every circle. If the
 // projected goal is still strictly inside one, no final edge can reach it.
 // Keep the direct escape check above, and a conservative numerical margin.
 if(circles.some(c=>{
  const dx=goal.x-c.x,dz=goal.z-c.z,limit=Math.max(0,c.r-1e-5);
  return dx*dx+dz*dz<limit*limit;
 }))return null;
 // Only a few obstacles normally block this segment. Their connected body
 // cluster supplies the first visibility graph, but every edge still checks
 // every obstacle. If that graph cannot connect the endpoints, use the full
 // graph, retaining routes that need a distant obstacle's detour vertices.
 const active=new Set(circles.filter(c=>!segmentClear(start,goal,[c]))),sides=16;
 let expanded=true;
 while(expanded){expanded=false;for(const c of circles)if(!active.has(c)){
  for(const o of active)if(dist(c,o)<=c.r/Math.cos(Math.PI/sides)+o.r/Math.cos(Math.PI/sides)+.05){active.add(c);expanded=true;break;}
 }}
 const fast=graph(start,goal,circles,[...active],sides);
 if(fast||active.size===circles.length)return fast;
 return graph(start,goal,circles,circles,sides);
}
function graph(start,goal,circles,vertices,sides){
 const nodes=[start,goal];
 for(const c of vertices)for(let i=0;i<sides;i++){
  const angle=i*Math.PI*2/sides,r=c.r/Math.cos(Math.PI/sides)+.025;
  const p={x:c.x+Math.cos(angle)*r,z:c.z+Math.sin(angle)*r};
  if(p.x>=0&&p.z>=0&&p.x<=655.35&&p.z<=655.35&&outside(p,circles))nodes.push(p);
 }
 const costs=nodes.map(()=>Infinity),prev=nodes.map(()=>-1),heuristic=nodes.map(p=>dist(p,goal)),done=new Set();costs[0]=0;
 while(done.size<nodes.length){
  // Euclidean distance is a consistent lower bound for this visibility graph.
  // A* visits fewer vertices than Dijkstra while retaining its shortest route.
  let u=-1;for(let i=0;i<nodes.length;i++)if(!done.has(i)&&(u<0||costs[i]+heuristic[i]<costs[u]+heuristic[u]))u=i;
  if(u<0||!Number.isFinite(costs[u]))return null;
  if(u===1){const out=[];for(let v=1;v!==0;v=prev[v])out.unshift(nodes[v]);return out;}
  done.add(u);
  // A visibility edge usually meets a nearby body before distant buildings.
  // Order checks once per expanded vertex; every circle still participates.
  const ordered=[...circles].sort((a,b)=>{
   const ax=a.x-nodes[u].x,az=a.z-nodes[u].z,bx=b.x-nodes[u].x,bz=b.z-nodes[u].z;
   return ax*ax+az*az-bx*bx-bz*bz;
  });
  for(let v=1;v<nodes.length;v++)if(!done.has(v)){
   const cost=costs[u]+dist(nodes[u],nodes[v]);
   if(cost<costs[v]&&segmentClear(nodes[u],nodes[v],ordered)){costs[v]=cost;prev[v]=u;}
  }
 }
 return null;
}
module.exports={route,segmentClear};
