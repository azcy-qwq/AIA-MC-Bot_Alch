#include "engine.hpp"
namespace mc {
void Engine::recoverOreScaffold(){
  auto& scaffold=state["oreScaffold"];if(!scaffold.is_object()||!scaffold.value("active",false)||scaffold.value("dimension",std::string())!=dimension)return;
  P base=point(scaffold["base"]),feet=point(status()["pos"]);
  if(feet[0]!=base[0]||feet[2]!=base[2]||feet[1]<base[1]){scaffold["active"]=false;scaffold["status"]="left_column";save();return;}
  auto& layers=scaffold["layers"];
  while(!layers.empty()){
    P q=point(layers.back()["pos"]);auto b=block(q,true);feet=point(status()["pos"]);
    if(air(b)){layers.erase(layers.end()-1);save();continue;}
    if(name(b)!=layers.back().value("item",std::string())||feet!=add(q,{0,1,0})||!support(block(add(q,{0,-1,0}),true)))throw Failure("unsafe_navigation","矿物垫柱实际状态改变，保留记录并停止拆柱");
    api("dig",{{"pos",jp(q)},{"collect",false}});if(!air(block(q,true)))throw Failure("dig_not_applied","矿物垫柱未确认拆除");
    for(int settle=0;settle<12&&point(status()["pos"])!=q;settle++)api("control",{{"sneak",true},{"ms",100}});
    if(point(status()["pos"])!=q)throw Failure("unsafe_navigation","矿物垫柱下降未落稳，保留进度");layers.erase(layers.end()-1);save();
  }
  scaffold["active"]=false;scaffold["status"]="recovered";save();
}
void Engine::harvestOre(P ore){
  // Exposure is not line of sight. Nearby air may lie on the far side of the
  // ore, while approach() accepts a close but occluded position.
  auto first=status();P origin=point(first["pos"]);int cuts=0;std::set<P> tried;
  progress("ore_candidate",{{"pos",jp(ore)},{"sameLevel",std::abs(ore[1]-origin[1])<=2}});
  bool triedVertical=false;
  const auto oreName=name(block(ore,true));
  std::string drop=oreName.rfind("deepslate_",0)==0?oreName.substr(10):oreName;
  static const std::map<std::string,std::string> drops={
    {"iron_ore","raw_iron"},{"gold_ore","raw_gold"},{"copper_ore","raw_copper"},
    {"lapis_ore","lapis_lazuli"},{"nether_quartz_ore","quartz"},{"nether_gold_ore","gold_nugget"}
  };
  if(drops.count(drop))drop=drops.at(drop);
  else if(ends(drop,"_ore"))drop.resize(drop.size()-4);
  const J pickup={{"types",J::array({drop,oreName})},{"radius",8},{"near",jp(ore)},{"openAccess",true}};
  const auto stock=[&](){auto inv=inventory();return count(inv,drop)+(drop==oreName?0:count(inv,oreName));};
  const int before=stock();
  while(true){
    try{
      approach(ore,true);
      tool(false,oreName);
      const bool scaffold=state["oreScaffold"].is_object()&&state["oreScaffold"].value("active",false);
      const P feet=point(status()["pos"]);
      const P floor=add(ore,{0,-1,0}),head=add(ore,{0,1,0});
      bool walkPickup=false;
      if(!scaffold&&feet[1]==ore[1]&&distance(feet,ore)==1){
        observe({floor,head});
        walkPickup=support(block(floor))&&passable(block(head));
      }
      dig(ore,!scaffold&&!walkPickup,false,false);
      if(walkPickup&&stand(ore)){
        try{rawMove(ore,true,feet);}
        catch(const Failure& e){
          if(!std::set<std::string>{"path_not_found","navigation_failed","unreachable","no_path","stalled"}.count(e.code))throw;
        }
      }
      recoverOreScaffold();
      break;
    }
    catch(const Failure& e){
      if(!std::set<std::string>{"out_of_reach","out_of_range","not_visible","no_line_of_sight","path_not_found","navigation_failed","unreachable","no_path","stalled","dig_unconfirmed"}.count(e.code))throw;
      if(air(block(ore,true))){recoverOreScaffold();break;}
      auto now=status();P feet=point(now["pos"]);bool repaired=false;
      // First prefer a different already safe face, without excavation.
      for(P d:dirs){P q=add(ore,d);q[1]=feet[1];if(tried.count(q)||distance(q,feet)>9||!stand(q))continue;tried.insert(q);
        try{rawMove(q);repaired=true;break;}catch(const Failure& nav){if(!std::set<std::string>{"path_not_found","navigation_failed","unreachable","no_path","stalled","unsafe_navigation"}.count(nav.code))throw;}
      }
      if(repaired)continue;
      if(!triedVertical&&ore[1]>feet[1]&&ore[1]-feet[1]<=8){
        triedVertical=true;
        // Align X/Z beside the ore at the current height first. Vertical
        // construction starts only from that verified standing column.
        for(P d:dirs){P base=add(ore,d);base[1]=feet[1];if(distance(base,feet)>9)continue;
          if(!stand(base))continue;
          try{navigate(base,false);auto& scaffold=state["oreScaffold"];scaffold={{"active",true},{"dimension",dimension},{"base",jp(base)},{"ore",jp(ore)},{"layers",J::array()},{"status","ascending"}};save();
            while(point(status()["pos"])[1]<ore[1]){P current=point(status()["pos"]),above=add(current,{0,2,0});auto b=block(above,true);
              if(!air(b)){if(!terrain(b)||important(b)||protectedAt(above)||falling(b))throw Failure("unsafe_excavation","抬高路径上方不适合安全开凿");tool(false,name(b));dig(above,false,false,false);}
              std::string material=filler();scaffold["layers"].push_back({{"pos",jp(current)},{"item",material}});save();pillar(1,material);
            }
            repaired=true;progress("ore_vertical_access",{{"ore",jp(ore)},{"horizontalAligned",jp(base)},{"pos",status()["pos"]}});break;
          }catch(const Failure& access){recoverOreScaffold();if(!std::set<std::string>{"path_not_found","navigation_failed","unreachable","no_path","stalled","unsafe_excavation","missing_item","no_headroom","no_progress"}.count(access.code))throw;}
        }
        if(repaired)continue;
      }
      // Only a short access cut near the current walking level. Never open
      // a blind shaft, remove our support, or tunnel through a protected base.
      if(cuts<3&&std::abs(ore[1]-feet[1])<=2&&distance(ore,feet)<=8){
        double eye[3]={now["pos"][0].get<double>(),now["pos"][1].get<double>()+1.62,now["pos"][2].get<double>()};
        std::set<P> ray;for(int i=1;i<=40;i++){P q{};for(int a=0;a<3;a++)q[a]=int(std::floor(eye[a]+(ore[a]+.5-eye[a])*i/40.0));if(q==ore)break;if(!ray.insert(q).second)continue;
          auto b=block(q,true);if(air(b))continue;
          if(q[1]<feet[1]||q==feet||q==add(feet,{0,1,0})||protectedAt(q)||important(b)||!terrain(b)||ends(name(b),"_ore")||falling(b)||distance(q,feet)>3.5)break;
          tool(false,name(b));dig(q,true,false,false);cuts++;repaired=true;progress("ore_access_cut",{{"ore",jp(ore)},{"obstruction",jp(q)},{"cuts",cuts}});break;
        }
      }
      if(repaired)continue;
      state["deferredOres"][dimension+":"+jp(ore).dump()]={{"pos",jp(ore)},{"dimension",dimension},{"type",name(block(ore))},{"reason",e.code},{"observedAt",wallms()},{"standAt",jp(feet)},{"accessCuts",cuts}};save();
      progress("ore_deferred",{{"pos",jp(ore)},{"reason",e.code},{"standAt",jp(feet)},{"accessCuts",cuts}});recoverOreScaffold();throw;
    }
  }
  int after=stock();
  if(after<=before){collectDrops(pickup);after=stock();}
  const auto key=dimension+":"+jp(ore).dump();
  state["deferredOres"].erase(key);
  if(after<=before){
    state["uncollectedOres"][key]={{"pos",jp(ore)},{"item",drop},{"observedAt",wallms()}};
    progress("ore_pickup_unconfirmed",{{"pos",jp(ore)},{"item",drop}});
  }else if(state.contains("uncollectedOres"))state["uncollectedOres"].erase(key);
  save();
}
}
