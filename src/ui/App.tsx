import { useEffect, useState } from "react";
import type {
  DemoState,
  TimelineEvent,
  WorkflowOutcome,
  Workshop
} from "../shared/types.ts";

const SUGGESTED_PROMPT =
  "Find an afternoon workshop about testing AI applications and reserve a seat for me.";

function time(iso: string): string {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC"
  }).format(new Date(iso));
}

function WorkshopRow({ workshop, selected }: { workshop: Workshop; selected: boolean }) {
  const seatLabel = workshop.remainingCapacity === 0
    ? "Sold out"
    : `${workshop.remainingCapacity} ${workshop.remainingCapacity === 1 ? "seat" : "seats"}`;

  return (
    <li className={`workshop-row ${selected ? "selected" : ""}`}>
      <time>{time(workshop.startsAt)}</time>
      <div>
        <strong>{workshop.title}</strong>
        <span>{workshop.tags.slice(0, 2).join(" · ")}</span>
      </div>
      <span className={`seat-count ${workshop.remainingCapacity <= 1 ? "last-seat" : ""}`}>
        {seatLabel}
      </span>
    </li>
  );
}

const visiblePhases = new Set([
  "mcp.discover",
  "tool.search_workshops",
  "tool.reserve_seat",
  "reservation.commit",
  "complete"
]);

function visibleTimeline(outcome: WorkflowOutcome): TimelineEvent[] {
  return outcome.timeline.filter(
    (event) => visiblePhases.has(event.phase) && event.status !== "started"
  );
}

function ExecutionDetails({ outcome }: { outcome: WorkflowOutcome }) {
  return (
    <details className="execution-details">
      <summary>
        <span>How this booking was processed</span>
        <time>{outcome.durationMs} ms</time>
      </summary>
      <ol className="execution-list">
        {visibleTimeline(outcome).map((event) => (
          <li key={event.id}>
            <span className="execution-check">✓</span>
            <span>{event.label}</span>
            <time>+{event.elapsedMs} ms</time>
          </li>
        ))}
      </ol>
    </details>
  );
}

function ReservationPanel({ outcome }: { outcome?: WorkflowOutcome }) {
  if (!outcome) {
    return (
      <aside className="reservation-panel empty-reservation">
        <p className="overline">Reservation</p>
        <h2>Not booked yet</h2>
        <p>Your confirmed workshop will appear here.</p>
      </aside>
    );
  }

  return (
    <aside className={`reservation-panel reservation-${outcome.status}`}>
      <div className="reservation-heading">
        <p className="overline">Reservation</p>
        <span>{outcome.status}</span>
      </div>
      {outcome.reservation ? (
        <>
          <h2>{outcome.reservation.workshopTitle}</h2>
          <dl>
            <div><dt>Attendee</dt><dd>{outcome.reservation.attendeeName}</dd></div>
            <div><dt>Request</dt><dd>{outcome.requestId.slice(0, 8)}</dd></div>
            <div><dt>Reservation</dt><dd>{outcome.reservation.id.slice(0, 8)}</dd></div>
          </dl>
          {outcome.langsmithTraceId ? (
            <div className="trace-id">
              <span>LangSmith trace</span>
              <code>{outcome.langsmithTraceId}</code>
            </div>
          ) : null}
        </>
      ) : (
        <p>{outcome.message}</p>
      )}
    </aside>
  );
}

export function App() {
  const [state, setState] = useState<DemoState>({ workshops: [], reservations: [] });
  const [outcome, setOutcome] = useState<WorkflowOutcome>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState("");
  const [submittedPrompt, setSubmittedPrompt] = useState<string>();

  const loadState = async (): Promise<void> => {
    const response = await fetch("/api/state");
    if (!response.ok) throw new Error(await response.text());
    setState(await response.json() as DemoState);
  };

  useEffect(() => {
    void loadState().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, []);

  const send = async (prompt: string): Promise<void> => {
    const message = prompt.trim();
    if (!message || running) return;

    setRunning(true);
    setOutcome(undefined);
    setError(undefined);
    setSubmittedPrompt(message);
    setDraft("");
    try {
      const response = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: message,
          attendee: {
            id: "attendee-anna",
            name: "Anna Developer",
            email: "anna@example.test"
          }
        })
      });
      const payload = await response.json() as {
        outcome?: WorkflowOutcome;
        state?: DemoState;
        error?: string;
      };
      if (!response.ok || !payload.outcome || !payload.state) {
        throw new Error(payload.error ?? `Request failed with ${response.status}`);
      }
      setOutcome(payload.outcome);
      setState(payload.state);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRunning(false);
    }
  };

  const reset = async (): Promise<void> => {
    setRunning(true);
    setError(undefined);
    try {
      const response = await fetch("/api/reset", { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
      setState(await response.json() as DemoState);
      setOutcome(undefined);
      setSubmittedPrompt(undefined);
      setDraft("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRunning(false);
    }
  };

  return (
    <main className="app-shell">
      <header className="site-header">
        <div className="brand">
          <strong>The Last Seat</strong>
          <span>Conference workshop booking</span>
        </div>
        <span className="conference-date">WeAreDevelopers · September 24</span>
      </header>

      <section className="demo-layout">
        <article className="assistant-panel">
          <div className="panel-heading">
            <h1>Booking assistant</h1>
            <span className="online-status"><i /> Online</span>
          </div>

          <div className="conversation" aria-live="polite">
            <div className="message assistant-message">
              <span>Booking assistant</span>
              <p>Hi Anna! What kind of workshop would you like to attend?</p>
            </div>

            {!submittedPrompt && !running ? (
              <button
                type="button"
                className="prompt-suggestion"
                onClick={() => void send(SUGGESTED_PROMPT)}
              >
                <span>Suggested request</span>
                {SUGGESTED_PROMPT}
              </button>
            ) : null}

            {submittedPrompt ? (
              <div className="message user-message">
                <span>You</span>
                <p>{submittedPrompt}</p>
              </div>
            ) : null}

            {running ? (
              <div className="message assistant-message working-message">
                <span>Booking assistant</span>
                <p>
                  Checking the schedule and reserving your seat
                  <span className="working-dots">…</span>
                </p>
              </div>
            ) : outcome ? (
              <div className="message assistant-message">
                <span>Booking assistant</span>
                <p>{outcome.message}</p>
              </div>
            ) : error ? (
              <div className="message assistant-message error-message">
                <span>Booking assistant</span>
                <p>{error}</p>
              </div>
            ) : null}
          </div>

          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void send(draft);
            }}
          >
            <input
              aria-label="Message the booking assistant"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Ask for a workshop…"
              disabled={running}
            />
            <button className="primary-button" type="submit" disabled={running || !draft.trim()}>
              Send
            </button>
          </form>
          <div className="conversation-actions">
            <button className="text-button" type="button" onClick={() => void reset()} disabled={running}>
              New conversation
            </button>
          </div>
        </article>

        <ReservationPanel outcome={outcome} />
      </section>

      <section className="inventory-section">
        <div className="section-title">
          <div>
            <p className="overline">September 24</p>
            <h2>Workshop schedule</h2>
          </div>
          <span>
            {state.reservations.length} reservation{state.reservations.length === 1 ? "" : "s"}
          </span>
        </div>
        <ul className="workshop-list">
          {state.workshops.map((workshop) => (
            <WorkshopRow
              key={workshop.id}
              workshop={workshop}
              selected={outcome?.reservation?.workshopId === workshop.id}
            />
          ))}
        </ul>
      </section>

      {outcome ? <ExecutionDetails outcome={outcome} /> : null}
    </main>
  );
}
