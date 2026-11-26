#include "engine.hpp"
namespace mc {
J Engine::survive(const J& p){
  const bool wasRescue=rescue;struct Restore{bool& ref;bool value;~Restore(){ref=value;}} restore{rescue,wasRescue};rescue=true;auto s=status(false);std::string kind=p.value("kind",std::string());auto inv=inventory();bool shield=count(inv,"shield")>0;
  const bool lowHealth=kind=="low_health";
  const double observedPeak=p.value("pressure",J::object()).value("peakHealth",20.0);
  const auto recoveryHealth=[&](const J& current){
    return std::max(10.0,0.4*std::max(observedPeak,current.value("max_health",20.0)));
  };
  const bool protect=lowHealth||std::set<std::string>{"surrounded","damage_pressure","armor_risk","ranged_pressure","creeper","ineffective_combat"}.count(kind);
  if(protect){
    const auto sealedAt=[&](P feet){for(P dir:dirs){P wall=add(feet,dir);for(int y=0;y<=2;y++)if(!support(block(add(wall,{0,y,0}),true)))return false;}return support(block(add(feet,{0,2,0}),true));};
    if(shield)equip("shield","off-hand");
    auto& protection=state["combat"]["protection"];if(!protection.is_object()||!protection.value("active",false)||protection.value("dimension",dimension)!=dimension)protection={{"active",true},{"origin",s["pos"]},{"at",wallms()},{"dimension",dimension},{"blocks",J::array()}};protection["kind"]=kind;save();
    std::set<std::pair<P,P>> blocked;std::vector<P> shelter;for(auto q:protection.value("blocks",J::array()))shelter.push_back(point(q));bool holding=false;int moves=0;std::string lastGeometry;
    double lastRecoveryHealth=-1;
    int lastRecoveryFood=-1;
    long long lastHealingAt=0;
    while(true){
      s=status(false);if(s.value("in_water",false)||s.value("submerged",false)){reachShore();continue;}if(s.value("in_lava",false))return survive({{"kind","lava"},{"combatAttempted",true}});
      inv=inventory();shield=count(inv,"shield")>0;if(shield)equip("shield","off-hand");
      auto entities=api("getEntities",{{"radius",16},{"types",J::array({"hostile"})}}).value("entities",J::array());J threats=J::array();double nearest=999;J closest;
      // Occlusion after sealing a pocket is not evidence that enemies left.
      for(auto e:entities){if(!e.contains("pos"))continue;auto n=name(e);bool neutral=std::set<std::string>{"enderman","zombified_piglin","piglin","wolf","bee","polar_bear","iron_golem","llama","trader_llama"}.count(n)||(n=="spider"&&s.value("is_day",false));if(neutral&&!e.value("aggressive",false)&&!e.value("angry",false)&&!e.value("confirmed_attacker",false)&&e.value("id",-2)!=p.value("entity_id",-1))continue;double d=0;for(int i=0;i<3;i++)d+=std::pow(e["pos"][i].get<double>()-s["pos"][i].get<double>(),2);d=std::sqrt(d);double safe=std::set<std::string>{"skeleton","stray","bogged","pillager","witch","blaze","ghast"}.count(n)?14:(lowHealth?10:8);if(d<safe){threats.push_back(e);if(d<nearest){nearest=d;closest=e;}}}
      if(threats.empty()){
        bool deferHealing=false;
        if(lowHealth&&s.value("health",20.0)<recoveryHealth(s)){
          if(s.value("food",20)<18)maintain({{"emergencyFood",true}});
          s=status(false);
          const double health=s.value("health",20.0);
          const int food=s.value("food",20);
          if(health>lastRecoveryHealth||lastHealingAt==0)lastHealingAt=clockms();
          deferHealing=health<recoveryHealth(s)&&(food<18||clockms()-lastHealingAt>=12000);
          if(health<recoveryHealth(s)&&!deferHealing){
            if(health!=lastRecoveryHealth||food!=lastRecoveryFood){
              progress("protection_hold",{{"kind",kind},{"pos",s["pos"]},{"health",health},{"food",food},{"message","低血保护中，等待生命恢复"}});
              lastRecoveryHealth=health;lastRecoveryFood=food;
            }
            std::this_thread::sleep_for(std::chrono::seconds(2));
            continue;
          }
        }
        // Reopen only blocks placed by this protection task, after enemies left.
        P at=point(s["pos"]);auto doorway=std::find_if(shelter.begin(),shelter.end(),[&](P q){return q[1]==at[1]&&std::abs(q[0]-at[0])+std::abs(q[2]-at[2])==1;});
        if(doorway!=shelter.end()){P low=*doorway;for(P q:shelter)if(q==low||q==add(low,{0,1,0})){auto b=block(q,true);if(!air(b)){tool(false,name(b));dig(q,true,false,false);}}}
        const std::string reason=deferHealing?"regeneration_unavailable":"protection_safe";
        const double health=s.value("health",20.0);
        if(deferHealing)state["combat"]["healingDeferred"]={{"health",health},{"food",s.value("food",20)},{"dimension",dimension}};
        else if(lowHealth)state["combat"].erase("healingDeferred");
        protection["active"]=false;
        protection["lastPos"]=s["pos"];
        if(!deferHealing)protection["safeAt"]=wallms();
        save();api("posture",J::object());
        progress(reason,{{"kind",kind},{"moves",moves},{"pos",s["pos"]},{"health",health},{"food",s.value("food",20)}});
        return {{"protected",!deferHealing},{"stopReason",reason},{"kind",kind},{"moves",moves},{"health",health}};
      }
      lastHealingAt=0;
      if(shield)api("posture",{{"shield",true}});
      const double ex=closest["pos"][0].get<double>()-s["pos"][0].get<double>(),ez=closest["pos"][2].get<double>()-s["pos"][2].get<double>();api("look",{{"yaw",std::atan2(-ex,-ez)},{"pitch",0}});
      P feet=point(s["pos"]);std::string geometry=jp(feet).dump()+threats.dump();if(geometry!=lastGeometry){blocked.clear();lastGeometry=geometry;}
      const bool sealed=sealedAt(feet);
      if(lowHealth&&sealed&&s.value("health",20.0)>=14) {int dx=closest["pos"][0].get<double>()-s["pos"][0].get<double>(),dz=closest["pos"][2].get<double>()-s["pos"][2].get<double>();P exitDir=std::abs(dx)>std::abs(dz)?P{dx>0?-1:1,0,0}:P{0,0,dz>0?-1:1};P doorway=add(feet,exitDir);for(P q:{doorway,add(doorway,{0,1,0})})if(!air(block(q,true)))dig(q,true,false,false);protection["active"]=false;protection["safeAt"]=wallms();protection["lastPos"]=s["pos"];save();api("posture",J::object());progress("low_health_recovered",{{"health",s.value("health",0.0)},{"pos",s["pos"]}});return {{"protected",true},{"stopReason","health_recovered"},{"kind",kind},{"health",s.value("health",0.0)},{"moves",moves}};}
      struct Exit {P p;double score;};std::vector<Exit> exits;
      if(lowHealth&&s.value("health",20.0)<14&&!sealed&&stand(feet)){std::vector<P> walls;for(P d:dirs)for(int y=0;y<=2;y++)walls.push_back(add(add(feet,d),{0,y,0}));walls.push_back(add(feet,{0,2,0}));observe(walls,true);bool allowed=true;int need=0;for(P q:walls){auto b=block(q);if(air(b)){need++;if(protectedAt(q))allowed=false;}else if(!support(b))allowed=false;}int materials=0;for(auto material:{"cobblestone","cobbled_deepslate","dirt","netherrack"})materials+=count(inv,material);if(allowed&&need>0&&materials>=need){for(P q:walls)if(air(block(q,true))){try{place(q,filler());shelter.push_back(q);protection["blocks"].push_back(jp(q));save();}catch(const Failure&e){if(e.code=="dead"||e.code=="cancelled")throw;progress("shelter_place_failed",{{"pos",jp(q)},{"code",e.code},{"message",e.what()}});allowed=false;break;}}if(allowed&&sealedAt(point(status(false)["pos"])))continue;}}
      for(int dx:{-1,0,1})for(int dz:{-1,0,1})if(dx||dz)for(int dy:{0,1,-1}){
        int length=dx&&dz?5:8;P q=add(feet,{dx*length,dy,dz*length});if(blocked.count({feet,q}))continue;
        double minimum=999,total=0;bool crosses=false;double vx=q[0]-feet[0],vz=q[2]-feet[2],v2=vx*vx+vz*vz;
        for(auto e:threats){auto ep=point(e["pos"]);double d=distance(q,ep);minimum=std::min(minimum,d);total+=d;double t=((ep[0]-feet[0])*vx+(ep[2]-feet[2])*vz)/v2;if(t>.15&&t<1&&std::hypot(ep[0]-feet[0]-vx*t,ep[2]-feet[2]-vz*t)<1.5)crosses=true;}
        if(!crosses&&minimum>nearest+1)exits.push_back({q,minimum+.08*total-.8*std::abs(dy)});
      }
      std::stable_sort(exits.begin(),exits.end(),[](const Exit&a,const Exit&b){return a.score>b.score;});bool moved=false;
      for(const auto& exit:exits){
        P q=exit.p;std::vector<P> route,cells;int steps=std::max(std::abs(q[0]-feet[0]),std::abs(q[2]-feet[2]));
        P previousCell=feet;for(int i=1;i<=steps;i++){P cell;for(int axis=0;axis<3;axis++)cell[axis]=int(std::lround(feet[axis]+double(q[axis]-feet[axis])*i/steps));route.push_back(cell);if(cell[0]!=previousCell[0]&&cell[2]!=previousCell[2]){route.push_back({cell[0],cell[1],previousCell[2]});route.push_back({previousCell[0],cell[1],cell[2]});}previousCell=cell;}
        for(P cell:route){cells.push_back(add(cell,{0,-1,0}));cells.push_back(cell);cells.push_back(add(cell,{0,1,0}));}observe(cells,true);bool safe=true;for(P cell:route)if(!stand(cell))safe=false;
        if(!safe){blocked.insert({feet,q});continue;}
        // This is a verified dry escape corridor. Sprint away instead of
        // standing in attack cooldowns or asking the model for each step.
        api("posture",J::object());double dx=q[0]-s["pos"][0].get<double>()+.5,dz=q[2]-s["pos"][2].get<double>()+.5;
        try{api("control",{{"forward",true},{"sprint",true},{"jump",q[1]>feet[1]},{"yaw",std::atan2(-dx,-dz)},{"ms",std::clamp(int(std::hypot(dx,dz)/7.0*1000),300,1800)},{"stop_on",J::array({"death"})}});}catch(const Failure&e){if(e.code=="dead"||e.code=="cancelled")throw;blocked.insert({feet,q});}
        s=status(false);if(shield)api("posture",{{"shield",true}});if(point(s["pos"])!=feet){moves++;moved=true;holding=false;protection["lastPos"]=s["pos"];save();progress("protection_retreat",{{"kind",kind},{"moves",moves},{"pos",s["pos"]},{"threats",threats.size()}});break;}blocked.insert({feet,q});
      }
      if(moved)continue;
      // An enclosed pocket can be sealed without leaving the current cell.
      // Never excavate a shelter while being surrounded or consume valuables.
      if(stand(feet)){
        std::vector<P> walls;for(P d:dirs){walls.push_back(add(feet,d));walls.push_back(add(add(feet,d),{0,1,0}));}walls.push_back(add(feet,{0,2,0}));observe(walls,true);bool allowed=true;int need=0;
        for(P q:walls){auto b=block(q);if(air(b)){need++;if(protectedAt(q))allowed=false;}else if(!support(b))allowed=false;}
        int materials=0;for(auto material:{"cobblestone","cobbled_deepslate","dirt","netherrack"})materials+=count(inv,material);
        if(allowed&&need>0&&materials>=need)for(P q:walls)if(air(block(q,true))){try{place(q,filler());shelter.push_back(q);protection["blocks"].push_back(jp(q));save();}catch(const Failure&e){if(e.code=="dead"||e.code=="cancelled")throw;break;}}
      }
      if(!holding){progress("protection_hold",{{"kind",kind},{"pos",s["pos"]},{"threats",threats.size()},{"shield",shield},{"shelterBlocks",shelter.size()},{"message","无已验证安全退路，保持防护并等待空间变化；不恢复原任务"}});holding=true;}
      if(s.value("food",20)<18)maintain(J::object());std::this_thread::sleep_for(std::chrono::milliseconds(500));
    }
  }
  if(!p.value("combatAttempted",false)&&p.contains("entity_id")&&s.value("health",20.0)>=7){auto attempt=combat({{"entity_id",p["entity_id"]}});s=status(false);if(s.value("health",20.0)>=10&&kind=="combat")return attempt;}
  if(s.value("submerged",false)||s.value("in_water",false)){auto result=reachShore();return {{"survival",result},{"health",status(false).value("health",20.0)}};}
  if(s.value("in_water",false)||s.value("in_lava",false))api("posture",{{"jump",true},{"shield",false}});else if(shield)api("posture",{{"shield",true}});
  if(kind=="fall"||kind=="fire"){P feet=point(s["pos"]);if(count(inv,"water_bucket")&&dimension.find("nether")==std::string::npos){equip("water_bucket");P below=add(feet,{0,-1,0});if(support(block(below,true)))api("interact",{{"pos",jp(below)}});}}
  if(s.value("in_lava",false)||s.value("submerged",false)||s.value("on_fire",false)||s.value("health",20.0)<10){
    P feet=point(s["pos"]);std::vector<P> escapes;for(int r:{8,5,2})for(int dy:{0,1})for(auto v:dirs)escapes.push_back(add(feet,{v[0]*r,dy,v[2]*r}));bool escaped=false;
    for(P q:escapes){if(!stand(q))continue;bool lavaNear=false;for(auto v:dirs)if(name(block(add(q,v)))=="lava")lavaNear=true;if(lavaNear)continue;try{navigate(q);escaped=true;break;}catch(const Failure&e){if(e.code!="path_not_found"&&e.code!="navigation_failed")throw;}}
    if(!escaped&&s.value("in_lava",false))throw Failure("no_safe_escape","周围没有可验证的脱险落脚点");
  }
  auto result=maintain({{"eat",true}});s=status(false);
  if(s.value("health",20.0)<10&&s.value("food",20)>=18&&!protectedAt(point(s["pos"]))){
    auto material=filler();if(count(inventory(),material)<9)throw Failure("missing_item","低血避难需要至少9块可用方块，避免只封一半");
    P feet=point(s["pos"]);std::vector<P> opening;std::vector<P> wallDirs;
    auto nearby=api("getEntities",{{"radius",8},{"types",J::array({"hostile"})}});J enemy=nearby.value("entities",J::array()).empty()?J():nearby["entities"][0];
    P exitDir={0,0,1};if(!enemy.is_null()&&enemy.contains("pos")){P ep=point(enemy["pos"]);int dx=ep[0]-feet[0],dz=ep[2]-feet[2];exitDir=std::abs(dx)>std::abs(dz)?P{dx>0?-1:1,0,0}:P{0,0,dz>0?-1:1};}
    for(auto v:dirs)if(v!=exitDir)wallDirs.push_back(v);
    if(wallDirs.size()!=3)wallDirs={dirs[0],dirs[1],dirs[2]};
    for(auto v:wallDirs){P low=add(feet,v),high=add(low,{0,1,0});if(!air(block(low,true))||!air(block(high,true)))throw Failure("no_shelter_space","周围不具备封闭掩体空间");if(protectedAt(low)||protectedAt(high))throw Failure("protected_workarea","不在禁止施工的工作区搭建应急掩体");}
    P roof=add(feet,{0,2,0});if(!air(block(roof,true))||protectedAt(roof))throw Failure("no_shelter_space","头顶没有安全的掩体空间");
    for(auto v:wallDirs){P low=add(feet,v);place(low,material);place(add(low,{0,1,0}),material);}
    place(roof,material);api("posture",{{"shield",shield}});progress("shelter",{{"phase","regenerate"},{"health",s.value("health",0.0)},{"food",s.value("food",0)}});
    while((s=status(false)).value("health",20.0)<14){if(s.value("food",0)<10)throw Failure("no_food","掩体内饥饿值不足，停止等待并交还 Tac");std::this_thread::sleep_for(std::chrono::seconds(4));progress("shelter",{{"phase","regenerate"},{"health",s.value("health",0.0)},{"food",s.value("food",0)}});}
    P reopen=add(feet,exitDir);if(!air(block(reopen,true)))dig(reopen,true);api("posture",J::object());
  }
  api("posture",J::object());return {{"survival",result},{"health",status(false).value("health",20.0)}};
}
J Engine::maintain(const J& p){
  const bool wasRescue=rescue;struct Restore{bool& ref;bool value;~Restore(){ref=value;}} restore{rescue,wasRescue};rescue=true;auto s=status(false);auto inv=inventory();int eaten=0;
  // Recovered/spare armor sitting in a full inventory provides no defense.
  // Fill confirmed empty slots with the best available piece; never replace
  // worn equipment (especially enchanted gear) as routine bag maintenance.
  if(inv.contains("armor")&&inv["armor"].is_object())for(auto [part,slot]:std::vector<std::pair<std::string,std::string>>{{"helmet","head"},{"chestplate","chest"},{"leggings","legs"},{"boots","feet"}}){
    if(!inv["armor"].contains(slot)||!inv["armor"][slot].is_null())continue;
    for(auto tier:{"netherite","diamond","iron","chainmail","golden","leather"}){std::string item=std::string(tier)+"_"+part;if(count(inv,item)>0){equip(item,slot=="chest"?"torso":slot);inv=inventory();progress("armor_slot_filled",{{"item",item},{"slot",slot}});break;}}
  }
  // Some third-party servers acknowledge /use_item but never finish the
  // held-item animation.  A failed food call must not abort a long native
  // task and trigger Distribution to replay the same work every few seconds.
  // Keep a short persisted cooldown so the next resumed script can continue
  // moving/collecting while the server settles, then retry once naturally.
  const long long now=wallms();
  const long long foodCooldown=state.value("foodUseCooldownUntil",0LL);
  std::vector<std::string> foods={"cooked_beef","cooked_porkchop","cooked_mutton","cooked_chicken","cooked_salmon","cooked_cod","bread","baked_potato","apple","carrot"};
  if(p.value("emergencyFood",false))foods.push_back("rotten_flesh");
  if(now>=foodCooldown) for(const auto& food:foods)while(s.value("food",20)<18&&count(inv,food)>0){
    int before=s.value("food",20);
    const bool restoreShield=s.value("blocking",false);
    try {
      if(restoreShield)api("posture",{{"shield",false}});
      api("useItem",{{"item",food}});eaten++;s=status(false);
      if(s.value("food",20)<=before) throw Failure("no_progress","食用后饥饿值未变化");
      inv=inventory();
      if(restoreShield)api("posture",{{"shield",true}});
    } catch(const Failure& e) {
      if(restoreShield)try{api("posture",{{"shield",true}});}catch(...){}
      if(e.code!="timeout"&&e.code!="no_progress"&&e.code!="busy"&&e.code!="not_hungry") throw;
      state["foodUseCooldownUntil"]=wallms()+30000;save();
      progress("food_use_deferred",{{"item",food},{"code",e.code},{"message",e.what()},{"food",s.value("food",20)}, {"cooldownMs",30000}});
      break;
    } catch(...) {
      if(restoreShield)try{api("posture",{{"shield",true}});}catch(...){}
      throw;
    }
  }
  if(p.contains("home"))route({{"to",p["home"]}});
  // Durable native objectives can continue through a whole series of jobs
  // without asking an LLM to repeat per-block or per-recipe decisions.
  if(p.contains("jobs"))return run("workflow",{{"jobs",p["jobs"]}});
  return {{"eaten",eaten},{"health",s.value("health",20.0)},{"food",s.value("food",20)}};
}
J Engine::recover(const J& p){
  rescue=true;auto s=status(false);J death=p.value("death",state.value("death",J()));if(death.is_null()||!death.contains("pos"))return {{"recovered",false},{"reason","无已记录死亡坐标"}};
  if(death.value("dimension",dimension)!=dimension)throw Failure("dimension_mismatch","死亡地点跨维度，不自动进门");P q=point(death["pos"]);if(s.value("health",20.0)<10)maintain(J::object());
  approach(q);auto es=api("getEntities",{{"radius",10},{"types",J::array({"item"})}});int visited=0;for(auto e:es.value("entities",J::array()))if(e.contains("pos")){P at=point(e["pos"]);if(distance(at,q)>10||!stand(at))continue;navigate(at);visited++;}
  auto inv=inventory();for(auto pair:std::vector<std::pair<std::string,std::string>>{{"iron_helmet","head"},{"iron_chestplate","torso"},{"iron_leggings","legs"},{"iron_boots","feet"},{"shield","off-hand"}})if(count(inv,pair.first))equip(pair.first,pair.second);
  auto remaining=api("getEntities",{{"radius",10},{"types",J::array({"item"})}});bool pending=false;for(auto e:remaining.value("entities",J::array()))if(e.contains("pos")&&distance(point(e["pos"]),q)<=10)pending=true;if(!pending){state["death"]=nullptr;save();}return {{"recovered",!pending},{"visited",visited},{"inventory",inv}};
}
}
