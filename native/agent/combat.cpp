#include "engine.hpp"
namespace mc {
static double entityDistance(const J&s,const J&e){if(e.contains("pos")&&s.contains("pos")){double n=0;for(int i=0;i<3;i++)n+=std::pow(e["pos"][i].get<double>()-s["pos"][i].get<double>(),2);return std::sqrt(n);}return e.value("dist",999.0);}
static bool hostile(const J&s,const J&e,bool confirmed=false){
  const auto n=name(e);const bool neutral=std::set<std::string>{"enderman","zombified_piglin","piglin","wolf","bee","polar_bear","iron_golem","llama","trader_llama"}.count(n)||(n=="spider"&&s.value("is_day",false));
  if(neutral&&!confirmed&&!e.value("aggressive",false)&&!e.value("angry",false)&&!e.value("confirmed_attacker",false))return false;
  return e.contains("pos")&&(e.value("type",std::string())=="hostile"||e.value("type",std::string())=="monster"||confirmed||e.value("confirmed_attacker",false))&&e.value("visible",true)&&e.value("line_of_sight",true)&&e.value("has_line_of_sight",true);
}
static bool threat(const J&s,const J&e,bool confirmed=false){
  const auto n=name(e);const bool ranged=std::set<std::string>{"skeleton","stray","bogged","pillager","illusioner","witch","blaze","ghast"}.count(n);
  return hostile(s,e,confirmed)&&entityDistance(s,e)<=(ranged?12.0:4.8)&&std::abs(e["pos"][1].get<double>()-s["pos"][1].get<double>())<(ranged?4.5:1.8);
}
static double bodyHeight(const J&e){if(e.contains("height")&&e["height"].is_number())return std::clamp(e["height"].get<double>(),.2,5.0);auto n=name(e);return n=="spider"?.9:n=="cave_spider"?.5:n=="silverfish"||n=="endermite"?.3:1.8;}
static J aimAtBody(const J&s,const J&e){
  const double dx=e["pos"][0].get<double>()-s["pos"][0].get<double>(),dz=e["pos"][2].get<double>()-s["pos"][2].get<double>();
  const double y=e["pos"][1].get<double>()+bodyHeight(e)*.55,eye=s["pos"][1].get<double>()+s.value("eye_height",1.62);
  return {{"yaw",std::atan2(-dx,-dz)},{"pitch",std::atan2(y-eye,std::hypot(dx,dz))},{"point",J::array({e["pos"][0],y,e["pos"][2]})}};
}
static bool sameBlockedGeometry(const J&snap,const J&s,const J&e){
  auto last=snap.value("nativeCombat",J::object()).value("last",J::object());
  if(!last.is_object()||last.value("entityId",-1)!=e.value("id",-2)||last.value("stopReason",std::string())!="sight_blocked"||!last.contains("botPos")||!last.contains("targetPos"))return false;
  double bot=0,target=0;for(int i=0;i<3;i++){bot+=std::pow(s["pos"][i].get<double>()-last["botPos"][i].get<double>(),2);target+=std::pow(e["pos"][i].get<double>()-last["targetPos"][i].get<double>(),2);}return bot<.25&&target<.25;
}
J assess(const J& snap){
  auto s=snap.value("status",J::object());if(s.is_null()||s.empty())return {{"urgent",false},{"reason","尚无状态"}};
  if(!s.value("alive",false))return {{"urgent",true},{"kind","dead"},{"priority",110},{"params",{{"kind","dead"},{"last_death",s.value("last_death",J())},{"dimension",s.value("dimension",std::string("overworld"))}}}};
  if(!s.value("ready",false))return {{"urgent",false},{"reason","等待就绪"}};
  auto pressure=snap.value("tacticalHistory",J::object());int hits=pressure.value("recentHits",0);double wear=pressure.value("armorWear",0.0);bool armorLost=pressure.value("armorLost",false);
  for(auto event:snap.value("events",J::array()))if(event.value("type",std::string())=="hurt")hits=std::max(hits,1);
  J enemy;int close=0,near=0;bool creeper=false,ranged=false;double closest=999;
  for(auto e:snap.value("entities",J::array()))if(hostile(s,e)&&entityDistance(s,e)<=16){
    double d=entityDistance(s,e);if(sameBlockedGeometry(snap,s,e)&&hits==0&&wear==0)continue;
    if(d<closest){closest=d;enemy=e;}if(d<=4.5)close++;if(d<=7)near++;
    if(name(e)=="creeper"&&d<=4.5)creeper=true;
    if(std::set<std::string>{"skeleton","stray","bogged","pillager","witch","blaze","ghast"}.count(name(e))&&d<=14)ranged=true;
  }
  bool fragile=false;auto inv=snap.value("inventory",J::object());
  static const std::map<std::string,std::array<int,4>> limits={{"leather",{55,80,75,65}},{"golden",{77,112,105,91}},{"chainmail",{165,240,225,195}},{"iron",{165,240,225,195}},{"diamond",{363,528,495,429}},{"netherite",{407,592,555,481}}};
  for(const auto& piece:inv.value("armor",J::object()))if(piece.is_object()){
    std::string n=name(piece);int maximum=0,remaining=0;for(const auto& tier:limits)for(int i=0;i<4;i++)if(n==tier.first+"_"+std::array<std::string,4>{"helmet","chestplate","leggings","boots"}[i])maximum=tier.second[i];
    if(piece.contains("durability")&&piece["durability"].is_array()&&piece["durability"].size()==2){remaining=piece["durability"][0].get<int>();maximum=piece["durability"][1].get<int>();}
    else if(maximum&&piece.contains("durability_used"))remaining=maximum-piece["durability_used"].get<int>();else continue;
    if(remaining<=std::max(16,int(maximum*.2)))fragile=true;
  }
  double reference=std::max(s.value("health",20.0),pressure.value("peakHealth",s.value("max_health",20.0)));
  std::string kind;int priority=0;
  if(s.value("in_lava",false)){kind="lava";priority=100;}
  else if(s.value("submerged",false)){kind="drowning";priority=95;}
  else if(s.value("on_fire",false)){kind="fire";priority=90;}
  else if(s.contains("velocity")&&s["velocity"].is_array()&&s["velocity"][1].get<double>()<-10&&!s.value("on_ground",false)){kind="fall";priority=90;}
  else if(s.value("in_water",false)){kind="water_exit";priority=85;}
  else if((s.value("health",20.0)<10||s.value("health",20.0)<reference*.4)
      &&(closest<10||ranged||!healingDeferred(s,snap.value("nativeCombat",J::object())))){kind="low_health";priority=80;}
  else if(creeper){kind="creeper";priority=78;}
  else if(close>=2||near>=3){kind="surrounded";priority=82;}
  else if(!enemy.is_null()&&(hits>=3||wear>=8||armorLost)){kind="damage_pressure";priority=70;}
  else if(!enemy.is_null()&&fragile){kind="armor_risk";priority=68;}
  else if(ranged&&hits>0){kind="ranged_pressure";priority=65;}
  else if(!enemy.is_null()&&snap.value("nativeCombat",J::object()).value("last",J::object()).value("stopReason",std::string())=="aim_missed"&&snap["nativeCombat"]["last"].value("entityId",-1)==enemy.value("id",-2)){kind="ineffective_combat";priority=65;}
  else if(!enemy.is_null()&&threat(s,enemy)){kind="combat";priority=76;}
  J params={{"kind",kind},{"pressure",{{"recentHits",hits},{"armorWear",wear},{"armorLost",armorLost},{"nearbyHostiles",near},{"closeHostiles",close},{"peakHealth",reference}}}};if(!enemy.is_null())params["entity_id"]=enemy["id"];
  return {{"urgent",!kind.empty()},{"safe",kind.empty()&&s.value("on_ground",false)},{"kind",kind},{"priority",priority},{"params",params}};
}
J Engine::combat(const J& p){
  const bool old=rescue;struct Restore{bool& flag;bool value;~Restore(){flag=value;}} restore{rescue,old};rescue=true;
  auto s=status(false);const int requested=p.value("entity_id",-1);const bool hunting=p.value("hunt",false)&&requested>=0;int hits=0,packets=0,misses=0,damage=0;J enemy;std::string weapon;
  auto inv=inventory();for(std::string w:{"netherite_sword","diamond_sword","iron_sword","stone_sword","netherite_axe","diamond_axe","iron_axe","stone_axe","wooden_sword"})if(count(inv,w)){equip(w);weapon=w;break;}
  const bool shield=count(inv,"shield")>0;if(shield)equip("shield","off-hand");bool blocking=false;long long lastSwing=0;
  auto setBlocking=[&](bool value){if(!shield||blocking==value)return;if(value)api("posture",{{"shield",true}});else api("posture",J::object());blocking=value;};
  auto finish=[&](std::string why){api("posture",J::object());J last={{"at",wallms()},{"entityId",enemy.is_object()?enemy.value("id",requested):requested},{"name",enemy.is_object()?name(enemy):std::string()},{"botPos",s["pos"]},{"targetPos",enemy.is_object()?enemy.value("pos",J()):J()},{"stopReason",why},{"hitsAttempted",hits},{"targetPackets",packets},{"damageConfirmed",damage}};state["combat"]["last"]=last;save();progress("combat_finished",last);return last;};
  J observedEnemies=J::array();double peakHealth=s.value("health",20.0);std::string sightKey;bool sightKnown=false,sightBlocked=false;
  auto readTarget=[&](bool initial){auto found=api("getEntities",{{"radius",16},{"types",hunting?J::array({"hostile","cow","mooshroom","horse","donkey","mule"}):J::array({"hostile"})}});observedEnemies=found.value("entities",J::array());for(auto e:observedEnemies)if((requested<0||e.value("id",-1)==requested)&&(!enemy.is_object()||e.value("id",-1)==enemy.value("id",-2))&&(hunting?leatherAnimal(e)&&e.contains("pos")&&e.value("visible",true)&&e.value("line_of_sight",true)&&(!initial||(entityDistance(s,e)<=3.6&&std::abs(e["pos"][1].get<double>()-s["pos"][1].get<double>())<1.8)):(initial?threat(s,e,p.value("confirmed_attacker",false)):e.value("visible",true)&&e.contains("pos"))))return e;return J();};
  // Short positioning uses verified ground and never starts a pathfinder chase.
  auto closeGap=[&](){
    const double dx=enemy["pos"][0].get<double>()-s["pos"][0].get<double>(),dz=enemy["pos"][2].get<double>()-s["pos"][2].get<double>(),d=std::hypot(dx,dz);
    const bool ranged=std::set<std::string>{"skeleton","stray","bogged","pillager","illusioner","witch","blaze","ghast"}.count(name(enemy));
    if(d<.01||d>12.0||!s.value("on_ground",false)||std::abs(enemy["pos"][1].get<double>()-s["pos"][1].get<double>())>(ranged?4.5:1.0))return false;
    if(d>=1.1&&d<=2.0)return false;
    const bool retreat=d<1.1;const double travel=retreat?std::min(.55,1.95-d):std::min(.85,std::max(.12,d-2.15));P from=point(s["pos"]);std::vector<P> cells;
    const double ux=dx/d,uz=dz/d,side=.20;
    for(double t=.12;t<=travel+.12;t+=.12){double sign=retreat?-1:1;P q{int(std::floor(s["pos"][0].get<double>()+sign*ux*std::min(t,travel)-uz*side)),from[1],int(std::floor(s["pos"][2].get<double>()+sign*uz*std::min(t,travel)+ux*side))};cells.push_back(q);}for(P q:cells)if(!stand(q))return false;
    const auto before=point(s["pos"]);setBlocking(false);api("control",{{"forward",!retreat},{"back",retreat},{"sprint",false},{"yaw",std::atan2(-dx,-dz)},{"ms",std::clamp(int(travel/3.0*1000),60,180)},{"stop_on",J::array()}});s=status(false);return point(s["pos"])!=before;
  };
  try{while(true){
    s=status(false);
    if(s.value("in_water",false)||s.value("submerged",false)||s.value("in_lava",false))return survive({{"kind","water_exit"},{"combatAttempted",true}});
    auto current=readTarget(true);peakHealth=std::max(peakHealth,s.value("health",20.0));auto risk=assess({{"status",s},{"inventory",inventory()},{"entities",observedEnemies},{"nativeCombat",state.value("combat",J::object())},{"tacticalHistory",{{"peakHealth",peakHealth}}}});
    if(risk.value("urgent",false)&&risk.value("kind",std::string())!="combat"){auto params=risk["params"];params["combatAttempted"]=true;progress("combat_protection_handoff",{{"kind",risk["kind"]},{"pressure",params["pressure"]}});return survive(params);}
    if(current.is_null())return finish(hits?"target_left_view":"no_direct_threat");enemy=current;
    if(s.value("health",20.0)<7)return survive({{"kind","low_health"},{"combatAttempted",true}});
    if(!s.value("on_ground",false)){if(shield)api("posture",{{"shield",true}});std::this_thread::sleep_for(std::chrono::milliseconds(10));continue;}
    const bool repositioned=closeGap();
    const double approachDistance=std::hypot(enemy["pos"][0].get<double>()-s["pos"][0].get<double>(),enemy["pos"][2].get<double>()-s["pos"][2].get<double>());
    if(repositioned)continue;
    if(approachDistance>3.6)return finish("approach_blocked");
    auto groundAim=aimAtBody(s,enemy);std::vector<P> ray;
    for(double t=.1;t<.98;t+=.08){P q;for(int i=0;i<3;i++){double a=s["pos"][i].get<double>()+(i==1?s.value("eye_height",1.62):0);q[i]=int(std::floor(a+(groundAim["point"][i].get<double>()-a)*t));}ray.push_back(q);}std::string nextSightKey;for(P q:ray)nextSightKey+=jp(q).dump();
    if(!sightKnown||nextSightKey!=sightKey){observe(ray,true);sightBlocked=false;for(P q:ray){auto b=block(q);auto n=name(b);if(!air(b)&&!liquid(b)&&support(b)&&n!="wildflowers"&&n!="leaf_litter"&&!ends(n,"_flower")){sightBlocked=true;break;}}sightKey=nextSightKey;sightKnown=true;}
    if(sightBlocked)return finish("sight_blocked");
    const int cooldown=ends(weapon,"_sword")?400:ends(weapon,"_axe")?800:250;
    setBlocking(true);
    if(lastSwing&&clockms()-lastSwing<cooldown)std::this_thread::sleep_for(std::chrono::milliseconds(cooldown-(clockms()-lastSwing)));
    setBlocking(false);
    api("control",{{"jump",true},{"ms",100},{"stop_on",J::array()}});
    // Both the player eye and a moving target changed during the jump. The
    // final angles travel WITH the hit request: no separate stale /look call.
    current=readTarget(false);if(current.is_null())return finish("target_left_view");enemy=current;s=status(false);
    if(s.value("in_water",false)||s.value("in_lava",false))return survive({{"combatAttempted",true}});
    auto aim=aimAtBody(s,enemy);auto shot=api("control",{{"hit",true},{"yaw",aim["yaw"]},{"pitch",aim["pitch"]},{"ms",50},{"stop_on",J::array()}});lastSwing=clockms();hits++;
    bool targetPacket=false;J hitBlock;for(auto hit:shot.value("hits",J::array())){auto target=hit.value("entity",J());if(target.is_object()&&target.value("id",-1)==enemy.value("id",-2))targetPacket=true;if(hit.contains("block"))hitBlock=hit["block"];}
    if(targetPacket){packets++;misses=0;}else misses++;
    J strike={{"at",wallms()},{"entityId",enemy["id"]},{"name",name(enemy)},{"botPos",s["pos"]},{"targetPos",enemy["pos"]},{"targetHeight",bodyHeight(enemy)},{"aim",aim},{"hitsAttempted",hits},{"targetPacket",targetPacket},{"hitBlock",hitBlock},{"response",shot}};
    state["combat"]["lastStrike"]=strike;save();progress("combat_strike",strike);
    setBlocking(true);
    J after=enemy;
    if(enemy.contains("health")){after=readTarget(false);if(after.is_null())return finish("target_left_view");if(after.contains("health")&&after["health"].is_number()&&after["health"]<enemy["health"]){damage++;misses=0;}}
    // Missing health is unknown, not proof that the swing missed. Packets
    // confirm only which entity was selected, never server-side damage.
    if(!targetPacket&&!hitBlock.is_null())return finish("sight_blocked");
    if(misses>=2)return finish("aim_missed");enemy=after;
  }}catch(...){try{api("posture",J::object());}catch(...){}throw;}
}
}
