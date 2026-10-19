import { CatalogPanel } from "./components/CatalogPanel";
import { FIXTURE_MODE, api } from "./api";
import { EnvBanner } from "./components/EnvBanner";
import { CaseView } from "./components/CaseView";
import { Inbox } from "./components/Inbox";
import { caseHref, useResource, useSelectedCaseId } from "./hooks";
import { useState } from "react";
import { ImportDispute } from "./components/ImportDispute";

export function App() {
  const health = useResource(() => api.health(), "health");
  const cases = useResource(() => api.cases(), "cases", 5000);
  const selectedId = useSelectedCaseId();
  const [caseVersion, setCaseVersion] = useState(0);
  return (
    <>
      <EnvBanner health={health} fixtures={FIXTURE_MODE} />
      <header className="top">
        <h1>RebuttalForge</h1>
        <p>Review evidence and draft responses before approving or sending anything to PayPal.</p>
      </header>
      <CatalogPanel />
      <main>
        <ImportDispute fixtures={FIXTURE_MODE} onImported={(c) => {
          cases.reload();
          if (selectedId === c.disputeId) setCaseVersion((version) => version + 1);
          window.location.hash = caseHref(c.disputeId);
        }} />
        <Inbox cases={cases} selectedId={selectedId} />
        {selectedId !== null && <CaseView key={`${selectedId}:${caseVersion}`} id={selectedId} onChanged={cases.reload} />}
      </main>
    </>
  );
}
