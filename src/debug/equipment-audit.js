// Local diagnostics only: never changes equipment, interrupts work or calls a model.
export function createEquipmentAudit(record) {
  let previous=null, signature=null;
  return snapshot => {
    if(!snapshot.inventory || !snapshot.status) return;
    const inventory=snapshot.inventory, slots=new Set(), owned={};
    for(const item of [...(inventory.items || []),inventory.held,inventory.offhand,...Object.values(inventory.armor || {})]) {
      if(!item?.name) continue;
      if(Number.isInteger(item.slot)) { if(slots.has(item.slot)) continue;slots.add(item.slot); }
      const name=item.name.replace(/^minecraft:/, "");
      if(!/_(helmet|chestplate|leggings|boots|pickaxe|sword)$/.test(name)) continue;
      owned[name]=(owned[name] || 0)+(item.count || 1);
    }
    const armor=Object.fromEntries(Object.entries(inventory.armor || {}).map(([slot,item]) => [slot,item?{name:item.name,slot:item.slot,...(Number.isFinite(item.durability_used)?{durability_used:item.durability_used}:{}),...(item.enchantments?{enchantments:item.enchantments}:{})}:null]));
    const equipment={armor,owned:Object.fromEntries(Object.entries(owned).sort(([a],[b])=>a.localeCompare(b)))};
    const next=JSON.stringify({owned:equipment.owned,armor:Object.fromEntries(Object.entries(armor).map(([slot,item])=>[slot,item?{...item,durability_used:Number.isFinite(item.durability_used)?Math.floor(item.durability_used/32):null}:null]))});
    if(next!==signature) record({at:Date.now(),observedAt:snapshot.observedAt,reason:signature===null?"worker-baseline":"equipment-changed",position:snapshot.status.pos,health:snapshot.status.health,equipment,previous});
    previous=equipment;signature=next;
  };
}
