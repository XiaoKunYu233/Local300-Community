'use strict';

// User-supplied cumulative ordinary-equipment table from a third-party
// equipment enhancement simulator, 2026-09-29. Rows 1..14 match official
// 13511 quotes captured this session. Higher rows and all listed success
// percentages still require independent current-server confirmation.
// This is evidence for a future server rule, not an executable rule by itself.
const cumulative=Object.freeze([
  [0,0,0,null],
  [0,5,5,100],[0,12,12,100],[0,21,21,89.4],[1,32,32,66.7],
  [4,45,45,41.5],[9,60,60,33],[16,75,75,27.5],[25,90,90,20.54],
  [36,105,105,8.1],[49,120,120,5.6],[64,135,135,3.27],
  [81,150,150,2.01],[100,165,165,1.21],[121,180,180,0.81],
  [144,195,195,0.61],[169,211,211,0.49],[196,228,228,0.01],
].map(row=>Object.freeze(row)));
function userCostFor(currentLevel){
  if(!Number.isInteger(currentLevel)||currentLevel<0||currentLevel>=17)
    throw new RangeError('current enhancement level must be 0..16');
  const before=cumulative[currentLevel],after=cumulative[currentLevel+1];
  return Object.freeze({currentLevel,targetLevel:currentLevel+1,
    resources:Object.freeze({40001:after[1]-before[1],40002:after[2]-before[2],
      40003:after[0]-before[0]}),
    claimedSuccessPercent:after[3],
    source:'user-supplied simulator table 2026-09-29',
    executionReady:false});
}
module.exports={cumulative,userCostFor};
