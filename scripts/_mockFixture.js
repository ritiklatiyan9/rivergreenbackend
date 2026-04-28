// Default mock device fixture: 5 users + 20 punches across today / yesterday.
// Returned via a factory so callers always get a fresh deep copy that
// they can mutate without affecting subsequent resets.

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};
const at = (date, h, m, s = 0) => {
  const d = new Date(date.getTime());
  d.setHours(h, m, s, 0);
  return d;
};

export const defaultFixture = () => {
  const today = startOfToday();
  const yesterday = new Date(today.getTime() - 86_400_000);

  const users = [
    { uid: 1, zktecoUserId: 1001, name: 'Alice Sharma', role: 0, password: '', cardNo: 0 },
    { uid: 2, zktecoUserId: 1002, name: 'Bob Verma',    role: 0, password: '', cardNo: 0 },
    { uid: 3, zktecoUserId: 1003, name: 'Carol Nair',   role: 0, password: '', cardNo: 0 },
    { uid: 4, zktecoUserId: 1004, name: 'Dev Mehta',    role: 0, password: '', cardNo: 0 },
    { uid: 5, zktecoUserId: 1005, name: 'Eva Patel',    role: 14, password: '', cardNo: 0 }, // role 14 = admin
  ];

  // 10 punches yesterday (in/out pairs for 5 users) + 10 today.
  const punches = [];
  let logId = 1;

  for (const day of [yesterday, today]) {
    for (const u of users) {
      const checkIn = at(day, 9, 5 + (u.uid % 5) * 3);   // staggered 9:05–9:17
      const checkOut = at(day, 18, 10 + (u.uid % 5) * 4); // staggered 18:10–18:26
      punches.push({
        logId: logId++,
        userSn: u.uid,
        zktecoUserId: u.zktecoUserId,
        time: checkIn,
        type: 0,
      });
      punches.push({
        logId: logId++,
        userSn: u.uid,
        zktecoUserId: u.zktecoUserId,
        time: checkOut,
        type: 1,
      });
    }
  }

  return { users, punches };
};
