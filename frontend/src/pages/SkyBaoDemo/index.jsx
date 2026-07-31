import React, { useEffect, useMemo, useState } from "react";
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
  BookOpen,
  Robot,
  CheckCircle,
  ChatCircleDots,
  Clock,
  Database,
  DotsThree,
  FileText,
  Folder,
  GearSix,
  Layout,
  MagnifyingGlass,
  PaperPlaneTilt,
  Plus,
  Sparkle,
  Stack,
  X,
} from "@phosphor-icons/react";
import { useDraggable } from "@dnd-kit/core";
import "./styles.css";

const AREAS = [
  {
    id: "assistant",
    label: "Assistant",
    icon: ChatCircleDots,
    children: ["Chat", "History"],
  },
  {
    id: "knowledge",
    label: "Knowledge",
    icon: BookOpen,
    children: ["Files", "Collections", "Data", "Connections", "Skills"],
  },
  {
    id: "communications",
    label: "Communications",
    icon: PaperPlaneTilt,
    children: ["Inbox", "Slack"],
  },
  {
    id: "work",
    label: "Work",
    icon: Layout,
    children: [
      "Overview",
      "Board",
      "Tasks",
      "Reminders",
      "Approvals",
      "Agent runs",
    ],
  },
  {
    id: "admin",
    label: "Admin",
    icon: GearSix,
    children: [
      "Privacy",
      "Users",
      "Permissions",
      "Models",
      "Deployment",
      "System",
    ],
  },
];

