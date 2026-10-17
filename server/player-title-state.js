'use strict';
function validate(state,account){
  // The verified normal-client ownership bitmap contains IDs 0..2399. A
  // u16 request alone is not evidence that a larger title can be represented.
  if(state?.version!==1||!Number.isInteger(state.titleId)||state.titleId<0||state.titleId>=2400||typeof state.hidden!=='boolean'||!Number.isSafeInteger(state.changedAt)||state.changedAt<0)throw Error('Invalid title state');
  if(state.titleId&&!account.owned.titles[state.titleId])throw Error('Selected title is not owned');
  if(!state.titleId&&!state.hidden)throw Error('No title selected');
  return state;
}
// Mutate only a PlayerAccounts.update draft. Expiration hides the effective
// title without deleting ownership history or silently selecting another title.
function apply(account,request,now=Date.now()){
  const next={version:1,titleId:request.titleId,hidden:request.hidden,changedAt:now};
  validate(next,account);
  if(next.titleId&&!next.hidden&&!require('./player-account-state').owns(account,'titles',next.titleId,now))throw Error('Title has expired');
  account.titleState=next;return next;
}
function effective(account,now=Date.now()){
  if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid title time');
  if(!account.titleState)return null;
  const state=validate(account.titleState,account);
  return !state.hidden&&state.titleId&&require('./player-account-state').owns(account,'titles',state.titleId,now)?state.titleId:null;
}
module.exports={validate,apply,effective};
