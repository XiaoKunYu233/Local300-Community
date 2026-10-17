'use strict';
const fs=require('node:fs'),path=require('node:path');
const files=['equipment-registry.json','economy-registry.json','mail-registry.json','inventory-registry.json','login-registry.json','battle-registry.json'];
function catalog(){
  const ids=new Set(),messages=[];
  for(const file of files){const registry=JSON.parse(fs.readFileSync(path.join(__dirname,file),'utf8'));
    if(registry.version!==1||!Array.isArray(registry.messages))throw Error('Invalid protocol registry: '+file);
    for(const message of registry.messages){
      if(!Number.isInteger(message.id)||message.id<1||message.id>65535||ids.has(message.id))throw Error('Invalid or duplicate message ID');ids.add(message.id);
      if(message.direction!=='c2s'||!Number.isInteger(message.payloadBytes)||message.payloadBytes<0||!message.evidence?.length)throw Error('Incomplete protocol contract: '+message.id);
      const covered=new Set();
      for(const field of message.fields){const bytes=field.bytes||({u8:1,u16le:2,u32le:4}[field.type])||Number(field.type?.match(/^bytes(\d+)$/)?.[1]);
        if(!Number.isInteger(field.offset)||field.offset<0||!Number.isInteger(bytes)||bytes<1||field.offset+bytes>message.payloadBytes)throw Error('Invalid protocol field: '+message.id+'/'+field.name);
        for(let i=field.offset;i<field.offset+bytes;i++){if(covered.has(i))throw Error('Overlapping protocol field: '+message.id);covered.add(i);}
      }
      if(covered.size!==message.payloadBytes)throw Error('Undocumented payload bytes: '+message.id);
      messages.push({...message,registry:file});
    }
  }
  return {version:1,scope:'Reviewed native C2S subset; opaque bytes are explicitly retained. No claim of complete game protocol.',messages:messages.sort((a,b)=>a.id-b.id)};
}
function table(data=catalog()){
  const escape=value=>String(value??'').replace(/\|/g,'\\|').replace(/[\r\n]+/g,' ');
  const lines=[data.scope,'','| ID | Direction | Name | Payload bytes | Mutation | Replies | Registry |','| --- | --- | --- | --- | --- | --- | --- |'];
  for(const row of data.messages)lines.push('| '+[row.id,row.direction,row.name,row.payloadBytes,row.mutation===true?'yes':row.mutation===false?'no':'unspecified',(row.successReplies||[]).join(', '),row.registry].map(escape).join(' | ')+' |');
  for(const row of data.messages){
    lines.push('','### '+row.id+' '+escape(row.name),'','| Field | Offset | Bytes / type | Constraint | Interpretation |','| --- | --- | --- | --- | --- |');
    for(const field of row.fields)lines.push('| '+[field.name,field.offset,field.bytes||field.type,field.required!==undefined?'required='+JSON.stringify(field.required):field.allowed?'allowed='+JSON.stringify(field.allowed):'',field.status||''].map(escape).join(' | ')+' |');
    lines.push('','Evidence: '+row.evidence.map(escape).join('; '));
    for(const key of ['repeatPolicy','stateEffect','responsePolicy'])if(row[key])lines.push('',escape(key)+': '+escape(row[key]));
  }
  return lines.join('\n')+'\n';
}
if(require.main===module)try{if(process.argv.slice(2).some(arg=>arg!=='--table'))throw Error('Usage: node protocols/catalog.js [--table]');console.log(process.argv.includes('--table')?table():JSON.stringify(catalog(),null,2));}catch(e){console.error(e.message);process.exitCode=1;}
module.exports={catalog,table};
