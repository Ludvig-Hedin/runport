import "server-only";
import { appRows } from "@/lib/server/overview";
import { AppListClient } from "./app-list-client";
import { BlockError } from "./retry";

export async function AppList() {
  try {
    const rows = await appRows();
    return <AppListClient initialRows={rows} now={Date.now()} />;
  } catch {
    return <BlockError what="your apps" />;
  }
}

export function AppListSkeleton() {
  return (
    <ul className="db-apps" aria-busy="true" aria-label="Loading apps">
      {[0, 1].map((i) => (
        <li key={i} className="db-app">
          <div className="db-app-head">
            <div className="db-skel db-skel-name" />
            <div className="db-skel db-skel-pill" />
          </div>
          <div className="db-skel db-skel-line" />
          <div className="db-app-stats">
            {[0, 1, 2, 3].map((j) => (
              <div key={j}>
                <div className="db-skel db-skel-label" />
                <div className="db-skel db-skel-stat" />
              </div>
            ))}
          </div>
          <div className="db-app-actions">
            <div className="db-skel db-skel-btn" />
            <div className="db-skel db-skel-btn" />
          </div>
        </li>
      ))}
    </ul>
  );
}