const FILES = [
  [
    "FY25 Renewal Strategy.pdf",
    "PDF",
    "2.4 MB",
    "Today, 10:42",
    "Ready",
    "Revenue / Planning",
    "Google Drive",
  ],
  [
    "Q2 customer health.xlsx",
    "XLSX",
    "684 KB",
    "Today, 9:18",
    "Ready",
    "Customer Success",
    "Local upload",
  ],
  [
    "Master services agreement.docx",
    "DOCX",
    "1.8 MB",
    "Yesterday",
    "Ready",
    "Legal",
    "Microsoft 365",
  ],
  [
    "Product feedback export.csv",
    "CSV",
    "482 KB",
    "Jul 28",
    "Indexing",
    "Research",
    "Slack export",
  ],
  [
    "On-call handoff.txt",
    "TXT",
    "18 KB",
    "Jul 27",
    "Ready",
    "Engineering",
    "Local upload",
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
      title: "Review renewal terms for Northstar",
      meta: "Legal · Today",
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
      title: "Draft Q2 incident report",
      meta: "Incident summary · 70%",
      priority: "High",
      avatar: "AI",
    },
    {
      id: "t4",
      title: "Research Acme expansion",
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

function PageTitle({ title, text, action, onAction }) {
  return (
    <header className="sb-page-head">
      <div>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
      {action && (
        <button className="sb-button" onClick={onAction} disabled={!onAction}>
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

function SideNav({ area, setArea, sub, setSub }) {
  return (
    <>
      <aside className="sb-sidebar">
        <div className="sb-brand">
          <span className="sb-brand-mark">
            <Sparkle weight="fill" />
          </span>
          <span>skybao</span>
          <b>•</b>
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

function AssistantView({ onAsk }) {
  const [message, setMessage] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [attachment, setAttachment] = useState("");
  const [source, setSource] = useState("Atlas knowledge · 24 sources");
  const [preview, setPreview] = useState("");
  const submit = (value = message) => {
    if (!value.trim()) return;
    setSubmitted(value.trim());
    setMessage("");
  };
  const reset = () => {
    setMessage("");
    setSubmitted("");
    setAttachment("");
    setPreview("");
  };
  return (
    <div className="sb-assistant-view">
      <header className="sb-page-head sb-assistant-head">
        <div>
          <div className="sb-eyebrow">
            ATLAS WORKSPACE <span>•</span> ALL CONNECTED SOURCES
          </div>
          <h1>What can I help you move forward?</h1>
          <p>
            SkyBao can reason across your documents, messages, datasets, and
            approved skills.
          </p>
        </div>
        <button className="sb-button" onClick={reset}>
          <Plus size={17} /> New conversation
        </button>
      </header>
      <section className="sb-chat-card">
        <div className="sb-conversation">
          <div className="sb-sky-avatar">
            <Sparkle weight="fill" />
          </div>
          <div>
            <p className="sb-chat-label">SKYBAO</p>
            <h3>Good morning, Marina.</h3>
            <p>
              I’ve found three items that need a decision today. I can prepare
              the context, draft the response, or turn them into work.
            </p>
            <div className="sb-source-chip-row">
              <button onClick={() => setPreview("Q2 customer health.xlsx")}>
                ↗ Q2 customer health.xlsx
              </button>
              <button onClick={() => setPreview("FY25 Renewal Strategy.pdf")}>
                ↗ FY25 Renewal Strategy.pdf
              </button>
            </div>
          </div>
        </div>
        {submitted && <div className="sb-user-message">{submitted}</div>}
        {submitted && (
          <div className="sb-ai-reply">
            <div className="sb-sky-avatar small">
              <Sparkle weight="fill" />
            </div>
            <div>
              <p>
                I’m grounding this in your connected knowledge. The renewal plan
                identifies Northstar’s July 31 decision date, while the health
                workbook flags adoption as the only open risk.
              </p>
              <button
                className="sb-citation"
                onClick={() => setPreview("FY25 Renewal Strategy.pdf")}
              >
                <FileText /> <span>FY25 Renewal Strategy.pdf</span>
                <small>p. 4 · Click to preview</small>
              </button>
              <button
                className="sb-text-button"
                onClick={() => onAsk("Create a review task for Northstar")}
              >
                Create review task <span>→</span>
              </button>
            </div>
          </div>
        )}
        <div className="sb-composer">
          <button
            className="sb-attach"
            aria-label="Attach file"
            onClick={() => setAttachment(attachment ? "" : "Q2 notes.pdf")}
          >
            <Plus size={20} />
          </button>
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Ask SkyBao anything…"
          />
          <button className="sb-send" onClick={() => submit()}>
            <PaperPlaneTilt weight="fill" />
          </button>
        </div>
        <div className="sb-composer-bottom">
          <label className="sb-source-select">
            <Stack size={14} />
            <select
              value={source}
              onChange={(event) => setSource(event.target.value)}
            >
              <option>Atlas knowledge · 24 sources</option>
              <option>Customer Success collection</option>
              <option>Legal collection</option>
            </select>
          </label>
          <span>⌘ ↵ to send</span>
        </div>
        {attachment && (
          <div className="sb-attachment-state">
            <FileText /> {attachment}
            <button
              onClick={() => setAttachment("")}
              aria-label="Remove attachment"
            >
              <X />
            </button>
          </div>
        )}
      </section>
      <div className="sb-suggested">
        <span>Try asking</span>
        {[
          "What needs my review?",
          "Draft a reply to the Acme thread",
          "Compare the two contract versions",
        ].map((t) => (
          <button key={t} onClick={() => submit(t)}>
            {t} <span>→</span>
          </button>
        ))}
      </div>
      {preview && (
        <SourcePreview title={preview} close={() => setPreview("")} />
      )}
    </div>
  );
}

function SourcePreview({ title, close }) {
  return (
    <div
      className="sb-source-preview"
      role="dialog"
      aria-label={`${title} preview`}
    >
      <button onClick={close} aria-label="Close preview">
        <X />
      </button>
      <span className="sb-eyebrow">SOURCE PREVIEW</span>
      <h3>{title}</h3>
      <p>
        Northstar’s renewal decision is due July 31. The attached source
        highlights adoption and expansion terms as the remaining discussion
        points.
      </p>
      <small>Google Drive · Indexed today · Clickable source preview</small>
    </div>
  );
}

function AssistantHistory({ onOpen }) {
  const history = [
    ["Northstar renewal plan", "Today · 10:42 AM", "4 cited sources"],
    ["Acme escalation reply", "Yesterday · 3:20 PM", "Slack + email"],
    ["Q2 health score analysis", "Jul 28", "Customer dataset"],
  ];
  return (
    <section>
      <PageTitle
        title="Conversation history"
        text="Recent work across your connected knowledge."
        action="New conversation"
        onAction={() => onOpen("New conversation started")}
      />
      <div className="sb-list-card">
        {history.map((item) => (
          <button
            className="sb-history-row"
            key={item[0]}
            onClick={() => onOpen(`Opened ${item[0]}`)}
          >
            <ChatCircleDots />
            <div>
              <b>{item[0]}</b>
              <p>{item[2]}</p>
            </div>
            <small>{item[1]}</small>
          </button>
        ))}
      </div>
    </section>
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
              "42 files",
              "Health scores, success plans, renewal notes",
            ],
            ["Legal", "28 files", "Contracts, redlines, and policy guidance"],
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
        text="Search, preview, and manage the documents that power SkyBao."
        action="Upload files"
        onAction={() => setUploaded(true)}
      />
      <div className="sb-toolbar">
        <div className="sb-search">
          <MagnifyingGlass />
          <input
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
        ["Northstar", "Enterprise", "Healthy", "$124,000"],
        ["Acme Co.", "Enterprise", "At risk", "$96,000"],
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
        ["Northstar MSA", "Renewal", "Jul 31", "In review"],
        ["Acme DPA", "New", "Aug 12", "Waiting"],
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
        ["INV-1942", "Northstar", "$31,000", "Paid"],
        ["INV-1943", "Acme Co.", "$24,000", "Due Aug 1"],
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
        ["Renewal readiness", "Marina", "Jul 31", "At risk"],
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
        ["SUP-4031", "Acme Co.", "High", "Open"],
        ["SUP-4029", "Northstar", "Medium", "Investigating"],
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
          ].map((d) => (
            <button
              className={dataset === d ? "selected" : ""}
              onClick={() => setDataset(d)}
              key={d}
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

function CommunicationsView({ sub }) {
  const [selected, setSelected] = useState(0);
  const [draft, setDraft] = useState(false);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("All sources");
  const [priority, setPriority] = useState("Priority");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState(false);
  const messages = [
    [
      "Gmail",
      "Northstar renewal — updated terms",
      "Lena Ortiz",
      "The legal team has included the proposed renewal language. Can you confirm…",
      "10:42 AM",
      true,
    ],
    [
      "Slack",
      "#customer-success · Acme escalation",
      "Jordan Chen",
      "I added the latest health notes. We need a customer response before EOD.",
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
          value={priority}
          onChange={(event) => {
            setPriority(event.target.value);
            setSelected(0);
          }}
        >
          <option>Priority</option>
          <option>Priority only</option>
        </select>
        <span className="sb-unread">5 unread</span>
      </div>
      <div className="sb-mail-layout">
        <div className="sb-thread-list">
          {visible.map((m, i) => (
            <button
              className={`sb-thread ${i === selected ? "selected" : ""}`}
              onClick={() => setSelected(i)}
              key={m[1]}
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
              {current[3]} I’ve attached the relevant context and the decision
              we need from your team. Let me know if you would like us to set up
              a short working session.
            </p>
            <div className="sb-thread-summary">
              <div>
                <Sparkle weight="fill" />
                <b>SkyBao summary</b>
              </div>
              <p>
                Northstar needs confirmation on the revised renewal terms. The
                only unresolved item is the expansion option language.
              </p>
              <button onClick={() => setPreview(true)}>
                View cited context <span>→</span>
              </button>
            </div>
            {draft ? (
              <div className="sb-draft">
                <b>Suggested reply</b>
                <textarea defaultValue="Thanks, Lena — I’ll review the expansion language with the team today and confirm our position by 3 PM." />
                <div>
                  <button
                    className="sb-outline"
                    onClick={() => {
                      setDraft(false);
                      setNotice("Draft saved");
                    }}
                  >
                    Save draft
                  </button>
                  <button
                    className="sb-button"
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
                <button className="sb-button" onClick={() => setDraft(true)}>
                  <Sparkle weight="fill" /> Draft reply
                </button>
                <button
                  className="sb-outline"
                  onClick={() => setNotice("Task created from this message")}
                >
                  Convert to task
                </button>
                <button
                  className="sb-text-button"
                  onClick={() =>
                    setNotice("SkyBao opened with this conversation")
                  }
                >
                  Ask SkyBao about this conversation →
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
          title="Northstar renewal context"
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
      style={{ transform: CSS.Translate.toString(transform) }}
      className={`sb-task-card ${isDragging ? "dragging" : ""}`}
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
      <button className="sb-task-title" onClick={() => onOpen(task)}>
        {task.title}
      </button>
      <p>{task.meta}</p>
      <div className="sb-task-bottom">
        <span className={`sb-mini-avatar ${task.avatar === "AI" ? "ai" : ""}`}>
          {task.avatar}
        </span>
        {task.meta.includes("Today") && <span>◷ Today</span>}
      </div>
    </article>
  );
}
function BoardColumn({ id, title, tasks, onOpen }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <section
      ref={setNodeRef}
      className={`sb-board-column ${isOver ? "over" : ""}`}
    >
      <div className="sb-board-header">
        <div>
          <span className={`sb-column-dot ${id}`} />
          <b>{title}</b>
          <small>{tasks.length}</small>
        </div>
        <IconButton label={`Add to ${title}`}>
          <Plus />
        </IconButton>
      </div>
      <div className="sb-board-tasks">
        {tasks.map((t) => (
          <TaskCard task={t} key={t.id} onOpen={onOpen} />
        ))}
      </div>
      <button className="sb-add-task">
        <Plus /> Add task
      </button>
    </section>
  );
}

function WorkView({ sub }) {
  const [tasks, setTasks] = useState(INITIAL_TASKS);
  const [active, setActive] = useState(null);
  const [detail, setDetail] = useState(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  );
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
          text="Drag work between stages to keep the day moving."
          action="New task"
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
            />
            <BoardColumn
              id="progress"
              title="In progress"
              tasks={tasks.progress}
              onOpen={setDetail}
            />
            <BoardColumn
              id="review"
              title="Needs review"
              tasks={tasks.review}
              onOpen={setDetail}
            />
            <BoardColumn
              id="complete"
              title="Complete"
              tasks={tasks.complete}
              onOpen={setDetail}
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
          <div className="sb-task-detail">
            <button onClick={() => setDetail(null)}>
              <X />
            </button>
            <span className="sb-eyebrow">TASK DETAIL</span>
            <h3>{detail.title}</h3>
            <p>
              Status:{" "}
              {Object.keys(tasks).find((key) =>
                tasks[key].some((task) => task.id === detail.id)
              )}{" "}
              · Priority: {detail.priority}
            </p>
            <p>
              Owner: {detail.avatar} · Due:{" "}
              {detail.meta.includes("Today") ? "Today" : "This week"}
            </p>
            <p>
              Related item: {detail.meta} · Origin:{" "}
              {detail.avatar === "AI" ? "agent" : "user"}
            </p>
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
              "Review Northstar renewal terms",
              "Contract review",
              "Today · 2:00 PM",
              "orange",
            ],
            [
              "Reply to Acme escalation",
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
              <p>Northstar & Acme accounts</p>
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
          related: "File: Northstar MSA",
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
          title: "Review Northstar renewal terms",
          status: "Needs review",
          priority: "High",
          owner: "Marina",
          due: "Today",
          related: "Message: Northstar renewal",
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
          title: "Research Acme expansion",
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
            "Reply to Acme escalation",
            "Created from #customer-success · 2 min ago",
            "Email drafting",
          ],
          [
            "Contract summary",
            "Northstar MSA renewal summary",
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
                onClick={() => setResult(`Previewing ${a[1]}`)}
              >
                Preview
              </button>
              <button
                className="sb-button"
                onClick={() =>
                  setResult(`${a[1]} approved — mock action complete`)
                }
              >
                Approve
              </button>
              <button
                className="sb-text-button"
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
            <button className="sb-outline" onClick={() => setDetail(r)}>
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
      "Privacy & data",
      "Monitored SkyBao application metrics for how information is processed and transferred.",
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
          ["Processing location", "US West · monitored application setting"],
          ["Active model", "SkyBao Reasoning · Balanced"],
          ["External AI requests", "18 today"],
          ["External AI data transferred", "42.6 MB today"],
        ].map((x) => (
          <article key={x[0]}>
            <span>{x[0]}</span>
            <b>{x[1]}</b>
            <small>Observed by SkyBao</small>
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
                ["Indexed documents", "1,248", "+18 this week"],
                ["Storage usage", "48.2 GB of 100 GB", "48% used"],
                ["Last successful sync", "2 minutes ago", "All core sources"],
                ["Server status", "Operational", "99.98% last 30 days"],
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
            ["Knowledge indexing", "Operational", "green"],
            ["Google Drive sync", "Operational", "green"],
            ["Microsoft 365 sync", "Syncing", "blue"],
            ["Slack connector", "Attention required", "orange"],
            ["GPU / compute", "Available", "green"],
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
        <IconButton label="Close skill" onClick={close}>
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
      <button className="sb-button wide">Save configuration</button>
    </aside>
  );
}

export default function SkyBaoDemo() {
  const [area, setArea] = useState("assistant");
  const [sub, setSub] = useState("Chat");
  const [askOpen, setAskOpen] = useState(false);
  const [skill, setSkill] = useState(null);
  const [toast, setToast] = useState("");
  const [askMessage, setAskMessage] = useState("");
  const ask = (text) => {
    setAskOpen(true);
    setToast(text);
  };
  const submitAsk = () => {
    if (!askMessage.trim()) return;
    setToast(`SkyBao: I found relevant context for “${askMessage.trim()}”.`);
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
  const view = useMemo(() => {
    if (area === "assistant")
      return sub === "History" ? (
        <AssistantHistory onOpen={ask} />
      ) : (
        <AssistantView onAsk={ask} />
      );
    if (area === "knowledge")
      return <KnowledgeView sub={sub} setSkill={setSkill} />;
    if (area === "communications") return <CommunicationsView sub={sub} />;
    if (area === "work") return <WorkView sub={sub} />;
    return <AdminView sub={sub} />;
  }, [area, sub]);
  return (
    <main className="sb-shell">
      <SideNav area={area} setArea={setArea} sub={sub} setSub={setSub} />
      <div className="sb-main">
        <header className="sb-topbar">
          <div className="sb-breadcrumb">
            <span>{AREAS.find((a) => a.id === area)?.label}</span>
            <b>/</b>
            <strong>{sub}</strong>
          </div>
          <div>
            <IconButton label="Search workspace">
              <MagnifyingGlass />
            </IconButton>
            <IconButton label="Notifications" className="has-dot">
              <Bell />
            </IconButton>
            <button className="sb-help">?</button>
          </div>
        </header>
        <div className="sb-content">{view}</div>
      </div>
      <button
        className={`sb-ask-float ${askOpen ? "open" : ""}`}
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
            autoFocus
            value={askMessage}
            onChange={(event) => setAskMessage(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && submitAsk()}
            placeholder="Ask about anything in SkyBao…"
          />
          <button className="sb-send" onClick={submitAsk}>
            <PaperPlaneTilt weight="fill" />
          </button>
        </div>
      )}
      <SkillPanel skill={skill} close={() => setSkill(null)} />
    </main>
  );
}
