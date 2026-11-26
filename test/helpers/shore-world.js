// Surface swimming fixture: movement obeys solid blocks and one-block banks.
export function shoreWorld({shoreX=3, submerged=false, enclosed=false, obstacle=false, stuck=false,eyeSubmersion=false,well=false}={}) {
  let pos=[.5,submerged?60:eyeSubmersion?61.8:62.5,.5], jumping=false;
  const controls=[], postures=[], progress=[];
  const block=([x,y,z])=>{
    if(well&&Math.abs(x)+Math.abs(z)===1&&y>=61&&y<=62)return 'stone';
    if(enclosed && (Math.abs(x)>2||Math.abs(z)>2)) return 'stone';
    if(obstacle&&x===1&&Math.abs(z)<=1&&y>=62&&y<=65)return 'stone';
    if(!enclosed&&x>=shoreX)return y<63?'stone':'air';
    return y<59?'stone':y<=62?'water':'air';
  };
  const water=()=>block(pos.map(Math.floor))==='water';
  const under=()=>block([Math.floor(pos[0]),eyeSubmersion?Math.floor(pos[1]+1.62):Math.floor(pos[1])+1,Math.floor(pos[2])])==='water';
  const grounded=()=>!water()&&Math.abs(pos[1]-Math.round(pos[1]))<.01&&block([Math.floor(pos[0]),Math.floor(pos[1])-1,Math.floor(pos[2])])==='stone';
  const api={async request(url,{body={}}={}){
    if(url==='/status')return {ok:true,result:{pos,alive:true,ready:true,health:20,food:20,dimension:'overworld',oxygen:under()?100:400,in_water:water(),submerged:under(),on_ground:grounded(),jumping}};
    if(url==='/get_block')return {ok:true,result:{name:block(body.pos),diggable:true}};
    if(url==='/inventory')return {ok:true,result:{items:[{name:'diamond',count:1}],empty_slots:35}};
    if(url==='/posture'){postures.push(body);if('jump' in body)jumping=body.jump;return {ok:true,result:{}};}
    if(url==='/control'){
      controls.push(body);if(controls.length>150)throw Object.assign(new Error('fixture detected repeated movement without escape'),{code:'test_loop'});
      if(!stuck)for(let t=0;t<body.ms;t+=25){
        if((body.jump||jumping)&&water())pos[1]=Math.min(62.5,pos[1]+.1);
        if(body.forward){
          const nx=pos[0]-Math.sin(body.yaw)*.075,nz=pos[2]-Math.cos(body.yaw)*.075;
          let ny=pos[1];
          if(block([Math.floor(nx),Math.floor(ny),Math.floor(nz)])==='stone'&&(body.jump||jumping)&&block([Math.floor(nx),Math.floor(ny)+1,Math.floor(nz)])==='air')ny=Math.floor(ny)+1;
          if(block([Math.floor(nx),Math.floor(ny),Math.floor(nz)])!=='stone'&&block([Math.floor(nx),Math.floor(ny)+1,Math.floor(nz)])!=='stone')pos=[nx,ny,nz];
        }
      }
      return {ok:true,result:{pos}};
    }
    throw new Error('Unexpected shoreline API '+url);
  }};
  return {api,controls,postures,progress,block,water,under,grounded,get pos(){return pos;}};
}
