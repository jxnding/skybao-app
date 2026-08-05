import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  CheckCircle,
  Database,
  FileText,
  PaperPlaneTilt,
  Sparkle,
  Stack,
  X,
} from "@phosphor-icons/react";
import WorkspaceFrame, { WorkspaceSurface } from "@/components/WorkspaceFrame";
import { ACME_STORY_PROMPT } from "./storyData";
import { useCapture } from "./capture";
import CaptureNavigationDrawer from "./CaptureNavigationDrawer";
import "./styles.css";

const RESEARCH_STEPS = [
  ["Acme Master Services Agreement.pdf", "Contract · page 12"],
  ["Acme agreement email thread", "Gmail · 8 messages"],
  ["Acme customer record", "PostgreSQL · synced 2 min ago"],
  ["Contract review", "Approved company skill"],
];

const RESPONSE =
  "Under section 7.2 of the Acme agreement, Atlas must provide 30 days’ written notice before a material service change. The Security Addendum also requires incident notice within 24 hours and written approval before a new subcontractor can access Acme data. I found no conflicting terms in the account record or prior email thread. I’ve prepared a concise response confirming both obligations and routed the external send to Marina for approval.";

const DEFAULT_DRAFT = `Hi Priya,

We reviewed the Acme agreement and can confirm that Atlas will provide 30 days’ written notice before any material service change. We will also continue to provide incident notice within 24 hours and obtain written approval before authorizing a new subcontractor to access Acme data.

Please let me know if you would like the relevant clauses attached.

Best,
Marina`;

function StorySourcePreview({ source, onClose }) {
  if (!source) return null;
  return (
    <aside
      className="sb-source-preview sb-story-source-preview"
      role="dialog"
      aria-label={`${source.title} preview`}
    >
      <button
        onClick={onClose}
        aria-label="Close source preview"
        data-capture-id="assistant-source-close"
      >
        <X />
      </button>
      <span className="sb-eyebrow">CITED SOURCE</span>
      <h3>{source.title}</h3>
      <small>{source.meta}</small>
      <blockquote>
        “Provider will give Customer no less than{" "}
        <mark>thirty (30) days’ written notice</mark> before implementing a
        material change to the Services.”
      </blockquote>
      <p>
        SkyBao matched this passage to the request and checked it against the
        Security Addendum and the latest customer record.
      </p>
    </aside>
  );
}

