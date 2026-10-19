import { recommendationFor, caseReviewLabel } from "../format";
import { AgGridReact } from "ag-grid-react";
import type { CellKeyDownEvent, ColDef, GridApi, ICellRendererParams, RowClassRules } from "ag-grid-community";
import { themeQuartz } from "ag-grid-community";
import { useEffect, useRef, useState } from "react";
import type { Case } from "../../../src/domain";
import type { Resource } from "../hooks";
import { caseHref } from "../hooks";
import {
  ACTION_LABEL,
  CONFIDENCE_LEVEL,
  amountValue,
  dueInfo,
  formatDate,
  formatMoney,
  humanReason,
  stepIndex,
} from "../format";
import { Chip, ConfidenceMeter, Empty, ErrorNote, Icon } from "./ui";

const gridTheme = themeQuartz.withParams({
  fontFamily: "var(--font-ui)",
  fontSize: 14,
  backgroundColor: "var(--surface)",
  foregroundColor: "var(--ink)",
  headerBackgroundColor: "var(--surface-2)",
  headerTextColor: "var(--ink-2)",
  headerFontWeight: 600,
  borderColor: "var(--line)",
  accentColor: "var(--accent)",
  selectedRowBackgroundColor: "var(--accent-soft)",
  rowHoverColor: "var(--surface-2)",
  oddRowBackgroundColor: "var(--surface)",
  wrapperBorderRadius: 6,
  rowHeight: 46,
  headerHeight: 40,
  spacing: 7,
});

const PIN_ID = window.matchMedia("(min-width: 700px)").matches;
const NO_DUE = Number.POSITIVE_INFINITY;
const isClosed = (c: Case) => c.status === "resolved";

function guardRank(c: Case): number {
  return recommendationFor(c) ? c.guardFailures.length : -1;
}

function IdCell({ data }: ICellRendererParams<Case>) {
  if (!data) return null;
  return (
    <a className="id-link" href={caseHref(data.disputeId)} tabIndex={-1}>
      {data.disputeId}
    </a>
  );
}

function DueCell({ data }: ICellRendererParams<Case>) {
  if (!data) return null;
  const due = dueInfo(data.sellerResponseDueDate);
  return (
    <span className="due">
      <span className="due__date">{formatDate(data.sellerResponseDueDate)}</span>
      {!isClosed(data) && due.state !== "none" && (
        <span className={`due__left due__left--${due.state}`}>
          {due.state === "overdue" && <Icon name="alert" />}
          {due.label}
        </span>
      )}
    </span>
  );
}

function StatusCell({ data }: ICellRendererParams<Case>) {
  return data ? <Chip tone={data.pendingAction || data.assessment?.kind === "hold" ? "warn" : "neutral"}>{caseReviewLabel(data)}</Chip> : null;
}

function ActionCell({ data }: ICellRendererParams<Case>) {
  if (!data) return null;
  if (data.assessment?.kind === "hold") return <Chip tone="warn" icon="alert">On hold</Chip>;
  if (!recommendationFor(data)) return <span className="muted">Not yet</span>;
  return <Chip>{ACTION_LABEL[recommendationFor(data)!.action]}</Chip>;
}

function ConfidenceCell({ data }: ICellRendererParams<Case>) {
  if (!data) return null;
  if (!recommendationFor(data)) return <span className="muted">Not yet</span>;
  const { confidence } = recommendationFor(data)!;
  return <ConfidenceMeter level={CONFIDENCE_LEVEL[confidence]} label={confidence} />;
}

function GuardCell({ data }: ICellRendererParams<Case>) {
  if (!data) return null;
  if (data.assessment?.kind === "hold") return <Chip tone="warn" icon="alert">On hold</Chip>;
  if (!recommendationFor(data)) return <Chip icon="ring">Not run</Chip>;
  const n = data.guardFailures.length;
  return n === 0 ? (
    <Chip tone="ok" icon="check">
      Pass
    </Chip>
  ) : (
    <Chip tone="bad" icon="alert">
      {n} {n === 1 ? "issue" : "issues"}
    </Chip>
  );
}

const columns: ColDef<Case>[] = [
  { headerName: "Dispute", field: "disputeId", width: 140, pinned: PIN_ID ? "left" : undefined, cellRenderer: IdCell, cellClass: "cell-id" },
  { headerName: "Reason", valueGetter: (p) => (p.data ? humanReason(p.data.reason) : ""), flex: 1, minWidth: 200 },
  {
    headerName: "Amount",
    valueGetter: (p) => (p.data ? amountValue(p.data.amount) : 0),
    valueFormatter: (p) => (p.data ? formatMoney(p.data.amount) : ""),
    filter: "agNumberColumnFilter",
    type: "rightAligned",
    width: 120,
    cellClass: "cell-num",
  },
  {
    headerName: "Status",
    valueGetter: (p) => (p.data ? caseReviewLabel(p.data) : ""),
    comparator: (_a, _b, na, nb) => (na.data && nb.data ? stepIndex(na.data.status) - stepIndex(nb.data.status) : 0),
    cellRenderer: StatusCell,
    width: 180,
  },
  {
    headerName: "Respond by",
    valueGetter: (p) => (p.data?.sellerResponseDueDate ? new Date(p.data.sellerResponseDueDate) : null),
    comparator: (a: Date | null, b: Date | null) => {
      const x = a ? a.getTime() : NO_DUE;
      const y = b ? b.getTime() : NO_DUE;
      return x === y ? 0 : x < y ? -1 : 1;
    },
    filter: "agDateColumnFilter",
    sort: "asc",
    cellRenderer: DueCell,
    width: 200,
  },
  {
    headerName: "Recommended",
    valueGetter: (p) => p.data?.assessment?.kind === "hold" ? "On hold" : (recommendationFor(p.data) ? ACTION_LABEL[recommendationFor(p.data)!.action] : "Not yet"),
    cellRenderer: ActionCell,
    width: 150,
  },
  {
    headerName: "Confidence",
    valueGetter: (p) => recommendationFor(p.data)?.confidence ?? "Not yet",
    comparator: (_a, _b, na, nb) =>
      (recommendationFor(na.data) ? CONFIDENCE_LEVEL[recommendationFor(na.data)!.confidence] : 0) -
      (recommendationFor(nb.data) ? CONFIDENCE_LEVEL[recommendationFor(nb.data)!.confidence] : 0),
    cellRenderer: ConfidenceCell,
    width: 140,
  },
  {
    headerName: "Guard",
    valueGetter: (p) => {
      if (!p.data) return "";
      if (p.data.assessment?.kind === "hold") return "On hold";
      const rank = guardRank(p.data);
      return rank < 0 ? "Not run" : rank === 0 ? "Pass" : `${rank} ${rank === 1 ? "issue" : "issues"}`;
    },
    comparator: (_a, _b, na, nb) => (na.data && nb.data ? guardRank(na.data) - guardRank(nb.data) : 0),
    cellRenderer: GuardCell,
    width: 140,
  },
];

