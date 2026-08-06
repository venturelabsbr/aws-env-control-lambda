import { ECSClient, UpdateServiceCommand, DescribeServicesCommand } from "@aws-sdk/client-ecs";
import {
  RDSClient,
  StopDBInstanceCommand,
  StartDBInstanceCommand,
  DescribeDBInstancesCommand,
  DescribeDBClustersCommand,
  ModifyDBClusterCommand,
} from "@aws-sdk/client-rds";
import { SSMClient, GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import { SchedulerClient, GetScheduleCommand, UpdateScheduleCommand } from "@aws-sdk/client-scheduler";
import {
  ApplicationAutoScalingClient,
  PutScheduledActionCommand,
  DeleteScheduledActionCommand,
} from "@aws-sdk/client-application-auto-scaling";
import {
  buildScheduleJson,
  normalizeSchedule,
  toEventBridgeCron,
  scheduleBlockHtml,
  type EnvScheduleJson,
  type NormalizedSchedule,
  type ScheduleActionConfig,
  type ScheduleInput,
} from "./schedule.js";

export type { EnvScheduleJson, EnvScheduleActionJson } from "./schedule.js";

/** Onde e como o agendamento é realmente disparado (além do JSON exibido). */
export type ScheduleTriggerConfig =
  | {
      type: "eventbridge-scheduler";
      group: string;
      startupScheduleName?: string;
      shutdownScheduleName?: string;
    }
  | {
      type: "app-autoscaling";
      resourceId: string;
      scalableDimension: string;
      serviceNamespace: "ecs";
      /** Capacidade (desired count) restaurada no ligamento automático. */
      restoreCapacity: number;
      startupActionName?: string;
      shutdownActionName?: string;
    };

/** Contrato da config: env ENV_CONFIG (JSON) */
export interface EnvControlConfig {
  cluster: string;
  region?: string;
  services: {
    app: string;
    apis?: string[];
    workers?: string[];
  };
  databases?: {
    rds?: string[];
    aurora?: string[];
  };
  token?: string;
  projectName?: string;
  schedule?: ScheduleInput;
  /** Nome do parâmetro SSM que guarda o agendamento editável em runtime (opcional). */
  scheduleSsmParam?: string;
  /** Gatilho real (EventBridge Scheduler ou Application Auto Scaling) atualizado quando o agendamento muda. */
  scheduleTrigger?: ScheduleTriggerConfig;
}

interface NormalizedConfig {
  region: string;
  cluster: string;
  serviceApp: string;
  serviceApis: string[];
  serviceWorkers: string[];
  dbInstanceIds: string[];
  dbClusterIds: string[];
  token: string;
  projectName: string;
  schedule: ReturnType<typeof normalizeSchedule>;
  scheduleSsmParam: string;
  scheduleTrigger: ScheduleTriggerConfig | null;
}

function loadConfig(): NormalizedConfig {
  const raw = process.env.ENV_CONFIG;
  const region =
    process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  const empty: NormalizedConfig = {
    region,
    cluster: "",
    serviceApp: "",
    serviceApis: [],
    serviceWorkers: [],
    dbInstanceIds: [],
    dbClusterIds: [],
    token: "",
    projectName: "",
    schedule: null,
    scheduleSsmParam: "",
    scheduleTrigger: null,
  };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as EnvControlConfig;
    const services = parsed.services ?? {};
    const databases = parsed.databases ?? {};
    return {
      region: parsed.region ?? region,
      cluster: String(parsed.cluster ?? ""),
      serviceApp: String(services.app ?? ""),
      serviceApis: Array.isArray(services.apis) ? services.apis : [],
      serviceWorkers: Array.isArray(services.workers) ? services.workers : [],
      dbInstanceIds: Array.isArray(databases.rds) ? databases.rds : [],
      dbClusterIds: Array.isArray(databases.aurora) ? databases.aurora : [],
      token: String(parsed.token ?? "").trim(),
      projectName: String(parsed.projectName ?? "").trim(),
      schedule: normalizeSchedule(parsed.schedule),
      scheduleSsmParam: String(parsed.scheduleSsmParam ?? "").trim(),
      scheduleTrigger: parsed.scheduleTrigger ?? null,
    };
  } catch {
    return empty;
  }
}

