import { ECSClient, UpdateServiceCommand, DescribeServicesCommand } from "@aws-sdk/client-ecs";
import { RDSClient, StopDBInstanceCommand, StartDBInstanceCommand, DescribeDBInstancesCommand, DescribeDBClustersCommand, ModifyDBClusterCommand } from "@aws-sdk/client-rds";

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
const CLUSTER = process.env.HML_CLUSTER;
const SERVICE_APP = process.env.HML_SERVICE_APP;
const SERVICE_API = (process.env.HML_SERVICE_API ?? "").trim();
const SERVICE_WORKER = (process.env.HML_SERVICE_WORKER ?? "").trim();
const DB_INSTANCE_ID = (process.env.HML_DB_INSTANCE ?? "").trim();
const DB_CLUSTER_ID = (process.env.HML_DB_CLUSTER ?? "").trim();
const TOKEN = (process.env.HML_CONTROL_TOKEN ?? "").trim();
const PROJECT_NAME = (process.env.HML_PROJECT_NAME ?? "").trim();
const useAurora = DB_CLUSTER_ID.length > 0;

const ecs = new ECSClient({ region: REGION });
const rds = new RDSClient({ region: REGION });

const AURORA_OFF_MIN = 0;
const AURORA_OFF_MAX = 1;
const AURORA_ON_MIN = 0.5;
const AURORA_ON_MAX = 1;

async function getStatus() {
  const status = { appRunning: 0, apiRunning: 0, workerRunning: 0, rdsStatus: null, rdsMinAcu: null };
  try {
    const services = [SERVICE_APP, ...(SERVICE_API ? [SERVICE_API] : []), ...(SERVICE_WORKER ? [SERVICE_WORKER] : [])].filter(Boolean);
    const svcPromise = services.length
      ? ecs.send(new DescribeServicesCommand({ cluster: CLUSTER, services }))
      : Promise.resolve({ services: [] });
    const dbPromise = useAurora
      ? rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: DB_CLUSTER_ID }))
      : (DB_INSTANCE_ID ? rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: DB_INSTANCE_ID })) : Promise.resolve({ DBInstances: [] }));
    const [svc, db] = await Promise.all([svcPromise, dbPromise]);
    const appSvc = svc.services?.find((s) => s.serviceName === SERVICE_APP);
    if (appSvc) status.appRunning = appSvc.runningCount ?? 0;
    if (SERVICE_API) {
      const apiSvc = svc.services?.find((s) => s.serviceName === SERVICE_API);
      if (apiSvc) status.apiRunning = apiSvc.runningCount ?? 0;
    }
    if (SERVICE_WORKER) {
      const workerSvc = svc.services?.find((s) => s.serviceName === SERVICE_WORKER);
      if (workerSvc) status.workerRunning = workerSvc.runningCount ?? 0;
    }
    if (useAurora) {
      const scaling = db.DBClusters?.[0]?.ServerlessV2ScalingConfiguration;
      if (scaling) status.rdsMinAcu = scaling.MinCapacity;
    } else {
      const instance = db.DBInstances?.[0];
      if (instance) status.rdsStatus = instance.DBInstanceStatus;
    }
  } catch (_) {}
  return status;
}

function statusToJson(status) {
  const empty = { allOn: false, allOff: true, items: [] };
  if (!status) return empty;
  const appOn = (status.appRunning ?? 0) > 0;
  const apiOn = (status.apiRunning ?? 0) > 0;
  const workerOn = (status.workerRunning ?? 0) > 0;
  const dbOn = useAurora ? (status.rdsMinAcu != null && status.rdsMinAcu > 0) : (status.rdsStatus === "available");
  const allOn = appOn && dbOn && (!SERVICE_API || apiOn) && (!SERVICE_WORKER || workerOn);
  const allOff = !appOn && !dbOn && (!SERVICE_API || !apiOn) && (!SERVICE_WORKER || !workerOn);
  const items = [
    ...(SERVICE_API ? [{ label: "API", on: apiOn }] : []),
    { label: "App", on: appOn },
    ...(SERVICE_WORKER ? [{ label: "Worker", on: workerOn }] : []),
    { label: useAurora ? "Banco (Aurora)" : "Banco (RDS)", on: dbOn },
  ];
  return { allOn, allOff, items };
}

