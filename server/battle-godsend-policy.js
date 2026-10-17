'use strict';
// Registration proves a descriptor exists, not that its combat mechanic exists.
const ids=Object.freeze([1,2,3,4,5,6,7,8,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29]);
const twoWorldOnly=Object.freeze([25,26,27]);
function classify(id,world,hasDescriptor){
 if(!ids.includes(id))return {status:'unknown-native-identity',applicable:null,registered:false,implemented:false};
 if(twoWorldOnly.includes(id)){
  if(world?.mapId===252||(world?.mapId==null&&world?.mode==='battlefield'))return {status:'not-applicable-map252',applicable:false,registered:false,implemented:false,requiredMode:'native-two-world'};
  return {status:'mode-unverified',applicable:null,registered:false,implemented:false,requiredMode:'native-two-world'};
 }
 if(!hasDescriptor)return {status:'not-implemented',applicable:true,registered:false,implemented:false};
 const base={applicable:true,registered:true,implemented:true};
 if(id===16)return {...base,status:'descriptor-only',implemented:false,implementedBranches:[],remainingBranches:['watch-instance-lifecycle','ally-and-enemy-aura','projectile-slowdown-and-hit-clock','native-client-acceptance']};
 if(id===6)return {...base,status:'implemented-needs-native-acceptance',developmentPolicies:['off-button-absolute-cooldown-retention','committed-channel-keeps-original-spell'],remainingNativeEvidence:['original-server-switch-cooldown-policy','original-server-channel-switch-policy','native-client-acceptance']};
 if(id===7)return {...base,status:'partially-implemented',implementedBranches:['one-second-recovery','seventeen-second-recovery'],developmentPolicies:['fresh-cycle-on-revive-or-reequip'],remainingBranches:['native-cycle-phase','native-status-and-client-acceptance']};
 if(id===14)return {...base,status:'partially-implemented',implementedBranches:['ally-death-unmodified-recovery'],remainingBranches:['damage-stack-duration-and-refresh','native-status-and-client-acceptance']};
 if(id===17)return {...base,status:'partially-implemented',implementedBranches:['known-quality-ledger-projection'],developmentPolicies:['local-ledger-null-expiry-ownership'],remainingBranches:['unknown-quality-mapping','imported-permanent-ownership-proof','native-tooltip-child-statuses','native-client-acceptance']};
 if(id===21)return {...base,status:'partially-implemented',implementedBranches:['owned-equipment-text-formula'],remainingBranches:['native-counter-and-attribute-reconciliation','native-tooltip-child-statuses','native-client-acceptance']};
 return {...base,status:'implemented-needs-native-acceptance'};
}
function partition(selected,world,statuses){
 if(!Array.isArray(selected))throw Error('Invalid godsend selection');
 const active=[],coverage=[],seen=new Set();
 for(const effect of selected){
  const id=effect?.godsendId;if(!Number.isInteger(id)||id<=0||seen.has(id))throw Error('Invalid or duplicate godsend selection');seen.add(id);
  const policy=classify(id,world,Object.hasOwn(statuses,id));
  // Preserve the validated descriptor for existing adapters and diagnostics.
  // A descriptor-only entry has no implemented combat branch.
  if(policy.registered){if(effect.nativeStatusId!==statuses[id])throw Error('Unverified rune-godsend descriptor');active.push(effect);}
  coverage.push({godsendId:id,sourceRuneIds:[...(effect.sourceRuneIds||[])],...policy,nativeAccepted:false});
 }
 return {active,coverage};
}
module.exports={ids,twoWorldOnly,classify,partition};
