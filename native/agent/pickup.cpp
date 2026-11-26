#include "engine.hpp"
namespace mc {
// Collection is part of the native job, not another Distribution request.
// Entity coordinates describe drops; only verified standing cells are walked.
J Engine::collectDrops(const J& p){
  int radius=std::clamp(p.value("radius",6),1,12),visited=0,skipped=0;
  std::set<std::string> wanted;
  if(p.contains("types")){
    if(!p["types"].is_array()||p["types"].size()>32)throw Failure("bad_args","拾取 types 须为物品名列表，最多32项");
    for(auto item:p["types"]){if(!item.is_string())throw Failure("bad_args","拾取物品名须为字符串");std::string n=item.get<std::string>();if(n.rfind("minecraft:",0)==0)n=n.substr(10);wanted.insert(n);}
  }
  auto itemName=[](const J& entity){
    auto raw=entity.value("item",J());std::string n=raw.is_string()?raw.get<std::string>():raw.is_object()?name(raw):std::string();
    if(n.rfind("minecraft:",0)==0)n=n.substr(10);
    auto x=n.rfind('x');if(x!=std::string::npos&&x+1<n.size()&&std::all_of(n.begin()+x+1,n.end(),[](unsigned char c){return std::isdigit(c);}))n=n.substr(0,x);
    while(!n.empty()&&std::isspace(static_cast<unsigned char>(n.back())))n.pop_back();return n;
  };
  auto sum=[&](const J& inv){int n=0;if(wanted.empty()){for(auto item:inv.value("items",J::array()))n+=item.value("count",0);}else for(auto type:wanted)n+=count(inv,type);return n;};
  auto s=status();P origin=point(s["pos"]);int before=sum(inventory());
  auto found=api("getEntities",{{"radius",radius},{"types",J::array({"item"})}});auto entities=found.value("entities",J::array());
  if(!entities.is_array())throw Failure("protocol_error","掉落物扫描没有返回实体列表");
  const bool openAccess=p.value("openAccess",false)&&p.contains("near");
  const P near=openAccess?point(p["near"]):origin;
  std::vector<P> drops;std::set<P> seen;
  for(auto entity:entities){if(!entity.contains("pos")||(!wanted.empty()&&!wanted.count(itemName(entity))))continue;P q=point(entity["pos"]);if(distance(q,origin)>radius+1||(openAccess&&distance(q,near)>3)||!seen.insert(q).second)continue;drops.push_back(q);}
  std::stable_sort(drops.begin(),drops.end(),[&](P a,P b){return std::abs(a[1]-origin[1])<std::abs(b[1]-origin[1])||(std::abs(a[1]-origin[1])==std::abs(b[1]-origin[1])&&distance(a,origin)<distance(b,origin));});
  auto walkToDrop=[&](P drop){
    std::vector<P> candidates{drop};
    if(!openAccess)for(auto d:dirs)candidates.push_back(add(drop,d));
    for(P q:candidates){
      if(!stand(q))continue;
      try{P now=point(status()["pos"]);if(distance(now,q)<=9.5)rawMove(q);else navigate(q,false);visited++;return true;}
      catch(const Failure&e){if(!std::set<std::string>{"path_not_found","navigation_failed","unreachable","no_path","stalled","unsafe_navigation","no_progress"}.count(e.code))throw;}
    }
    return false;
  };
  int cuts=0;
  for(P drop:drops){
    status();
    bool reached=walkToDrop(drop);
    if(openAccess&&sum(inventory())>before)break;
    if(openAccess&&!reached&&cuts<2){
      const P feet=point(status()["pos"]);
      const int dx=drop[0]-feet[0],dz=drop[2]-feet[2];
      if(drop[1]==feet[1]&&(dx==0||dz==0)&&std::abs(dx)+std::abs(dz)==2){
        const P front=add(feet,{dx/2,0,dz/2});
        const P head=add(front,{0,1,0});
        observe({front,head,add(front,{0,-1,0}),drop,add(drop,{0,1,0}),add(drop,{0,-1,0})},true);
        auto canClear=[&](P q){
          auto b=block(q);
          return passable(b)||(terrain(b)&&!falling(b)&&!ends(name(b),"_ore")&&b.value("diggable",true)&&!protectedAt(q));
        };
        const int needed=int(!passable(block(front)))+int(!passable(block(head)));
        if(needed>0&&cuts+needed<=2&&stand(drop)&&support(block(add(front,{0,-1,0})))&&canClear(front)&&canClear(head)){
          try{
            for(P q:{head,front}){
              auto b=block(q,true);
              if(passable(b))continue;
              if(!canClear(q))break;
              ++cuts;
              tool(false,name(b));dig(q,false,false,false);
              progress("ore_pickup_access_cut",{{"drop",jp(drop)},{"obstruction",jp(q)}});
            }
            if(stand(front))reached=walkToDrop(drop);
          }catch(const Failure& e){
            static const std::set<std::string> local={"unsafe_excavation","falling_block_risk","protected_workarea","out_of_reach","not_visible","no_line_of_sight","dig_unconfirmed","missing_tool","insufficient_tool_tier"};
            if(!local.count(e.code))throw;
          }
        }
      }
    }
    if(!reached)skipped++;
    if(openAccess&&sum(inventory())>before)break;
  }
  int gained=std::max(0,sum(inventory())-before);
  progress("collect_drops",{{"visited",visited},{"skipped",skipped},{"gained",gained}});
  return {{"visited",visited},{"skipped",skipped},{"gained",gained}};
}
}