function statusBlock(status) {
  if (!status) return "<p class=\"text-sm text-slate-400 mb-4\">Ligar ou desligar ambiente.</p>";
  const appOn = status.appRunning > 0;
  const apiOn = status.apiRunning > 0;
  const workerOn = status.workerRunning > 0;
  const dbOn = useAurora ? (status.rdsMinAcu != null && status.rdsMinAcu > 0) : (status.rdsStatus === "available");
  const dbStarting = !useAurora && status.rdsStatus === "starting";
  const dbStopping = !useAurora && status.rdsStatus === "stopping";
  const allOn = appOn && dbOn && (!SERVICE_API || apiOn) && (!SERVICE_WORKER || workerOn);
  const allOff = !appOn && !dbOn && (!SERVICE_API || !apiOn) && (!SERVICE_WORKER || !workerOn);
  const hasDivergence = !allOn && !allOff && !dbStarting && !dbStopping;
  const divergenceWarning = hasDivergence
    ? `<div class="mb-4 p-3 rounded-lg bg-amber-900/50 border border-amber-600/50 text-amber-200 text-sm">Os status estão diferentes. O ambiente pode estar iniciando ou desligando; aguarde alguns minutos.</div>`
    : "";
  const dbLabel = dbOn ? (useAurora ? `Ligado (${status.rdsMinAcu ?? "?"} ACU)` : "Ligado") : (dbStarting ? "Ligando…" : (dbStopping ? "Desligando…" : (useAurora ? "Escala mínima" : "Desligado")));
  const apiLine = SERVICE_API
    ? `<div class="flex items-center gap-2"><span class="h-2.5 w-2.5 rounded-full ${apiOn ? "bg-emerald-500" : "bg-rose-500"}"></span><span class="text-sm text-slate-300">API</span><span class="text-sm ${apiOn ? "text-emerald-400" : "text-rose-400"}">${apiOn ? "Ligado" : "Desligado"}</span></div>`
    : "";
  const workerLine = SERVICE_WORKER
    ? `<div class="flex items-center gap-2"><span class="h-2.5 w-2.5 rounded-full ${workerOn ? "bg-emerald-500" : "bg-rose-500"}"></span><span class="text-sm text-slate-300">Worker</span><span class="text-sm ${workerOn ? "text-emerald-400" : "text-rose-400"}">${workerOn ? "Ligado" : "Desligado"}</span></div>`
    : "";
  return `${divergenceWarning}
    <div class="mb-4 flex flex-col gap-2">
      ${apiLine}
      <div class="flex items-center gap-2"><span class="h-2.5 w-2.5 rounded-full ${appOn ? "bg-emerald-500" : "bg-rose-500"}"></span><span class="text-sm text-slate-300">App</span><span class="text-sm ${appOn ? "text-emerald-400" : "text-rose-400"}">${appOn ? "Ligado" : "Desligado"}</span></div>
      ${workerLine}
      <div class="flex items-center gap-2"><span class="h-2.5 w-2.5 rounded-full ${dbOn ? "bg-emerald-500" : (dbStarting || dbStopping ? "bg-amber-500" : "bg-rose-500")}"></span><span class="text-sm text-slate-300">Banco (${useAurora ? "Aurora" : "RDS"})</span><span class="text-sm ${dbOn ? "text-emerald-400" : (dbStarting || dbStopping ? "text-amber-400" : "text-rose-400")}">${dbLabel}</span></div>
    </div>`;
}

