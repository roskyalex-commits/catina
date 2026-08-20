import { createClient } from "@supabase/supabase-js";
import { requireEnv } from "./load-env";
const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const admin = createClient(url, requireEnv("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const anon = createClient(url, requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"), { auth: { persistSession: false } });

async function main() {
  const { data: orgs } = await admin.from("orgs").select("id, name, slug");
  console.log("orgs:", JSON.stringify(orgs));
  const org = (orgs ?? [])[0] as { id: string; name: string } | undefined;
  if (!org) throw new Error("no orgs");

  const email = `viewer-${Date.now()}@example.test`;
  const password = `Test-${crypto.randomUUID()}`;
  const { data: user, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  await admin.from("memberships").insert({ org_id: org.id, user_id: user.user!.id, role: "owner" });

  const { data: signed, error: e2 } = await anon.auth.signInWithPassword({ email, password });
  if (e2) throw e2;

  const ref = new URL(url).hostname.split(".")[0];
  console.log("USERID:" + user.user!.id);
  console.log("ORGNAME:" + org.name);
  console.log("COOKIENAME:sb-" + ref + "-auth-token");
  console.log("COOKIEVALUE:base64-" + Buffer.from(JSON.stringify(signed.session)).toString("base64url"));
}
main();
