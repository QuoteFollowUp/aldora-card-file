// Nightly: add any new people reps logged calls with in the Call Log app.
import { syncFromCallLog } from "./api.mjs";

export default async () => {
  try { const r = await syncFromCallLog("Nightly Call Log sync"); console.log("Call Log sync", JSON.stringify(r)); }
  catch (e) { console.error("Call Log sync failed", e.message); }
};

// 4:15 AM Eastern (09:15 UTC), before reps start their day.
export const config = { schedule: "15 9 * * *" };
