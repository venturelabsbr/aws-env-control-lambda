import parser from "cron-parser";

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const ISO_DAY_NAMES = [
  "Segunda",
  "Terça",
  "Quarta",
  "Quinta",
  "Sexta",
  "Sábado",
  "Domingo",
] as const;

const ISO_TO_AWS_DAY = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;

export interface ScheduleActionInput {
  enabled?: boolean;
  time?: string;
  daysOfWeek?: number[];
}

export interface ScheduleInput {
  timezone?: string;
  shutdown?: ScheduleActionInput;
  startup?: ScheduleActionInput;
}

export interface ScheduleActionConfig {
  enabled: boolean;
  time: string;
  daysOfWeek: number[];
}

export interface NormalizedSchedule {
  timezone: string;
  shutdown?: ScheduleActionConfig;
  startup?: ScheduleActionConfig;
}

export interface EnvScheduleActionJson {
  enabled: boolean;
  time: string;
  daysOfWeek: number[];
  daysLabel: string;
  cron: string;
  nextAt: string | null;
}

export interface EnvScheduleJson {
  timezone: string;
  shutdown?: EnvScheduleActionJson;
  startup?: EnvScheduleActionJson;
}

function parseTime(time: string): { hour: number; minute: number } | null {
  const m = TIME_RE.exec(time.trim());
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function normalizeDays(days: unknown): number[] | null {
  if (!Array.isArray(days) || days.length === 0) return null;
  const parsed: number[] = [];
  for (const d of days) {
    const n = Number(d);
    if (!Number.isInteger(n) || n < 1 || n > 7) return null;
    if (!parsed.includes(n)) parsed.push(n);
  }
  parsed.sort((a, b) => a - b);
  return parsed;
}

function normalizeAction(raw: ScheduleActionInput | undefined): ScheduleActionConfig | null {
  if (!raw || raw.enabled === false) return null;
  const time = typeof raw.time === "string" ? raw.time.trim() : "";
  const parsedTime = parseTime(time);
  const days = normalizeDays(raw.daysOfWeek);
  if (!parsedTime || !days) return null;
  return { enabled: true, time, daysOfWeek: days };
}

export function normalizeSchedule(raw: ScheduleInput | undefined): NormalizedSchedule | null {
  if (!raw || typeof raw !== "object") return null;
  const timezone =
    typeof raw.timezone === "string" && raw.timezone.trim()
      ? raw.timezone.trim()
      : "America/Sao_Paulo";
  const shutdown = normalizeAction(raw.shutdown);
  const startup = normalizeAction(raw.startup);
  if (!shutdown && !startup) return null;
  const out: NormalizedSchedule = { timezone };
  if (shutdown) out.shutdown = shutdown;
  if (startup) out.startup = startup;
  return out;
}

/** Rótulo em português para dias da semana (ISO 1=seg … 7=dom). */
export function daysLabel(daysOfWeek: number[]): string {
  if (daysOfWeek.length === 7) return "Todos os dias";
  if (daysOfWeek.length === 1) return ISO_DAY_NAMES[daysOfWeek[0] - 1];

  const ranges: string[] = [];
  let start = daysOfWeek[0];
  let prev = daysOfWeek[0];

  const flush = (s: number, e: number) => {
    if (s === e) ranges.push(ISO_DAY_NAMES[s - 1]);
    else ranges.push(`${ISO_DAY_NAMES[s - 1].slice(0, 3)}–${ISO_DAY_NAMES[e - 1].slice(0, 3)}`);
  };

  for (let i = 1; i < daysOfWeek.length; i++) {
    const d = daysOfWeek[i];
    if (d === prev + 1) {
      prev = d;
      continue;
    }
    flush(start, prev);
    start = d;
    prev = d;
  }
  flush(start, prev);
  return ranges.join(", ");
}

function isoDaysToAwsField(daysOfWeek: number[]): string {
  const names = daysOfWeek.map((d) => ISO_TO_AWS_DAY[d - 1]);
  if (names.length === 1) return names[0];
  if (names.length === 7) return "*";

  const indices = daysOfWeek.map((d) => d - 1);
  let rangeStart = indices[0];
  let rangeEnd = indices[0];
  const parts: string[] = [];

  const pushRange = (s: number, e: number) => {
    if (s === e) parts.push(ISO_TO_AWS_DAY[s]);
    else parts.push(`${ISO_TO_AWS_DAY[s]}-${ISO_TO_AWS_DAY[e]}`);
  };

  for (let i = 1; i < indices.length; i++) {
    if (indices[i] === rangeEnd + 1) {
      rangeEnd = indices[i];
    } else {
      pushRange(rangeStart, rangeEnd);
      rangeStart = indices[i];
      rangeEnd = indices[i];
    }
  }
  pushRange(rangeStart, rangeEnd);
  return parts.join(",");
}

/** Expressão cron no formato EventBridge Scheduler (6 campos). */
export function toEventBridgeCron(time: string, daysOfWeek: number[]): string | null {
  const t = parseTime(time);
  if (!t || daysOfWeek.length === 0) return null;
  const dow = isoDaysToAwsField(daysOfWeek);
  return `cron(${t.minute} ${t.hour} ? * ${dow} *)`;
}

/** ISO 1=seg … 7=dom → campo day-of-week do cron-parser (0=dom, 1=seg …). */
function isoDaysToCronParserField(daysOfWeek: number[]): string {
  const mapped = [...new Set(daysOfWeek.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);
  if (mapped.length === 7) return "*";

  const parts: string[] = [];
  let start = mapped[0];
  let prev = mapped[0];

  const push = (s: number, e: number) => {
    parts.push(s === e ? String(s) : `${s}-${e}`);
  };

  for (let i = 1; i < mapped.length; i++) {
    if (mapped[i] === prev + 1) {
      prev = mapped[i];
    } else {
      push(start, prev);
      start = mapped[i];
      prev = mapped[i];
    }
  }
  push(start, prev);
  return parts.join(",");
}

export function getNextRun(time: string, daysOfWeek: number[], timezone: string): string | null {
  const t = parseTime(time);
  if (!t || daysOfWeek.length === 0) return null;
  const dow = isoDaysToCronParserField(daysOfWeek);
  const expression = `${t.minute} ${t.hour} * * ${dow}`;
  try {
    const interval = parser.parseExpression(expression, {
      tz: timezone,
      currentDate: new Date(),
    });
    return interval.next().toDate().toISOString();
  } catch {
    return null;
  }
}

function actionToJson(
  action: ScheduleActionConfig,
  timezone: string
): EnvScheduleActionJson {
  const cron = toEventBridgeCron(action.time, action.daysOfWeek) ?? "";
  return {
    enabled: action.enabled,
    time: action.time,
    daysOfWeek: action.daysOfWeek,
    daysLabel: daysLabel(action.daysOfWeek),
    cron,
    nextAt: action.enabled ? getNextRun(action.time, action.daysOfWeek, timezone) : null,
  };
}

export function buildScheduleJson(schedule: NormalizedSchedule | null): EnvScheduleJson | undefined {
  if (!schedule) return undefined;
  const out: EnvScheduleJson = { timezone: schedule.timezone };
  if (schedule.shutdown) out.shutdown = actionToJson(schedule.shutdown, schedule.timezone);
  if (schedule.startup) out.startup = actionToJson(schedule.startup, schedule.timezone);
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatNextAtLocal(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: timezone,
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** Bloco HTML com próximo ligamento/desligamento. */
export function scheduleBlockHtml(schedule: EnvScheduleJson | undefined): string {
  if (!schedule) return "";
  const lines: string[] = [];
  const tz = schedule.timezone;

  const line = (label: string, action: EnvScheduleActionJson | undefined) => {
    if (!action?.enabled) return;
    const fixed = `${escapeHtml(action.daysLabel)} às ${escapeHtml(action.time)}`;
    if (action.nextAt) {
      lines.push(
        `<p class="text-sm text-slate-300"><span class="text-slate-400">${label}:</span> ${escapeHtml(formatNextAtLocal(action.nextAt, tz))} <span class="text-slate-500">(${fixed})</span></p>`
      );
    } else {
      lines.push(
        `<p class="text-sm text-slate-300"><span class="text-slate-400">${label}:</span> ${fixed}</p>`
      );
    }
  };

  line("Próximo ligamento", schedule.startup);
  line("Próximo desligamento", schedule.shutdown);

  if (lines.length === 0) return "";
  return `<div class="mb-4 p-3 rounded-lg bg-slate-700/50 border border-slate-600 text-sm">
    <p class="text-xs text-slate-500 uppercase tracking-wider mb-2">Agendamento (${escapeHtml(tz)})</p>
    ${lines.join("")}
  </div>`;
}
