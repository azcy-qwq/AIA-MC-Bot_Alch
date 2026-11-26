#include "engine.hpp"
namespace mc {
J Engine::reachShore(){
  const bool previous=rescue;struct Restore{bool& flag;bool value;~Restore(){flag=value;}} restore{rescue,previous};rescue=true;
  auto s=status(false);auto& recovery=state["shoreRecovery"];
  if(!recovery.is_object()||!recovery.value("active",false)||recovery.value("dimension",std::string())!=dimension)recovery={{"active",true},{"entry",s["pos"]},{"dimension",dimension},{"visited",J::object()},{"at",wallms()}};
  const P entry=point(recovery["entry"]);std::set<std::pair<P,P>> blocked;
  auto water=[](const J& b){auto n=name(b);return n=="water"||n=="flowing_water"||n=="bubble_column"||n=="seagrass"||n=="tall_seagrass"||n=="kelp"||n=="kelp_plant";};
  int legs=0;std::set<P> rejectedLandings;
  while(true){
    s=status(false);if(s.value("in_lava",false))throw Failure("survival_priority","寻找岸边途中遇到岩浆");
    if(s.value("submerged",false)){breathe();s=status(false);}
    P feet=point(s["pos"]);
    if(!s.value("in_water",false)&&stand(feet)){
      api("posture",{{"jump",false},{"sneak",false},{"shield",false}});
      if(!s.value("on_ground",false)){api("control",{{"sneak",true},{"ms",150},{"stop_on",J::array()}});continue;}
      recovery["active"]=false;recovery["landedAt"]=wallms();recovery["land"]=s["pos"];state["breathing"]["holdingFloat"]=false;
      state["anchors"]["最近上岸点"]={{"pos",jp(feet)},{"dimension",dimension},{"verifiedAt",wallms()}};save();
      progress("shore_reached",{{"pos",s["pos"]},{"legs",legs}});return {{"breathing",true},{"onLand",true},{"pos",s["pos"]},{"legs",legs}};
    }
    api("posture",{{"jump",true},{"sneak",false},{"shield",false}});state["breathing"]["holdingFloat"]=true;
    auto& visited=recovery["visited"];if(!visited.is_object())visited=J::object();visited[std::to_string(feet[0])+":"+std::to_string(feet[2])]=wallms();
    std::map<P,P> parent;std::set<P> seen{feet};std::vector<P> frontier{feet},swimCells{feet};P goal{},advance=feet;bool land=false;double best=-1e100;
    // Search observed swimming cells and actual supported dry land together.
    // A water-to-land route never goes through the floor-only walking A*.
    while(!frontier.empty()&&!land){
      std::map<P,P> sources;std::vector<P> cells,points;
      for(P from:frontier)for(P d:std::array<P,5>{P{1,0,0},P{-1,0,0},P{0,0,1},P{0,0,-1},P{0,0,0}})for(int dy:{0,1,-1}){P q=add(from,{d[0],dy,d[2]});if(seen.count(q)||sources.count(q)||blocked.count({from,q})||std::abs(q[0]-feet[0])+std::abs(q[2]-feet[2])>10||std::abs(q[1]-feet[1])>2)continue;sources[q]=from;cells.push_back(q);for(int y=-1;y<=1;y++)points.push_back(add(q,{0,y,0}));}
      if(cells.empty())break;observe(points);std::vector<P> next;
      for(P q:cells){seen.insert(q);bool dry=support(block(add(q,{0,-1,0})))&&air(block(q))&&air(block(add(q,{0,1,0})));
        bool swim=air(block(add(q,{0,1,0})))&&(water(block(q))||(air(block(q))&&water(block(add(q,{0,-1,0})))));
        if(!dry&&!swim)continue;parent[q]=sources[q];if(dry){goal=q;land=true;break;}next.push_back(q);swimCells.push_back(q);
        std::string key=std::to_string(q[0])+":"+std::to_string(q[2]);int horizontal=std::abs(q[0]-feet[0])+std::abs(q[2]-feet[2]);
        if(horizontal>=8&&!visited.contains(key)){double score=horizontal+std::hypot(double(q[0]-entry[0]),double(q[2]-entry[2]))*.25-std::abs(q[1]-feet[1])*.2;if(score>best){best=score;advance=q;}}
      }
      frontier=next;
    }
    if(!land){
      // A solid bank is useful support, not a reason to stay in the water.
      // Cut a one-cell landing with two-block clearance above the waterline,
      // keeping its floor intact. Ordinary excavation still enforces all
      // liquid boundaries: the lake-facing side must be air at cut height.
      struct Landing {P p;int cuts;double score;};std::vector<Landing> candidates;std::set<P> inspected;
      auto cuttable=[&](const J& b){return air(b)||(terrain(b)&&b.value("diggable",true)&&!important(b));};
      auto validLanding=[&](P q,bool fresh=false){
        P head=add(q,{0,1,0}),floor=add(q,{0,-1,0}),roof=add(q,{0,2,0});std::vector<P> checks{floor,q,head,roof};
        for(P r:{q,head})for(P d:dirs)checks.push_back(add(r,d));observe(checks,fresh);
        auto base=block(floor),top=block(roof);const auto baseName=name(base);
        if(!support(base)||water(base)||baseName=="magma_block"||baseName=="campfire"||baseName=="soul_campfire"||baseName=="cactus"||baseName=="powder_snow")return false;
        if(name(top).empty()||name(top)=="void_air"||falling(top)||liquid(top)||water(top))return false;
        for(P r:{q,head}){
          auto b=block(r);if(!cuttable(b)||(!air(b)&&protectedAt(r)))return false;
          for(P d:dirs){auto side=block(add(r,d));if(name(side).empty()||name(side)=="void_air"||liquid(side)||water(side))return false;}
        }
        return true;
      };
      std::vector<P> nearbyLandings,landingChecks;
      for(P from:swimCells)for(P d:dirs)for(int dy:{0,1}){
        if(std::abs(from[0]-feet[0])+std::abs(from[2]-feet[2])>1)continue;
        const int surface=from[1]+(water(block(from))?1:0);P q=add(from,{d[0],dy,d[2]});
        if(q[1]>surface||!inspected.insert(q).second||rejectedLandings.count(q)||distance(feet,add(q,{0,1,0}))>4.5)continue;
        nearbyLandings.push_back(q);for(int y=-1;y<=2;y++)landingChecks.push_back(add(q,{0,y,0}));
        for(P r:{q,add(q,{0,1,0})})for(P side:dirs)landingChecks.push_back(add(r,side));
      }
      observe(landingChecks,true);
      for(P q:nearbyLandings){
        if(!validLanding(q))continue;int cuts=!air(block(q))+!air(block(add(q,{0,1,0})));if(!cuts)continue;
        candidates.push_back({q,cuts,distance(feet,q)+cuts*.6+std::abs(q[1]-feet[1])*.4});
      }
      std::stable_sort(candidates.begin(),candidates.end(),[](const Landing&a,const Landing&b){return a.score<b.score;});bool opened=false;
      for(const auto& candidate:candidates){
        P q=candidate.p,head=add(q,{0,1,0});if(!validLanding(q,true))continue;
        recovery["status"]="excavating_landing";recovery["landingExcavation"]={{"target",jp(q)},{"floor",jp(add(q,{0,-1,0}))},{"startedAt",wallms()},{"complete",false}};save();
        progress("shore_landing_plan",{{"target",jp(q)},{"cuts",candidate.cuts},{"pos",s["pos"]}});
        auto cut=[&](P r){auto b=block(r,true);if(air(b))return;auto material=name(b);bool soft=std::set<std::string>{"dirt","grass_block","coarse_dirt","rooted_dirt","clay","sand","red_sand","gravel"}.count(material);if(!soft)tool(false,material);dig(r,true,false,false);progress("shore_landing_cut",{{"pos",jp(r)},{"target",jp(q)}});};
        try{
          try{cut(head);}catch(const Failure&e){if(!std::set<std::string>{"not_visible","no_line_of_sight"}.count(e.code))throw;cut(q);cut(head);}
          cut(q);if(!stand(q))throw Failure("unsafe_navigation","上岸落脚点开挖后仍未确认实体支撑和净空");
          recovery["landingExcavation"]["complete"]=true;recovery["landingExcavation"]["confirmedAt"]=wallms();save();
          blocked.clear();opened=true;progress("shore_landing_excavated",{{"target",jp(q)},{"floor",jp(add(q,{0,-1,0}))},{"pos",status(false)["pos"]}});break;
        }catch(const Failure&e){
          if(!std::set<std::string>{"missing_tool","insufficient_tool_tier","unsafe_excavation","falling_block_risk","out_of_reach","out_of_range","not_visible","no_line_of_sight","protected_workarea","dig_not_applied","unsafe_navigation"}.count(e.code))throw;
          rejectedLandings.insert(q);recovery["landingExcavation"]["error"]=e.code;save();progress("shore_landing_unavailable",{{"target",jp(q)},{"code",e.code}});
        }
      }
      if(opened)continue;
      if(advance==feet){recovery["status"]="blocked";recovery["lastPos"]=s["pos"];save();throw Failure("no_shore_route","没有可直接抵达或安全开凿的岸边落脚点，保持浮面并保留已查路线",{{"pos",s["pos"]},{"searchedCells",seen.size()},{"landingCandidates",candidates.size()}});}goal=advance;
    }
    std::vector<P> path;for(P q=goal;q!=feet;q=parent.at(q))path.push_back(q);std::reverse(path.begin(),path.end());
    P direction{};for(int a=0;a<3;a++)direction[a]=path.front()[a]-feet[a];size_t last=0;
    for(size_t i=1;i<path.size();i++){P d{};for(int a=0;a<3;a++)d[a]=path[i][a]-path[i-1][a];if(d!=direction||distance(feet,path[i])>8)break;last=i;}
    P target=path[last];recovery["target"]=jp(target);recovery["lastPos"]=s["pos"];recovery["status"]="swimming_to_shore";save();
    progress("shore_swim",{{"target",jp(target)},{"knownLand",land?jp(goal):J()},{"pos",s["pos"]}});
    while(true){
      auto before=status(false);if(before.value("submerged",false)){breathe();break;}
      P actual=point(before["pos"]);if(!before.value("in_water",false)&&stand(actual))break;
      double dx=target[0]+.5-before["pos"][0].get<double>(),dz=target[2]+.5-before["pos"][2].get<double>(),horizontal=std::hypot(dx,dz);
      const double tolerance=land&&target==goal?.18:.4;
      if(horizontal<tolerance&&before["pos"][1].get<double>()>=target[1]-.05)break;
      // An air-breathing eye can still leave the feet below the next swim
      // cell. A same-column upward leg needs an actual jump control too.
      api("control",{{"jump",true},{"forward",horizontal>=tolerance},{"yaw",std::atan2(-dx,-dz)},{"ms",std::clamp(int(horizontal/3.0*1000),150,900)},{"stop_on",J::array()}});
      auto after=status(false);double nextHorizontal=std::hypot(target[0]+.5-after["pos"][0].get<double>(),target[2]+.5-after["pos"][2].get<double>());
      const double rise=after["pos"][1].get<double>()-before["pos"][1].get<double>();
      progress("shore_moving",{{"target",jp(target)},{"pos",after["pos"]}});
      if(nextHorizontal>=horizontal-.03&&rise<.05){P first=path.front();if(actual==feet)blocked.insert({feet,first});else {P d{direction[0],0,direction[2]};blocked.insert({actual,add(actual,d)});}break;}
    }
    legs++;if(visited.size()>8192)visited.erase(visited.begin());
  }
}
}
