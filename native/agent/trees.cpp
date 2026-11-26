#include "engine.hpp"
namespace mc {
void Engine::recoverTreePillar(){
  auto& tower=state["treePillar"];
  if(!tower.is_object()||!tower.value("active",false))return;
  auto s=status();P base=point(tower["base"]),feet=point(s["pos"]);
  if(tower.value("dimension",std::string())!=dimension)return;
  // Do not walk back onto a pillar after death/knockback. Keep its ledger
  // for inspection, but never mine remote blocks or the natural base floor.
  if(feet[0]!=base[0]||feet[2]!=base[2]||feet[1]<base[1]){
    tower["phase"]="abandoned";tower["active"]=false;save();return;
  }
  tower["phase"]="down";save();
  auto& placed=tower["placed"];
  while(placed.is_array()&&!placed.empty()){
    auto entry=placed.back();P q=point(entry["pos"]);s=status();feet=point(s["pos"]);
    if(q[0]!=base[0]||q[2]!=base[2]||q[1]<base[1])throw Failure("state_corrupt","树冠垫块记录不在原柱线上");
    auto b=block(q,true);
    // A pending placement can have succeeded before its response was lost.
    // Likewise, an interrupted descent can have already removed the block.
    if(air(b)){placed.erase(placed.size()-1);save();continue;}
    if(name(b)!=entry.value("item",std::string()))throw Failure("scaffold_changed","树冠垫块已被更改，保留记录，不挖未知支撑",{{"pos",jp(q)}});
    if(feet!=add(q,{0,1,0}))throw Failure("scaffold_position","拆柱前必须站在最上方已记录垫块上",{{"actual",s["pos"]},{"block",jp(q)}});
    P below=add(q,{0,-1,0});if(!support(block(below,true)))throw Failure("unsafe_navigation","拆柱下方支撑已消失，停止下降");
    // collect=false prevents the API pickup pathfinder from walking off the
    // column; drops are collected only after returning to the ground.
    if(entry.value("item",std::string())=="dirt")tool(true);else tool(false);
    dig(q,false,false,false);
    s=status();if(point(s["pos"])!=q&&!s.value("on_ground",true)){api("control",{{"ms",100}});s=status();}
    if(point(s["pos"])!=q)throw Failure("scaffold_position","拆柱后尚未落到下一层，保留下降进度");
    placed.erase(placed.size()-1);save();progress("tree_descend",{{"base",jp(base)},{"remainingLayers",placed.size()}});
  }
  tower["active"]=false;tower["phase"]="ground";save();
}
J Engine::harvestTrees(const J& p){
  std::vector<std::string> types={"oak_log","birch_log","spruce_log","jungle_log","acacia_log","dark_oak_log","mangrove_log","cherry_log","pale_oak_log"};
  if(p.contains("types"))types=p["types"].get<std::vector<std::string>>();
  if(types.empty()||types.size()>24)throw Failure("bad_args","砍树需要有效原木种类");
  for(auto type:types)if(!ends(type,"_log"))throw Failure("bad_args","砍树只接受原木");
  const int target=p.value("targetCount",32),radius=std::clamp(p.value("radius",24),4,48),explore=std::clamp(p.value("exploreSteps",6),0,16);
  if(target<1||target>256)throw Failure("bad_args","原木背包总目标须在1到256之间");
  auto isLog=[&](std::string n){return std::find(types.begin(),types.end(),n)!=types.end();};
  auto total=[&](){auto inv=inventory();if(inv.value("empty_slots",1)<=0)throw Failure("inventory_full","背包已满，保留未砍完的树");int n=0;for(auto type:types)n+=count(inv,type);return n;};
  // A server-confirmation miss can be caused by a moving target, a falling
  // player, or a protected/partially unloaded log. Treat that one log as
  // locally unavailable and continue with the rest of the connected tree;
  // /dig confirmation remains mandatory and the coordinate is recorded as
  // rejected for this harvest pass.
  auto localFailure=[](const Failure& e){return std::set<std::string>{"path_not_found","navigation_failed","unreachable","unsafe_navigation","unsafe_excavation","falling_block_risk","protected_workarea","out_of_reach","out_of_range","no_progress","dig_unconfirmed","dig_not_applied"}.count(e.code)>0;};
  int current=total(),initial=current,mined=0,trees=0,explored=0,scans=0,incomplete=0;
  auto collectWood=[&](){collectDrops({{"types",types},{"radius",6}});current=total();};
  P origin=point(status()["pos"]);std::set<P> rejected,visited{origin};
  auto& saved=state["treeHarvest"];
  bool active=saved.is_object()&&saved.value("active",false)&&saved.value("dimension",std::string())==dimension;
  std::set<P> connected;
  if(active)for(auto q:saved.value("connected",J::array()))connected.insert(point(q));
  P root=active?point(saved["root"]):origin;
  auto saveTree=[&](){J points=J::array();for(P q:connected)points.push_back(jp(q));saved={{"active",active},{"dimension",dimension},{"root",jp(root)},{"connected",points},{"updatedAt",wallms()}};save();};
  auto report=[&](std::string phase){progress(phase,{{"root",jp(root)},{"currentCount",current},{"targetCount",target},{"mined",mined},{"treesCompleted",trees},{"incompleteTrees",incomplete},{"workCompleted",std::max(0,current-initial)},{"workTotal",std::max(0,target-initial)},{"finishingTree",active&&current>=target},{"scanCount",scans}});};
  auto onPillar=[&](){auto& t=state["treePillar"];return t.is_object()&&t.value("active",false);};
  auto climbFor=[&](P targetBlock){
    auto live=status();P feet=point(live["pos"]);auto& tower=state["treePillar"];
    if(std::hypot(double(feet[0]-targetBlock[0]),double(feet[2]-targetBlock[2]))>3.0)return false;
    if(!onPillar()){
      if(!stand(feet))return false;
      // Center the body before jumping so placement cannot clip the edge.
      rawMove(feet);
      tower={{"active",true},{"dimension",dimension},{"base",jp(feet)},{"phase","up"},{"placed",J::array()}};save();
    }
    P base=point(tower["base"]);
    while(true){
      live=status();feet=point(live["pos"]);
      double reach=std::hypot(std::hypot(targetBlock[0]+.5-live["pos"][0].get<double>(),targetBlock[2]+.5-live["pos"][2].get<double>()),targetBlock[1]+.5-live["pos"][1].get<double>()-1.62);
      if(reach<=4.2)return true;
      if(feet[0]!=base[0]||feet[2]!=base[2]||feet[1]-base[1]>=24||targetBlock[1]<=feet[1])return false;
      for(int dy:{2,3}){
        P overhead=add(feet,{0,dy,0});auto b=block(overhead,true);
        if(air(b))continue;
        if((isLog(name(b))&&connected.count(overhead))||ends(name(b),"_leaves")){
          tool(true);dig(overhead,false,false,false);if(isLog(name(b)))mined++;
        }else return false;
      }
      std::string material=filler();
      if(protectedAt(feet)||!air(block(feet,true)))return false;
      safeStand(feet);
      api("control",{{"jump",true},{"ms",300}});auto airborne=status();
      if(airborne["pos"][1].get<double>()<feet[1]+.9)throw Failure("no_progress","树冠垫高跳跃不足，未放方块");
      tower["placed"].push_back({{"pos",jp(feet)},{"item",material},{"confirmed",false}});save();
      api("place",{{"item",material},{"pos",jp(feet)}});
      if(name(block(feet,true))!=material)throw Failure("place_not_applied","树冠垫块未确认，保留恢复记录");
      tower["placed"].back()["confirmed"]=true;save();
      auto landed=status();if(point(landed["pos"])!=add(feet,{0,1,0})&&!landed.value("on_ground",true)){api("control",{{"ms",100}});landed=status();}
      if(point(landed["pos"])!=add(feet,{0,1,0}))throw Failure("scaffold_position","未站上树冠垫块，保留恢复记录");
      report("tree_climb");
    }
  };
  std::vector<P> candidates;
  while(current<target||active){
    auto s=status();P feet=point(s["pos"]);
    // Keep a batch of the current tree's logs. Re-scan on exhaustion or after
    // four removals, rather than re-discovering and choosing a new tree per log.
    if(candidates.empty()){
      auto list=api("findBlocks",{{"types",types},{"radius",radius},{"limit",128}}).value("blocks",J::array());scans++;
      if(!list.is_array())throw Failure("protocol_error","砍树扫描未返回列表");
      std::map<P,std::string> logs;
      for(auto b:list)if(b.contains("pos")&&isLog(name(b))&&!protectedAt(point(b["pos"])))logs[point(b["pos"])]=name(b);
      if(!active){
        double nearest=1e9;bool found=false;
        for(auto entry:logs)if(!rejected.count(entry.first)&&distance(feet,entry.first)<nearest){root=entry.first;nearest=distance(feet,root);found=true;}
        if(found){connected.clear();connected.insert(root);active=true;}
      }
      if(active){
        // Include branch/diagonal connections, but keep the bounded tree
        // geometry; old mined trunk cells remain the connectivity backbone.
        bool changed=true;
        while(changed){changed=false;for(auto entry:logs){P q=entry.first;if(connected.count(q)||std::abs(q[0]-root[0])>6||std::abs(q[2]-root[2])>6||std::abs(q[1]-root[1])>24)continue;
          for(P known:connected)if(std::abs(q[0]-known[0])<=1&&std::abs(q[1]-known[1])<=1&&std::abs(q[2]-known[2])<=1){connected.insert(q);changed=true;break;}
        }}
        int blocked=0;for(auto entry:logs)if(connected.count(entry.first)){if(rejected.count(entry.first))blocked++;else candidates.push_back(entry.first);}
        if(candidates.empty()){
          recoverTreePillar();
          collectWood();
          if(blocked){incomplete++;progress("tree_unreachable",{{"root",jp(root)},{"remainingObserved",blocked},{"message","树冠仍有不可达原木，保留事实，不视为整树完成"}});}
          else trees++;
          active=false;saveTree();report("tree_finished");
          if(current>=target)break;
          continue;
        }
        saveTree();
      }
      if(candidates.empty()){
        if(explored++>=explore)throw Failure("resource_unavailable","附近没有可达树木",{{"currentCount",current},{"mined",mined},{"incompleteTrees",incomplete}});
        bool moved=false;
        for(P d:dirs){P q=add(feet,{d[0]*9,0,d[2]*9});if(visited.count(q)||distance(origin,q)>48)continue;visited.insert(q);if(!stand(q))continue;
          try{navigate(q);moved=true;break;}catch(const Failure&e){if(!localFailure(e))throw;}
        }
        if(!moved)throw Failure("resource_unavailable","没有可达树木或中距探索位置",{{"currentCount",current},{"mined",mined}});
        continue;
      }
      tool(true);
    }
    auto eyeDistance=[&](P q){return std::hypot(std::hypot(q[0]+0.5-s["pos"][0].get<double>(),q[2]+0.5-s["pos"][2].get<double>()),q[1]+0.5-s["pos"][1].get<double>()-1.62);};
    std::stable_sort(candidates.begin(),candidates.end(),[&](P a,P b){bool ar=eyeDistance(a)<=4.2,br=eyeDistance(b)<=4.2;if(ar!=br)return ar;if(ar&&a[1]!=b[1])return a[1]>b[1];return distance(feet,a)<distance(feet,b);});
    P q=candidates.front();candidates.erase(candidates.begin());
    try{
      if(!isLog(name(block(q,true))))continue;
      // Eye-to-block reach includes the upper trunk. The old feet-distance
      // 2.8 rule rejected normal birch crowns despite being in digging reach.
      if(eyeDistance(q)>4.2){
        if(onPillar()){
          if(!climbFor(q)){recoverTreePillar();approach(q);if(!climbFor(q))throw Failure("out_of_reach","当前柱线不能触及树枝");}
        }else{
          try{approach(q);}catch(const Failure&e){if(!localFailure(e))throw;}
          auto live=status();s=live;
          if(eyeDistance(q)>4.2&&!climbFor(q))throw Failure("out_of_reach","没有可垫高的树冠工作位置");
        }
      }
      if(mined%8==0)tool(true);
      if(!isLog(name(block(q,true)))){candidates.clear();continue;}
      dig(q,!onPillar(),false,false);mined++;current=total();
      // /dig collect can leave drops on ledges or at the old trunk. Only
      // supplement pickup when the bag did not grow, avoiding a detour per log.
      if(!onPillar()&&current<initial+mined&&mined%4==0)collectWood();
      report("tree_harvest");
      if(mined%4==0)candidates.clear();
    }catch(const Failure&e){if(!localFailure(e))throw;recoverTreePillar();rejected.insert(q);report("tree_local_obstacle");}
  }
  recoverTreePillar();active=false;saveTree();report("finished");
  return {{"currentCount",current},{"targetCount",target},{"mined",mined},{"treesCompleted",trees},{"incompleteTrees",incomplete},{"targetReached",current>=target}};
}
}
