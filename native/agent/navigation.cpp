#include "engine.hpp"
namespace mc {
P Engine::rawMove(P p,bool requireStand,std::optional<P> knownOrigin){
  J origin=knownOrigin?J::array({(*knownOrigin)[0]+0.5,(*knownOrigin)[1],(*knownOrigin)[2]+0.5}):status()["pos"];
  const double actualDistance=std::hypot(origin[0].get<double>()-p[0]-0.5,origin[1].get<double>()-p[1],origin[2].get<double>()-p[2]-0.5);
  if(actualDistance>10.01)throw Failure("segment_too_long","单次移动目标不可超过10格");
  if(requireStand&&!knownOrigin)safeStand(p);
  progress("navigate",{{"target",jp(p)},{"segmentDistance",actualDistance}});
  // The public API's goNear short-circuits at range + 0.5. A positive
  // radius can accept the adjacent cell, which construction cannot use.
  // moveTo returns the authoritative final position; reuse it instead of
  // paying another status round trip between consecutive movement segments.
  auto moved=api("moveTo",{{"x",p[0]+0.5},{"y",p[1]},{"z",p[2]+0.5},{"range",0}});
  J reported=moved.value("result",moved), actualJson=reported.value("pos",J());
  auto s=actualJson.is_array()&&actualJson.size()==3?J{{"pos",actualJson}}:status();
  auto actual=point(s["pos"]);if(actual!=p)throw Failure("navigation_failed","移动后所在方块不符合当前段目标",{{"target",jp(p)},{"actual",s["pos"]}});
  if(requireStand&&!knownOrigin)safeStand(actual);
  // Downstairs has no support precondition. Record the reached cell only
  // after observing its actual support and clearance, so it can be reused.
  if(knownOrigin||requireStand||stand(actual)){auto& cells=state["traversedCells"];if(!cells.is_object())cells=J::object();if(cells.size()>=8192)cells.erase(cells.begin());cells[dimension+":"+jp(actual).dump()]=wallms();save();}
  return actual;
}
std::vector<P> Engine::localPath(P start,P goal){
  // Small fallback graph of observed, safe walking cells. HTTP A* remains the
  // normal pathfinder; never scan an unbounded world through individual RPCs.
  struct Node{double f;P p;bool operator<(const Node& n)const{return f>n.f;}};
  std::priority_queue<Node> open;std::map<P,double> costs;std::map<P,P> parent;costs[start]=0;open.push({distance(start,goal),start});int explored=0;
  while(!open.empty()&&explored++<48){P p=open.top().p;open.pop();if(p==goal){std::vector<P> out;while(p!=start){out.push_back(p);p=parent[p];}std::reverse(out.begin(),out.end());return out;}
    std::vector<P> next;for(auto v:dirs)next.push_back(add(p,v));std::sort(next.begin(),next.end(),[&](P a,P b){return distance(a,goal)<distance(b,goal);});
    std::vector<P> observations{add(p,{0,2,0})};
    for(P level:next)for(int y=-2;y<=2;y++)observations.push_back(add(level,{0,y,0}));
    observe(observations);
    for(P level:next)for(int dy:{0,1,-1}){P n=add(level,{0,dy,0});if(distance(n,start)>10||!stand(n)||(dy>0&&!passable(block(add(p,{0,2,0})))))continue;double cost=costs[p]+1+.4*std::abs(dy);if(!costs.count(n)||cost<costs[n]){costs[n]=cost;parent[n]=p;open.push({cost+distance(n,goal),n});}}
  }return {};
}
bool Engine::recordedPassage(P feet){
  if(state.value("traversedCells",J::object()).contains(dimension+":"+jp(feet).dump()))return true;
  auto onSegment=[&](const J& a,const J& b){if(!a.is_array()||!b.is_array())return false;P start=point(a),end=point(b);if(start[1]!=feet[1]||end[1]!=feet[1])return false;if(start[0]==end[0])return feet[0]==start[0]&&feet[2]>=std::min(start[2],end[2])&&feet[2]<=std::max(start[2],end[2]);if(start[2]==end[2])return feet[2]==start[2]&&feet[0]>=std::min(start[0],end[0])&&feet[0]<=std::max(start[0],end[0]);return false;};
  for(const auto& lane:state.value("fishboneRoutes",J::object())){
    // Selecting a new lane inserts a provisional null record before entry
    // checks. Failed selections can also leave such records on disk.
    if(!lane.is_object())continue;
    if(lane.value("dimension",std::string())!=dimension)continue;
    if(onSegment(lane.value("origin",J()),lane.value("end",J())))return true;
    for(const auto& branch:lane.value("branches",J::array()))if(onSegment(branch.value("hub",J()),branch.value("end",J())))return true;
  }
  return false;
}
bool Engine::exposedAhead(P next,P forward){
  P side={-forward[2],0,forward[0]};
  std::vector<P> adjacent;
  for(int sign:{-1,1}){P q=add(next,{side[0]*sign,0,side[2]*sign});adjacent.push_back(q);adjacent.push_back(add(q,{0,1,0}));}
  observe(adjacent,true);
  for(int sign:{-1,1}){
    P q=add(next,{side[0]*sign,0,side[2]*sign});
    if(air(block(q))&&air(block(add(q,{0,1,0})))){
      // A recorded crossing is a route, not evidence of a new cavern. Its
      // geometry must still be freshly valid; history alone never permits it.
      if(recordedPassage(q)&&support(block(add(q,{0,-1,0}),true)))continue;
      return true;
    }
  }
  return false;
}
void Engine::corridor(P target,std::string material,bool allowOpenSpace,bool sweep){
  P feet=point(status()["pos"]);if(feet[1]!=target[1])throw Failure("bad_args","水平施工前必须到同一高度");
  while(feet!=target){P v=std::abs(target[0]-feet[0])>=std::abs(target[2]-feet[2])?P{target[0]>feet[0]?1:-1,0,0}:P{0,0,target[2]>feet[2]?1:-1};P next=add(feet,v),floor=add(next,{0,-1,0});
    observe({floor,next,add(next,{0,1,0})},true);
    if(stand(next)){rawMove(next);feet=point(status()["pos"]);if(sweep)sweepVisibleOres(next);continue;}
    if(!allowOpenSpace&&exposedAhead(next,v))throw Failure("open_space_ahead","新开挖位置侧面连通到未确认的开放空间，记录边界并保留退路",{{"pos",jp(next)}});
    for(int dy=1;dy>=0;--dy){auto b=block(add(next,{0,dy,0}),true);if(!air(b)&&(!terrain(b)||important(b)))throw Failure("unsafe_navigation","通道有非天然障碍，停止施工");}
    if(!support(block(floor,true)))place(floor,material.empty()?filler():material);
    for(int dy=1;dy>=0;--dy)if(!air(block(add(next,{0,dy,0}),true))){P cell=add(next,{0,dy,0});auto obstacle=block(cell,true);tool(false,name(obstacle));dig(cell,ends(name(obstacle),"_ore"),false,false);}
    // Construction is necessarily cellwise. Batch movement across each newly
    // built straight stretch where reach allows; never fake long-reach digging.
    rawMove(next);feet=point(status()["pos"]);if(sweep)sweepVisibleOres(next);
  }
}
void Engine::navigate(P goal,bool construct){
  auto s=status();P start=point(s["pos"]);std::vector<P> recorded{start};
  // In an enclosed underground route, settle height before horizontal work.
  if(construct&&std::abs(start[1]-goal[1])>1&&!air(block(add(start,{0,4,0})))){
    while(start[1]!=goal[1]){P v=std::abs(goal[0]-start[0])>=std::abs(goal[2]-start[2])?P{goal[0]>=start[0]?1:-1,0,0}:P{0,0,goal[2]>=start[2]?1:-1};staircase(goal[1]>start[1],std::min(2,std::abs(goal[1]-start[1])),v);start=point(status()["pos"]);recorded.push_back(start);}
  }
  while(start!=goal){
    const P segmentStart=start;
    double dis=distance(start,goal);P wanted;
    for(int i=0;i<3;i++)wanted[i]=(int)std::lround(start[i]+(goal[i]-start[i])*std::min(1.0,9.0/dis));
    if(dis<=9.5)wanted=goal;
    while(distance(start,wanted)>10){for(int i=0;i<3;i++)if(wanted[i]!=start[i]){wanted[i]+=wanted[i]>start[i]?-1:1;break;}}
    // Equivalent destinations stay near the 10-block end point, not the bot.
    std::vector<P> candidates{wanted};for(int radius=1;radius<=2;radius++)for(int dy:{0,1,-1})for(auto v:dirs)candidates.push_back(add(wanted,{v[0]*radius,dy,v[2]*radius}));
    std::stable_sort(candidates.begin(),candidates.end(),[&](P a,P b){if(a==wanted)return b!=wanted;if(b==wanted)return false;auto score=[&](P p){return std::abs(p[1]-wanted[1])*4+std::abs(distance(start,p)-9.0);};return score(a)<score(b);});
    std::vector<P> landing;for(P p:candidates)if(distance(start,p)<=9.5&&distance(p,goal)<dis){landing.push_back(add(p,{0,-1,0}));landing.push_back(p);landing.push_back(add(p,{0,1,0}));}observe(landing);
    bool moved=false;P chosen=wanted;
    for(P p:candidates){if(distance(start,p)>9.5||distance(p,goal)>=distance(start,goal)||!stand(p))continue;chosen=p;try{start=rawMove(p,true,start);moved=true;break;}catch(const Failure& e){if(e.code!="path_not_found"&&e.code!="navigation_failed"&&e.code!="unreachable"&&e.code!="stalled"&&e.code!="no_path")throw;P actual=point(status()["pos"]);if(actual!=start){start=actual;moved=true;break;}break;}}
    if(!moved){
      if(construct){if(goal[1]!=start[1]){P v=std::abs(goal[0]-start[0])>=std::abs(goal[2]-start[2])?P{goal[0]>=start[0]?1:-1,0,0}:P{0,0,goal[2]>=start[2]?1:-1};staircase(goal[1]>start[1],std::min(2,std::abs(goal[1]-start[1])),v);}else corridor(wanted);}
      else {auto path=localPath(start,chosen);if(path.empty())throw Failure("path_not_found","中距移动无合法路线，需改变路线或允许最小施工",{{"target",jp(goal)},{"segment",jp(wanted)}});for(size_t i=0;i<path.size();){size_t j=i;while(j+1<path.size()&&distance(start,path[j+1])<=9.5)j++;start=rawMove(path[j],true,start);i=j+1;}}
    }
    // Construction fallbacks do not return a coordinate. They are rare and
    // may query status once; ordinary API movement stays on the response path.
    if(!moved&&construct)start=point(status()["pos"]);
    if(start==segmentStart&&!moved)throw Failure("no_progress","路径施工没有实际位移");
    if(distance(recorded.back(),start)>=5||start==goal)recorded.push_back(start);
  }
  J route=J::array();for(auto p:recorded)route.push_back(jp(p));state["routes"][dimension+":"+jp(recorded.front()).dump()+"=>"+jp(goal).dump()]={{"points",route},{"dimension",dimension},{"verifiedAt",wallms()}};save();
}
void Engine::staircase(bool up,int steps,P v,std::string material,bool allowOpenSpace){
  if(std::abs(v[0])+std::abs(v[2])!=1||v[1]!=0||steps<1||steps>64)throw Failure("bad_args","阶梯需水平轴方向与1到64级数量");
  const bool caveMode=!exploringCave&&hasIronArmor(inventory());
  if(caveMode&&state.contains("constructionCaveDetour")&&state["constructionCaveDetour"].is_object()&&state["constructionCaveDetour"].value("active",false))exploreMiningCave(point(state["constructionCaveDetour"]["checkpoint"]),state["constructionCaveDetour"],up?"staircase_up":"staircase_down");
  P feet=point(status()["pos"]),start=feet;
  int oresCollected=0,backfilled=0,lastScanStep=0;
  const int oreScanStride=3;
  if(caveMode)exploreMiningCave(feet,state["constructionCaveDetour"],up?"staircase_up":"staircase_down");
  for(int n=0;n<steps;n++){
    std::vector<P> harvested;
    if(n==0){sweepVisibleOres(feet,&harvested);feet=point(status()["pos"]);}
    const int dugBeforeStep=blocksDug;
    P next=add(feet,{v[0],up?1:-1,v[2]});P ground=add(next,{0,-1,0});
    if(up&&material.empty()&&!support(block(ground,true))){
      const std::array<P,4> candidates={v,P{-v[2],0,v[0]},P{v[2],0,-v[0]},P{-v[0],0,-v[2]}};
      bool foundNaturalStep=false;
      for(P heading:candidates){
        P candidate=add(feet,{heading[0],1,heading[2]}),candidateGround=add(candidate,{0,-1,0});
        std::vector<P> candidateClear={add(feet,{0,2,0}),candidate,add(candidate,{0,1,0}),add(candidate,{0,2,0})};
        std::vector<P> candidateChecks=candidateClear;candidateChecks.push_back(candidateGround);observe(candidateChecks,true);
        if(!support(block(candidateGround)))continue;
        bool safe=true;
        for(P cell:candidateClear){
          auto obstacle=block(cell);
          if(!air(obstacle)&&(important(obstacle)||liquid(obstacle)||!terrain(obstacle)||!obstacle.value("diggable",true)||protectedAt(cell))){safe=false;break;}
        }
        if(!safe)continue;
        v=heading;next=candidate;ground=candidateGround;start=feet;foundNaturalStep=true;
        progress("staircase_up_turn",{{"direction",jp(v)},{"pos",jp(feet)},{"message","原方向无自然台阶，已改沿有支撑的地形上挖"}});
        break;
      }
      if(!foundNaturalStep)throw Failure("natural_ascent_blocked","四个方向都没有可挖的天然上行台阶；停止采石搭脚手方块",{{"pos",jp(feet)},{"direction",jp(v)}});
    }
    std::vector<P> clear{add(feet,{0,2,0})};for(int dy=2;dy>=0;dy--)clear.push_back(add(next,{0,dy,0}));
    std::vector<P> landing=clear;landing.push_back(ground);observe(landing,true);
    bool existing=support(block(ground));for(P q:clear)if(!air(block(q)))existing=false;
    if(!existing&&!allowOpenSpace&&exposedAhead(next,v))throw Failure("open_space_ahead","阶梯下一高度的新开挖位置连通到未确认的开放空间，停止继续挖掘",{{"pos",jp(next)}});

    // Existing stairs are traversed in medium legs (six steps ~= 8.5 blocks),
    // with the same ore sweeps at both ends as freshly excavated stairs.
    if(existing){
      int leg=1;std::vector<P> ahead;
      for(int i=2;i<=std::min(6,steps-n);i++){P q=add(feet,{v[0]*i,(up?1:-1)*i,v[2]*i});for(int y=-1;y<=2;y++)ahead.push_back(add(q,{0,y,0}));}observe(ahead,true);
      for(int i=2;i<=std::min(6,steps-n);i++){P q=add(feet,{v[0]*i,(up?1:-1)*i,v[2]*i});if(!stand(q)||!air(block(add(q,{0,2,0}))))break;leg=i;}
      next=add(feet,{v[0]*leg,(up?1:-1)*leg,v[2]*leg});feet=rawMove(next,up);n+=leg-1;
    }else{
    for(P p:clear){auto b=block(p);if(!air(b)&&(!terrain(b)||important(b)||!b.value("diggable",true)||protectedAt(p)))throw Failure("unsafe_navigation","阶梯净空无法安全清理",{{"pos",jp(p)},{"block",b}});}
    if(up&&!support(block(ground,true))){
      if(material.empty())throw Failure("natural_ascent_blocked","上行楼梯没有天然支撑面；不为寻找垫脚石而中断当前路线",{{"pos",jp(feet)},{"target",jp(next)}});
      place(ground,material);
    }
    // Ordinary rubble is picked up while walking the new stair. API collect
    // performs its own pathfinding and can leave this step before it is ready.
    for(P p:clear){auto obstacle=block(p);if(!air(obstacle)){tool(false,name(obstacle));dig(p,false,false,false);}}
    feet=rawMove(next,up);
    }
    // Fresh cuts expose veins that were absent from the pre-cut scan. The
    // shared sweep repeatedly scans, repairs line of sight, and returns here.
    if(blocksDug>dugBeforeStep||n+1-lastScanStep>=oreScanStride||n+1==steps){
      sweepVisibleOres(feet,&harvested);
      lastScanStep=n+1;
    }
    oresCollected+=harvested.size();
    std::sort(harvested.begin(),harvested.end(),[&](P a,P b){return distance(a,feet)>distance(b,feet);});
    for(P q:harvested){
      const int along=(q[0]-start[0])*v[0]+(q[2]-start[2])*v[2];
      const bool onAxis=(q[0]-start[0])*v[2]-(q[2]-start[2])*v[0]==0;
      const int walkingY=start[1]+(up?along:-along);
      if(onAxis&&along>=0&&along<=steps&&q[1]>=walkingY&&q[1]<=walkingY+2)continue;
      if(protectedAt(q)||distance(q,feet)>4.5||!air(block(q,true)))continue;
      try{place(q,material.empty()?filler():material);backfilled++;}
      catch(const Failure&e){if(e.code=="dead"||e.code=="survival_priority"||e.code=="cancelled")throw;progress("stair_backfill_pending",{{"pos",jp(q)},{"code",e.code}});}
    }
    if(!harvested.empty())restoreMiningPosition(feet);
    if(caveMode)exploreMiningCave(feet,state["constructionCaveDetour"],up?"staircase_up":"staircase_down");
    progress(up?"staircase_up":"staircase_down",{{"completed",n+1},{"total",steps},{"pos",jp(feet)},{"oresCollected",oresCollected},{"backfilled",backfilled}});
  }
}
void Engine::bridge(P goal,std::string material){P feet=point(status()["pos"]);if(feet[1]!=goal[1])throw Failure("bad_args","水平搭路的目标须同高");api("posture",{{"sneak",true}});try{corridor(goal,material,true);}catch(...){try{api("posture",J::object());}catch(...){}throw;}api("posture",J::object());}
void Engine::pillar(int height,std::string material){if(height<1||height>32)throw Failure("bad_args","垫高范围1到32");for(int i=0;i<height;i++){auto s=status();P feet=point(s["pos"]);safeStand(feet);if(!air(block(add(feet,{0,2,0}),true)))throw Failure("no_headroom","垫高需要脚部到头顶三格净空");auto item=material.empty()?filler():material;if(count(inventory(),item)<1)throw Failure("missing_item","垫高材料不足");api("control",{{"jump",true},{"ms",300}});auto airborne=status();if(airborne["pos"][1].get<double>()<feet[1]+0.9)throw Failure("no_progress","跳跃高度不足，不放置脚下方块");api("place",{{"item",item},{"pos",jp(feet)}});if(!support(block(feet,true)))throw Failure("place_not_applied","垫高方块未被确认");auto landed=status();if(point(landed["pos"])[1]<feet[1]+1)throw Failure("navigation_failed","未站上垫高方块");progress("pillar",{{"completed",i+1},{"total",height}});}}
void Engine::restoreMiningPosition(P work){
  P feet=point(status()["pos"]),floor=add(work,{0,-1,0});
  if(distance(feet,work)<=4.5&&air(block(work,true))&&air(block(add(work,{0,1,0}),true))){
    // Incidental ore can be the old route floor. Restore it rather than
    // repeatedly searching for a path to an unsupported air cell above us.
    if(feet[0]==work[0]&&feet[2]==work[2]&&feet[1]<work[1]&&work[1]-feet[1]<=3){
      const int levels=work[1]-feet[1];bool usedRecess=false;
      for(int level=0;level<levels;level++){
        feet=point(status()["pos"]);P raised=add(feet,{0,1,0});
        try{pillar(1);}
        catch(const Failure& e){
          if(!std::set<std::string>{"no_progress","place_failed","blocked_by_self","place_not_applied","navigation_failed","no_headroom"}.count(e.code))throw;
          P actual=point(status()["pos"]);
          // A delayed reply can report failure after one level has already
          // succeeded. Commit that verified step instead of restarting it.
          if(actual==raised&&support(block(feet,true))&&stand(raised))continue;
          if(actual!=feet||!air(block(feet,true)))throw;
          bool restored=false;
          for(P d:dirs){
            P side=add(feet,d),above=add(side,{0,1,0}),head=add(side,{0,2,0});
            P recorded={side[0],work[1],side[2]};
            if(!recordedPassage(recorded))continue;
            observe({add(side,{0,-1,0}),side,above,head},true);
            if(!support(block(add(side,{0,-1,0}))))continue;
            bool clear=true;std::vector<P> refill;
            for(P q:{head,above,side}){auto b=block(q);if(!air(b)){if(protectedAt(q)||!terrain(b)||important(b)||!b.value("diggable",true)){clear=false;break;}refill.push_back(q);}}
            if(!clear)continue;
            for(P q:refill){tool(false,name(block(q)));dig(q,false,false,false);}
            rawMove(side);place(feet,filler());rawMove(raised);
            // Close the temporary recess from the bottom upwards, after
            // reaching the restored step. Preserve the recorded corridor.
            if(std::find(refill.begin(),refill.end(),side)==refill.end())refill.push_back(side);
            std::sort(refill.begin(),refill.end(),[](P a,P b){return a[1]<b[1];});
            for(P q:refill)if(q[1]<work[1]&&air(block(q,true)))try{place(q,filler());}catch(const Failure& r){if(r.code=="dead"||r.code=="survival_priority"||r.code=="cancelled")throw;progress("mining_floor_refill_warning",{{"pos",jp(q)},{"code",r.code}});}
            progress("mining_floor_restored",{{"returnTo",jp(work)},{"method","side_step"},{"recess",jp(side)},{"step",jp(raised)}});usedRecess=true;restored=true;break;
          }
          if(!restored)throw;
        }
        if(point(status()["pos"])!=raised||!stand(raised))throw Failure("navigation_failed","矿坑回升后落脚未确认",{{"returnTo",jp(work)},{"step",jp(raised)}});
      }
      progress("mining_floor_restored",{{"returnTo",jp(work)},{"method",usedRecess?"recovered_steps":"pillar"},{"levels",levels}});
    }else if(air(block(floor,true))&&floor!=feet&&floor!=add(feet,{0,1,0})){
      place(floor,filler());progress("mining_floor_restored",{{"returnTo",jp(work)},{"pos",jp(floor)},{"method","backfill"}});
    }
  }
  if(point(status()["pos"])!=work)navigate(work,false);
  safeStand(work);
}
void Engine::approach(P p,bool localOnly){
  auto s=status();P feet=point(s["pos"]);if(distance(feet,p)<=2.8)return;
  std::vector<P> candidates;for(int radius:{1,2})for(int dy:{0,1,-1})for(auto v:dirs)candidates.push_back(add(p,{v[0]*radius,dy,v[2]*radius}));
  std::stable_sort(candidates.begin(),candidates.end(),[&](P a,P b){return std::abs(a[1]-feet[1])<std::abs(b[1]-feet[1])||(std::abs(a[1]-feet[1])==std::abs(b[1]-feet[1])&&distance(a,feet)<distance(b,feet));});
  if(localOnly){
    std::vector<P> observations;
    for(P q:candidates)if(distance(q,feet)<=8.5){
      observations.push_back(add(q,{0,-1,0}));
      observations.push_back(q);
      observations.push_back(add(q,{0,1,0}));
    }
    observe(observations);
  }
  J failures=J::array();
  for(P q:candidates){
    if(localOnly&&(distance(q,feet)>8.5||failures.size()>=3))continue;
    if(!stand(q))continue;
    try{if(localOnly)rawMove(q);else navigate(q,false);return;}
    catch(const Failure&e){
      if(!std::set<std::string>{"path_not_found","navigation_failed","unreachable","no_path","stalled","unsafe_navigation","no_progress"}.count(e.code))throw;
      failures.push_back({{"pos",jp(q)},{"code",e.code}});
      progress("approach_alternative",{{"target",jp(p)},{"failedLanding",jp(q)},{"code",e.code}});
      if(localOnly)feet=point(status()["pos"]);
    }
  }
  throw Failure("unreachable","目标旁没有可达交互位置；已尝试同层优先的替代落点",{{"target",jp(p)},{"attempts",failures}});
}
J Engine::anchor(const J& p){auto s=status();std::string label=p.value("name",std::string());if(label.empty())throw Failure("bad_args","锚点需要名称");P pos=p.contains("pos")?point(p["pos"]):point(s["pos"]);safeStand(pos);state["anchors"][label]={{"pos",jp(pos)},{"dimension",dimension},{"verifiedAt",wallms()}};save();return state["anchors"][label];}
J Engine::route(const J& p){auto s=status();P goal;if(p.contains("to")){std::string to=p["to"];if(!state["anchors"].contains(to))throw Failure("unknown_anchor","未知锚点 "+to);auto a=state["anchors"][to];if(a.value("dimension",std::string())!=dimension)throw Failure("dimension_mismatch","锚点不在当前维度");goal=point(a["pos"]);}else goal=point(p.at("target"));
  // Reuse verified successful medium-range segments, rechecking each landing.
  P start=point(s["pos"]);auto key=dimension+":"+jp(start).dump()+"=>"+jp(goal).dump();bool cached=false;
  if(state["routes"].contains(key)){try{for(auto& pos:state["routes"][key]["points"]){P q=point(pos);P current=point(status()["pos"]);if(q==current)continue;if(distance(current,q)>10.01)throw Failure("route_invalid","缓存段过长");rawMove(q);}cached=true;}catch(const Failure& e){if(e.code=="dead"||e.code=="survival_priority")throw;state["routes"].erase(key);save();}}
  if(!cached)navigate(goal,p.value("construct",false));return {{"reached",true},{"pos",jp(point(status()["pos"]))},{"cached",cached}};
}
}
