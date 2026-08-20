import { createClient } from "@supabase/supabase-js";
import { requireEnv } from "./load-env";
const db = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const active = process.argv[2] === "on";
async function main() {
  const { data, error } = await db.from("agents")
    .update({ is_active: active })
    .eq("name", "Cluj software")
    .select("id, name, is_active, status");
  if (error) throw error;
  console.log(JSON.stringify(data));
  const { count } = await db.from("leads").select("id", { count: "exact", head: true });
  console.log("leads still present:", count);
}
main();