const config = loadConfig();
const ecs = new ECSClient({ region: config.region });
const rds = new RDSClient({ region: config.region });
const ssm = new SSMClient({ region: config.region });
const scheduler = new SchedulerClient({ region: config.region });
const autoScaling = new ApplicationAutoScalingClient({ region: config.region });

/**
 * Agendamento "vivo": lê o valor gravado em SSM (editado via UI/API) quando existir;
 * cai para o `schedule` estático do ENV_CONFIG quando o parâmetro ainda não foi escrito.
 */
async function loadDynamicSchedule(): Promise<NormalizedSchedule | null> {
  if (!config.scheduleSsmParam) return config.schedule;
  try {
    const res = await ssm.send(
      new GetParameterCommand({ Name: config.scheduleSsmParam })
    );
    const raw = res.Parameter?.Value;
    if (!raw) return config.schedule;
    const parsed = JSON.parse(raw) as ScheduleInput;
    return normalizeSchedule(parsed) ?? config.schedule;
  } catch {
    return config.schedule;
  }
}

async function saveDynamicSchedule(schedule: NormalizedSchedule): Promise<void> {
  if (!config.scheduleSsmParam) return;
  await ssm.send(
    new PutParameterCommand({
      Name: config.scheduleSsmParam,
      Value: JSON.stringify(schedule),
      Type: "String",
      Overwrite: true,
    })
  );
}

