#include "engine.hpp"
namespace mc {
Engine::Engine(const J& init):stateFile(init.value("stateFile",std::string())) {
  state={{"version",1},{"anchors",J::object()},{"routes",J::object()},{"workareas",J::array()},{"death",nullptr}};
  if(!stateFile.empty()){std::ifstream in(stateFile);if(in.good()){try{in>>state;}catch(...){throw Failure("state_corrupt","本地路线/工作区状态损坏，拒绝覆盖");}}}
  for(auto k:{"anchors","routes","facilityCache","deferredOres","caveSurveys","resourceSurveys"})if(!state.contains(k)||!state[k].is_object())state[k]=J::object();
  if(!state.contains("workareas"))state["workareas"]=J::array();
  if(!state.contains("workareaBuilds"))state["workareaBuilds"]=J::object();
  if(!state.contains("baseBuilds"))state["baseBuilds"]=J::object();
  if(init.contains("imports")&&state["anchors"].empty())for(auto it=init["imports"].begin();it!=init["imports"].end();++it){if(it.value().is_array())state["anchors"][it.key()]={{"pos",it.value()},{"dimension","overworld"}};}
}
J Engine::api(const std::string& method,J params){
  std::cout<<J({{"kind","api"},{"id",++sequence},{"method",method},{"params",params}}).dump()<<std::endl;
  std::string line;if(!std::getline(std::cin,line))throw Failure("cancelled","API 桥接已停止");
  auto r=J::parse(line);if(r.value("id",0)!=sequence)throw Failure("protocol_error","API 回包序号不符");
  if(!r.value("ok",false)){
    auto e=r.value("error",J::object());std::string message=e.value("message",std::string("API 请求失败"));
    // busy rejects the request before it executes. Wait for the previous
    // server action to release its lock, then retry this exact request.
    // No elapsed-time failure and no model round trip for an API lock.
    if(e.value("code",std::string())=="busy"&&method!="status"){
      progress("server_action_wait",{{"method",method},{"code","busy"}});
      while(true){auto pending=api("status");if(pending.contains("alive")&&!pending.value("alive",false))throw Failure("dead","等待服务端动作结束时角色死亡");if(pending.contains("ready")&&!pending.value("ready",true))throw Failure("not_ready","服务端角色暂不可操作");auto busy=pending.value("busy",J());if(busy.is_null()||busy==false||busy=="")break;std::this_thread::sleep_for(std::chrono::milliseconds(100));}
      progress("server_action_released",{{"method",method}});return api(method,params);
    }
    if(method=="dig"&&message.find("enchantments is not iterable")!=std::string::npos){
      if(digCompatibilityAttempted)throw Failure("api_compatibility_unresolved","第三方 /dig 附魔格式错误在兼容恢复后仍存在；停止同类操作，等待接口修复",{{"endpoint","/dig"},{"upstreamMessage",message},{"params",params},{"storage",state.value("apiCompatibility",J::object())}});
      digCompatibilityAttempted=true;
      try{recoverDigCompatibility();}catch(const Failure& recovery){if(recovery.code=="dead"||recovery.code=="survival_priority"||recovery.code=="cancelled")throw;throw Failure("api_compatibility_unresolved","第三方 /dig 附魔格式错误；无法安全暂存/更换工具，已停止重复挖掘",{{"endpoint","/dig"},{"upstreamMessage",message},{"recoveryCode",recovery.code},{"recoveryMessage",recovery.what()},{"storage",state.value("apiCompatibility",J::object())}});}
      progress("api_compatibility_recovered",{{"method",method},{"message","附魔装备已确认暂存，使用普通工具重试原挖掘一次"},{"storage",state.value("apiCompatibility",J::object())}});
      return api(method,params);
    }
    throw Failure(e.value("code",std::string("api_error")),message,e.value("details",J::object()));
  }
  if(method!="status"&&method!="inventory"&&method!="getBlock"&&method!="observeBlocks"&&method!="getEntities"&&method!="findBlocks"&&method!="windowView"){
    operations++;lastOp=method;lastParams=params;invalidate();
  }
  auto body=r.value("response",J::object());auto result=body.value("result",J::object());
  if(method=="dig"&&result.is_object()&&result.contains("tool")&&result["tool"].is_string()&&!preferredTool.empty()&&result["tool"]!=preferredTool&&!state.value("apiBehavior",J::object()).value("autoTool",false)){
    state["apiBehavior"]["autoTool"]=true;save();progress("api_tool_override",{{"requested",preferredTool},{"actual",result["tool"]},{"message","服务端挖掘会自动选工具；停止重复装备，不能宣称已强制使用低级镐"}});
  }
  return result;
}
void Engine::progress(std::string phase,J extra){extra["phase"]=phase;extra["operations"]=operations;extra["elapsedMs"]=clockms()-began;std::cout<<J({{"kind","progress"},{"progress",extra}}).dump()<<std::endl;}
J Engine::status(bool survival){
  auto s=api("status");if(!s.value("alive",false))throw Failure("dead","角色死亡，交由恢复程序");if(!s.value("ready",false))throw Failure("not_ready","角色暂不可操作");dimension=s.value("dimension",std::string("overworld"));
  if(!s.value("in_water",false)&&state.value("breathing",J::object()).value("holdingFloat",false)){api("posture",{{"jump",false}});state["breathing"]["holdingFloat"]=false;save();}
  if(!s.value("submerged",false)){auto& breathing=state["breathing"];if(!breathing.is_object())breathing=J::object();breathing["capacity"]=std::max(breathing.value("capacity",20),s.value("oxygen",20));breathing["lastAir"]={{"pos",s["pos"]},{"dimension",dimension}};}
  if(survival&&!rescue){
    if(s.value("in_lava",false)||s.value("on_fire",false)||(s.value("health",20.0)<6&&!healingDeferred(s,state.value("combat",J::object()))))throw Failure("survival_priority","危险状态，交给 Tac");
    // Entering water is handled inside the running native task, before air
    // becomes critical. Do not abandon the task or wait for another LLM call.
    if(s.value("submerged",false)||s.value("in_water",false)||(state.contains("shoreRecovery")&&state["shoreRecovery"].is_object()&&state["shoreRecovery"].value("active",false))){reachShore();s=status(false);if(s.value("in_water",false)||s.value("submerged",false))throw Failure("survival_priority","水域脱困尚未上岸，交给 Tac");}
  }
  return s;
}
J Engine::inventory(){return api("inventory");}
J Engine::block(P p,bool fresh){if(!fresh&&cache.count(p))return cache[p];return cache[p]=api("getBlock",{{"pos",jp(p)}});}
void Engine::observe(const std::vector<P>& points,bool fresh){J positions=J::array();std::set<P> seen;for(P p:points)if(seen.insert(p).second&&(fresh||!cache.count(p)))positions.push_back(jp(p));if(positions.empty())return;auto values=api("observeBlocks",{{"positions",positions}});if(!values.is_array()||values.size()!=positions.size())throw Failure("protocol_error","批量观察数量不符");for(size_t i=0;i<values.size();i++)cache[point(positions[i])]=values[i];}
void Engine::save(){if(stateFile.empty())return;state["updatedAt"]=wallms();std::filesystem::path path(stateFile);if(path.has_parent_path())std::filesystem::create_directories(path.parent_path());std::string temp=stateFile+".tmp";{std::ofstream out(temp);if(!out)throw Failure("state_write","无法保存本地坐标状态");out<<state.dump(2);out.flush();if(!out)throw Failure("state_write","本地状态写入失败");}if(std::filesystem::exists(path)){std::filesystem::copy_file(path,stateFile+".bak",std::filesystem::copy_options::overwrite_existing);std::filesystem::remove(path);}std::filesystem::rename(temp,path);}
bool Engine::protectedAt(P p){for(auto& a:state["workareas"]){if(a.value("dimension",std::string())!=dimension)continue;auto lo=point(a["min"]),hi=point(a["max"]);if(p[0]>=lo[0]&&p[0]<=hi[0]&&p[1]>=lo[1]&&p[1]<=hi[1]&&p[2]>=lo[2]&&p[2]<=hi[2])return true;}return false;}
bool Engine::stand(P p){observe({add(p,{0,-1,0}),p,add(p,{0,1,0})});return support(block(add(p,{0,-1,0})))&&passable(block(p))&&passable(block(add(p,{0,1,0})));}
void Engine::safeStand(P p){if(!stand(p))throw Failure("unsafe_navigation","落脚点必须有实体支撑及两格净空",{{"pos",jp(p)}});}
int Engine::count(const J& inv,const std::string& item){int n=0;std::set<int> slots;for(auto& a:inv.value("items",J::array())){if(name(a)==item){int slot=a.value("slot",-1);if(slot<0||slots.insert(slot).second)n+=a.value("count",1);}}for(auto key:{"held","offhand"})if(inv.contains(key)&&inv[key].is_object()&&name(inv[key])==item){int slot=inv[key].value("slot",-1);if(slot>=0&&slots.insert(slot).second)n+=inv[key].value("count",1);}return n;}
std::string Engine::filler(){auto inv=inventory();for(auto n:{"cobblestone","cobbled_deepslate","dirt","netherrack"})if(count(inv,n)>0)return n;throw Failure("missing_item","缺少可安全搭路的方块");}
void Engine::equip(std::string item,std::string slot){
  if(item.empty())throw Failure("bad_args","装备缺少物品名");
  if(!std::set<std::string>{"hand","off-hand","head","torso","legs","feet"}.count(slot))throw Failure("bad_args","装备栏位须为 hand/off-hand/head/torso/legs/feet");
  if(slot=="off-hand"&&(ends(item,"_sword")||ends(item,"_axe")||ends(item,"_pickaxe")||item=="bow"||item=="trident"||item=="mace"))throw Failure("invalid_equip_slot","武器/工具只能装备主手");
  auto matches=[&](const J& inv,const J& s){
    std::string key=slot=="hand"?"held":slot=="off-hand"?"offhand":"";
    if(!key.empty()){
      for(const auto* source:{&s,&inv})if(source->contains(key)&&(*source)[key].is_object()&&name((*source)[key])==item)return true;
      return false;
    }
    if(!inv.contains("armor")||!inv["armor"].is_object())return false;
    const auto& armor=inv["armor"];std::string armorSlot=slot=="torso"?"chest":slot;
    return armor.contains(armorSlot)&&armor[armorSlot].is_object()&&name(armor[armorSlot])==item;
  };
  auto s=status(false);
  if((slot=="hand"||slot=="off-hand")&&matches(J::object(),s))return;
  auto inv=inventory();
  // Worn armor is not in inventory.items. A repeated instruction is already
  // satisfied, rather than a missing-item failure requiring another LLM turn.
  if(matches(inv,s))return;
  if(count(inv,item)<1)throw Failure("missing_item","背包缺少装备 "+item);
  api("equip",{{"item",item},{"slot",slot}});
  auto now=status(false);
  if(!matches(J::object(),now)&&!matches(inventory(),now))throw Failure("equip_not_applied","装备后实际栏位不匹配",{{"item",item},{"slot",slot}});
}
void Engine::sweepVisibleOres(P around,std::vector<P>* harvested){
  if(sweepingOres)return;
  sweepingOres=true;
  try{
    static const J oreTypes=J::array({
      "coal_ore","deepslate_coal_ore","iron_ore","deepslate_iron_ore",
      "copper_ore","deepslate_copper_ore","gold_ore","deepslate_gold_ore",
      "redstone_ore","deepslate_redstone_ore","lapis_ore","deepslate_lapis_ore",
      "diamond_ore","deepslate_diamond_ore","emerald_ore","deepslate_emerald_ore",
      "nether_quartz_ore","nether_gold_ore"
    });
    auto before=status(false);P returnTo=point(before["pos"]);
    std::set<P> rejected;
    while(true){
      auto found=api("findBlocks",{{"types",oreTypes},{"radius",8},{"limit",128}});std::vector<P> candidates;std::map<P,std::string> resources;
      for(auto entry:found.value("blocks",J::array()))if(entry.contains("pos")){P q=point(entry["pos"]);auto key=dimension+":"+jp(q).dump();auto memo=state["deferredOres"].value(key,J::object());std::string reason=memo.value("reason",std::string());bool retryForTool=reason=="insufficient_tool_tier";if(distance(q,returnTo)<=8&&!rejected.count(q)&&!protectedAt(q)&&(!state["deferredOres"].contains(key)||retryForTool)){candidates.push_back(q);resources[q]=name(entry);}}
      auto rankingInventory=inventory();int xp=status().value("xp_level",30);
      std::stable_sort(candidates.begin(),candidates.end(),[&](P a,P b){double pa=orePriority(returnTo,a,resources[a],rankingInventory,xp),pb=orePriority(returnTo,b,resources[b],rankingInventory,xp);if(std::abs(pa-pb)>0.05)return pa>pb;return distance(a,returnTo)<distance(b,returnTo);});bool mined=false;
      for(P q:candidates){try{
        auto live=block(q,true);std::string ore=name(live);if(!ends(ore,"_ore")||!live.value("diggable",true)){rejected.insert(q);continue;}
        std::vector<P> neighbors;for(P d:std::array<P,6>{P{1,0,0},P{-1,0,0},P{0,1,0},P{0,-1,0},P{0,0,1},P{0,0,-1}})neighbors.push_back(add(q,d));observe(neighbors,true);
        bool exposed=false;for(P n:neighbors)if(air(block(n)))exposed=true;if(!exposed){rejected.insert(q);continue;}
        status();harvestOre(q);if(harvested)harvested->push_back(q);mined=true;rejected.clear();
        state["deferredOres"].erase(dimension+":"+jp(q).dump());save();progress("incidental_ore",{{"pos",jp(q)},{"block",ore},{"source",jp(around)}});break;
      }catch(const Failure& e){
        if(e.code=="dead"||e.code=="not_ready"||e.code=="survival_priority"||e.code=="cancelled")throw;
        if(e.code=="insufficient_tool_tier")deferOre(q,name(block(q)),e.details.value("requiredTier",3));
        else if(!std::set<std::string>{"path_not_found","navigation_failed","unreachable","no_path","stalled","unsafe_excavation","falling_block_risk","unsafe_navigation","protected_workarea","out_of_reach","out_of_range","not_visible","no_line_of_sight","dig_unconfirmed"}.count(e.code))throw;
        else {state["deferredOres"][dimension+":"+jp(q).dump()]={{"pos",jp(q)},{"dimension",dimension},{"type",name(block(q))},{"reason",e.code},{"observedAt",wallms()}};save();}
        rejected.insert(q);
      }}
      if(!mined)break;
    }
    auto afterSweep=point(status(false)["pos"]);
    if(afterSweep!=returnTo)restoreMiningPosition(returnTo);
  }catch(...){sweepingOres=false;throw;}
  sweepingOres=false;
}
void Engine::dig(P p,bool collect,bool workarea,bool sweep){
  if(protectedAt(p)&&!doorwayRepairs.count(p))throw Failure("protected_workarea","工作区禁止挖掘",{{"pos",jp(p)}});
  std::vector<P> checks{p,add(p,{0,1,0})};for(auto v:dirs)checks.push_back(add(p,v));observe(checks,true);auto b=block(p);if(air(b))return;
  if(name(b).empty()||important(b)||liquid(b)||!b.value("diggable",true)||(!terrain(b)&&name(b)!="obsidian"&&name(b)!="sugar_cane"&&!ends(name(b),"_log")&&!ends(name(b),"_stem")&&!ends(name(b),"_leaves")))throw Failure("unsafe_excavation","拒绝未知、重要或危险方块",{{"block",b},{"pos",jp(p)}});
  P roof=add(p,{0,1,0});auto above=block(roof);
  if(falling(above)){
    // Plan the whole reachable loose stack before touching its support.
    // Removing from the top avoids triggering a collapse onto the route.
    P feet=point(status()["pos"]),top=roof;std::vector<P> loose;
    while(falling(above)){
      if(distance(feet,top)>4.5||protectedAt(top)||!above.value("diggable",true))throw Failure("falling_block_risk","松散柱顶不可安全触及，保留支撑并选择其他路线",{{"pos",jp(p)},{"top",jp(top)}});
      loose.push_back(top);top=add(top,{0,1,0});above=block(top,true);
    }
    if(name(above).empty()||name(above)=="void_air"||liquid(above))throw Failure("unsafe_excavation","松散柱上方未知或有液体，保留整柱",{{"pos",jp(top)},{"block",above}});
    for(auto it=loose.rbegin();it!=loose.rend();++it){dig(*it,false,workarea,false);progress("clear_loose_roof",{{"pos",jp(*it)},{"supportedBlock",jp(p)}});}
    // Each API action invalidates cached geometry; recheck before the cut.
    observe(checks,true);above=block(roof);
    if(falling(above))throw Failure("falling_block_risk","松散柱发生变化，保留支撑",{{"pos",jp(p)}});
  }
  if(name(above).empty()||name(above)=="void_air"||liquid(above))throw Failure("unsafe_excavation","上方未知或有液体，不开挖",{{"pos",jp(roof)},{"block",above}});
  for(auto v:dirs){P q=add(p,v);auto side=block(q);if(name(side).empty()||liquid(side))throw Failure("unsafe_excavation","边界未知或有液体，不开挖",{{"pos",jp(p)},{"boundary",jp(q)},{"block",side}});}
  api("dig",{{"pos",jp(p)},{"collect",collect}});if(!air(block(p,true)))throw Failure("dig_not_applied","挖掘后方块仍在，停止重试",{{"pos",jp(p)}});blocksDug++;
  if(sweep&&!sweepingOres)sweepVisibleOres(p);
}
void Engine::place(P p,std::string item){
  auto s=status();if(p==point(s["pos"])||p==add(point(s["pos"]),{0,1,0}))throw Failure("occupied","不能放入人体空间");if(!air(block(p,true)))throw Failure("occupied","放置位置不为空气");if(count(inventory(),item)<1)throw Failure("missing_item","缺少放置材料 "+item);bool face=false;for(auto v:std::array<P,6>{P{1,0,0},P{-1,0,0},P{0,1,0},P{0,-1,0},P{0,0,1},P{0,0,-1}})if(support(block(add(p,v)))){face=true;break;}if(!face)throw Failure("no_support","没有实体附着面");
  try{api("place",{{"item",item},{"pos",jp(p)}});}
  catch(const Failure& e){
    if(e.code!="blocked_by_self")throw;
    // The server may move into the target during its own goNear. Step to
    // a verified adjacent standing cell, inside goNear's radius, then retry.
    bool placed=false;P feet=point(status()["pos"]);
    for(P d:dirs){P q=add(p,d);q[1]=feet[1];if(q==p||add(q,{0,1,0})==p||q==feet||distance(q,feet)>9||distance(q,p)>2.5||!stand(q))continue;
      try{rawMove(q);if(!air(block(p,true)))throw Failure("occupied","恢复放置时目标已被占用",{{"pos",jp(p)}});api("place",{{"item",item},{"pos",jp(p)}});placed=true;progress("placement_self_recovered",{{"pos",jp(p)},{"standAt",jp(q)}});break;}
      catch(const Failure& retry){if(!std::set<std::string>{"blocked_by_self","path_not_found","navigation_failed","unreachable","no_path","stalled"}.count(retry.code))throw;}
    }
    if(!placed)throw Failure("blocked_by_self",e.what(),{{"pos",jp(p)},{"item",item},{"recovery","no_reachable_adjacent_cell"}});
  }
  auto placedName=name(block(p,true));if(placedName!=item&&!(item=="torch"&&placedName=="wall_torch"))throw Failure("place_not_applied","放置后方块未确认");
}
void Engine::tool(bool wood,std::string resource){
  auto inv=inventory();std::string suffix=wood?"_axe":"_pickaxe";
  int required=1,available=0;
  if(resource=="obsidian")required=4;
  if(!wood&&(resource.find("iron_ore")!=std::string::npos||resource.find("copper_ore")!=std::string::npos||resource.find("lapis_ore")!=std::string::npos))required=2;
  if(!wood&&(resource.find("diamond_ore")!=std::string::npos||resource.find("gold_ore")!=std::string::npos||resource.find("redstone_ore")!=std::string::npos||resource.find("emerald_ore")!=std::string::npos))required=3;
  // A lone iron pick is the only way to harvest diamonds/redstone. Spend
  // renewable stone picks on ordinary rock before using that scarce reserve.
  std::vector<std::string> tiers={"netherite","diamond","iron","stone","wooden"};
  if(!wood&&required<=2&&count(inv,"iron_pickaxe")<=1)tiers={"netherite","diamond","stone","iron","wooden"};
  for(int pass=0;pass<2;pass++)for(const auto& tier:tiers){
    std::string item=tier+suffix;if(count(inv,item)<1)continue;
    int limit=std::string(tier)=="netherite"?2031:std::string(tier)=="diamond"?1561:std::string(tier)=="iron"?250:std::string(tier)=="stone"?131:59;
    int remaining=0;for(const auto& stack:inv.value("items",J::array()))if(name(stack)==item)remaining=std::max(remaining,limit-stack.value("durability_used",0));
    int level=std::string(tier)=="netherite"?5:std::string(tier)=="diamond"?4:std::string(tier)=="iron"?3:std::string(tier)=="stone"?2:1;
    if(remaining>0)available=std::max(available,level);
    if(!wood&&level<required)continue;
    if(remaining<=0||(pass==0&&remaining<=8))continue;
    preferredTool=item;if(!state.value("apiBehavior",J::object()).value("autoTool",false))equip(item);return;
  }
  if(!wood&&available>0&&available<required)throw Failure("insufficient_tool_tier","现有镐仍可挖普通岩石，但目标矿物要求更高级工具",{{"resource",resource},{"requiredTier",required},{"availableTier",available}});
  if(!wood)throw Failure("missing_tool","缺少可采集目标的镐");
}
void Engine::deferOre(P p,std::string resource,int requiredTier){
  auto& deferred=state["deferredOres"];if(!deferred.is_object())deferred=J::object();
  auto key=dimension+":"+jp(p).dump();
  if(!deferred.contains(key)||deferred[key].value("type",std::string())!=resource){
    if(deferred.size()>=128)deferred.erase(deferred.begin());
    deferred[key]={{"pos",jp(p)},{"dimension",dimension},{"type",resource},{"requiredTier",requiredTier},{"observedAt",wallms()}};save();
    progress("ore_deferred",{{"pos",jp(p)},{"block",resource},{"requiredTier",requiredTier},{"reason","工具等级不足，记坐标并继续普通探矿，不重复造同级镐"}});
  }
}
}
