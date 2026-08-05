import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  Bell,
  Robot,
  CheckCircle,
  Clock,
  Database,
  DotsThree,
  FileText,
  Folder,
  MagnifyingGlass,
  PaperPlaneTilt,
  Plus,
  Sparkle,
  X,
} from "@phosphor-icons/react";
import { useDraggable } from "@dnd-kit/core";
import { PENDING_HOME_MESSAGE } from "@/utils/constants";
import Workspace from "@/models/workspace";
import paths from "@/utils/paths";
import { ACME_STORY_PROMPT } from "./storyData";
import { useCapture } from "./capture";
import CaptureNavigationDrawer from "./CaptureNavigationDrawer";
import { PRIMARY_AREAS as AREAS } from "./navigation";
import "./styles.css";

const FILES = [
  [
    "Acme Master Services Agreement.pdf",
    "PDF",
    "3.8 MB",
    "Today, 10:42",
    "Ready",
    "Legal / Acme",
    "Google Drive",
  ],
  [
    "Acme Security Addendum.pdf",
    "PDF",
    "1.1 MB",
    "Today, 10:40",
    "Ready",
    "Legal / Acme",
    "SharePoint",
  ],
  [
    "Acme customer record.xlsx",
    "XLSX",
    "248 KB",
    "Today, 10:38",
    "Ready",
    "Customer Success / Acme",
    "PostgreSQL export",
  ],
  [
    "Acme agreement email thread.pdf",
    "PDF",
    "612 KB",
    "Today, 10:36",
    "Ready",
    "Communications / Acme",
    "Gmail",
  ],
  [
    "Atlas contract review playbook.docx",
    "DOCX",
    "924 KB",
    "Yesterday",
    "Ready",
    "Legal",
    "Microsoft 365",
  ],
];

const SKILLS = [
  [
    "Contract review",
    "Identify key obligations, renewal terms, and non-standard clauses.",
    "Contracts, legal playbooks",
    "Approval required",
    "Today",
  ],
  [
    "Email drafting",
    "Turn context from conversations into clear, on-brand replies.",
    "Email, contacts",
    "No approval",
    "12 min ago",
  ],
  [
    "Meeting summarization",
    "Create decisions, risks, and follow-ups from meeting notes.",
    "Calendar, transcripts",
    "No approval",
    "Yesterday",
  ],
  [
    "Spreadsheet analysis",
    "Find trends and explain business data without writing SQL.",
    "XLSX, datasets",
    "No approval",
    "Today",
  ],
  [
    "Customer research",
    "Build an account brief using approved company sources.",
    "Drive, CRM",
    "Approval required",
    "Jul 28",
  ],
  [
    "Weekly report generation",
    "Compile an executive update from the week’s work.",
    "Tasks, projects",
    "Approval required",
    "Friday",
  ],
  [
    "Incident summarization",
    "Turn incident activity into a concise, decision-ready operational summary.",
    "Incident timeline, ticket",
    "Approval required",
    "Today",
  ],
  [
    "Document comparison",
    "Compare two documents and surface material wording changes with citations.",
    "Two documents",
    "No approval",
    "Jul 26",
  ],
];

const INITIAL_TASKS = {
  todo: [
    {
      id: "t1",
      title: "Confirm Acme security contacts",
      meta: "Customer Success · Today",
      priority: "High",
      avatar: "ME",
    },
    {
      id: "t2",
      title: "Prepare customer health briefing",
      meta: "Data · Thu",
      priority: "Medium",
      avatar: "JC",
    },
  ],
  progress: [
    {
      id: "t3",
      title: "Refresh legal playbook index",
      meta: "Knowledge sync · 70%",
      priority: "High",
      avatar: "AI",
    },
    {
      id: "t4",
      title: "Prepare Acme account brief",
      meta: "Customer research · Fri",
      priority: "Medium",
      avatar: "LN",
    },
  ],
  review: [
    {
      id: "t5",
      title: "Approve weekly operations report",
      meta: "AI generated · 4 sources",
      priority: "High",
      avatar: "AI",
    },
  ],
  complete: [
    {
      id: "t6",
      title: "Send onboarding follow-up",
      meta: "Email · Sent 10:14",
      priority: "Low",
      avatar: "ME",
    },
  ],
};

const ACME_REVIEW_TASK = {
  id: "acme-review",
  title: "Review Acme obligations & response",
  meta: "Contract review · Draft attached",
  priority: "High",
  avatar: "AI",
  owner: "Marina Brooks",
  due: "Today · 3:00 PM",
  origin: "Acme agreement email",
  sources: "3 cited sources",
  attachment: "Draft response to Priya Shah",
  recent: true,
};

const TASK_COLUMN_LABELS = {
  todo: "To do",
  progress: "In progress",
  review: "Needs review",
  complete: "Complete",
};

function initialTasks(includeAcmeTask) {
  return {
    ...INITIAL_TASKS,
    todo: [...INITIAL_TASKS.todo],
    progress: [...INITIAL_TASKS.progress],
    review: includeAcmeTask
      ? [ACME_REVIEW_TASK, ...INITIAL_TASKS.review]
      : [...INITIAL_TASKS.review],
    complete: [...INITIAL_TASKS.complete],
  };
}

function Status({ children, tone = "green" }) {
  return <span className={`sb-status ${tone}`}>{children}</span>;
}
function IconButton({ children, label, className = "", ...props }) {
  return (
    <button
      className={`sb-icon-button ${className}`}
      aria-label={label}
      {...props}
    >
      {children}
    </button>
  );
}

function PageTitle({ title, text, action, onAction, captureId }) {
  return (
    <header className="sb-page-head">
      <div>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
      {action && (
        <button
          className="sb-button"
          onClick={onAction}
          disabled={!onAction}
          data-capture-id={captureId}
        >
          <Plus size={17} /> {action}
        </button>
      )}
    </header>
  );
}

function MetricCard({ value, label, note, tone = "blue" }) {
  return (
    <article className="sb-metric">
      <div className={`sb-metric-orb ${tone}`} />
      <div>
        <strong>{value}</strong>
        <span>{label}</span>
        <small>{note}</small>
      </div>
    </article>
  );
}

