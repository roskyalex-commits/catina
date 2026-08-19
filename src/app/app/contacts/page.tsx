import Link from "next/link";
import { Plus, Users } from "lucide-react";
import { ContactsEnrichmentProvider } from "@/components/contacts/enrichment";
import { ContactsTable } from "@/components/contacts/table";
import { ContactsToolbar } from "@/components/contacts/toolbar";
import { EmptyState, LinkButton, PageHeader } from "@/components/ui/primitives";
import { listContacts } from "@/lib/data/contacts";
import type { ContactRow } from "@/lib/data/types";
import { cn } from "@/lib/utils";

const TABS = [
  { key: "people", label: "All contacts" },
  { key: "companies", label: "Companies" },
  { key: "lists", label: "Lists" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tab?: string; page?: string; list?: string }>;
}) {
  const params = await searchParams;
  const tab: TabKey = TABS.some((t) => t.key === params.tab)
    ? (params.tab as TabKey)
    : "people";
  const query = params.q ?? "";
  const page = Number.parseInt(params.page ?? "1", 10) || 1;

  const { rows, total, perPage } = await listContacts({
    query,
    listId: params.list,
    page,
    perPage: 100,
  });

  const from = total === 0 ? 0 : (page - 1) * perPage + 1;
  const to = Math.min(total, page * perPage);
  const pageCount = Math.max(1, Math.ceil(total / perPage));

  return (
    <>
      <PageHeader
        icon={Users}
        title="Contacts"
        description="Manage and organize your contacts and lists"
        action={
          <LinkButton href="/onboarding" variant="primary">
            <Plus className="h-4 w-4" aria-hidden />
            Add leads
          </LinkButton>
        }
      />

      <div className="mb-4 border-b border-border">
        <nav className="flex gap-1" aria-label="Contact views">
          {TABS.map((item) => {
            const active = item.key === tab;
            const search = new URLSearchParams();
            if (item.key !== "people") search.set("tab", item.key);
            if (query) search.set("q", query);
            const suffix = search.toString();

            return (
              <Link
                key={item.key}
                href={`/app/contacts${suffix ? `?${suffix}` : ""}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative px-3 py-2.5 text-[13px] transition",
                  active
                    ? "font-medium text-foreground"
                    : "text-muted hover:text-foreground",
                )}
              >
                {item.label}
                {active && (
                  <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-foreground" />
                )}
              </Link>
            );
          })}
        </nav>
      </div>

      {/*
        Toolbar and table share one selection, so they share one provider. The
        page itself is a server component and cannot hold that state.
      */}
      {tab === "people" && (
        <ContactsEnrichmentProvider>
          <ContactsToolbar initialQuery={query} />

          {rows.length === 0 ? (
            <EmptyState icon={Users} title={query ? "No matches" : "No contacts yet"}>
              {query
                ? "Nothing matched that search. Try a company, a county or a job title."
                : "Launch an agent and the people it finds land here, scored and ready to review."}
            </EmptyState>
          ) : (
            <>
              <ContactsTable rows={rows} />

              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[13px] text-muted">
                <span>
                  Showing {from} to {to} of {total} results
                </span>
                <span className="flex items-center gap-3">
                  <span>Show: {perPage} per page</span>
                  <span className="flex items-center gap-1">
                    {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => {
                      const search = new URLSearchParams();
                      if (query) search.set("q", query);
                      search.set("page", String(n));
                      return (
                        <Link
                          key={n}
                          href={`/app/contacts?${search}`}
                          aria-current={n === page ? "page" : undefined}
                          className={cn(
                            "grid h-7 min-w-7 place-items-center rounded-md px-2 transition",
                            n === page
                              ? "bg-accent-soft font-medium text-accent"
                              : "hover:bg-background hover:text-foreground",
                          )}
                        >
                          {n}
                        </Link>
                      );
                    })}
                  </span>
                </span>
              </div>
            </>
          )}
        </ContactsEnrichmentProvider>
      )}

      {tab === "companies" && <CompaniesTab rows={rows} />}
      {tab === "lists" && <ListsTab rows={rows} />}
    </>
  );
}

/**
 * Companies, collapsed from the same rows rather than fetched separately — one
 * company usually holds several contacts, and a second query would only have to
 * be reconciled with this one.
 */
function CompaniesTab({ rows }: { rows: ContactRow[] }) {
  const companies = new Map<
    string,
    {
      name: string;
      domain: string | null;
      county: string | null;
      caen: string | null;
      contacts: number;
      bestScore: number;
    }
  >();

  for (const row of rows) {
    const key = row.companyDomain ?? row.companyName;
    const existing = companies.get(key);
    if (existing) {
      existing.contacts += 1;
      existing.bestScore = Math.max(existing.bestScore, row.score);
    } else {
      companies.set(key, {
        name: row.companyName,
        domain: row.companyDomain,
        county: row.county,
        caen: row.caen,
        contacts: 1,
        bestScore: row.score,
      });
    }
  }

  const list = [...companies.values()].sort((a, b) => b.bestScore - a.bestScore);

  if (list.length === 0) {
    return (
      <EmptyState icon={Users} title="No companies sourced yet">
        The registry engine matches on CAEN code, county, headcount and filed
        revenue — it needs a seeded company table to search.
      </EmptyState>
    );
  }

  return (
    <div className="scrollbar-thin overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
      <table className="w-full min-w-[720px] text-left text-[13px]">
        <thead>
          <tr className="border-b border-border text-[11px] uppercase tracking-wide text-muted">
            <th scope="col" className="px-4 py-3 font-medium">Company</th>
            <th scope="col" className="px-4 py-3 font-medium">County</th>
            <th scope="col" className="px-4 py-3 font-medium">CAEN</th>
            <th scope="col" className="px-4 py-3 font-medium">Contacts</th>
            <th scope="col" className="px-4 py-3 font-medium">Best score</th>
          </tr>
        </thead>
        <tbody>
          {list.map((company) => (
            <tr key={company.name} className="border-b border-border last:border-0">
              <td className="px-4 py-3">
                <p className="font-medium">{company.name}</p>
                {company.domain && <p className="text-muted">{company.domain}</p>}
              </td>
              <td className="px-4 py-3 text-muted">{company.county ?? "—"}</td>
              <td className="px-4 py-3 font-mono text-muted">{company.caen ?? "—"}</td>
              <td className="px-4 py-3 tabular-nums">{company.contacts}</td>
              <td className="px-4 py-3 tabular-nums">{company.bestScore}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ListsTab({ rows }: { rows: ContactRow[] }) {
  const lists = new Map<string, { id: string; name: string; count: number }>();
  for (const row of rows) {
    if (!row.list) continue;
    const existing = lists.get(row.list.id);
    if (existing) existing.count += 1;
    else lists.set(row.list.id, { ...row.list, count: 1 });
  }

  const all = [...lists.values()];
  if (all.length === 0) {
    return (
      <EmptyState icon={Users} title="No lists yet">
        Select contacts and use Add to list to group them.
      </EmptyState>
    );
  }

  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {all.map((list) => (
        <li key={list.id}>
          <Link
            href={`/app/contacts?list=${encodeURIComponent(list.id)}`}
            className="block rounded-[var(--radius-card)] border border-border bg-surface p-4 transition hover:border-border-strong"
          >
            <p className="font-medium">{list.name}</p>
            <p className="mt-0.5 text-[13px] text-muted">
              {list.count} contact{list.count === 1 ? "" : "s"}
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}