export default function AssistantStory() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const capture = useCapture();
  const autoplay = searchParams.get("autoplay") === "1";
  const transparent =
    capture.transparent || searchParams.get("capture") === "transparent";
  const [message, setMessage] = useState(ACME_STORY_PROMPT);
  const [question, setQuestion] = useState("");
  const [phase, setPhase] = useState("idle");
  const [visibleSteps, setVisibleSteps] = useState(0);
  const [typedResponse, setTypedResponse] = useState("");
  const [runId, setRunId] = useState(0);
  const [draftOpen, setDraftOpen] = useState(false);
  const [draft, setDraft] = useState(DEFAULT_DRAFT);
  const [source, setSource] = useState(null);
  const autoplayed = useRef(false);

  const tokens = useMemo(() => RESPONSE.split(/(\s+)/), []);

  const submit = useCallback((value) => {
    const nextQuestion = value.trim();
    if (!nextQuestion) return;
    setQuestion(nextQuestion);
    setMessage("");
    setVisibleSteps(0);
    setTypedResponse("");
    setDraftOpen(false);
    setPhase("research");
    setRunId((current) => current + 1);
  }, []);

  useEffect(() => {
    if (capture.artifact || !autoplay || autoplayed.current) return;
    autoplayed.current = true;
    const timer = window.setTimeout(() => submit(ACME_STORY_PROMPT), 550);
    return () => window.clearTimeout(timer);
  }, [autoplay, capture.artifact, submit]);

  useEffect(() => {
    if (!capture.artifact) return;

    const state = capture.state || "assistant-idle";
    setMessage(ACME_STORY_PROMPT);
    setQuestion("");
    setPhase("idle");
    setVisibleSteps(0);
    setTypedResponse("");
    setDraftOpen(false);
    setDraft(DEFAULT_DRAFT);
    setSource(null);

    if (state === "assistant-idle") return;

    setMessage("");
    setQuestion(ACME_STORY_PROMPT);
    if (state === "assistant-research") {
      setPhase("research");
      return;
    }
    if (state === "assistant-answer-typing") {
      setPhase("typing");
      return;
    }

    setPhase("done");
    setTypedResponse(RESPONSE);
  }, [capture.artifact, capture.state]);

  useEffect(() => {
    if (!capture.artifact) return;
    if (capture.state === "assistant-research") {
      setVisibleSteps(
        Math.min(
          RESEARCH_STEPS.length,
          Math.max(0, Math.floor((capture.frame - 10) / 24) + 1)
        )
      );
      return;
    }
    if (capture.state !== "assistant-answer-typing") return;

    const lastFrame = 179;
    const progress = Math.min(1, capture.frame / lastFrame);
    const visibleTokenCount = Math.floor(progress * tokens.length);
    setTypedResponse(tokens.slice(0, visibleTokenCount).join(""));
    setPhase(capture.frame >= lastFrame ? "done" : "typing");
  }, [capture.artifact, capture.frame, capture.state, tokens]);

  useEffect(() => {
    if (capture.artifact || !runId || phase !== "research") return;
    const timers = RESEARCH_STEPS.map((_, index) =>
      window.setTimeout(() => setVisibleSteps(index + 1), 320 + index * 430)
    );
    timers.push(
      window.setTimeout(
        () => setPhase("typing"),
        320 + RESEARCH_STEPS.length * 430
      )
    );
    return () => timers.forEach(window.clearTimeout);
  }, [capture.artifact, phase, runId]);

  useEffect(() => {
    if (capture.artifact || phase !== "typing") return;
    let index = 0;
    const timer = window.setInterval(() => {
      index += 1;
      setTypedResponse(tokens.slice(0, index).join(""));
      if (index >= tokens.length) {
        window.clearInterval(timer);
        setPhase("done");
      }
    }, 24);
    return () => window.clearInterval(timer);
  }, [capture.artifact, phase, tokens]);

  const reset = () => {
    setMessage(ACME_STORY_PROMPT);
    setQuestion("");
    setPhase("idle");
    setVisibleSteps(0);
    setTypedResponse("");
    setDraftOpen(false);
    setSource(null);
  };

  const createTask = () => {
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
  };

  const isWorking = phase === "research" || phase === "typing";

  return (
    <WorkspaceFrame className="min-w-0 flex-1 overflow-hidden">
      <WorkspaceSurface
        bordered
        className={`overflow-y-auto ${transparent ? "sb-capture-surface" : ""}`}
      >
        <main
          data-capture-id="assistant-root"
          className={`sb-shell sb-native-area sb-assistant-story ${
            transparent ? "sb-capture-transparent" : ""
          }`}
        >
          <header className="sb-native-head">
            <div>
              <span className="sb-eyebrow">SKYBAO WORKSPACE</span>
              <h1>Assistant</h1>
            </div>
            <div className="sb-story-context">
              <span className="sb-story-live-dot" />
              Atlas knowledge
              <b>568 sources</b>
            </div>
          </header>
          <div className="sb-content">
            <div className="sb-assistant-view">
              <header className="sb-page-head sb-assistant-head">
                <div>
                  <div className="sb-eyebrow">
                    ACME AGREEMENT <span>•</span> PRIVATE WORKSPACE
                  </div>
                  <h1>Turn company knowledge into action.</h1>
                  <p>
                    SkyBao can reason across approved documents, messages,
                    business data, and company skills.
                  </p>
                </div>
                <button
                  className="sb-outline"
                  onClick={reset}
                  data-capture-id="assistant-new-conversation"
                >
                  New conversation
                </button>
              </header>

              <section className="sb-chat-card sb-story-chat-card">
                {!question && (
                  <div className="sb-conversation">
                    <div className="sb-sky-avatar">
                      <Sparkle weight="fill" />
                    </div>
                    <div>
                      <p className="sb-chat-label">SKYBAO</p>
                      <h3>I’m ready to research the Acme request.</h3>
                      <p>
                        I’ll use only sources approved for the Atlas workspace
                        and keep any external action behind human review.
                      </p>
                      <div className="sb-source-chip-row">
                        <button onClick={() => setMessage(ACME_STORY_PROMPT)}>
                          <FileText /> Acme agreement
                        </button>
                        <button onClick={() => setMessage(ACME_STORY_PROMPT)}>
                          <Stack /> Contract-review skill
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {question && <div className="sb-user-message">{question}</div>}

                {phase === "research" && (
                  <div className="sb-story-research" aria-live="polite">
                    <div className="sb-sky-avatar small">
                      <Sparkle weight="fill" />
                    </div>
                    <div>
                      <p className="sb-chat-label">
                        RESEARCHING APPROVED SOURCES
                      </p>
                      <div className="sb-story-research-grid">
                        {RESEARCH_STEPS.map(([title, meta], index) => (
                          <div
                            className={index < visibleSteps ? "complete" : ""}
                            key={title}
                          >
                            {index < visibleSteps ? (
                              <CheckCircle weight="fill" />
                            ) : (
                              <span className="sb-story-spinner" />
                            )}
                            <span>
                              <b>{title}</b>
                              <small>{meta}</small>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {(phase === "typing" || phase === "done") && (
                  <div className="sb-ai-reply sb-story-answer">
                    <div className="sb-sky-avatar small">
                      <Sparkle weight="fill" />
                    </div>
                    <div>
                      <p className="sb-chat-label">GROUNDED ANSWER</p>
                      <h3>Acme’s obligations are confirmed.</h3>
                      <p className="sb-story-typed-copy">
                        {typedResponse}
                        {phase === "typing" && (
                          <span className="sb-story-caret" aria-hidden="true" />
                        )}
                      </p>

                      {phase === "done" && (
                        <>
                          <div className="sb-obligation-grid">
                            <div>
                              <CheckCircle weight="fill" />
                              <span>
                                <b>30-day notice</b>
                                <small>Material service changes</small>
                              </span>
                            </div>
                            <div>
                              <CheckCircle weight="fill" />
                              <span>
                                <b>24-hour notice</b>
                                <small>Security incidents</small>
                              </span>
                            </div>
                            <div>
                              <CheckCircle weight="fill" />
                              <span>
                                <b>Written approval</b>
                                <small>New data subprocessors</small>
                              </span>
                            </div>
                          </div>

                          <div className="sb-story-citations">
                            <button
                              className="sb-citation"
                              data-capture-id="assistant-citation-acme-msa"
                              onClick={() =>
                                setSource({
                                  title: "Acme Master Services Agreement.pdf",
                                  meta: "Page 12 · section 7.2 · Google Drive",
                                })
                              }
                            >
                              <FileText />
                              <span>Acme MSA</span>
                              <small>p. 12 · §7.2</small>
                            </button>
                            <button
                              className="sb-citation"
                              data-capture-id="assistant-citation-security"
                              onClick={() =>
                                setSource({
                                  title: "Acme Security Addendum.pdf",
                                  meta: "Page 4 · sections 3.1–3.2 · SharePoint",
                                })
                              }
                            >
                              <FileText />
                              <span>Security Addendum</span>
                              <small>p. 4 · §3.1</small>
                            </button>
                            <button
                              className="sb-citation"
                              data-capture-id="assistant-citation-customer"
                              onClick={() =>
                                setSource({
                                  title: "Acme customer record",
                                  meta: "PostgreSQL · synced 2 minutes ago",
                                })
                              }
                            >
                              <Database />
                              <span>Customer record</span>
                              <small>Live data</small>
                            </button>
                          </div>

                          {draftOpen && (
                            <div className="sb-story-draft">
                              <div>
                                <span className="sb-eyebrow">
                                  DRAFT RESPONSE
                                </span>
                                <span>Human approval required</span>
                              </div>
                              <textarea
                                data-capture-id="assistant-draft-text"
                                value={draft}
                                onChange={(event) =>
                                  setDraft(event.target.value)
                                }
                                aria-label="Draft response to Acme"
                              />
                            </div>
                          )}

                          <div className="sb-story-actions">
                            <button
                              className="sb-outline"
                              data-capture-id="assistant-draft-toggle"
                              onClick={() => setDraftOpen((open) => !open)}
                            >
                              {draftOpen ? "Hide draft" : "View draft"}
                            </button>
                            <button
                              className="sb-button"
                              data-capture-id="assistant-create-task"
                              onClick={createTask}
                            >
                              <CheckCircle weight="fill" /> Create review task
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}

                <div className="sb-composer sb-story-composer">
                  <Stack size={18} />
                  <input
                    data-capture-id="assistant-prompt"
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !isWorking) submit(message);
                    }}
                    placeholder="Ask SkyBao about the Acme request…"
                  />
                  <button
                    className="sb-send"
                    data-capture-id="assistant-send"
                    onClick={() => submit(message)}
                    disabled={isWorking || !message.trim()}
                    aria-label="Send message"
                  >
                    <PaperPlaneTilt weight="fill" />
                  </button>
                </div>
                <div className="sb-composer-bottom">
                  <span>Atlas knowledge · 568 approved sources</span>
                  <span>External actions require approval</span>
                </div>
              </section>
            </div>
          </div>
          <StorySourcePreview source={source} onClose={() => setSource(null)} />
          <CaptureNavigationDrawer area="assistant" />
        </main>
      </WorkspaceSurface>
    </WorkspaceFrame>
  );
}