export function NativeAreaNavigationPreview({ area, setArea, sub, setSub }) {
  return (
    <>
      <aside className="sb-sidebar">
        <div className="sb-brand">
          <img src="/skybao-logo.svg" alt="" aria-hidden="true" />
          <span>SkyBao</span>
        </div>
        <nav className="sb-primary-nav" aria-label="Primary navigation">
          {AREAS.map((item) => {
            const Icon = item.icon;
            const active = area === item.id;
            return (
              <button
                key={item.id}
                className={`sb-nav-item ${active ? "active" : ""} ${item.id === "admin" ? "admin" : ""}`}
                onClick={() => {
                  setArea(item.id);
                  setSub(item.children[0]);
                }}
              >
                <Icon weight={active ? "fill" : "regular"} />
                <span>{item.label}</span>
                {item.id === "communications" && <i>5</i>}
              </button>
            );
          })}
        </nav>
        <div className="sb-sidebar-foot">
          <div className="sb-user-avatar">MB</div>
          <div>
            <b>Marina Brooks</b>
            <span>Atlas workspace</span>
          </div>
          <DotsThree size={20} />
        </div>
        <div className="sb-secondary">
          <div className="sb-secondary-title">
            {AREAS.find((a) => a.id === area)?.label}
          </div>
          {AREAS.find((a) => a.id === area)?.children.map((item) => (
            <button
              key={item}
              className={sub === item ? "selected" : ""}
              onClick={() => setSub(item)}
            >
              {item}
              {item === "Approvals" && <em>2</em>}
              {item === "Inbox" && <em>5</em>}
            </button>
          ))}
        </div>
      </aside>
      <nav className="sb-mobile-nav" aria-label="Mobile primary navigation">
        {AREAS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className={area === item.id ? "active" : ""}
              onClick={() => {
                setArea(item.id);
                setSub(item.children[0]);
              }}
            >
              <Icon weight={area === item.id ? "fill" : "regular"} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      <nav
        className="sb-mobile-secondary"
        aria-label="Mobile secondary navigation"
      >
        {AREAS.find((item) => item.id === area)?.children.map((item) => (
          <button
            key={item}
            className={sub === item ? "selected" : ""}
            onClick={() => setSub(item)}
          >
            {item}
          </button>
        ))}
      </nav>
    </>
  );
}

function SourcePreview({ title, close }) {
  const isSecurity = title.toLowerCase().includes("security");
  const passage = isSecurity
    ? "Provider will notify Customer within 24 hours of confirming a Security Incident and will obtain written approval before a new subprocessor accesses Customer Data."
    : "Provider will give Customer no less than thirty (30) days’ written notice before implementing a material change to the Services.";
  return (
    <div
      className="sb-source-preview"
      role="dialog"
      aria-label={`${title} preview`}
    >
      <button
        onClick={close}
        aria-label="Close preview"
        data-capture-id="source-preview-close"
      >
        <X />
      </button>
      <span className="sb-eyebrow">SOURCE PREVIEW</span>
      <h3>{title}</h3>
      <blockquote>
        {passage.split(isSecurity ? "24 hours" : "thirty (30) days")[0]}
        <mark>{isSecurity ? "24 hours" : "thirty (30) days"}</mark>
        {passage.split(isSecurity ? "24 hours" : "thirty (30) days")[1]}
      </blockquote>
      <p>
        SkyBao matched this passage to the Acme request and cross-checked it
        against the latest email thread and customer record.
      </p>
      <small>Approved company source · Indexed today · Citation verified</small>
    </div>
  );
}

function KnowledgeView({ sub, setSkill }) {
  const [query, setQuery] = useState("");
  const [filePreview, setFilePreview] = useState("");
  const [uploaded, setUploaded] = useState(false);
  const [typeFilter, setTypeFilter] = useState("All types");
  const filtered = FILES.filter(
    (f) =>
      f.join(" ").toLowerCase().includes(query.toLowerCase()) &&
      (typeFilter === "All types" || f[1] === typeFilter)
  );
  if (sub === "Skills")
    return (
      <section>
        <PageTitle
          title="Skills library"
          text="Reusable AI abilities SkyBao can use across your workspace."
          action="Create skill"
        />
        <div className="sb-skill-grid">
          {SKILLS.map((s, i) => (
            <article
              className="sb-skill-card"
              key={s[0]}
              data-capture-id={`knowledge-skill-${i}`}
              onClick={() => setSkill(s)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") setSkill(s);
              }}
              role="button"
              tabIndex={0}
            >
              <div className="sb-skill-top">
                <span className={`sb-skill-icon i${i % 4}`}>
                  <Robot weight="fill" />
                </span>
                <Status tone={i === 4 ? "gray" : "green"}>
                  {i === 4 ? "Disabled" : "Enabled"}
                </Status>
              </div>
              <h3>{s[0]}</h3>
              <p>{s[1]}</p>
              <div className="sb-skill-meta">
                <span>
                  Inputs <b>{s[2]}</b>
                </span>
                <span>
                  Available data <b>Drive, messages, datasets</b>
                </span>
                <span>
                  Human review <b>{s[3]}</b>
                </span>
                <span>
                  Last used <b>{s[4]}</b>
                </span>
              </div>
              <button>
                Open configuration <span>→</span>
              </button>
            </article>
          ))}
        </div>
      </section>
    );
  if (sub === "Connections")
    return (
      <section>
        <PageTitle
          title="Connections"
          text="Keep the information SkyBao uses current and scoped to your workspace."
          action="Add connection"
        />
        <div className="sb-connection-grid">
          {[
            ["Google Drive", "Connected", "2 min ago", "green"],
            ["Microsoft 365", "Syncing", "1,248 files", "blue"],
            ["Gmail", "Connected", "43 threads today", "green"],
            [
              "Slack",
              "Attention required",
              "Reconnect to finish sync",
              "orange",
            ],
            ["SharePoint", "Not configured", "Add a site collection", "gray"],
            ["PostgreSQL", "Connected", "5 tables", "green"],
            ["MySQL", "Not configured", "Add credentials", "gray"],
            ["Local folders", "Connected", "3 folders watched", "green"],
          ].map(([name, state, info, tone]) => (
            <article className="sb-connection" key={name}>
              <div className="sb-connection-logo">{name.slice(0, 1)}</div>
              <div>
                <h3>{name}</h3>
                <Status tone={tone}>{state}</Status>
                <p>{info}</p>
              </div>
              <IconButton label={`Configure ${name}`}>
                <DotsThree />
              </IconButton>
            </article>
          ))}
        </div>
      </section>
    );
  if (sub === "Data") return <DataView />;
  if (sub === "Collections")
    return (
      <section>
        <PageTitle
          title="Collections"
          text="Curated knowledge spaces with their own sources and access rules."
          action="New collection"
        />
        <div className="sb-collection-grid">
          {[
            [
              "Customer Success",
              "186 files",
              "Account records, success plans, and renewal notes",
            ],
            ["Legal", "214 files", "Contracts, addenda, and policy guidance"],
            [
              "Product Research",
              "36 files",
              "Feedback exports, interviews, product briefs",
            ],
            [
              "Engineering",
              "19 files",
              "Runbooks, incidents, and architecture docs",
            ],
          ].map((c, i) => (
            <article className="sb-collection" key={c[0]}>
              <span className={`sb-folder f${i}`}>
                <Folder weight="fill" />
              </span>
              <h3>{c[0]}</h3>
              <small>{c[1]}</small>
              <p>{c[2]}</p>
              <button>View collection →</button>
            </article>
          ))}
        </div>
      </section>
    );
  return (
    <section>
      <PageTitle
        title="Files"
        text="Every approved source for the Acme workflow, searchable in one place."
        action="Upload files"
        onAction={() => setUploaded(true)}
        captureId="knowledge-upload"
      />
      <div
        className="sb-knowledge-pulse"
        aria-label="Connected knowledge summary"
      >
        {[
          ["436", "PDF documents", "Indexed and searchable"],
          ["128", "Spreadsheets", "Structured for analysis"],
          ["Connected", "PostgreSQL", "Synced 2 minutes ago"],
          ["8 enabled", "Company skills", "Contract review ready"],
        ].map(([value, label, note], index) => (
          <article key={label}>
            <span className={`sb-knowledge-icon i${index}`}>
              {index === 2 ? (
                <Database />
              ) : index === 3 ? (
                <Robot />
              ) : (
                <FileText />
              )}
            </span>
            <div>
              <strong>{value}</strong>
              <b>{label}</b>
              <small>{note}</small>
            </div>
          </article>
        ))}
      </div>
      <div className="sb-toolbar">
        <div className="sb-search">
          <MagnifyingGlass />
          <input
            data-capture-id="knowledge-file-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files and source metadata"
          />
        </div>
        <button className="sb-filter" onClick={() => setQuery("")}>
          All collections⌄
        </button>
        <select
          className="sb-filter"
          data-capture-id="knowledge-type-filter"
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value)}
        >
          <option>All types</option>
          <option>PDF</option>
          <option>DOCX</option>
          <option>XLSX</option>
          <option>CSV</option>
          <option>TXT</option>
        </select>
      </div>
      <div className="sb-file-table">
        <div className="sb-table-head">
          <span>Name</span>
          <span>Collection</span>
          <span>Added</span>
          <span>Status</span>
          <span></span>
        </div>
        {filtered.map((f) => (
          <div className="sb-file-row" key={f[0]}>
            <div className="sb-file-name">
              <span className={`sb-file-icon ${f[1].toLowerCase()}`}>
                {f[1]}
              </span>
              <div>
                <b>{f[0]}</b>
                <small>
                  {f[1]} · {f[2]} · {f[6]}
                </small>
              </div>
            </div>
            <span>{f[5]}</span>
            <span>{f[3]}</span>
            <Status tone={f[4] === "Ready" ? "green" : "blue"}>
              {f[4] === "Ready" ? "Indexed" : "Indexing"}
            </Status>
            <button
              className="sb-text-button"
              data-capture-id={`knowledge-file-preview-${FILES.indexOf(f)}`}
              onClick={() => setFilePreview(f[0])}
            >
              Preview
            </button>
          </div>
        ))}
      </div>
      {uploaded && (
        <div className="sb-upload-state">
          <FileText />{" "}
          <div>
            <b>Executive operating review.pdf</b>
            <p>Mock upload added — indexing in progress</p>
          </div>
          <button onClick={() => setUploaded(false)}>
            <X />
          </button>
        </div>
      )}
      {filePreview && (
        <SourcePreview title={filePreview} close={() => setFilePreview("")} />
      )}
    </section>
  );
}

