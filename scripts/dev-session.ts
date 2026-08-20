/**
 * A browser session for looking at real data in development.
 *
 *   npm run dev:session              # mint one, print the cookie to paste
 *   npm run dev:session -- --cleanup # delete every account this ever made
 *
 * The app has no demo mode once Supabase is configured, and signing in needs a
 * password nobody should be typing into an automated browser. This creates a
 * throwaway account, joins it to the existing workspace, and prints the cookie
 * to set — so `/app` renders the real 919 leads instead of a login screen.
 *
 * **Development only.** It uses the service role to mint an owner membership,
 * which is a thing no production code path may ever do. Every account it
 * creates is named `viewer-<timestamp>@example.test` so `--cleanup` can find
 * and remove them without touching a real user.
 *
 * Sessions last an hour. When `/app` bounces you to `/login`, run it again.
 */
import { createClient } from "@supabase/supabase-js";
import { requireEnv } from "./load-env";

const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const admin = createClient(url, requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const VIEWER_PREFIX = "viewer-";

/** @supabase/ssr chunks a cookie above this; below it, one is enough. */
const MAX_CHUNK_SIZE = 3180;

async function cleanup() {
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 200 });
  if (error) throw error;

  const viewers = data.users.filter((user) =>
    (user.email ?? "").startsWith(VIEWER_PREFIX),
  );
  console.log(`${viewers.length} viewer account(s)`);

  for (const user of viewers) {
    // Membership first: deleting the user leaves an orphan row otherwise, and
    // `memberships.user_id` has no FK to auth.users to cascade it.
    await admin.from("memberships").delete().eq("user_id", user.id);
    await admin.auth.admin.deleteUser(user.id);
    console.log(`  deleted ${user.email}`);
  }
  if (viewers.length === 0) console.log("Nothing to clean up.");
}

async function mint() {
  const { data: orgs, error: orgError } = await admin
    .from("orgs")
    .select("id, name")
    .order("created_at", { ascending: true })
    .limit(1);
  if (orgError) throw orgError;

  const org = (orgs ?? [])[0] as { id: string; name: string } | undefined;
  if (!org) {
    console.error("No workspace exists yet. Sign up in the app first.");
    process.exit(1);
  }

  const stamp = Date.now();
  const email = `${VIEWER_PREFIX}${stamp}@example.test`;
  const password = `Dev-${crypto.randomUUID()}`;

  const { data: created, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError || !created.user) throw userError ?? new Error("createUser failed");

  await admin
    .from("memberships")
    .insert({ org_id: org.id, user_id: created.user.id, role: "owner" });

  const anon = createClient(url, requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signedIn, error: signInError } = await anon.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError || !signedIn.session) {
    throw signInError ?? new Error("signIn failed");
  }

  const ref = new URL(url).hostname.split(".")[0];
  const name = `sb-${ref}-auth-token`;
  const value = `base64-${Buffer.from(JSON.stringify(signedIn.session)).toString("base64url")}`;

  console.log(`workspace: ${org.name}\naccount:   ${email}\n`);
  if (value.length > MAX_CHUNK_SIZE) {
    console.log(
      `The session is ${value.length} chars, over the ${MAX_CHUNK_SIZE} cookie ` +
        `chunk limit. Split it as \`${name}.0\`, \`${name}.1\`, … the way ` +
        `@supabase/ssr does.\n`,
    );
  }
  console.log("Paste into the browser console at http://localhost:3000, then reload:\n");
  console.log(`document.cookie=${JSON.stringify(`${name}=${value}; path=/; SameSite=Lax`)}`);
}

async function main() {
  if (process.argv.includes("--cleanup")) await cleanup();
  else await mint();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
