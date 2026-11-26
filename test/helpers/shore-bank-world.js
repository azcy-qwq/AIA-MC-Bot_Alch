// Exposed water well surrounded by a solid bank, not an existing doorway.
export function shoreBankWorld({leak=null,unsupported=false,looseRoof=false,hiddenHead=false,noTool=false,removed=[]}={}){
  let pos=[.5,62.5,.5],held='stone_pickaxe',jumping=false;const holes=new Set(removed.map(q=>q.join(','))),digs=[],controls=[],postures=[],progress=[],failed=[];
  const original=([x,y,z])=>{
    if(x===0&&z===0)return y<59?'stone':y<=62?'water':'air';
    if(leak&&Math.abs(x)+Math.abs(z)>1&&[63,64].includes(y))return leak;
    if(unsupported&&y===62)return 'air';
    if(looseRoof&&y===65)return 'gravel';
    return y<66?'stone':'air';
  };
  const block=q=>holes.has(q.join(','))?'air':original(q);
  const water=()=>block(pos.map(Math.floor))==='water';
  const under=()=>block([Math.floor(pos[0]),Math.floor(pos[1]+1.62),Math.floor(pos[2])])==='water';
  const grounded=()=>!water()&&Math.abs(pos[1]-Math.round(pos[1]))<.01&&block([Math.floor(pos[0]),Math.floor(pos[1])-1,Math.floor(pos[2])])==='stone';
  const api={async request(url,{body={}}={}){
    let result={};
    if(url==='/status')result={alive:true,ready:true,pos:[...pos],health:20,food:20,dimension:'overworld',in_water:water(),submerged:under(),on_ground:grounded(),oxygen:400,jumping,held:{name:held,slot:36}};
    else if(url==='/inventory')result={items:noTool?[]:[{name:'stone_pickaxe',count:1,slot:36}],held:noTool?null:{name:held,slot:36},empty_slots:35};
    else if(url==='/get_block')result={name:block(body.pos),diggable:true};
    else if(url==='/posture'){postures.push(body);if('jump'in body)jumping=body.jump;}
    else if(url==='/equip')held=body.item;
    else if(url==='/dig'){
      const [x,y,z]=body.pos;
      if(hiddenHead&&y===64&&!holes.has([x,63,z].join(','))){failed.push(body.pos);return {ok:false,error:{code:'not_visible',message:'lower bank masks head block'}};}
      if(y<63)throw new Error('excavation removed landing support or waterline');
      digs.push([...body.pos]);holes.add(body.pos.join(','));
    }else if(url==='/control'){
      controls.push(body);if(controls.length>100)throw new Error('bank fixture detected stalled swimming');
      for(let t=0;t<body.ms;t+=25){
        if((body.jump||jumping)&&water())pos[1]=Math.min(62.5,pos[1]+.1);
        if(body.forward){const nx=pos[0]-Math.sin(body.yaw)*.075,nz=pos[2]-Math.cos(body.yaw)*.075;let ny=pos[1];
          if(block([Math.floor(nx),Math.floor(ny),Math.floor(nz)])==='stone'&&(body.jump||jumping)&&block([Math.floor(nx),Math.floor(ny)+1,Math.floor(nz)])==='air')ny=Math.floor(ny)+1;
          if(block([Math.floor(nx),Math.floor(ny),Math.floor(nz)])!=='stone'&&block([Math.floor(nx),Math.floor(ny)+1,Math.floor(nz)])!=='stone')pos=[nx,ny,nz];
        }
      }
      result={pos:[...pos]};
    }else throw new Error('unexpected bank escape API '+url);
    return {ok:true,result};
  }};
  return {api,digs,failed,controls,postures,progress,block,water,under,grounded,get pos(){return pos;}};
}
