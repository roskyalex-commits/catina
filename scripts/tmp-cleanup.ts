import { createClient } from "@supabase/supabase-js";
import { requireEnv } from "./load-env";
const admin = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const KEEP = process.argv[2] ?? "";
async function main() {
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 200 });
  if (error) throw error;
  const viewers = data.users.filter((u) => (u.email ?? "").startsWith("viewer-"));
  console.log(`${viewers.length} viewer accounts`);
  for (const u of viewers) {
    if (u.id === KEEP) { console.log(`  keep   ${u.email}`); continue; }
    await admin.from("memberships").delete().eq("user_id", u.id);
    await admin.auth.admin.deleteUser(u.id);
    console.log(`  delete ${u.email}`);
  }
}
main();
