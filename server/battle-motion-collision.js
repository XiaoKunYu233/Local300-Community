'use strict';
const navigation=require('./battle-navigation');
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const buildingKinds=new Set(['tower','base','barracks','fountain']);
const collidable=e=>e.bodyRadius>0&&(e.alive||buildingKinds.has(e.kind));
const stationary=e=>!!e.staticBlock;
function blockers(sim,entity,{staticOnly=false,allMobile=false}={}){
 return [...sim.entities.values()].filter(other=>other!==entity&&other.id!==entity.id&&collidable(other)&&
  (stationary(other)||!staticOnly&&['hero','minion'].includes(other.kind)&&(allMobile||distance(entity,other)<6)))
  .map(other=>({id:other.id,kind:other.kind,static:!!stationary(other),x:other.x,z:other.z,r:other.bodyRadius+(entity.bodyRadius||0)+.02}));
}
function projectedRoute(sim,entity,goal,circles,{mobile=false}={}){
 const radius=entity.bodyRadius||0,points=navigation.route(entity,goal,circles);
 if(!sim.terrain)return points;
 if(points&&[entity,...points].every((p,i,a)=>!i||sim.terrain.segment(a[i-1],p,radius)))return points;
 // A moving crowd must not trigger a full-map search every 100 ms.
 // Static routes keep the full search; transient avoidance retries locally.
 return sim.terrain.route(entity,goal,radius,circles,mobile?{maxVisited:512}:{});
}
// A building/wall can permanently project a click to its reachable boundary.
// A mobile unit cannot change the player's order: its boundary is temporary.
// Keep this distinction on the compatible waypoint array, outside wire rows.
function planRoute(sim,entity,goal){
 const statics=blockers(sim,entity,{staticOnly:true}),fixed=projectedRoute(sim,entity,goal,statics);
 if(!fixed?.length)return null;
 const arrival={...fixed.at(-1)},circles=blockers(sim,entity);
 let points=fixed;
 if(![entity,...fixed].every((p,i,a)=>!i||navigation.segmentClear(a[i-1],p,circles)))points=projectedRoute(sim,entity,arrival,circles,{mobile:true});
 // An entirely surrounded actor retains the order and retries after mobile
 // blockers move, rather than rejecting the order or completing it in place.
 if(!points?.length)points=[{x:entity.x,z:entity.z}];
 const waitingForMobile=distance(points.at(-1),arrival)>1e-6;
 Object.defineProperties(points,{arrival:{value:arrival},waitingForMobile:{value:waitingForMobile}});
 return points;
}
function arrived(entity){
 return !!entity.motionGoal&&entity.navigation?.length===0&&!entity.motionWaitingForMobile&&
  distance(entity,entity.motionArrival||entity.motionGoal)<.001;
}
module.exports={blockers,collidable,stationary,planRoute,arrived};