const rowClassRules: RowClassRules<Case> = {
  "row-overdue": (p) => !!p.data && !isClosed(p.data) && dueInfo(p.data.sellerResponseDueDate).state === "overdue",
  "row-blocked": (p) => !!p.data && (p.data.assessment?.kind === "hold" || p.data.guardFailures.length > 0) && !isClosed(p.data),
  "row-closed": (p) => !!p.data && isClosed(p.data),
};

const defaultColDef: ColDef<Case> = { sortable: true, filter: true, resizable: true, suppressMovable: true };

interface InboxProps {
  cases: Resource<Case[]>;
  selectedId: string | null;
}

export function Inbox({ cases, selectedId }: InboxProps) {
  const apiRef = useRef<GridApi<Case> | null>(null);
  const syncingSelection = useRef(false);
  const previousSelection = useRef(selectedId);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState(0);
  const rows = cases.data;

  useEffect(() => {
    if (previousSelection.current !== null && selectedId === null) headingRef.current?.focus({ preventScroll: true });
    previousSelection.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    syncingSelection.current = true;
    let found = false;
    api.forEachNode((node) => {
      const match = node.data?.disputeId === selectedId;
      if (node.isSelected() !== match) node.setSelected(match);
      if (match) {
        found = true;
        api.ensureNodeVisible(node);
      }
    });
    if (!found) api.deselectAll();
    syncingSelection.current = false;
  }, [selectedId, rows]);

  const onCellKeyDown = (e: CellKeyDownEvent<Case>) => {
    const key = (e.event as KeyboardEvent | null)?.key;
    if (key === "Enter" && e.data) window.location.hash = caseHref(e.data.disputeId);
  };

  return (
    <section className="inbox" aria-labelledby="inbox-heading">
      <div className="inbox__bar">
        <h2 id="inbox-heading" ref={headingRef} tabIndex={-1}>Dispute inbox</h2>
        <div className="inbox__tools">
          <label className="field field--inline">
            <span>Filter disputes</span>
            <input
              type="search"
              value={filter}
              placeholder="Id, reason, status"
              onChange={(e) => setFilter(e.target.value)}
              autoComplete="off"
            />
          </label>
          <p className="inbox__count" aria-live="polite">
            {rows ? `${shown} of ${rows.length} ${rows.length === 1 ? "dispute" : "disputes"}` : ""}
          </p>
        </div>
      </div>

      {cases.error !== undefined && (
        <ErrorNote
          title={rows ? "Could not refresh the inbox" : "Could not load disputes"}
          message={rows ? `${cases.error} Showing the last loaded list.` : cases.error}
          onRetry={cases.reload}
        />
      )}

      {rows === undefined && cases.error === undefined && <div className="grid-placeholder" role="status">Loading disputes</div>}

      {rows !== undefined && rows.length === 0 && cases.error === undefined && (
        <Empty title="No disputes loaded">Load a known PayPal dispute ID to review its current state.</Empty>
      )}

      {rows !== undefined && rows.length > 0 && (
        <div className={`inbox__grid ${selectedId ? "inbox__grid--compact" : ""}`}>
          <AgGridReact<Case>
            theme={gridTheme}
            rowData={rows}
            columnDefs={columns}
            defaultColDef={defaultColDef}
            getRowId={(p) => p.data.disputeId}
            rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
            rowClassRules={rowClassRules}
            quickFilterText={filter}
            overlayNoRowsTemplate="No disputes match the filter."
            onGridReady={(e) => {
              apiRef.current = e.api;
              setShown(e.api.getDisplayedRowCount());
            }}
            onModelUpdated={(e) => setShown(e.api.getDisplayedRowCount())}
            onRowSelected={(e) => {
              if (!syncingSelection.current && e.source !== "api" && e.node.isSelected() && e.data && e.data.disputeId !== selectedId) {
                window.location.hash = caseHref(e.data.disputeId);
              }
            }}
            onCellKeyDown={onCellKeyDown}
          />
        </div>
      )}

      <p className="inbox__foot">
        {cases.updatedAt ? `Updated ${cases.updatedAt.toLocaleTimeString()}. ` : ""}Refreshes every 5 seconds.
      </p>
    </section>
  );
}