function htmlPage(functionUrl, message = "", status = null, options = {}) {
  const { showStartupNotice = false, autoRefreshSeconds = 20 } = options;
  const action = functionUrl || "";
  const tokenRequired = (String(process.env.HML_CONTROL_TOKEN || "").trim().length > 0);
  const statusHtml = statusBlock(status);
  const startupNotice = showStartupNotice
    ? `<div class="mb-4 p-3 rounded-lg bg-cyan-900/40 border border-cyan-600/50 text-cyan-200 text-sm">Os serviços podem levar alguns minutos para ficarem disponíveis. A página será atualizada automaticamente; evite clicar novamente.</div>`
    : "";
  const refreshMeta = autoRefreshSeconds > 0 ? `<meta http-equiv="refresh" content="${autoRefreshSeconds}">` : "";
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${PROJECT_NAME ? `${PROJECT_NAME} — Controle` : "Controle ambiente"}</title>${refreshMeta}<script src="https://cdn.tailwindcss.com"></script></head>
<body class="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-4">
  <div class="w-full max-w-md rounded-xl bg-slate-800 border border-slate-700 shadow-xl p-6">
    ${PROJECT_NAME ? `<p class="text-xs text-slate-500 uppercase tracking-wider mb-1">${PROJECT_NAME}</p>` : ""}
    <h1 class="text-xl font-semibold text-slate-100 mb-2">Controle ambiente</h1>${statusHtml}${startupNotice}
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

function parseBody(body, contentType) {
  if (!body) return {};
  const str = typeof body === "string" ? body : (body instanceof Buffer ? body.toString("utf8") : String(body));
  if ((contentType || "").toLowerCase().includes("application/json")) {
    try { return JSON.parse(str); } catch { return {}; }
  }
  try { return Object.fromEntries(new URLSearchParams(str)); } catch { return {}; }
}

function getRawBody(event) {
  const b = event.body;
  if (!b) return "";
  if (event.isBase64Encoded) return Buffer.from(b, "base64").toString("utf8");
  return typeof b === "string" ? b : String(b);
}

function getToken(event) {
  const q = event.queryStringParameters || {};
  if (q.token) return q.token;
  const contentType = (event.headers && (event.headers["content-type"] || event.headers["Content-Type"])) || "";
  const body = parseBody(getRawBody(event), contentType);
  return body.token ?? "";
}

function wantsJson(event) {
  const q = event.queryStringParameters || {};
  if (q.format === "json") return true;
  const accept = (event.headers && (event.headers["accept"] || event.headers["Accept"])) || "";
  return accept.includes("application/json");
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod || "GET";
  const functionUrl = event.requestContext?.domainName ? `https://${event.requestContext.domainName}${event.rawPath || ""}` : "";

  if (method === "GET") {
    let status = null;
    try { status = await getStatus(); } catch (_) {}
    if (event.queryStringParameters?.format === "json" || wantsJson(event)) {
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(statusToJson(status)) };
    }
    return { statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: htmlPage(functionUrl, "", status, { autoRefreshSeconds: 20 }) };
  }

  if (method !== "POST") {
    if (wantsJson(event)) return { statusCode: 405, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Method Not Allowed" }) };
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const contentType = (event.headers && (event.headers["content-type"] || event.headers["Content-Type"])) || "";
  const rawBody = getRawBody(event);
  const body = parseBody(rawBody, contentType);
  const action = (body.action || "").trim() || (event.queryStringParameters || {}).action;

  if (!action || !["on", "off"].includes(action)) {
    if (wantsJson(event)) return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Informe action: on ou off." }) };
    return { statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: htmlPage(functionUrl, "Informe action: on ou off.", null, { autoRefreshSeconds: 20 }) };
  }

  const token = getToken(event);
  if (TOKEN.length > 0 && token !== TOKEN) {
    if (wantsJson(event)) return { statusCode: 403, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Token inválido." }) };
    return { statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: htmlPage(functionUrl, "Token inválido.", null, { autoRefreshSeconds: 20 }) };
  }

  const desiredCount = action === "on" ? 1 : 0;
  const messages = [];

  if (SERVICE_API) {
    try {
      await ecs.send(new UpdateServiceCommand({ cluster: CLUSTER, service: SERVICE_API, desiredCount }));
    } catch (err) { messages.push(`API: ${err.message}`); }
  }
  try {
    await ecs.send(new UpdateServiceCommand({ cluster: CLUSTER, service: SERVICE_APP, desiredCount }));
  } catch (err) { messages.push(`App: ${err.message}`); }
  if (SERVICE_WORKER) {
    try {
      await ecs.send(new UpdateServiceCommand({ cluster: CLUSTER, service: SERVICE_WORKER, desiredCount }));
    } catch (err) { messages.push(`Worker: ${err.message}`); }
  }

  try {
    if (useAurora) {
      const describe = await rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: DB_CLUSTER_ID }));
      const cluster = describe.DBClusters?.[0];
      if (cluster?.DBClusterIdentifier) {
        const minAcu = action === "off" ? AURORA_OFF_MIN : AURORA_ON_MIN;
        const maxAcu = action === "off" ? AURORA_OFF_MAX : AURORA_ON_MAX;
        await rds.send(new ModifyDBClusterCommand({
          DBClusterIdentifier: DB_CLUSTER_ID,
          ServerlessV2ScalingConfiguration: { MinCapacity: minAcu, MaxCapacity: maxAcu },
        }));
      }
    } else if (DB_INSTANCE_ID) {
      const describe = await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: DB_INSTANCE_ID }));
      const instance = describe.DBInstances?.[0];
      if (instance?.DBInstanceIdentifier) {
        const currentStatus = (instance.DBInstanceStatus || "").toLowerCase();
        if (action === "off" && currentStatus === "available") await rds.send(new StopDBInstanceCommand({ DBInstanceIdentifier: DB_INSTANCE_ID }));
        else if (action === "on" && currentStatus === "stopped") await rds.send(new StartDBInstanceCommand({ DBInstanceIdentifier: DB_INSTANCE_ID }));
      }
    }
  } catch (err) {
    const msg = (err?.message) ? String(err.message) : "";
    if (useAurora && /isn't available for modification|status modifying/i.test(msg)) messages.push("Aurora: em modificação; aguarde 1–2 min e tente novamente.");
    else if (!useAurora && /InvalidParameterValue|Cannot modify|is not in state/i.test(msg)) messages.push("RDS: instância em transição; aguarde e tente novamente.");
    else messages.push(useAurora ? `Aurora: ${msg || err}` : `RDS: ${msg || err}`);
  }

  const finalStatus = await getStatus();
  if (wantsJson(event)) {
    const payload = statusToJson(finalStatus);
    const message = messages.join(". ") || (action === "on" ? "Ligando." : "Desligando.");
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, message }) };
  }
  return { statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: htmlPage(functionUrl, messages.join(". ") || undefined, finalStatus, { showStartupNotice: true, autoRefreshSeconds: 20 }) };
};
