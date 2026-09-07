// Device counters can reset and delayed punches can have older timestamps.
// The durable journal, rather than a high-water counter, decides what is new.
export function pendingPunches(punches, userMap, recorded, unmapped) {
  const known = new Set(recorded.map(r => `${r.user_id}:${new Date(r.punch_time).getTime()}`));
  const unknown = new Set(unmapped.map(r => `${Number(r.zkteco_user_id)}:${new Date(r.punch_time).getTime()}`));
  return punches.filter(p => {
    const user = userMap.get(p.zktecoUserId);
    const key = `${user?.id ?? p.zktecoUserId}:${p.time.getTime()}`;
    return !(user ? known : unknown).has(key);
  });
}
