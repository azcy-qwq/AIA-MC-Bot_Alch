#include "engine.hpp"
namespace mc {
void Engine::illuminate(P feet,P heading){
  auto& lights=state["mineLighting"];if(!lights.is_object())lights=J::object();
  for(auto it=lights.begin();it!=lights.end();++it){auto v=it.value();if(v.value("dimension",std::string())==dimension&&std::abs(point(v["pos"])[1]-feet[1])<=2&&distance(point(v["pos"]),feet)<=7)return;}
  auto inv=inventory();int fuel=count(inv,"coal")+count(inv,"charcoal"),torches=count(inv,"torch");
  if(torches<8&&fuel>32){
    // Keep at least 24 fuel; an inventory recipe/DAG handles sticks locally.
    try{craft("torch",32);inv=inventory();torches=count(inv,"torch");}
    catch(const Failure& e){if(e.code=="dead"||e.code=="survival_priority"||e.code=="cancelled")throw;return;}
  }
  if(torches<8)return;
  for(P d:dirs){if(heading!=P{0,0,0}&&d[0]*heading[0]+d[2]*heading[2]!=0)continue;
    P floor=add(feet,d),q=add(floor,{0,1,0});auto b=block(q,true);auto foundation=block(floor,true);
    // A one-cell recess ABOVE a solid side wall keeps the exact two-block
    // walking column clear. Do not modify a station, ore or loose boundary.
    if(protectedAt(q)||!support(foundation)||!terrain(foundation)||important(foundation)||ends(name(foundation),"_ore"))continue;
    if(name(b)=="torch"||name(b)=="wall_torch"){lights[dimension+":"+jp(q).dump()]={{"pos",jp(q)},{"dimension",dimension},{"verifiedAt",wallms()}};save();return;}
    if(!air(b)&&(!terrain(b)||important(b)||ends(name(b),"_ore")||falling(b)))continue;
    try{if(!air(b)){tool(false,name(b));dig(q,true,false,false);}place(q,"torch");lights[dimension+":"+jp(q).dump()]={{"pos",jp(q)},{"dimension",dimension},{"verifiedAt",wallms()}};save();progress("mine_lighting",{{"pos",jp(q)},{"remaining",torches-1}});return;}
    catch(const Failure& e){if(e.code=="dead"||e.code=="survival_priority"||e.code=="cancelled"||e.code=="api_compatibility_unresolved")throw;progress("lighting_deferred",{{"pos",jp(q)},{"code",e.code}});}
  }
}
}
