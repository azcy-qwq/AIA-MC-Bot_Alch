#include "engine.hpp"
namespace mc {
J Engine::breathe(){
  const bool previous=rescue;struct Restore{bool& flag;bool value;~Restore(){flag=value;}} restore{rescue,previous};rescue=true;
  auto s=status(false);if(!s.value("submerged",false))return {{"breathing",true},{"pos",s["pos"]}};
  const J posture={{"jump",s.value("jumping",false)},{"sneak",s.value("sneaking",false)},{"shield",s.value("blocking",false)}};
  const P entry=point(s["pos"]);int swims=0;std::set<std::pair<P,P>> blocked;
  auto swimmable=[](const J& b){const auto n=name(b);return air(b)||n=="water"||n=="flowing_water"||n=="bubble_column"||n=="seagrass"||n=="tall_seagrass"||n=="kelp"||n=="kelp_plant";};
  auto clear=[&](P q){return swimmable(block(q))&&swimmable(block(add(q,{0,1,0})));};
  try{
    api("posture",{{"jump",true},{"sneak",false},{"shield",false}});
    while((s=status(false)).value("submerged",false)){
      P feet=point(s["pos"]);if(s.value("in_lava",false))throw Failure("survival_priority","换气途中遇到岩浆");
      if(distance(feet,entry)>24)throw Failure("no_air_route","已超出已验证的局部换气水域，保留入口坐标",{{"entry",jp(entry)},{"pos",s["pos"]}});
      observe({add(feet,{0,2,0})},true);
      P up=add(feet,{0,1,0});
      if(swimmable(block(add(feet,{0,2,0})))&&!blocked.count({feet,up})){
        const double old=s["pos"][1];api("control",{{"jump",true},{"ms",600}});auto after=status(false);swims++;
        if(!after.value("submerged",false))break;
        if(after["pos"][1].get<double>()>old+.05){progress("breathe_ascending",{{"pos",after["pos"]},{"oxygen",after.value("oxygen",0)}});continue;}
        blocked.insert({feet,up});
      }
      // The standing-cell pathfinder requires a floor and cannot find air
      // pockets over deep water. Search connected two-block swimming cells.
      // Search each breadth layer in one observation batch; never dig a roof
      // or assume an air block behind a solid wall is reachable.
      std::map<P,P> parent;std::set<P> seen{feet};std::vector<P> frontier{feet};P target{},ascent=feet;bool found=false;
      // The finite geometry below already bounds this search to at most
      // 85 horizontal cells x 8 heights. Counted rock boundaries must not
      // consume a smaller budget before a connected surface is reached.
      while(!frontier.empty()&&!found){
        std::vector<P> cells,points;std::map<P,P> sources;
        for(P from:frontier)for(P d:std::array<P,6>{P{0,1,0},P{1,0,0},P{-1,0,0},P{0,0,1},P{0,0,-1},P{0,-1,0}}){
          P q=add(from,d);if(seen.count(q)||sources.count(q)||blocked.count({from,q})||std::abs(q[0]-feet[0])+std::abs(q[2]-feet[2])>6||q[1]<feet[1]-1||q[1]>feet[1]+6)continue;
          sources[q]=from;cells.push_back(q);points.push_back(q);points.push_back(add(q,{0,1,0}));
        }
        if(cells.empty())break;observe(points);std::vector<P> next;
        for(P q:cells){seen.insert(q);if(!clear(q))continue;parent[q]=sources[q];if(q[1]>ascent[1])ascent=q;if(air(block(add(q,{0,1,0})))){target=q;found=true;break;}next.push_back(q);}
        frontier=next;
        auto current=status(false);if(!current.value("submerged",false)){found=true;target=feet;break;}
        // Persistent jump can lift us while observations are in flight. The
        // old graph is then stale, so plan from the actual column again.
        if(point(current["pos"])!=feet){found=true;target=feet;break;}
      }
      // A deeper pool may put its surface beyond one local scan. Reach the
      // highest connected swimming column first, then keep surfacing there.
      if(!found&&ascent[1]>feet[1]){target=ascent;found=true;progress("breathe_open_column",{{"target",jp(target)},{"pos",jp(feet)}});}
      if(!found)throw Failure("no_air_route","水上方封闭，局部连通水域内没有已验证的空气出口",{{"entry",jp(entry)},{"pos",s["pos"]},{"searchedCells",seen.size()}});
      if(target==feet)continue;
      std::vector<P> path;for(P q=target;q!=feet;q=parent.at(q))path.push_back(q);std::reverse(path.begin(),path.end());
      // /control only enables true keys; false does not clear a persistent
      // /posture jump. Release buoyancy before a route that may need a dive.
      api("posture",{{"jump",false},{"sneak",false},{"shield",false}});
      bool replan=false;
      for(P q:path){
        while(true){auto before=status(false);if(!before.value("submerged",false))break;P actual=point(before["pos"]);
          const double dx=q[0]+.5-before["pos"][0].get<double>(),dz=q[2]+.5-before["pos"][2].get<double>();
          const bool upward=q[1]>=parent.at(q)[1];
          const double actualY=before["pos"][1];
          if(actual[0]==q[0]&&actual[2]==q[2]&&((actual==q&&(upward||actualY<=q[1]+.2))||(upward&&actual[1]>=q[1]))&&std::hypot(dx,dz)<.45)break;
          if(std::abs(q[1]-actual[1])>1){replan=true;break;}
          J control={{"jump",q[1]>actual[1]},{"ms",300}};
          if(q[1]<actual[1]||(!upward&&actualY>q[1]+.2))control["sneak"]=true;
          else if(std::hypot(dx,dz)>.2){control["forward"]=true;control["yaw"]=std::atan2(-dx,-dz);control["ms"]=std::clamp(int(std::hypot(dx,dz)/2.5*1000),80,400);}
          api("control",control);swims++;auto after=status(false);
          double delta=0;for(int a=0;a<3;a++)delta+=std::pow(after["pos"][a].get<double>()-before["pos"][a].get<double>(),2);
          progress("breathe_air_route",{{"target",jp(target)},{"pos",after["pos"]},{"oxygen",after.value("oxygen",0)}});
          if(after.value("submerged",false)&&delta<.0025){blocked.insert({actual,q});replan=true;break;}
        }
        if(replan||!status(false).value("submerged",false))break;
      }
    }
    s=status(false);const bool holdFloat=s.value("in_water",false)&&!s.value("on_ground",false);
    api("posture",{{"jump",holdFloat},{"sneak",false},{"shield",false}});
    s=status(false);int capacity=state.value("breathing",J::object()).value("capacity",20),unchanged=0;
    while(!s.value("submerged",false)&&s.value("oxygen",capacity)<capacity*.9){int old=s.value("oxygen",0);std::this_thread::sleep_for(std::chrono::milliseconds(200));s=status(false);if(s.value("oxygen",0)<=old){if(++unchanged>=3)break;}else unchanged=0;}
    if(s.value("submerged",false))throw Failure("survival_priority","空气出口未能稳定停留，需要继续换气");
    state["breathing"]["holdingFloat"]=holdFloat;
    state["breathing"]["lastRecovery"]={{"entry",jp(entry)},{"air",s["pos"]},{"dimension",dimension},{"at",wallms()},{"swims",swims}};save();
    J restored=posture;if(holdFloat)restored["jump"]=true;
    api("posture",restored);progress("breathe_recovered",{{"entry",jp(entry)},{"pos",s["pos"]},{"oxygen",s.value("oxygen",0)},{"swims",swims}});
    return {{"breathing",true},{"pos",s["pos"]},{"oxygen",s.value("oxygen",0)},{"swims",swims}};
  }catch(...){try{J held=posture;if(s.value("in_water",false)){held["jump"]=true;held["sneak"]=false;held["shield"]=false;state["breathing"]["holdingFloat"]=true;save();}api("posture",held);}catch(...){}throw;}
}
}
