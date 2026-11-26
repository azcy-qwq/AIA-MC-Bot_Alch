// Serialize priorities chosen by C++. This layer does not decide game tactics.
export class NativeTacResponder {
  constructor({executor,events,canRun=()=>true,isAlive=()=>true,onBusy=()=>{},onDecision=()=>{}}) {
    Object.assign(this,{executor,events,canRun,isAlive,onBusy,onDecision});
    this.busy=false;this.current=null;this.pending=null;this.preempting=null;this.running=null;this.awaitingSafe=false;this.completedKey=null;
  }
  priority(decision) {return Number(decision?.priority)||(decision?.kind==="combat"?30:80);}
  decisionKey(decision) {
    const kind=String(decision?.kind||"");
    return `${kind}:${kind==="combat"?decision?.params?.entity_id??"":""}`;
  }
  submit(decision) {
    if(!decision||!this.canRun())return;
    if(!decision.urgent){
      if(decision.safe===true&&this.isAlive())this.completedKey=null;
      // Only an explicit native safe assessment can release a failed rescue.
      // Missing/unready observations are not evidence that protection worked.
      if(!this.busy&&this.awaitingSafe&&decision.safe===true&&this.isAlive()){
        this.awaitingSafe=false;this.onBusy(false);this.executor.resume();
        this.events.emit("tac-protection-cleared",{});this.events.emit("tac-idle",{});
      }
      return;
    }
    if(!this.busy&&decision.kind!=="combat"&&this.completedKey===this.decisionKey(decision))return;
    if(this.busy) {
      const barrier=Math.max(this.priority(this.current),this.pending?this.priority(this.pending):0);
      if(this.priority(decision)<=barrier)return;
      this.pending=decision;
      this.events.emit("tac-preempt",{at:Date.now(),from:this.current?.kind,to:decision.kind,priority:this.priority(decision)});
      if(this.executor.running?.source==="tac"&&!this.preempting) {
        this.preempting=this.executor.interrupt({resume:false}).catch(error=>this.events.emit("runtime-warning",{type:"tac-preempt",error:{message:error.message,code:error.code}}));
      }
      return this.running;
    }
    this.busy=true;this.current=decision;this.awaitingSafe=false;this.onBusy(true);
    this.running=(async()=>{
      // Preserve the original native objective and all its dependent work once.
      await this.executor.interrupt({resume:true});
      while(this.current&&this.canRun()&&this.isAlive()) {
        if(this.pending&&this.priority(this.pending)>this.priority(this.current)){this.current=this.pending;this.pending=null;}
        const active=this.current;
        const type = active.kind === "combat" ? "jump_attack" : "survive";
        this.onDecision(active);
        this.events.emit("emergency",{kind:active.kind,priority:this.priority(active),actions:[{type}]});
        const completion=await this.executor.priority({type,params:active.params||{kind:active.kind}},"tac");
        if(this.preempting){await this.preempting;this.preempting=null;}
        const failure=completion?.error||completion?.warning||completion?.outcome?.result?.warning;
        if(failure&&!(completion?.error?.code==="cancelled"&&this.pending)){
          this.completedKey=null;
          this.awaitingSafe=true;
          this.events.emit("tac-protection-blocked",{kind:active.kind,error:completion?.error,warning:completion?.warning});
        }else {
          const healingDeferred=completion?.outcome?.result?.stopReason==="regeneration_unavailable";
          this.completedKey=active.kind==="combat"||healingDeferred?null:this.decisionKey(active);
          this.awaitingSafe=false;
        }
        this.current=this.pending;this.pending=null;
      }
    })().catch(error=>{this.awaitingSafe=true;this.events.emit("runtime-warning",{type:"tac",error:{message:error.message,code:error.code}});}).finally(()=>{
      this.current=null;this.pending=null;this.preempting=null;this.busy=false;this.onBusy(this.awaitingSafe);
      if(!this.awaitingSafe&&this.canRun()&&this.isAlive()){this.executor.resume();this.events.emit("tac-idle",{});}
    });
    return this.running;
  }
}