function DataView() {
  const [dataset, setDataset] = useState("Customers");
  const [query, setQuery] = useState("");
  const [askResult, setAskResult] = useState("");
  const data = {
    Customers: {
      headers: ["Customer", "Segment", "Health", "ARR"],
      schema: [
        ["customer_name", "text"],
        ["segment", "enum"],
        ["health_score", "number"],
        ["arr", "currency"],
      ],
      rows: [
        ["Acme Industries", "Enterprise", "Healthy", "$124,000"],
        ["Vantage Group", "Enterprise", "At risk", "$96,000"],
        ["Redwood Labs", "Growth", "Healthy", "$42,000"],
        ["Vantage", "Growth", "Watch", "$31,000"],
      ],
    },
    Contracts: {
      headers: ["Contract", "Type", "Renewal", "Status"],
      schema: [
        ["contract_name", "text"],
        ["type", "enum"],
        ["renewal_date", "date"],
        ["status", "enum"],
      ],
      rows: [
        ["Acme MSA", "Active", "Jul 31", "In review"],
        ["Acme Security Addendum", "Active", "Jul 31", "Verified"],
        ["Redwood MSA", "Renewal", "Sep 02", "Signed"],
      ],
    },
    Invoices: {
      headers: ["Invoice", "Account", "Amount", "Status"],
      schema: [
        ["invoice_id", "text"],
        ["account", "text"],
        ["amount", "currency"],
        ["status", "enum"],
      ],
      rows: [
        ["INV-1942", "Acme Industries", "$31,000", "Paid"],
        ["INV-1943", "Vantage Group", "$24,000", "Due Aug 1"],
        ["INV-1944", "Vantage", "$9,200", "Paid"],
      ],
    },
    Projects: {
      headers: ["Project", "Owner", "Due", "Status"],
      schema: [
        ["project_name", "text"],
        ["owner", "person"],
        ["due_date", "date"],
        ["status", "enum"],
      ],
      rows: [
        ["Acme agreement review", "Marina", "Today", "Needs review"],
        ["Support deflection", "Jordan", "Aug 9", "On track"],
        ["Q3 planning", "Lena", "Aug 16", "Planning"],
      ],
    },
    "Support tickets": {
      headers: ["Ticket", "Customer", "Priority", "State"],
      schema: [
        ["ticket_id", "text"],
        ["customer", "text"],
        ["priority", "enum"],
        ["state", "enum"],
      ],
      rows: [
        ["SUP-4031", "Acme Industries", "High", "Open"],
        ["SUP-4029", "Redwood Labs", "Medium", "Investigating"],
        ["SUP-4018", "Vantage", "Low", "Resolved"],
      ],
    },
  };
  const current = data[dataset];
  const rows = current.rows.filter((row) =>
    row.join(" ").toLowerCase().includes(query.toLowerCase())
  );
  return (
    <section>
      <PageTitle
        title="Data"
        text="Business-friendly data, ready to explore or ask about in plain language."
      />
      <div className="sb-data-layout">
        <aside className="sb-datasets">
          <span>DATASETS</span>
          {[
            "Customers",
            "Contracts",
            "Invoices",
            "Projects",
            "Support tickets",
          ].map((d, index) => (
            <button
              className={dataset === d ? "selected" : ""}
              onClick={() => setDataset(d)}
              key={d}
              data-capture-id={`knowledge-dataset-${index}`}
            >
              <Database /> {d}
              <small>
                {d === "Customers" ? "1,248" : d === "Contracts" ? "86" : "312"}
              </small>
            </button>
          ))}
          <button className="sb-advanced">
            Advanced SQL <span>↗</span>
          </button>
        </aside>
        <div className="sb-dataset-detail">
          <div className="sb-dataset-top">
            <div>
              <h2>{dataset}</h2>
              <p>
                {dataset === "Customers"
                  ? "1,248 customer records · Synced from PostgreSQL"
                  : "Business records · Last synced 12 minutes ago"}
              </p>
            </div>
            <button
              className="sb-outline"
              data-capture-id="knowledge-data-ask"
              onClick={() =>
                setAskResult(
                  `SkyBao is ready to analyze ${dataset}: ${rows.length} matching records are in scope.`
                )
              }
            >
              <Sparkle weight="fill" /> Ask SkyBao
            </button>
          </div>
          <div className="sb-data-actions">
            <div className="sb-search">
              <MagnifyingGlass />
              <input
                data-capture-id="knowledge-data-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${dataset.toLowerCase()}`}
              />
            </div>
            <button>Columns</button>
            <button>Filter</button>
          </div>
          <div className="sb-data-table">
            <div className="sb-data-head">
              {current.headers.map((header) => (
                <span key={header}>{header}</span>
              ))}
            </div>
            {rows.map((row) => (
              <div className="sb-data-row" key={row[0]}>
                {row.map((x, i) => (
                  <span key={x} className={i === 0 ? "primary" : ""}>
                    {i === 2 && (x === "At risk" || x === "Watch") ? (
                      <Status tone="orange">{x}</Status>
                    ) : (
                      x
                    )}
                  </span>
                ))}
              </div>
            ))}
          </div>
          <div className="sb-schema">
            <b>Table structure</b>
            {current.schema.map(([name, type]) => (
              <span key={name}>
                {name} <i>{type}</i>
              </span>
            ))}
          </div>
        </div>
      </div>
      {askResult && (
        <div className="sb-action-notice">
          {askResult}
          <button onClick={() => setAskResult("")}>
            <X />
          </button>
        </div>
      )}
    </section>
  );
}