/** Atualiza o gatilho real (EventBridge Scheduler ou Application Auto Scaling) para refletir o novo agendamento. */
async function applyScheduleTrigger(schedule: NormalizedSchedule): Promise<string[]> {
  const trigger = config.scheduleTrigger;
  if (!trigger) return ["Agendamento salvo apenas para exibição — nenhum gatilho automático configurado."];
  const notices: string[] = [];

  const syncAction = async (
    kind: "startup" | "shutdown",
    action: ScheduleActionConfig | undefined
  ) => {
    if (trigger.type === "eventbridge-scheduler") {
      const name = kind === "startup" ? trigger.startupScheduleName : trigger.shutdownScheduleName;
      if (!name) return;
      try {
        const current = await scheduler.send(
          new GetScheduleCommand({ Name: name, GroupName: trigger.group })
        );
        if (action) {
          const cron = toEventBridgeCron(action.time, action.daysOfWeek);
          if (!cron) {
            notices.push(`${kind}: horário/dias inválidos, gatilho não atualizado.`);
            return;
          }
          await scheduler.send(
            new UpdateScheduleCommand({
              Name: name,
              GroupName: trigger.group,
              ScheduleExpression: cron,
              ScheduleExpressionTimezone: schedule.timezone,
              FlexibleTimeWindow: current.FlexibleTimeWindow ?? { Mode: "OFF" },
              Target: current.Target,
              State: "ENABLED",
            })
          );
        } else if (current.State !== "DISABLED") {
          await scheduler.send(
            new UpdateScheduleCommand({
              Name: name,
              GroupName: trigger.group,
              ScheduleExpression: current.ScheduleExpression,
              ScheduleExpressionTimezone: current.ScheduleExpressionTimezone,
              FlexibleTimeWindow: current.FlexibleTimeWindow ?? { Mode: "OFF" },
              Target: current.Target,
              State: "DISABLED",
            })
          );
        }
      } catch (err) {
        notices.push(`${kind}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    if (trigger.type === "app-autoscaling") {
      const name = kind === "startup" ? trigger.startupActionName : trigger.shutdownActionName;
      if (!name) return;
      try {
        if (action) {
          const cron = toEventBridgeCron(action.time, action.daysOfWeek);
          if (!cron) {
            notices.push(`${kind}: horário/dias inválidos, gatilho não atualizado.`);
            return;
          }
          await autoScaling.send(
            new PutScheduledActionCommand({
              ScheduledActionName: name,
              ServiceNamespace: trigger.serviceNamespace,
              ResourceId: trigger.resourceId,
              ScalableDimension: trigger.scalableDimension as never,
              Schedule: cron,
              Timezone: schedule.timezone,
              ScalableTargetAction:
                kind === "startup"
                  ? { MinCapacity: trigger.restoreCapacity, MaxCapacity: trigger.restoreCapacity }
                  : { MinCapacity: 0, MaxCapacity: 0 },
            })
          );
        } else {
          await autoScaling.send(
            new DeleteScheduledActionCommand({
              ScheduledActionName: name,
              ServiceNamespace: trigger.serviceNamespace,
              ResourceId: trigger.resourceId,
              ScalableDimension: trigger.scalableDimension as never,
            })
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/not found/i.test(msg)) notices.push(`${kind}: ${msg}`);
      }
    }
  };

  await syncAction("startup", schedule.startup);
  await syncAction("shutdown", schedule.shutdown);
  return notices;
}

const AURORA_OFF_MIN = 0;
const AURORA_OFF_MAX = 1;
const AURORA_ON_MIN = 0.5;
const AURORA_ON_MAX = 1;

interface ServiceRunning {
  name: string;
  running: number;
}

interface DbStatusRds {
  id: string;
  type: "rds";
  status: string | null;
  minAcu?: never;
}

interface DbStatusAurora {
  id: string;
  type: "aurora";
  status?: never;
  minAcu: number | null;
}

type DbStatus = DbStatusRds | DbStatusAurora;

interface EnvStatus {
  appRunning: number;
  apis: ServiceRunning[];
  workers: ServiceRunning[];
  dbs: DbStatus[];
}

interface StatusItem {
  resource: string;
  resourceType: "ECS" | "RDS" | "Aurora";
  on: boolean;
}

interface StatusJson {
  allOn: boolean;
  allOff: boolean;
  items: StatusItem[];
  schedule?: EnvScheduleJson;
}

interface HtmlPageOptions {
  showStartupNotice?: boolean;
  autoRefreshSeconds?: number;
}

export interface LambdaFunctionUrlEvent {
  requestContext?: {
    http?: { method?: string };
    domainName?: string;
  };
  httpMethod?: string;
  rawPath?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string>;
  queryStringParameters?: Record<string, string> | null;
}

export interface LambdaResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

async function getStatus(): Promise<EnvStatus> {
  const status: EnvStatus = { appRunning: 0, apis: [], workers: [], dbs: [] };
  try {
    const services = [config.serviceApp, ...config.serviceApis, ...config.serviceWorkers].filter(Boolean);
    const svcPromise =
      services.length > 0
        ? ecs.send(new DescribeServicesCommand({ cluster: config.cluster, services }))
        : Promise.resolve({ services: [] });
    const rdsInstancePromises = config.dbInstanceIds.map((id) =>
      rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: id }))
    );
    const rdsClusterPromises = config.dbClusterIds.map((id) =>
      rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: id }))
    );
    const dbPromises = [...rdsInstancePromises, ...rdsClusterPromises];
    const allPromises = dbPromises.length > 0 ? [svcPromise, ...dbPromises] : [svcPromise];
    const results = await Promise.all(allPromises);
    interface EcsDescribeResult {
      services?: Array<{ serviceName?: string; runningCount?: number }>;
    }
    const svc = results[0] as EcsDescribeResult;
    const dbResults = results.slice(1) as unknown[];
    const appSvc = svc?.services?.find((s) => s.serviceName === config.serviceApp);
    if (appSvc) status.appRunning = appSvc.runningCount ?? 0;
    for (const apiName of config.serviceApis) {
      const apiSvc = svc?.services?.find((s) => s.serviceName === apiName);
      status.apis.push({ name: apiName, running: apiSvc ? (apiSvc.runningCount ?? 0) : 0 });
    }
    for (const workerName of config.serviceWorkers) {
      const workerSvc = svc?.services?.find((s) => s.serviceName === workerName);
      status.workers.push({
        name: workerName,
        running: workerSvc ? (workerSvc.runningCount ?? 0) : 0,
      });
    }
    let dbIdx = 0;
    for (const id of config.dbInstanceIds) {
      const res = dbResults[dbIdx++] as { DBInstances?: { DBInstanceStatus?: string }[] } | undefined;
      const instance = res?.DBInstances?.[0];
      status.dbs.push({
        id,
        type: "rds",
        status: instance?.DBInstanceStatus ?? null,
      });
    }
    for (const id of config.dbClusterIds) {
      const res = dbResults[dbIdx++] as {
        DBClusters?: { ServerlessV2ScalingConfiguration?: { MinCapacity?: number } }[];
      } | undefined;
      const scaling = res?.DBClusters?.[0]?.ServerlessV2ScalingConfiguration;
      status.dbs.push({ id, type: "aurora", minAcu: scaling?.MinCapacity ?? null });
    }
  } catch {
    // keep default status
  }
  return status;
}

function statusToJson(status: EnvStatus | null, dynamicSchedule: NormalizedSchedule | null): StatusJson {
  const schedule = buildScheduleJson(dynamicSchedule);
  const empty: StatusJson = { allOn: false, allOff: true, items: [], ...(schedule ? { schedule } : {}) };
  if (!status) return empty;
  const appOn = (status.appRunning ?? 0) > 0;
  const apis = status.apis ?? [];
  const workers = status.workers ?? [];
  const dbs = status.dbs ?? [];
  const apisOn = apis.length === 0 || apis.every((a) => (a.running ?? 0) > 0);
  const workersOn = workers.length === 0 || workers.every((w) => (w.running ?? 0) > 0);
  const dbOn = (db: DbStatus): boolean =>
    db.type === "aurora" ? (db.minAcu != null && db.minAcu > 0) : db.status === "available";
  const allDbsOn = dbs.length === 0 || dbs.every(dbOn);
  const allOn = appOn && allDbsOn && apisOn && workersOn;
  const allOff =
    !appOn &&
    apis.every((a) => (a.running ?? 0) === 0) &&
    workers.every((w) => (w.running ?? 0) === 0) &&
    dbs.every((d) =>
      d.type === "aurora" ? (d.minAcu ?? 0) === 0 : d.status !== "available"
    );
  const items: StatusItem[] = [
    ...apis.map((a) => ({ resource: a.name, resourceType: "ECS" as const, on: (a.running ?? 0) > 0 })),
    { resource: config.serviceApp, resourceType: "ECS" as const, on: appOn },
    ...workers.map((w) => ({ resource: w.name, resourceType: "ECS" as const, on: (w.running ?? 0) > 0 })),
    ...dbs.map((d) => ({
      resource: d.id,
      resourceType: (d.type === "aurora" ? "Aurora" : "RDS") as "ECS" | "RDS" | "Aurora",
      on: dbOn(d),
    })),
  ];
  return { allOn, allOff, items, ...(schedule ? { schedule } : {}) };
}

function statusBlock(status: EnvStatus | null): string {
  if (!status)
    return '<p class="text-sm text-slate-400 mb-4">Ligar ou desligar ambiente.</p>';
  const appOn = status.appRunning > 0;
  const apis = status.apis ?? [];
  const workers = status.workers ?? [];
  const dbs = status.dbs ?? [];
  const dbOn = (d: DbStatus): boolean =>
    d.type === "aurora" ? (d.minAcu != null && d.minAcu > 0) : d.status === "available";
  const dbTransition = (d: DbStatus): boolean =>
    d.type === "rds" && (d.status === "starting" || d.status === "stopping");
  const allApisOn = apis.length === 0 || apis.every((a) => a.running > 0);
  const allWorkersOn = workers.length === 0 || workers.every((w) => w.running > 0);
  const allDbsOn = dbs.length === 0 || dbs.every(dbOn);
  const anyDbTransition = dbs.some(dbTransition);
  const allOn = appOn && allDbsOn && allApisOn && allWorkersOn;
  const allOff =
    !appOn &&
    apis.every((a) => a.running === 0) &&
    workers.every((w) => w.running === 0) &&
    dbs.every((d) =>
      d.type === "aurora" ? (d.minAcu ?? 0) === 0 : d.status !== "available"
    );
  const hasDivergence = !allOn && !allOff && !anyDbTransition;
  const divergenceWarning = hasDivergence
    ? `<div class="mb-4 p-3 rounded-lg bg-amber-900/50 border border-amber-600/50 text-amber-200 text-sm">Os status estão diferentes. O ambiente pode estar iniciando ou desligando; aguarde alguns minutos.</div>`
    : "";
  const tag = (type: string) =>
    `<span class="ml-1 text-xs font-medium px-2 py-0.5 rounded bg-slate-600 text-slate-300 border border-slate-500">${type}</span>`;
  const line = (
    name: string,
    type: "ECS" | "RDS" | "Aurora",
    on: boolean,
    statusText?: string
  ): string => {
    const dot = on ? "bg-emerald-500" : "bg-rose-500";
    const text = on ? "text-emerald-400" : "text-rose-400";
    const st = statusText ?? (on ? "Ligado" : "Desligado");
    return `<div class="flex items-center gap-2 flex-wrap"><span class="h-2.5 w-2.5 rounded-full flex-shrink-0 ${dot}"></span><span class="text-sm text-slate-300">${name}</span> ${tag(type)} <span class="text-sm ${text}">${st}</span></div>`;
  };
  const apiLines = apis
    .map((a) => line(a.name, "ECS", a.running > 0))
    .join("");
  const workerLines = workers
    .map((w) => line(w.name, "ECS", w.running > 0))
    .join("");
  const dbLine = (d: DbStatus): string => {
    const on = dbOn(d);
    const starting = d.type === "rds" && d.status === "starting";
    const stopping = d.type === "rds" && d.status === "stopping";
    const statusText = on
      ? d.type === "aurora"
        ? `Ligado (${d.minAcu ?? "?"} ACU)`
        : "Ligado"
      : starting
        ? "Ligando…"
        : stopping
          ? "Desligando…"
          : d.type === "aurora"
            ? "Escala mínima"
            : "Desligado";
    const dot = on ? "bg-emerald-500" : starting || stopping ? "bg-amber-500" : "bg-rose-500";
    const text = on ? "text-emerald-400" : starting || stopping ? "text-amber-400" : "text-rose-400";
    const typeLabel = d.type === "aurora" ? "Aurora" : "RDS";
    return `<div class="flex items-center gap-2 flex-wrap"><span class="h-2.5 w-2.5 rounded-full flex-shrink-0 ${dot}"></span><span class="text-sm text-slate-300">${d.id}</span> ${tag(typeLabel)} <span class="text-sm ${text}">${statusText}</span></div>`;
  };
  const dbLines = dbs.map(dbLine).join("");
  return `${divergenceWarning}
    <div class="mb-4 flex flex-col gap-2">
      ${apiLines}
      ${line(config.serviceApp, "ECS", appOn)}
      ${workerLines}
      ${dbLines}
    </div>`;
}

function htmlPage(
  functionUrl: string,
  message = "",
  status: EnvStatus | null = null,
  options: HtmlPageOptions = {},
  dynamicSchedule: NormalizedSchedule | null = config.schedule
): string {
  const { showStartupNotice = false, autoRefreshSeconds = 20 } = options;
  const action = functionUrl || "";
  const tokenRequired = config.token.length > 0;
  const statusHtml = statusBlock(status);
  const scheduleHtml = scheduleBlockHtml(buildScheduleJson(dynamicSchedule));
  const startupNotice = showStartupNotice
    ? `<div class="mb-4 p-3 rounded-lg bg-cyan-900/40 border border-cyan-600/50 text-cyan-200 text-sm">Os serviços podem levar alguns minutos para ficarem disponíveis. A página será atualizada automaticamente; evite clicar novamente.</div>`
    : "";
  const refreshMeta =
    autoRefreshSeconds > 0
      ? `<meta http-equiv="refresh" content="${autoRefreshSeconds}">`
      : "";
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${config.projectName ? `${config.projectName} — Controle` : "Controle ambiente"}</title>${refreshMeta}<script src="https://cdn.tailwindcss.com"></script></head>
<body class="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-4">
  <div class="w-full max-w-md rounded-xl bg-slate-800 border border-slate-700 shadow-xl p-6">
    ${config.projectName ? `<p class="text-xs text-slate-500 uppercase tracking-wider mb-1">${config.projectName}</p>` : ""}
    <h1 class="text-xl font-semibold text-slate-100 mb-2">Controle ambiente</h1>${statusHtml}${scheduleHtml}${startupNotice}
    ${message ? `<div class="mb-4 p-3 rounded-lg bg-amber-900/50 border border-amber-600/50 text-amber-200 text-sm">${message}</div>` : ""}
    <form id="env-form" action="${action}" method="POST" enctype="application/x-www-form-urlencoded" class="space-y-4">
      ${tokenRequired ? `<div><label class="block text-sm text-slate-400 mb-1">Token</label><input type="password" name="token" required class="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-slate-100 placeholder-slate-500 focus:border-cyan-500 focus:outline-none" placeholder="Token de acesso" /></div>` : ""}
      <input type="hidden" name="action" id="env-action" value="" />
      <div class="flex gap-3"><button type="button" onclick="document.getElementById('env-action').value='on'; document.getElementById('env-form').submit();" class="flex-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2.5 font-medium text-white transition">Ligar</button><button type="button" onclick="document.getElementById('env-action').value='off'; document.getElementById('env-form').submit();" class="flex-1 rounded-lg bg-rose-600 hover:bg-rose-500 px-4 py-2.5 font-medium text-white transition">Desligar</button></div>
    </form>
    ${autoRefreshSeconds > 0 ? `<p id="refresh-countdown" class="mt-4 text-center text-xs text-slate-500">Próxima atualização em <span id="refresh-sec">${autoRefreshSeconds}</span>s</p><script>(function(){var el=document.getElementById('refresh-sec');if(!el)return;var sec=${autoRefreshSeconds};var i=setInterval(function(){sec--;el.textContent=sec;if(sec<=0)clearInterval(i);},1000);})();</script>` : ""}
  </div>
</body>
</html>`;
}

function parseBody(
  body: string | Buffer | undefined,
  contentType: string
): Record<string, string> {
  if (!body) return {};
  const str =
    typeof body === "string" ? body : body instanceof Buffer ? body.toString("utf8") : String(body);
  if ((contentType || "").toLowerCase().includes("application/json")) {
    try {
      return JSON.parse(str) as Record<string, string>;
    } catch {
      return {};
    }
  }
  try {
    return Object.fromEntries(new URLSearchParams(str)) as Record<string, string>;
  } catch {
    return {};
  }
}

function getRawBody(event: LambdaFunctionUrlEvent): string {
  const b = event.body;
  if (!b) return "";
  if (event.isBase64Encoded) return Buffer.from(b, "base64").toString("utf8");
  return typeof b === "string" ? b : String(b);
}

function header(
  event: LambdaFunctionUrlEvent,
  name: "content-type" | "accept" | "authorization"
): string {
  const h = event.headers;
  if (!h) return "";
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === lower && typeof v === "string") return v;
  }
  return "";
}

function getToken(event: LambdaFunctionUrlEvent): string {
  const q = event.queryStringParameters ?? {};
  if (q.token) return String(q.token).trim();

  const auth = header(event, "authorization");
  const bearer = /^Bearer\s+(\S+)/i.exec(auth);
  if (bearer?.[1]) return bearer[1].trim();

  const contentType = header(event, "content-type");
  const body = parseBody(getRawBody(event), contentType);
  return String((body.token as string) ?? "").trim();
}

function wantsJson(event: LambdaFunctionUrlEvent): boolean {
  const q = event.queryStringParameters ?? {};
  if (q.format === "json") return true;
  if (header(event, "accept").toLowerCase().includes("application/json")) return true;
  if (header(event, "content-type").toLowerCase().includes("application/json")) return true;
  return false;
}

export const handler = async (
  event: LambdaFunctionUrlEvent
): Promise<LambdaResponse> => {
  const method =
    event.requestContext?.http?.method || event.httpMethod || "GET";
  const functionUrl = event.requestContext?.domainName
    ? `https://${event.requestContext.domainName}${event.rawPath ?? ""}`
    : "";

  if (method === "GET") {
    let status: EnvStatus | null = null;
    try {
      status = await getStatus();
    } catch {
      // keep null
    }
    const dynamicSchedule = await loadDynamicSchedule();
    if (
      (event.queryStringParameters?.format === "json") ||
      wantsJson(event)
    ) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(statusToJson(status, dynamicSchedule)),
      };
    }
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: htmlPage(functionUrl, "", status, { autoRefreshSeconds: 20 }, dynamicSchedule),
    };
  }

  if (method !== "POST") {
    if (wantsJson(event))
      return {
        statusCode: 405,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Method Not Allowed" }),
      };
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const contentType = header(event, "content-type");
  const rawBody = getRawBody(event);
  const body = parseBody(rawBody, contentType);
  const action = (body.action ?? "").trim() || (event.queryStringParameters ?? {}).action;

  if (!action || !["on", "off", "schedule"].includes(action)) {
    if (wantsJson(event))
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Informe action: on, off ou schedule." }),
      };
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: htmlPage(functionUrl, "Informe action: on, off ou schedule.", null, {
        autoRefreshSeconds: 20,
      }),
    };
  }

  const token = getToken(event);
  if (config.token.length > 0 && token !== config.token) {
    if (wantsJson(event))
      return {
        statusCode: 403,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Token inválido." }),
      };
    return {
      statusCode: 403,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: htmlPage(functionUrl, "Token inválido.", null, {
        autoRefreshSeconds: 20,
      }),
    };
  }

  if (action === "schedule") {
    const rawSchedule =
      typeof body.schedule === "string"
        ? (() => {
            try {
              return JSON.parse(body.schedule as string) as ScheduleInput;
            } catch {
              return undefined;
            }
          })()
        : (body as unknown as { schedule?: ScheduleInput }).schedule;
    const normalized = normalizeSchedule(rawSchedule);
    if (!normalized) {
      if (wantsJson(event))
        return {
          statusCode: 400,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Agendamento inválido. Informe schedule: { timezone, startup?, shutdown? }." }),
        };
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
        body: htmlPage(functionUrl, "Agendamento inválido.", null, { autoRefreshSeconds: 20 }),
      };
    }
    await saveDynamicSchedule(normalized);
    const notices = await applyScheduleTrigger(normalized);
    const finalStatus = await getStatus();
    const payload = statusToJson(finalStatus, normalized);
    const message = notices.join(". ") || "Agendamento atualizado.";
    if (wantsJson(event))
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, message }),
      };
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: htmlPage(functionUrl, message, finalStatus, { autoRefreshSeconds: 20 }, normalized),
    };
  }

  const desiredCount = action === "on" ? 1 : 0;
  const messages: string[] = [];

  for (const apiName of config.serviceApis) {
    try {
      await ecs.send(
        new UpdateServiceCommand({
          cluster: config.cluster,
          service: apiName,
          desiredCount,
        })
      );
    } catch (err) {
      messages.push(`${apiName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    await ecs.send(
      new UpdateServiceCommand({
        cluster: config.cluster,
        service: config.serviceApp,
        desiredCount,
      })
    );
  } catch (err) {
    messages.push(`App: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const workerName of config.serviceWorkers) {
    try {
      await ecs.send(
        new UpdateServiceCommand({
          cluster: config.cluster,
          service: workerName,
          desiredCount,
        })
      );
    } catch (err) {
      messages.push(`${workerName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const id of config.dbClusterIds) {
    try {
      const describe = await rds.send(
        new DescribeDBClustersCommand({ DBClusterIdentifier: id })
      );
      const cluster = describe.DBClusters?.[0];
      if (cluster?.DBClusterIdentifier) {
        const minAcu = action === "off" ? AURORA_OFF_MIN : AURORA_ON_MIN;
        const maxAcu = action === "off" ? AURORA_OFF_MAX : AURORA_ON_MAX;
        await rds.send(
          new ModifyDBClusterCommand({
            DBClusterIdentifier: id,
            ServerlessV2ScalingConfiguration: {
              MinCapacity: minAcu,
              MaxCapacity: maxAcu,
            },
          })
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/isn't available for modification|status modifying/i.test(msg))
        messages.push(`${id} (Aurora): em modificação; aguarde 1–2 min.`);
      else messages.push(`${id} (Aurora): ${msg}`);
    }
  }
  for (const id of config.dbInstanceIds) {
    try {
      const describe = await rds.send(
        new DescribeDBInstancesCommand({ DBInstanceIdentifier: id })
      );
      const instance = describe.DBInstances?.[0];
      if (instance?.DBInstanceIdentifier) {
        const currentStatus = (instance.DBInstanceStatus ?? "").toLowerCase();
        if (action === "off" && currentStatus === "available")
          await rds.send(new StopDBInstanceCommand({ DBInstanceIdentifier: id }));
        else if (action === "on" && currentStatus === "stopped")
          await rds.send(new StartDBInstanceCommand({ DBInstanceIdentifier: id }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/InvalidParameterValue|Cannot modify|is not in state/i.test(msg))
        messages.push(`${id} (RDS): instância em transição; aguarde.`);
      else messages.push(`${id} (RDS): ${msg}`);
    }
  }

  const finalStatus = await getStatus();
  const dynamicSchedule = await loadDynamicSchedule();
  if (wantsJson(event)) {
    const payload = statusToJson(finalStatus, dynamicSchedule);
    const message =
      messages.join(". ") || (action === "on" ? "Ligando." : "Desligando.");
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, message }),
    };
  }
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: htmlPage(
      functionUrl,
      messages.join(". ") || undefined,
      finalStatus,
      {
        showStartupNotice: true,
        autoRefreshSeconds: 20,
      },
      dynamicSchedule
    ),
  };
};
