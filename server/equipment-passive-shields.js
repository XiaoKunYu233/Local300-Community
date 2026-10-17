'use strict';

function shieldCap(hero){
  const p=hero.passives?.omen;
  return p?Math.floor(hero.hpMax*((p.omenCapBase??12.5)+p.level*(p.omenCapPerLevel??.5))/100):0;
}

module.exports={shieldCap};
