/**
 * Supabase database types.
 *
 * PLACEHOLDER — regenerate against a real project once one exists:
 *
 *   npx supabase gen types typescript --project-id <ref> --schema public \
 *     > src/lib/supabase/types.ts
 *
 * (wired up as `npm run db:types`).
 *
 * Until then this is deliberately permissive rather than hand-written. A
 * hand-maintained copy of the schema in snake_case would drift from
 * `src/lib/db/schema.ts` silently and give false confidence — Drizzle stays the
 * single source of truth, and the generated file replaces this one wholesale.
 *
 * The table-name union below IS accurate, so table names are still checked.
 */

export type TableName =
  | "orgs"
  | "memberships"
  | "agents"
  | "lists"
  | "list_members"
  | "companies"
  | "people"
  | "emails"
  | "signals"
  | "leads"
  | "campaigns"
  | "sequence_steps"
  | "messages"
  | "email_accounts"
  | "provider_usage"
  | "suppressions"
  | "job_runs";

type GenericRow = Record<string, unknown>;

type GenericTable = {
  Row: GenericRow;
  Insert: GenericRow;
  Update: GenericRow;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: Record<TableName, GenericTable>;
    Views: Record<string, never>;
    Functions: {
      current_org_ids: {
        Args: Record<string, never>;
        Returns: string[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