function CommunicationsView({ sub, onAsk, onCreateTask }) {
  const [selected, setSelected] = useState(0);
  const [draft, setDraft] = useState(false);
  const [draftText, setDraftText] = useState(
    "Hi Priya — I’ll confirm the relevant obligations in the Acme agreement and send a cited response for review today."
  );
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("All sources");
  const [priority, setPriority] = useState("Priority");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState(false);
  const messages = [
    [
      "Gmail",
      "Acme agreement — obligations and response",
      "Priya Shah",
      "Can you confirm our obligations under the Acme agreement and prepare a response?",
      "10:42 AM",
      true,
    ],
    [
      "Slack",
      "#customer-success · Acme account update",
      "Jordan Chen",
      "I added the latest Acme account notes and verified the security contacts.",
      "9:18 AM",
      true,
    ],
    [
      "Gmail",
      "Re: Q2 business review",
      "Maya Patel",
      "Thanks for sending this over. One question on the adoption trend…",
      "Yesterday",
      false,
    ],
    [
      "Slack",
      "#product-feedback · July themes",
      "SkyBao Research",
      "Weekly digest is ready for review. 14 themes detected.",
      "Yesterday",
      false,
    ],
  ];
  const visible = messages.filter(
    (m) =>
      (sub === "Slack" ? m[0] === "Slack" : true) &&
      (source === "All sources" || m[0] === source) &&
      (priority !== "Priority" ? m[5] : true) &&
      m.join(" ").toLowerCase().includes(query.toLowerCase())
  );
  const current = visible[Math.min(selected, visible.length - 1)];
  return (
    <section>
      <PageTitle
        title={sub === "Slack" ? "Workplace messages" : "Communications"}
        text="Focus on messages that need a decision, response, or next step."
      />
      <div className="sb-comms-toolbar">
        <div className="sb-search">
          <MagnifyingGlass />
          <input
            data-capture-id="communications-search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            placeholder="Search conversations"
          />
        </div>
        <select
          className="sb-filter"
          data-capture-id="communications-source-filter"
          value={source}
          onChange={(event) => {
            setSource(event.target.value);
            setSelected(0);
          }}
        >
          <option>All sources</option>
          <option>Gmail</option>
          <option>Slack</option>
        </select>
        <select
          className="sb-filter"
          data-capture-id="communications-priority-filter"
          value={priority}
          onChange={(event) => {
            setPriority(event.target.value);
            setSelected(0);
          }}
        >
          <option>Priority</option>
          <option>Priority only</option>
        </select>
        <span className="sb-unread">1 priority request</span>
      </div>
      <div className="sb-mail-layout">
        <div className="sb-thread-list">
          {visible.map((m, i) => (
            <button
              className={`sb-thread ${i === selected ? "selected" : ""}`}
              onClick={() => setSelected(i)}
              key={m[1]}
              data-capture-id={`communications-thread-${messages.indexOf(m)}`}
            >
              <div>
                <span className={`sb-message-source ${m[0].toLowerCase()}`}>
                  {m[0]}
                </span>
                {m[5] && <i />}
                <time>{m[4]}</time>
              </div>
              <b>{m[1]}</b>
              <span>{m[2]}</span>
              <p>{m[3]}</p>
            </button>
          ))}
        </div>
        {current ? (
          <article className="sb-message-detail">
            <div className="sb-message-title">
              <div>
                <span
                  className={`sb-message-source ${current[0].toLowerCase()}`}
                >
                  {current[0]}
                </span>
                <h2>{current[1]}</h2>
              </div>
              <IconButton label="More message options">
                <DotsThree />
              </IconButton>
            </div>
            <div className="sb-message-from">
              <div className="sb-person">
                {current[2]
                  .split(" ")
                  .map((x) => x[0])
                  .join("")}
              </div>
              <div>
                <b>{current[2]}</b>
                <span>to Marina, Customer Success</span>
              </div>
              <time>{current[4]}</time>
            </div>
            <p className="sb-message-body">
              {current[1].startsWith("Acme agreement")
                ? "Hi Marina — can you confirm our obligations under the Acme agreement and prepare a response? Please check the notice period for service changes, the security incident timeline, and whether we need approval for any new subprocessors. I’ve attached the agreement for context."
                : `${current[3]} I’ve attached the relevant context and the decision we need from your team.`}
            </p>
            <div className="sb-thread-summary">
              <div>
                <Sparkle weight="fill" />
                <b>SkyBao summary</b>
              </div>
              <p>
                {current[1].startsWith("Acme agreement")
                  ? "Priya needs a cited confirmation of three contract obligations and a customer-ready response. Human approval is required before sending."
                  : "This conversation needs a decision and a clear next step today."}
              </p>
              <button
                onClick={() => setPreview(true)}
                data-capture-id="communications-cited-context"
              >
                View cited context <span>→</span>
              </button>
            </div>
            {draft ? (
              <div className="sb-draft">
                <b>Suggested reply</b>
                <textarea
                  data-capture-id="communications-draft-text"
                  value={draftText}
                  onChange={(event) => setDraftText(event.target.value)}
                />
                <div>
                  <button
                    className="sb-outline"
                    data-capture-id="communications-draft-save"
                    onClick={() => {
                      setDraft(false);
                      setNotice("Draft saved");
                    }}
                  >
                    Save draft
                  </button>
                  <button
                    className="sb-button"
                    data-capture-id="communications-draft-approve"
                    onClick={() => {
                      setDraft(false);
                      setNotice("Reply sent for approval");
                    }}
                  >
                    Send for approval
                  </button>
                </div>
              </div>
            ) : (
              <div className="sb-message-actions">
                <button
                  className="sb-button"
                  data-capture-id="communications-ask"
                  onClick={() => onAsk(ACME_STORY_PROMPT)}
                >
                  <Sparkle weight="fill" /> Ask SkyBao
                </button>
                <button
                  className="sb-outline"
                  data-capture-id="communications-draft-open"
                  onClick={() => setDraft(true)}
                >
                  Draft reply
                </button>
                <button
                  className="sb-text-button"
                  data-capture-id="communications-convert-task"
                  onClick={() => onCreateTask(current[1])}
                >
                  Convert to task <span>→</span>
                </button>
              </div>
            )}
          </article>
        ) : (
          <div className="sb-empty-state">
            No conversations match these filters.
          </div>
        )}
      </div>
      {notice && (
        <div className="sb-action-notice">
          {notice}
          <button onClick={() => setNotice("")}>
            <X />
          </button>
        </div>
      )}
      {preview && (
        <SourcePreview
          title="Acme Master Services Agreement.pdf"
          close={() => setPreview(false)}
        />
      )}
    </section>
  );
}

function TaskCard({ task, onOpen }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: task.id, data: task });
  return (
    <article
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      data-capture-id={`work-task-${task.id}`}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={`sb-task-card ${isDragging ? "dragging" : ""} ${
        task.recent ? "recent" : ""
      }`}
    >
      <div className="sb-task-top">
        <Status
          tone={
            task.priority === "High"
              ? "orange"
              : task.priority === "Low"
                ? "gray"
                : "blue"
          }
        >
          {task.priority}
        </Status>
        <DotsThree size={19} />
      </div>
      <button
        className="sb-task-title"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => onOpen(task)}
      >
        {task.title}
      </button>
      <p>{task.meta}</p>
      <div className="sb-task-bottom">
        <span className={`sb-mini-avatar ${task.avatar === "AI" ? "ai" : ""}`}>
          {task.avatar}
        </span>
        {task.due ? (
          <span>◷ {task.due}</span>
        ) : (
          task.meta.includes("Today") && <span>◷ Today</span>
        )}
      </div>
    </article>
  );
}
function BoardColumn({ id, title, tasks, onOpen, onAdd }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <section
      ref={setNodeRef}
      data-capture-id={`work-column-${id}`}
      className={`sb-board-column ${isOver ? "over" : ""}`}
    >
      <div className="sb-board-header">
        <div>
          <span className={`sb-column-dot ${id}`} />
          <b>{title}</b>
          <small>{tasks.length}</small>
        </div>
        <IconButton label={`Add to ${title}`} onClick={() => onAdd(id)}>
          <Plus />
        </IconButton>
      </div>
      <div className="sb-board-tasks">
        {tasks.map((t) => (
          <TaskCard task={t} key={t.id} onOpen={onOpen} />
        ))}
      </div>
      <button className="sb-add-task" onClick={() => onAdd(id)}>
        <Plus /> Add task
      </button>
    </section>
  );
}

