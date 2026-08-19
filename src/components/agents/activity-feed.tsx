import {
  AlertTriangle,
  Mail,
  Radar,
  Rocket,
  SearchX,
  UserPlus,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Avatar, relativeTime } from "@/components/ui/primitives";
import type { ActivityEvent } from "@/lib/data/types";

const ICONS: Record<ActivityEvent["kind"], LucideIcon> = {
  leads_found: UserPlus,
  no_leads: SearchX,
  email_sent: Mail,
  signal: Radar,
  launch: Rocket,
  error: AlertTriangle,
};

const TONES: Record<ActivityEvent["kind"], string> = {
  leads_found: "bg-success-soft text-success",
  no_leads: "bg-background text-muted",
  email_sent: "bg-info-soft text-info",
  signal: "bg-accent-soft text-accent",
  launch: "bg-accent-soft text-accent",
  error: "bg-danger-soft text-danger",
};

/**
 * The activity feed.
 *
 * A "no new leads found" row is as important as a "21 new leads found" row —
 * it is the only place a user learns that a keyword is dead, and hiding it
 * would make an idle agent look like a working one.
 */
export function ActivityFeed({ events }: { events: ActivityEvent[] }) {
  return (
    <ul className="divide-y divide-border">
      {events.map((event) => {
        const Icon = ICONS[event.kind];
        return (
          <li key={event.id} className="flex items-start gap-3 px-3 py-3">
            {event.initials ? (
              <Avatar name={event.subtitle ?? event.title} size={28} />
            ) : (
              <span
                className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${TONES[event.kind]}`}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />
              </span>
            )}

            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium leading-snug">{event.title}</p>
              {event.subtitle && (
                <p className="truncate text-[13px] text-muted">{event.subtitle}</p>
              )}
            </div>

            <time
              dateTime={event.at.toISOString()}
              className="shrink-0 text-xs text-muted"
            >
              {relativeTime(event.at)}
            </time>
          </li>
        );
      })}
    </ul>
  );
}
