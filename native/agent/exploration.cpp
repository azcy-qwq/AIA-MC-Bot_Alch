#include "engine.hpp"
namespace mc {
void Engine::exploreMiningCave(P checkpoint,J& detour,std::string source){
  if(exploringCave)return;
  if(!detour.is_object())detour=J::object();
  if(!detour.value("active",false)){
    bool opening=false;for(P d:dirs){P q=add(checkpoint,d);if(!recordedPassage(q)&&stand(q)){opening=true;break;}}
    if(!opening)return;
    std::string id=dimension+":"+jp(checkpoint).dump();
    for(auto it=state["caveSurveys"].begin();it!=state["caveSurveys"].end();++it){const auto& survey=it.value();if(survey.value("dimension",std::string())==dimension&&(survey.value("nodes",J::object()).contains(jp(checkpoint).dump())||survey.value("visitedCells",J::object()).contains(jp(checkpoint).dump()))){id=it.key();break;}}
    const auto old=state["caveSurveys"].value(id,J::object());if(old.value("status",std::string())=="surveyed_reachable_frontier")return;
    detour={{"active",true},{"caveId",id},{"checkpoint",jp(checkpoint)},{"source",source},{"at",wallms()}};save();
  }
  struct Restore{bool& flag;~Restore(){flag=false;}} restore{exploringCave};exploringCave=true;
  const P home=point(detour["checkpoint"]);const std::string caveId=detour["caveId"];
  while(true){
    progress("mining_cave_exploration",{{"source",source},{"caveId",caveId},{"checkpoint",jp(home)}});
    auto result=explore({{"mode","cave"},{"caveId",caveId},{"maxNodes",160}});detour["lastResult"]=result;save();
    if(result.value("warning",false))throw Failure(result.value("code",std::string("resource_unavailable")),"矿洞探索需补给，保留施工及矿洞进度",result);
    if(result.value("stopReason",std::string())!="node_batch_complete")break;
  }
  restoreMiningPosition(home);detour["active"]=false;detour["returnedAt"]=wallms();save();
  progress("mining_cave_returned",{{"source",source},{"caveId",caveId},{"checkpoint",jp(home)}});
}
J Engine::explore(const J& p){
  auto s=status();P feet=point(s["pos"]);const bool cave=p.value("mode",std::string("cave"))=="cave";int surfaceY=std::clamp(p.value("surfaceY",64),48,160);
  if(dimension!="overworld")throw Failure("unsafe_navigation","本轮探索仅限主世界");
  if(p.contains("entry")){navigate(point(p["entry"]),false);feet=point(status()["pos"]);}
  // Field tasks never create storage or deposit minerals. Only an explicit
  // workshop job may select a known base chest and transfer chosen items.
  auto prepareInventory=[&](){maintain({{"eat",true}});return tidyMiningInventory(inventory());};
  prepareInventory();
  if(!cave){
    // A dry, open shoreline at Y=63 is already a usable surface. Do not
    // staircase away from its cane just to reach the default Y=64.
    if(!p.contains("surfaceY")&&feet[1]>=48&&feet[1]<surfaceY){
      std::vector<P> sky;for(int dy=2;dy<=8;dy++)sky.push_back(add(feet,{0,dy,0}));observe(sky,true);
      bool open=stand(feet);for(P q:sky)if(!passable(block(q))&&!ends(name(block(q)),"_leaves"))open=false;
      if(open)surfaceY=feet[1];
    }
    // A surface job received while underground owns its access work. A bad
    // Distribution order must not turn cave corridors into a cane survey.
    P heading={1,0,0};
    if(p.contains("surfaceDirection")){std::string d=p.value("surfaceDirection",std::string("x"));if(d=="-x")heading={-1,0,0};else if(d=="z")heading={0,0,1};else if(d=="-z")heading={0,0,-1};else if(d!="x")throw Failure("bad_args","surfaceDirection 须为 x/-x/z/-z");}
    while(feet[1]<surfaceY){
      auto inv=tidyMiningInventory(inventory());inv=maintainMiningTools(inv);
      progress("surface_access",{{"targetY",surfaceY},{"pos",jp(feet)},{"surveyId",p.value("surveyId",std::string())}});
      // Facilities can occupy a previously chosen exit. Try the other
      // headings locally, preserving the same resource job and all progress.
      const P before=feet;bool advanced=false;J blocked=J::array();
      for(P direction:std::array<P,4>{heading,P{-heading[2],0,heading[0]},P{heading[2],0,-heading[0]},P{-heading[0],0,-heading[2]}}){
        P next=add(feet,{direction[0],1,direction[2]});std::vector<P> clearance{add(feet,{0,2,0})};for(int dy=0;dy<=2;dy++)clearance.push_back(add(next,{0,dy,0}));observe(clearance,true);
        bool safe=true;for(P q:clearance){auto b=block(q);if(!air(b)&&(!terrain(b)||important(b)||!b.value("diggable",true)||protectedAt(q))){safe=false;blocked.push_back({{"pos",jp(q)},{"block",name(b)}});break;}}
        if(!safe)continue;
        try{staircase(true,std::min(8,surfaceY-feet[1]),direction,"",true);heading=direction;advanced=true;break;}
        catch(const Failure&e){if(!std::set<std::string>{"unsafe_navigation","unsafe_excavation","falling_block_risk","protected_workarea","path_not_found","navigation_failed","unreachable","no_path","stalled","no_progress"}.count(e.code))throw;blocked.push_back({{"direction",jp(direction)},{"code",e.code}});feet=point(status()["pos"]);if(feet[1]>before[1]){heading=direction;advanced=true;break;}}
      }
      feet=point(status()["pos"]);if(!advanced||feet[1]<=before[1])throw Failure("surface_access_blocked","地表上行的四个方向均受阻，保留资源任务与出口检查点",{{"pos",jp(feet)},{"blocked",blocked}});
      if(heading!=P{1,0,0})progress("surface_access_turn",{{"direction",jp(heading)},{"pos",jp(feet)}});
    }
    std::vector<P> overhead;for(int dy=2;dy<=8;dy++)overhead.push_back(add(feet,{0,dy,0}));observe(overhead,true);
    // A canopy is normal above a surface landing, not a sealed cave roof.
    bool open=true;for(P q:overhead)if(!passable(block(q))&&!ends(name(block(q)),"_leaves"))open=false;
    if(!open)return {{"warning",true},{"code","surface_access_blocked"},{"message","已到目标地表高度，但上方仍封闭；保留上行路线，需要调整出口，未开始地表采集"},{"pos",jp(feet)},{"targetY",surfaceY}};
    state["anchors"]["地表采集出口"]={{"pos",jp(feet)},{"dimension",dimension},{"verifiedAt",wallms()},{"basis","target_height_and_open_column"}};save();
  }
  std::string id=p.value(cave?"caveId":"surveyId",std::string());
  if(id.empty())id=dimension+":"+jp(feet).dump();
  auto& surveys=state[cave?"caveSurveys":"resourceSurveys"];if(!surveys.is_object())surveys=J::object();
  // Old versions incorrectly started surface surveys underground. Preserve
  // those records for diagnosis, but never use their DFS stack to lead this
  // surface run back into the mine.
  if(!cave&&surveys.contains(id)&&surveys[id].value("entry",jp(feet))[1].get<int>()<surfaceY-4)id+=":surface";
  // Reuse a connected, physically reached node even if the caller renamed it.
  for(auto it=surveys.begin();it!=surveys.end();++it)if(it.value().value("dimension",std::string())==dimension&&(cave||point(it.value().value("entry",jp(feet)))[1]>=surfaceY-4)&&it.value().value("nodes",J::object()).contains(jp(feet).dump())){id=it.key();break;}
  auto& survey=surveys[id];if(!survey.is_object())survey={{"entry",jp(feet)},{"dimension",dimension},{"nodes",J::object()},{"visitedCells",J::object()},{"stack",J::array()},{"runs",J::array()},{"status","partial"}};
  auto& nodes=survey["nodes"];auto& visited=survey["visitedCells"];auto& stack=survey["stack"];
  if(stack.empty()||point(stack.back())!=feet)stack.push_back(jp(feet));
  if(!nodes.contains(jp(feet).dump()))nodes[jp(feet).dump()]={{"pos",jp(feet)},{"state","frontier"}};
  const int maxNodes=std::clamp(p.value("maxNodes",160),1,512);J goals=p.value("targets",J::array());
  for(auto g:goals)if(!g.contains("item")||g.value("count",0)<1||g.value("count",0)>512)throw Failure("bad_args","采集目标需要物品名与1到512总数");
  auto initial=inventory();const long long started=wallms();int added=0,mined=0;std::string reason="node_batch_complete";
  auto targetsMet=[&](const J& inv,const J& status){if(goals.empty()&&!p.contains("minXpLevel"))return false;for(auto g:goals)if(count(inv,g["item"])<g.value("count",1))return false;return status.value("xp_level",0)>=p.value("minXpLevel",0);};
  auto roomFor=[&](const J& inv,const std::string& item){if(inv.value("empty_slots",36)>0)return true;for(const auto& stack:inv.value("items",J::array()))if(name(stack)==item&&stack.value("count",64)<64)return true;return false;};
  auto recoverable=[](const Failure& e){return std::set<std::string>{"path_not_found","navigation_failed","unreachable","no_path","stalled","unsafe_navigation","unsafe_excavation","falling_block_risk","insufficient_tool_tier","out_of_reach","out_of_range","no_progress"}.count(e.code)>0;};
  while(added<maxNodes){
    s=status();feet=point(s["pos"]);auto inv=prepareInventory();
    if(targetsMet(inv,s)){reason="target_reached";break;}
    if(inv.value("empty_slots",36)<=0){bool capacity=false;for(auto g:goals)if(count(inv,g["item"])<g.value("count",1)&&roomFor(inv,g["item"]))capacity=true;if(cave)for(auto item:{"diamond","raw_iron","raw_gold","lapis_lazuli","redstone","coal"})if(roomFor(inv,item))capacity=true;if(!capacity){reason="inventory_full";break;}}
    if(cave){sweepVisibleOres(feet);illuminate(feet);}
    const auto nodeKey=jp(feet).dump();auto& node=nodes[nodeKey];if(!node.is_object())node={{"pos",jp(feet)},{"state","frontier"}};
    visited[nodeKey]=wallms();survey["lastPos"]=jp(feet);survey["updatedAt"]=wallms();save();
    if(!cave){
      auto gathered=gatherSurface(goals,survey);mined+=gathered.value("harvested",0);s=status();inv=inventory();
      if(targetsMet(inv,s)){reason="target_reached";break;}
      P reached=point(s["pos"]);
      if(reached!=feet){node["resourceVisits"].push_back({{"to",jp(reached)},{"at",wallms()}});if(stack.empty()||point(stack.back())!=reached)stack.push_back(jp(reached));added++;save();continue;}
    }
    // The shared sweep already handles ores. Obsidian is a separate goal.
    if(cave&&std::any_of(goals.begin(),goals.end(),[&](const J& goal){
      return goal["item"]=="obsidian"&&count(inv,"obsidian")<goal.value("count",1);
    })){
    inv=inventory();
    auto found=api("findBlocks",{{"types",J::array({"obsidian"})},{"radius",8},{"limit",48}});
    for(auto b:found.value("blocks",J::array())){
      if(!b.contains("pos"))continue;P q=point(b["pos"]);if(node.value("resourcesSkipped",J::object()).contains(jp(q).dump()))continue;auto live=block(q,true);if(air(live)||protectedAt(q))continue;
      if(name(live)!="obsidian"||!roomFor(inv,"obsidian"))continue;
      std::vector<P> adj;for(P d:std::array<P,6>{P{1,0,0},P{-1,0,0},P{0,1,0},P{0,-1,0},P{0,0,1},P{0,0,-1}})adj.push_back(add(q,d));observe(adj,true);
      bool exposed=false;for(P a:adj)if(air(block(a)))exposed=true;if(!exposed)continue;
      try{approach(q);tool(false,"obsidian");dig(q,true,false,false);mined++;restoreMiningPosition(feet);inv=inventory();}
      catch(const Failure& e){if(!recoverable(e))throw;node["resourcesSkipped"][jp(q).dump()]=e.code;if(point(status()["pos"])!=feet)navigate(feet,false);}
    }
    }
    s=status();inv=inventory();if(targetsMet(inv,s)){reason="target_reached";break;}
    // Scan each ray in order, choosing a 6–9 block destination where possible.
    // Every traversed cell is checked; no blind long-range A* or cliff drops.
    J candidates=J::array();std::vector<P> observations;
    for(P d:dirs)for(int r=1;r<=8;r++)for(int lateral=-1;lateral<=1;lateral++)for(int y=-2;y<=2;y++)observations.push_back(add(feet,{d[0]*r+d[2]*lateral,y,d[2]*r+d[0]*lateral}));
    observe(observations,true);
    for(P d:dirs){P last=feet;J trail=J::array();bool fresh=false;
      for(int r=1;r<=8;r++){bool reached=false;for(int dy:{0,1,-1}){P q{feet[0]+d[0]*r,last[1]+dy,feet[2]+d[2]*r};if(std::abs(q[1]-feet[1])>1||(!cave&&q[1]<surfaceY-4)||!stand(q))continue;
          // Adjacent liquid alone does not invalidate a dry walking cell.
          // stand(q) checks our actual body and support, not a buffer radius.
          last=q;trail.push_back(jp(q));fresh=fresh||!visited.contains(jp(q).dump());reached=true;break;}
        if(!reached)break;
      }
      if(last!=feet&&fresh&&!node.value("rejected",J::object()).contains(jp(last).dump()))candidates.push_back({{"pos",jp(last)},{"cells",trail}});
    }
    if(!cave){
      auto focus=[&](P q){double score=1e6;for(const auto& r:survey.value("resourceTargets",J::object()))if(r.value("status",std::string())=="deferred"||r.value("status",std::string())=="pending"){P target=point(r["target"]);if(distance(target,feet)<=24&&std::abs(target[1]-feet[1])<=3)score=std::min(score,distance(q,target));}return score;};
      std::stable_sort(candidates.begin(),candidates.end(),[&](const J&a,const J&b){return focus(point(a["pos"]))<focus(point(b["pos"]));});
    }
    node["frontier"]=candidates;node["scannedAt"]=wallms();node["state"]=candidates.empty()?"surveyed_local":"frontier";save();
    bool moved=false;
    for(auto candidate:candidates){P q=point(candidate["pos"]);try{
        // Retain side junctions crossed during a medium-distance move. A
        // visited walking cell is not the same as a fully explored branch.
        J junctions=J::array();P previous=feet;P forward{(q[0]>feet[0])-(q[0]<feet[0]),0,(q[2]>feet[2])-(q[2]<feet[2])};
        for(auto cell:candidate["cells"]){P c=point(cell);for(int sign:{-1,1}){P side{forward[2]*sign,0,forward[0]*sign};P sideCell=add(c,side);if(c!=q&&stand(sideCell)&&!visited.contains(jp(sideCell).dump())&&!stand(add(previous,side)))junctions.push_back(cell);}previous=c;}
        rawMove(q);for(auto cell:candidate["cells"])visited[cell.dump()]=wallms();node["edges"].push_back({{"to",jp(q)},{"cells",candidate["cells"]},{"observedAt",wallms()}});
        for(auto j:junctions){if(stack.empty()||stack.back()!=j)stack.push_back(j);if(!nodes.contains(j.dump()))nodes[j.dump()]={{"pos",j},{"state","unexplored_side_exit"}};}
        stack.push_back(jp(q));added++;moved=true;save();break;}
      catch(const Failure& e){if(!recoverable(e))throw;node["rejected"][jp(q).dump()]={{"code",e.code},{"at",wallms()}};P actual=point(status()["pos"]);if(actual!=feet){stack.push_back(jp(actual));added++;moved=true;progress("survey_partial_move",{{"from",jp(feet)},{"reached",jp(actual)},{"code",e.code}});}save();if(moved)break;}
    }
    if(!moved){
      node["state"]="surveyed_local";save();
      if(stack.size()<=1){reason="surveyed_reachable_frontier";survey["status"]="surveyed_reachable_frontier";break;}
      // Old revisions could record plants as a one-block-high floor, and
      // mobs can change route geometry. Retire only that failed DFS edge;
      // keep the survey and try the next reachable ancestor locally.
      stack.erase(stack.end()-1);bool returned=false;
      while(!stack.empty()){
        P parent=point(stack.back());
        try{if(!stand(parent))throw Failure("unsafe_navigation","历史探索落点已经失效");navigate(parent,false);returned=true;break;}
        catch(const Failure& e){if(!recoverable(e))throw;node["blockedReturns"][jp(parent).dump()]={{"code",e.code},{"at",wallms()}};progress("survey_backtrack_repaired",{{"surveyId",id},{"skipped",jp(parent)},{"code",e.code}});P actual=point(status()["pos"]);stack.erase(stack.end()-1);if(actual!=feet){stack.push_back(jp(actual));returned=true;break;}}
      }
      if(!returned){stack.push_back(jp(point(status()["pos"])));reason="surveyed_reachable_frontier";survey["status"]=reason;save();break;}save();
    }
    progress(cave?"explore_cave":"gather_resources",{{"surveyId",id},{"nodesVisited",visited.size()},{"newNodes",added},{"mined",mined},{"pos",status()["pos"]},{"frontier",candidates.size()},{"status","partial"}});
  }
  auto final=inventory();J gained=J::object();for(auto item:{"diamond","obsidian","raw_iron","lapis_lazuli","redstone","sugar_cane","leather"})gained[item]=count(final,item)-count(initial,item);
  J run={{"startedAt",started},{"endedAt",wallms()},{"durationMs",wallms()-started},{"gained",gained},{"newNodes",added},{"stopReason",reason}};
  survey["runs"].push_back(run);if(survey["runs"].size()>32)survey["runs"].erase(survey["runs"].begin());survey["lastPos"]=status()["pos"];survey["updatedAt"]=wallms();save();
  return {{"surveyId",id},{"stopReason",reason},{"status",survey.value("status",std::string("partial"))},{"gained",gained},{"nodesVisited",visited.size()},{"durationMs",wallms()-started},{"warning",reason=="inventory_full"},{"code",reason=="inventory_full"?"inventory_full":""}};
}
}