function WorkView({ sub, includeAcmeTask = false, captureState = "" }) {
  const [tasks, setTasks] = useState(() => initialTasks(includeAcmeTask));
  const [active, setActive] = useState(null);
  const [detail, setDetail] = useState(null);
  const [notice, setNotice] = useState("");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  );
  useEffect(() => {
    setTasks(initialTasks(includeAcmeTask));
    setDetail(null);
    setNotice("");
    if (
      includeAcmeTask &&
      ["work-board-detail", "work-task-approval"].includes(captureState)
    ) {
      setDetail(ACME_REVIEW_TASK);
      return undefined;
    }
    if (includeAcmeTask && !captureState) {
      const timer = window.setTimeout(() => setDetail(ACME_REVIEW_TASK), 500);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [captureState, includeAcmeTask]);

  const addTask = (column) => {
    const title = window.prompt("Task name", "New follow-up task");
    if (!title?.trim()) return;
    const task = {
      id: `task-${Date.now()}`,
      title: title.trim(),
      meta: "Created by Marina · Today",
      priority: "Medium",
      avatar: "ME",
      due: "Today",
    };
    setTasks((current) => ({
      ...current,
      [column]: [...current[column], task],
    }));
    setNotice(`${task.title} added to the board`);
  };

  const approveTask = (task) => {
    const from = Object.keys(tasks).find((key) =>
      tasks[key].some((item) => item.id === task.id)
    );
    if (!from) return;
    setTasks((current) => ({
      ...current,
      [from]: current[from].filter((item) => item.id !== task.id),
      complete: [
        { ...task, recent: false, meta: "Approved by Marina · Just now" },
        ...current.complete.filter((item) => item.id !== task.id),
      ],
    }));
    sessionStorage.setItem(
      "skybao_acme_story_task",
      JSON.stringify({ state: "approved", approvedAt: Date.now() })
    );
    setDetail(null);
    setNotice("Acme response approved — ready for the controlled send");
  };
  const handleDragEnd = ({ active, over }) => {
    setActive(null);
    if (!over || !tasks[over.id]) return;
    const from = Object.keys(tasks).find((k) =>
      tasks[k].some((t) => t.id === active.id)
    );
    if (!from || from === over.id) return;
    const item = tasks[from].find((t) => t.id === active.id);
    if (!item) return;
    setTasks((prev) => ({
      ...prev,
      [from]: prev[from].filter((t) => t.id !== item.id),
      [over.id]: [...prev[over.id], item],
    }));
  };
  if (sub === "Board")
    return (
      <section>
        <PageTitle
          title="Work board"
          text="Track the Acme response from grounded answer to human approval."
          action="New task"
          onAction={() => addTask("todo")}
        />
        <DndContext
          sensors={sensors}
          onDragStart={({ active }) => setActive(active.data.current)}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActive(null)}
        >
          <div className="sb-board">
            <BoardColumn
              id="todo"
              title="To do"
              tasks={tasks.todo}
              onOpen={setDetail}
              onAdd={addTask}
            />
            <BoardColumn
              id="progress"
              title="In progress"
              tasks={tasks.progress}
              onOpen={setDetail}
              onAdd={addTask}
            />
            <BoardColumn
              id="review"
              title="Needs review"
              tasks={tasks.review}
              onOpen={setDetail}
              onAdd={addTask}
            />
            <BoardColumn
              id="complete"
              title="Complete"
              tasks={tasks.complete}
              onOpen={setDetail}
              onAdd={addTask}
            />
          </div>
          <DragOverlay>
            {active ? (
              <div className="sb-drag-overlay">
                <h4>{active.title}</h4>
                <p>{active.meta}</p>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
        {detail && (
          <div
            className={`sb-task-detail ${
              detail.id === ACME_REVIEW_TASK.id ? "sb-story-task-detail" : ""
            }`}
          >
            <button onClick={() => setDetail(null)}>
              <X />
            </button>
            <span className="sb-eyebrow">TASK DETAIL</span>
            <h3>{detail.title}</h3>
            <p>
              Status:{" "}
              {
                TASK_COLUMN_LABELS[
                  Object.keys(tasks).find((key) =>
                    tasks[key].some((task) => task.id === detail.id)
                  )
                ]
              }{" "}
              · Priority: {detail.priority}
            </p>
            <p>
              Owner: {detail.owner || detail.avatar} · Due:{" "}
              {detail.due ||
                (detail.meta.includes("Today") ? "Today" : "This week")}
            </p>
            <p>
              Related item: {detail.meta} · Origin:{" "}
              {detail.origin || (detail.avatar === "AI" ? "agent" : "user")}
            </p>
            {detail.attachment && (
              <div className="sb-task-attachment">
                <FileText />
                <span>
                  <b>{detail.attachment}</b>
                  <small>{detail.sources} · Human approval required</small>
                </span>
              </div>
            )}
            {detail.id === ACME_REVIEW_TASK.id &&
              !tasks.complete.some((task) => task.id === detail.id) && (
                <button
                  className="sb-button sb-task-approve"
                  data-capture-id="work-task-approve"
                  onClick={() => approveTask(detail)}
                >
                  <CheckCircle weight="fill" /> Approve response
                </button>
              )}
          </div>
        )}
        {notice && (
          <div className="sb-action-notice sb-board-notice">
            <CheckCircle weight="fill" /> {notice}
            <button onClick={() => setNotice("")}>
              <X />
            </button>
          </div>
        )}
      </section>
    );
  if (sub === "Approvals") return <Approvals />;
  if (sub === "Agent runs") return <AgentRuns />;
  if (sub === "Tasks" || sub === "Reminders")
    return <TaskList reminders={sub === "Reminders"} />;
  return <WorkOverview setBoard={() => {}} />;
}

function WorkOverview() {
  return (
    <section>
      <PageTitle
        title="Good morning, Marina"
        text="Here’s the work that needs your attention today."
      />
      <div className="sb-metric-grid">
        <MetricCard
          value="3"
          label="tasks need review"
          note="1 due today"
          tone="orange"
        />
        <MetricCard
          value="5"
          label="important unread messages"
          note="2 mention you"
        />
        <MetricCard
          value="2"
          label="approvals waiting"
          note="Oldest: 34 min"
          tone="purple"
        />
        <MetricCard
          value="4"
          label="AI jobs completed today"
          note="All outputs ready"
          tone="green"
        />
      </div>
      <div className="sb-work-grid">
        <article className="sb-panel sb-attention">
          <div className="sb-panel-head">
            <div>
              <span className="sb-eyebrow">PRIORITY QUEUE</span>
              <h2>Needs your attention</h2>
            </div>
            <button>View all →</button>
          </div>
          {[
            [
              "Review Acme obligations & response",
              "Contract review",
              "Today · 2:00 PM",
              "orange",
            ],
            [
              "Approve response to Priya Shah",
              "Email drafting",
              "Today · 3:00 PM",
              "blue",
            ],
            [
              "Approve weekly operations report",
              "Report generation",
              "Waiting 34 min",
              "purple",
            ],
          ].map((x, i) => (
            <div className="sb-attention-item" key={x[0]}>
              <span className={`sb-attention-icon ${x[3]}`}>
                {i === 0 ? (
                  <FileText />
                ) : i === 1 ? (
                  <PaperPlaneTilt />
                ) : (
                  <CheckCircle />
                )}
              </span>
              <div>
                <b>{x[0]}</b>
                <p>
                  {x[1]} · <span>{x[2]}</span>
                </p>
              </div>
              <button>Review</button>
            </div>
          ))}
        </article>
        <article className="sb-panel">
          <div className="sb-panel-head">
            <div>
              <span className="sb-eyebrow">LIVE ACTIVITY</span>
              <h2>Agent runs</h2>
            </div>
            <button>View runs →</button>
          </div>
          {[
            ["Customer research", "Compiling account brief", "72%", "blue"],
            ["Incident summarization", "Waiting for approval", "", "orange"],
            ["Spreadsheet analysis", "Completed 8 min ago", "", "green"],
          ].map((a) => (
            <div className="sb-run-row" key={a[0]}>
              <span className={`sb-run-dot ${a[3]}`} />
              <div>
                <b>{a[0]}</b>
                <p>{a[1]}</p>
                {a[2] && (
                  <div className="sb-progress">
                    <i style={{ width: a[2] }} />
                  </div>
                )}
              </div>
              <span>
                {a[2] ||
                  (a[3] === "green" ? (
                    <CheckCircle weight="fill" />
                  ) : (
                    <Clock />
                  ))}
              </span>
            </div>
          ))}
        </article>
      </div>
      <div className="sb-work-grid lower">
        <article className="sb-panel">
          <div className="sb-panel-head">
            <div>
              <span className="sb-eyebrow">UP NEXT</span>
              <h2>Reminders</h2>
            </div>
            <button>View all →</button>
          </div>
          <div className="sb-reminder">
            <b>10:30 AM</b>
            <span />
            <div>
              <b>Customer health review</b>
              <p>Acme account and contract</p>
            </div>
          </div>
          <div className="sb-reminder">
            <b>2:00 PM</b>
            <span />
            <div>
              <b>Renewal decision check-in</b>
              <p>Legal · Sales · CS</p>
            </div>
          </div>
        </article>
        <article className="sb-panel">
          <div className="sb-panel-head">
            <div>
              <span className="sb-eyebrow">KNOWLEDGE</span>
              <h2>Recently added</h2>
            </div>
            <button>Open files →</button>
          </div>
          {FILES.slice(0, 3).map((f) => (
            <div className="sb-recent-file" key={f[0]}>
              <span className={`sb-file-icon ${f[1].toLowerCase()}`}>
                {f[1]}
              </span>
              <div>
                <b>{f[0]}</b>
                <p>
                  {f[5]} · {f[3]}
                </p>
              </div>
              <Status>Indexed</Status>
            </div>
          ))}
        </article>
        <article className="sb-panel">
          <div className="sb-panel-head">
            <div>
              <span className="sb-eyebrow">COMPLETED TODAY</span>
              <h2>Recently completed work</h2>
            </div>
            <CheckCircle weight="fill" />
          </div>
          {[
            ["Onboarding follow-up", "Email drafting · 10:14 AM"],
            ["Q2 health score analysis", "Spreadsheet analysis · 9:42 AM"],
            ["July feedback digest", "Meeting summarization · 8:30 AM"],
          ].map(([title, meta]) => (
            <div className="sb-recent-file" key={title}>
              <span className="sb-list-check">
                <CheckCircle weight="fill" />
              </span>
              <div>
                <b>{title}</b>
                <p>{meta}</p>
              </div>
            </div>
          ))}
        </article>
      </div>
    </section>
  );
}

function TaskList({ reminders }) {
  const items = reminders
    ? [
        {
          title: "Customer health review",
          status: "Scheduled",
          priority: "High",
          owner: "Marina",
          due: "Today · 10:30 AM",
          related: "Dataset: Customers",
          origin: "user",
        },
        {
          title: "Renewal decision check-in",
          status: "Scheduled",
          priority: "Medium",
          owner: "Lena",
          due: "Today · 2:00 PM",
          related: "File: Acme MSA",
          origin: "message",
        },
        {
          title: "Prepare team weekly update",
          status: "Upcoming",
          priority: "Medium",
          owner: "Marina",
          due: "Tomorrow · 9:00 AM",
          related: "Skill: Weekly report",
          origin: "agent",
        },
      ]
    : [
        {
          title: "Review Acme obligations & response",
          status: "Needs review",
          priority: "High",
          owner: "Marina",
          due: "Today",
          related: "Message: Acme agreement request",
          origin: "message",
        },
        {
          title: "Prepare customer health briefing",
          status: "In progress",
          priority: "Medium",
          owner: "Jordan",
          due: "Thursday",
          related: "Dataset: Customers",
          origin: "document",
        },
        {
          title: "Approve weekly operations report",
          status: "Waiting",
          priority: "High",
          owner: "Marina",
          due: "Today",
          related: "Agent run: Weekly report",
          origin: "agent",
        },
        {
          title: "Verify Acme account contacts",
          status: "To do",
          priority: "Medium",
          owner: "Lena",
          due: "Friday",
          related: "Skill: Customer research",
          origin: "skill",
        },
      ];
  return (
    <section>
      <PageTitle
        title={reminders ? "Reminders" : "Tasks"}
        text={
          reminders
            ? "Keep important moments visible without losing the context."
            : "All work, whether it started with you, a message, a document, or SkyBao."
        }
        action={reminders ? "New reminder" : "New task"}
      />
      <div className="sb-list-card">
        {items.map((item) => (
          <div className="sb-list-row" key={item.title}>
            <span className={`sb-list-check ${reminders ? "reminder" : ""}`}>
              {reminders ? <Bell /> : <CheckCircle />}
            </span>
            <div>
              <b>{item.title}</b>
              <p>
                Status: {item.status} · Owner: {item.owner} · Due: {item.due} ·
                Related: {item.related} · Origin: {item.origin}
              </p>
            </div>
            <Status tone={item.priority === "High" ? "orange" : "blue"}>
              {item.priority}
            </Status>
            <span className="sb-due">{item.due}</span>
            <IconButton label="Task actions">
              <DotsThree />
            </IconButton>
          </div>
        ))}
      </div>
    </section>
  );
}
function Approvals() {
  const [result, setResult] = useState("");
  return (
    <section>
      <PageTitle
        title="Approvals"
        text="Review AI-proposed actions before they affect your work or external systems."
      />
      <div className="sb-approval-grid">
        {[
          [
            "Draft email",
            "Reply to Acme agreement request",
            "Created from #customer-success · 2 min ago",
            "Email drafting",
          ],
          [
            "Contract summary",
            "Acme MSA obligations summary",
            "Includes 4 highlighted clauses · 19 min ago",
            "Contract review",
          ],
          [
            "Generated report",
            "Weekly operations report",
            "Combines 12 tasks and 8 messages · 34 min ago",
            "Weekly report",
          ],
        ].map((a, i) => (
          <article className="sb-approval-card" key={a[0]}>
            <div>
              <span className={`sb-approval-icon i${i}`}>
                <Sparkle weight="fill" />
              </span>
              <Status tone="orange">Waiting for approval</Status>
            </div>
            <span className="sb-eyebrow">{a[0]}</span>
            <h3>{a[1]}</h3>
            <p>{a[2]}</p>
            <small>Skill: {a[3]}</small>
            <div>
              <button
                className="sb-outline"
                data-capture-id={`work-approval-preview-${i}`}
                onClick={() => setResult(`Previewing ${a[1]}`)}
              >
                Preview
              </button>
              <button
                className="sb-button"
                data-capture-id={`work-approval-approve-${i}`}
                onClick={() =>
                  setResult(`${a[1]} approved — mock action complete`)
                }
              >
                Approve
              </button>
              <button
                className="sb-text-button"
                data-capture-id={`work-approval-reject-${i}`}
                onClick={() =>
                  setResult(`${a[1]} rejected — returned to draft`)
                }
              >
                Reject
              </button>
            </div>
          </article>
        ))}
      </div>
      {result && (
        <div className="sb-action-notice">
          {result}
          <button onClick={() => setResult("")}>
            <X />
          </button>
        </div>
      )}
    </section>
  );
}
function AgentRuns() {
  const [detail, setDetail] = useState(null);
  const runs = [
    [
      "Customer research",
      "Running",
      "72%",
      "Collecting public company signals and account context",
      "blue",
    ],
    [
      "Incident summarization",
      "Waiting for approval",
      "",
      "Drafted executive incident summary",
      "orange",
    ],
    [
      "Spreadsheet analysis",
      "Completed",
      "",
      "Q2 health score analysis is ready",
      "green",
    ],
    [
      "Weekly report generation",
      "Queued",
      "",
      "Will start after source sync",
      "gray",
    ],
    [
      "Document comparison",
      "Failed",
      "",
      "A source file could not be opened",
      "orange",
    ],
  ];
  return (
    <section>
      <PageTitle
        title="Agent runs"
        text="Individual executions of reusable SkyBao skills, with their inputs and activity."
        action="Run a skill"
      />
      <div className="sb-agent-list">
        {runs.map((r, i) => (
          <article className="sb-agent-run" key={r[0]}>
            <span className={`sb-agent-icon ${r[4]}`}>
              <Robot weight="fill" />
            </span>
            <div className="sb-agent-main">
              <div>
                <h3>{r[0]}</h3>
                <Status tone={r[4]}>{r[1]}</Status>
              </div>
              <p>{r[3]}</p>
              <small>
                Skill: {r[0]} · Inputs: 4 sources · Started {i + 2} min ago
              </small>
              {r[2] && (
                <div className="sb-progress">
                  <i style={{ width: r[2] }} />
                </div>
              )}
            </div>
            <button
              className="sb-outline"
              data-capture-id={`work-agent-run-open-${i}`}
              onClick={() => setDetail(r)}
            >
              Open run
            </button>
          </article>
        ))}
      </div>
      {detail && (
        <div className="sb-task-detail">
          <button onClick={() => setDetail(null)}>
            <X />
          </button>
          <span className="sb-eyebrow">AGENT RUN DETAIL</span>
          <h3>{detail[0]}</h3>
          <p>
            State: {detail[1]} · Progress: {detail[2] || "Complete"}
          </p>
          <p>Inputs: 4 connected sources · Output: {detail[3]}</p>
          <p>
            Activity log: started → retrieved sources → produced draft →{" "}
            {detail[1].toLowerCase()}
          </p>
        </div>
      )}
    </section>
  );
}

function AdminView({ sub }) {
  const content = {
    Privacy: [
      "Private by design",
      "Verify where the Acme request was processed and what left the workspace.",
    ],
    Users: ["Users", "Workspace members and their current access."],
    Permissions: [
      "Permissions",
      "Manage workspace roles and access to connected knowledge.",
    ],
    Models: ["Models", "Current model routing and approved AI providers."],
    Deployment: [
      "Deployment",
      "Deployment and compute information for this SkyBao workspace.",
    ],
    System: ["System health", "Live application metrics and connector status."],
  }[sub] || ["Admin", "Manage SkyBao workspace settings."];
  return (
    <section>
      <PageTitle
        title={content[0]}
        text={content[1]}
        action={sub === "Users" ? "Invite user" : undefined}
      />
      <div className="sb-admin-top">
        {[
          ["Processing location", "Local"],
          ["Private model", "Active"],
          ["External AI data transferred", "0 bytes"],
          ["System", "Healthy"],
        ].map((x) => (
          <article key={x[0]}>
            <span>{x[0]}</span>
            <b>{x[1]}</b>
            <small>Protected by Atlas workspace policy</small>
          </article>
        ))}
      </div>
      <div className="sb-admin-grid">
        <article className="sb-panel">
          <div className="sb-panel-head">
            <div>
              <span className="sb-eyebrow">WORKSPACE STATUS</span>
              <h2>
                {sub === "Users" ? "People with access" : "System metrics"}
              </h2>
            </div>
            <Status>Healthy</Status>
          </div>
          {sub === "Users"
            ? [
                ["Marina Brooks", "Owner", "Active now"],
                ["Jordan Chen", "Member", "Active 8 min ago"],
                ["Lena Ortiz", "Reviewer", "Active today"],
                ["SkyBao Service", "Automation", "Active now"],
              ].map((x) => (
                <div className="sb-user-row" key={x[0]}>
                  <span>
                    {x[0]
                      .split(" ")
                      .map((s) => s[0])
                      .join("")}
                  </span>
                  <div>
                    <b>{x[0]}</b>
                    <p>{x[1]}</p>
                  </div>
                  <small>{x[2]}</small>
                  <DotsThree />
                </div>
              ))
            : [
                ["Acme request", "Processed locally", "Completed just now"],
                ["Sources consulted", "3 approved", "No public web sources"],
                ["External transfer", "Blocked", "0 bytes transferred"],
                ["Approval policy", "Enforced", "Marina reviewed the action"],
              ].map((x) => (
                <div className="sb-admin-row" key={x[0]}>
                  <div>
                    <b>{x[0]}</b>
                    <p>{x[2]}</p>
                  </div>
                  <strong>{x[1]}</strong>
                </div>
              ))}
        </article>
        <article className="sb-panel">
          <div className="sb-panel-head">
            <div>
              <span className="sb-eyebrow">CONNECTED SERVICES</span>
              <h2>Health checks</h2>
            </div>
            <button>View logs →</button>
          </div>
          {[
            ["Private model", "Active", "green"],
            ["Knowledge indexing", "Operational", "green"],
            ["Google Drive sync", "Operational", "green"],
            ["PostgreSQL sync", "Operational", "green"],
            ["Local compute", "Available", "green"],
          ].map((x) => (
            <div className="sb-health-row" key={x[0]}>
              <span className={`sb-run-dot ${x[2]}`} />
              <b>{x[0]}</b>
              <Status tone={x[2]}>{x[1]}</Status>
            </div>
          ))}
        </article>
      </div>
    </section>
  );
}

function SkillPanel({ skill, close }) {
  if (!skill) return null;
  return (
    <aside className="sb-drawer">
      <div className="sb-drawer-head">
        <div>
          <span className="sb-skill-icon i0">
            <Robot weight="fill" />
          </span>
          <div>
            <span className="sb-eyebrow">SKILL CONFIGURATION</span>
            <h2>{skill[0]}</h2>
          </div>
        </div>
        <IconButton
          label="Close skill"
          onClick={close}
          data-capture-id="knowledge-skill-close"
        >
          <X />
        </IconButton>
      </div>
      <div className="sb-config-section">
        <b>Instructions</b>
        <p>
          {skill[1]} This mocked configuration gives SkyBao a focused, reusable
          approach while preserving the workspace’s approval rules.
        </p>
      </div>
      <div className="sb-config-section">
        <b>Connected knowledge sources</b>
        <div className="sb-config-tags">
          <span>Contracts collection</span>
          <span>Google Drive</span>
          <span>Legal playbook</span>
        </div>
      </div>
      <div className="sb-config-section">
        <b>Required tools</b>
        <div className="sb-config-row">
          <span>Document retrieval</span>
          <Status>Enabled</Status>
        </div>
        <div className="sb-config-row">
          <span>Source citations</span>
          <Status>Enabled</Status>
        </div>
      </div>
      <div className="sb-config-section">
        <b>Output format</b>
        <select defaultValue="Structured review">
          <option>Structured review</option>
          <option>Executive summary</option>
          <option>Draft email</option>
        </select>
      </div>
      <div className="sb-config-section">
        <b>Approval rules</b>
        <div className="sb-approval-rule">
          <CheckCircle weight="fill" />
          <span>
            {skill[3] === "Approval required"
              ? "Require human approval before an external action."
              : "No approval required for internal drafts."}
          </span>
        </div>
      </div>
      <button className="sb-button wide" data-capture-id="knowledge-skill-save">
        Save configuration
      </button>
    </aside>
  );
}

export default function NativeArea({ area }) {
  const navigate = useNavigate();
  const { search } = useLocation();
  const capture = useCapture();
  const searchParams = useMemo(() => new URLSearchParams(search), [search]);
  const requestedSub = searchParams.get("view");
  const validSub = AREAS.find((item) => item.id === area)?.children.includes(
    requestedSub
  )
    ? requestedSub
    : null;
  const transparent =
    capture.transparent || searchParams.get("capture") === "transparent";
  const includeAcmeTask = searchParams.get("created") === "1";
  const [sub, setSub] = useState(
    validSub || AREAS.find((item) => item.id === area)?.children[0] || "Files"
  );
  const [askOpen, setAskOpen] = useState(false);
  const [skill, setSkill] = useState(null);
  const [toast, setToast] = useState("");
  const [askMessage, setAskMessage] = useState("");
  const openAcmeStory = useCallback(() => {
    const params = new URLSearchParams({ demo: "acme", autoplay: "1" });
    if (transparent) params.set("capture", "transparent");
    if (capture.artifact) {
      params.set("artifact", "1");
      params.set("framing", capture.framing);
      params.set("state", "assistant-research");
    }
    navigate(`/?${params.toString()}`);
  }, [capture.artifact, capture.framing, navigate, transparent]);
  const createTaskFromMessage = useCallback(() => {
    sessionStorage.setItem(
      "skybao_acme_story_task",
      JSON.stringify({ state: "created", createdAt: Date.now() })
    );
    const params = new URLSearchParams({
      view: "Board",
      created: "1",
      focus: "acme",
    });
    if (transparent) params.set("capture", "transparent");
    if (capture.artifact) {
      params.set("artifact", "1");
      params.set("framing", capture.framing);
      params.set("state", "work-board-detail");
    }
    navigate(`/work?${params.toString()}`);
  }, [capture.artifact, capture.framing, navigate, transparent]);
  const submitAsk = async () => {
    if (!askMessage.trim()) return;
    sessionStorage.setItem(
      PENDING_HOME_MESSAGE,
      JSON.stringify({ message: askMessage.trim(), attachments: [] })
    );
    const workspaces = await Workspace.all();
    if (workspaces.length > 0) {
      navigate(paths.workspace.chat(workspaces[0].slug));
    } else {
      setToast("Create or join a workspace before sending a SkyBao question.");
      setAskOpen(true);
    }
    setAskMessage("");
  };
  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setAskOpen(true);
      }
      if (event.key === "Escape") {
        setAskOpen(false);
        setSkill(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => {
    setSub(
      validSub || AREAS.find((item) => item.id === area)?.children[0] || "Files"
    );
    setSkill(null);
  }, [area, validSub]);
  useEffect(() => {
    if (!capture.artifact) return;
    setAskOpen(capture.state === "global-ask-open");
    setAskMessage("");
    setToast("");
    setSkill(capture.state === "knowledge-skill-open" ? SKILLS[0] : null);
  }, [capture.artifact, capture.state]);
  const view = useMemo(() => {
    if (area === "knowledge")
      return <KnowledgeView sub={sub} setSkill={setSkill} />;
    if (area === "communications")
      return (
        <CommunicationsView
          sub={sub}
          onAsk={openAcmeStory}
          onCreateTask={createTaskFromMessage}
        />
      );
    if (area === "work")
      return (
        <WorkView
          sub={sub}
          includeAcmeTask={includeAcmeTask}
          captureState={capture.state}
        />
      );
    return <AdminView sub={sub} />;
  }, [
    area,
    capture.state,
    createTaskFromMessage,
    includeAcmeTask,
    openAcmeStory,
    sub,
  ]);
  return (
    <main
      data-capture-id="native-area-root"
      data-capture-area={area}
      data-capture-view={sub}
      className={`sb-shell sb-native-area ${
        transparent ? "sb-capture-transparent" : ""
      }`}
    >
      <header className="sb-native-head">
        <div>
          <span className="sb-eyebrow">SKYBAO WORKSPACE</span>
          <h1>{AREAS.find((item) => item.id === area)?.label}</h1>
        </div>
        <nav className="sb-native-tabs" aria-label={`${area} navigation`}>
          {AREAS.find((item) => item.id === area)?.children.map((item) => (
            <button
              key={item}
              className={sub === item ? "selected" : ""}
              data-capture-id={`native-tab-${item.toLowerCase().replaceAll(" ", "-")}`}
              onClick={() => setSub(item)}
            >
              {item}
            </button>
          ))}
        </nav>
      </header>
      <div className="sb-content">{view}</div>
      <button
        className={`sb-ask-float ${askOpen ? "open" : ""}`}
        data-capture-id="global-ask-toggle"
        onClick={() => setAskOpen(!askOpen)}
      >
        <span>
          <Sparkle weight="fill" />
        </span>{" "}
        Ask SkyBao <kbd>⌘K</kbd>
      </button>
      {askOpen && (
        <div className="sb-ask-popover">
          <button
            className="sb-popover-close"
            onClick={() => setAskOpen(false)}
          >
            <X />
          </button>
          <div className="sb-sky-avatar">
            <Sparkle weight="fill" />
          </div>
          <b>Ask SkyBao</b>
          <p>{toast || "I’m ready to help with the context on this screen."}</p>
          <input
            data-capture-id="global-ask-input"
            autoFocus
            value={askMessage}
            onChange={(event) => setAskMessage(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && submitAsk()}
            placeholder="Ask about anything in SkyBao…"
          />
          <button
            className="sb-send"
            data-capture-id="global-ask-send"
            onClick={submitAsk}
          >
            <PaperPlaneTilt weight="fill" />
          </button>
        </div>
      )}
      <SkillPanel skill={skill} close={() => setSkill(null)} />
      <CaptureNavigationDrawer area={area} />
    </main>
  );
}
