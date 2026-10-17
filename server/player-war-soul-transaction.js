'use strict';
const protocol=require('./progression-protocol'),{stageCfg}=require('./war-soul');
const copy=value=>JSON.parse(JSON.stringify(value));
const uint=value=>Number.isSafeInteger(value)&&value>=0&&value<=0xffffffff;
const rowsFor=(category,id)=>stageCfg.filter(row=>Number(row[1])===category&&Number(row[2])===id);

// The native page's levels, remaining fragments and derived unit data share
// one document. Evaluate every rank and its final debit/refund on a private
// model, then save that whole document once through the protected commit.
function prepare(model,request){
  try{
    if(model.frozenSnapshot)throw Error('war-soul-storage-frozen');
    if(request?.system!=='warSoul'||!['bulkLevelUp','bulkReset','renamePage','changePage'].includes(request.operation))throw Error('invalid-war-soul-operation');
    const page=request.page;
    if(!Number.isInteger(page)||page<0||page>4||!model.state.pages[page])throw Error('war-soul-page-not-found');
    if(['bulkLevelUp','bulkReset'].includes(request.operation)){
      const category=request.category;
      if(!Number.isInteger(category)||category<1||category>4)throw Error('invalid-war-soul-chapter');
      if(!Array.isArray(request.unitIds)||request.unitIds.some(id=>!Number.isInteger(id)||id<1||id>1280||!rowsFor(category,id).length))throw Error('war-soul-unit-not-found');
      if(category===1&&request.unitIds.some(id=>Object.hasOwn(model.state.pages[page].levels||{},'1:'+id)))throw Error('unverified-war-soul-level-alias');
      if(request.operation==='bulkReset'){
        const ids=new Set(request.unitIds),whole=!ids.size&&request.mode===0;
        // An unrecognized historical level is retained until its refund rule
        // is known. A generic node's material price is never substituted.
        for(const [key,level]of Object.entries(model.state.pages[page].levels||{})){
          const parts=key.split(':'),cat=parts.length===1?1:Number(parts[0]),id=Number(parts.at(-1));
          if(!whole&&(cat!==category||ids.size&&!ids.has(id)))continue;
          if(!/^(?:[1-4]:)?[1-9][0-9]*$/.test(key)||key!==model.pageUnitKey(id,cat)||!Number.isInteger(level)||level<0||level>5)throw Error('unverified-war-soul-refund');
          const unit=model.resolveUnit(id,cat),rows=rowsFor(cat,id);
          if(level&&(!unit||Number(unit.unitId)!==id||Number(unit.category)!==cat))throw Error('unverified-war-soul-refund');
          for(let rank=1;rank<=level;rank++)if(rows.filter(row=>Number(row[3])===rank).length!==1)throw Error('unverified-war-soul-refund');
        }
      }
    }
    const draft=Object.create(Object.getPrototypeOf(model));
    draft.state=copy(model.state);draft.random=model.random;draft.save=()=>{};
    const fragments=draft.pageFragments(page);
    if(!fragments||Object.values(fragments).some(value=>!uint(value)))throw Error('invalid-war-soul-material-balance');
    const result=protocol.handle({...request,availableMaterials:{...fragments}},{warSoul:draft});
    if(!result.ok)return result;
    for(const [sign,amounts]of [[-1,result.costs],[1,result.refunds]])for(const [id,amount]of Object.entries(amounts||{})){
      const held=fragments[id]??0,next=held+sign*amount;
      if(!/^[1-9][0-9]*$/.test(id)||!uint(amount)||!uint(held)||!uint(next))throw Error('invalid-war-soul-material-balance');
      fragments[id]=next;
    }
    return {ok:true,state:draft.state,result};
  }catch(error){return {ok:false,reason:error.message};}
}
module.exports={prepare};
