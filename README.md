# aws-env-control-lambda

Lambda para AWS que liga/desliga ambiente (ECS + Aurora Serverless v2 ou RDS) com página HTML e API JSON. Suporta múltiplos serviços (app, APIs, workers) e múltiplos bancos (RDS e/ou Aurora). **Uso com Terraform**: configuração via env `ENV_CONFIG` (JSON).

## Contrato `ENV_CONFIG`

Variável de ambiente na Lambda:

| Variável     | Obrigatório | Descrição       |
|-------------|-------------|-----------------|
| `ENV_CONFIG` | Sim        | JSON (contrato abaixo) |

```json
{
  "cluster": "nome-do-cluster-ecs",
  "region": "us-east-1",
  "services": {
    "app": "nome-servico-app",
    "apis": ["api-1", "api-2"],
    "workers": ["worker-1", "worker-2"]
  },
  "databases": {
    "rds": ["id-instancia-rds-1"],
    "aurora": ["id-cluster-aurora-1"]
  },
  "token": "token-secreto-post",
  "projectName": "Nome do Projeto"
}
```

| Campo | Obrigatório | Descrição |
|------|-------------|-----------|
| `cluster` | Sim | Nome do cluster ECS |
| `region` | Não | Região AWS (default: `AWS_REGION` ou `us-east-1`) |
| `services.app` | Sim | Nome do serviço ECS do app |
| `services.apis` | Não | Array de nomes dos serviços ECS de API |
| `services.workers` | Não | Array de nomes dos serviços ECS de worker |
| `databases.rds` | Não | Array de IDs de instâncias RDS (Start/Stop) |
| `databases.aurora` | Não | Array de IDs de clusters Aurora (escala 0 = desligado) |
| `token` | Não | Token para POST (vazio = sem proteção) |
| `projectName` | Não | Nome exibido na UI |

RDS e Aurora podem ser usados ao mesmo tempo (vários de cada).

## API (Function URL)

- **GET** — Página HTML com status e botões Ligar/Desligar.
- **GET ?format=json** ou **Accept: application/json** — JSON: `{ allOn, allOff, items: [{ label, on }] }`.
- **POST** — Ação `on` ou `off`. Body: form-urlencoded ou JSON `{ "action": "on"|"off", "token": "..." }`. Resposta JSON: `{ allOn, allOff, items, message }` ou `{ error: "..." }`.

## Uso com Terraform

### 1. Incluir o pacote no projeto

No repositório onde está o Terraform:

```bash
npm install github:venturelabsbr/aws-env-control-lambda --save
```

### 2. Gerar o zip da Lambda

A Lambda usa **handler** `dist/index.handler` (ESM). O zip deve conter `dist/`, `node_modules/` e `package.json`.

**Importante:** não inclua `index.mjs` nem `index.ts` na **raiz** do zip. O runtime da Lambda pode tentar carregar o módulo `"index"` e falhar com "Cannot find module 'index'". Exclua-os no `find` com `! -path './index.mjs' ! -path './index.ts'`.

**Build determinístico (recomendado com Terraform)**

Para que `source_code_hash` seja estável entre `plan` e `apply`, use ordem fixa e `zip -X`. Exclua os arquivos de entrada na raiz para evitar conflito no runtime:

```bash
cd node_modules/aws-env-control-lambda
(npm ci 2>/dev/null || npm install 2>/dev/null)
find . -type f ! -path './.git/*' ! -path './index.mjs' ! -path './index.ts' | sort | zip -rq -X env-control-lambda.zip -@
```

- `find ... ! -path './index.mjs' ! -path './index.ts'` — evita "Cannot find module 'index'" na Lambda.
- `sort` — ordem determinística.
- `zip -rq -X` — `-X` evita metadados que variam entre máquinas.

**Build manual (no projeto, após `npm install`):**

Opção A — zipar só o necessário (sem arquivos na raiz que confundam o runtime):

```bash
cd node_modules/aws-env-control-lambda
npm ci --omit=dev
npm run build
zip -rq ../../env-control-lambda.zip dist node_modules package.json
cd ../..
```

Opção B — zipar a pasta toda **excluindo** `index.mjs` e `index.ts` da raiz:

```bash
cd node_modules/aws-env-control-lambda
npm ci --omit=dev
find . -type f ! -path './.git/*' ! -path './index.mjs' ! -path './index.ts' | sort | zip -rq -X ../../env-control-lambda.zip -@
cd ../..
```

**Build via Terraform (determinístico)**

Use `data "external"` para gerar o zip no **plan** (assim `filebase64sha256` existe no primeiro apply). Na Lambda use `depends_on = [data.external.env_control_build]` para evitar hash diferente no apply. **Exclua** `index.mjs` e `index.ts` da raiz no `find`:

```hcl
locals {
  env_control_source = "${path.module}/node_modules/aws-env-control-lambda"
  env_control_zip    = "${path.module}/env-control-lambda.zip"
  env_control_build_cmd = "cd ${local.env_control_source} && (npm ci 2>/dev/null || npm install 2>/dev/null) && find . -type f ! -path './.git/*' ! -path './index.mjs' ! -path './index.ts' | sort | zip -rq -X ${local.env_control_zip} -@"
}

data "external" "env_control_build" {
  program = ["sh", "-c", "${local.env_control_build_cmd} 1>&2; echo '{\"ok\":\"1\"}'"]
}
```

Na Lambda: `filename = local.env_control_zip`, `source_code_hash = filebase64sha256(local.env_control_zip)`, `handler = "dist/index.handler"` e `depends_on = [data.external.env_control_build]`.

### 3. Recursos Terraform: Lambda, IAM, Function URL

```hcl
# IAM role
resource "aws_iam_role" "env_control" {
  name = "env-control-lambda-role"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

# Permissões: CloudWatch Logs, ECS, RDS
resource "aws_iam_role_policy" "env_control" {
  name   = "env-control-lambda"
  role   = aws_iam_role.env_control.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect   = "Allow"
        Action   = ["ecs:DescribeServices", "ecs:DescribeClusters", "ecs:UpdateService"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = [
          "rds:DescribeDBInstances", "rds:DescribeDBClusters",
          "rds:StartDBInstance", "rds:StopDBInstance",
          "rds:ModifyDBCluster"
        ]
        Resource = "*"
      }
    ]
  })
}

# Config para ENV_CONFIG
locals {
  env_control_config = {
    cluster   = aws_ecs_cluster.main.name
    region    = data.aws_region.current.name
    services  = {
      app     = aws_ecs_service.app.name
      apis    = [] # ou [aws_ecs_service.api.name]
      workers = [aws_ecs_service.worker.name]
    }
    databases = {
      aurora = [aws_rds_cluster.main.id]
      # rds   = [aws_db_instance.main.id]
    }
    token       = var.env_control_token
    projectName = var.project_name
  }
}

# Lambda
resource "aws_lambda_function" "env_control" {
  filename         = "${path.module}/env-control-lambda.zip"
  function_name    = "env-control"
  role             = aws_iam_role.env_control.arn
  handler          = "dist/index.handler"
  runtime          = "nodejs20.x"
  timeout          = 60  # ECS/RDS podem demorar
  source_code_hash = filebase64sha256("${path.module}/env-control-lambda.zip")

  environment {
    variables = {
      ENV_CONFIG = jsonencode(local.env_control_config)
    }
  }

  depends_on = [data.external.env_control_build] # zip gerado no plan
}

# Function URL (acesso pelo navegador)
resource "aws_lambda_function_url" "env_control" {
  function_name      = aws_lambda_function.env_control.function_name
  authorization_type = "NONE"
}

# Permissão para invocação pública da URL (evita 403 em muitas contas)
resource "aws_lambda_permission" "env_control_url" {
  statement_id           = "AllowPublicInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.env_control.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "env_control_invoke" {
  statement_id  = "AllowPublicInvokeFunction"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.env_control.function_name
  principal     = "*"
}

output "env_control_url" {
  value = aws_lambda_function_url.env_control.function_url
}
```

Ajuste `filename` e `source_code_hash` se o zip vier do CI. Acesse `env_control_url` no navegador para ligar/desligar o ambiente.

### Resumo

| Passo | Ação |
|-------|------|
| 1 | `npm install github:venturelabsbr/aws-env-control-lambda` no projeto |
| 2 | Gerar zip: **excluir** `./index.mjs` e `./index.ts` do zip (evita "Cannot find module 'index'"). Build determinístico: `find ... ! -path './index.mjs' ! -path './index.ts' \| sort \| zip -X`. Terraform: `data "external"` no plan; Lambda `depends_on = [data.external.env_control_build]`. |
| 3 | Lambda: `handler = "dist/index.handler"`, `runtime = "nodejs20.x"`, `timeout = 60`, `ENV_CONFIG = jsonencode(...)`. IAM: logs, ECS (DescribeClusters, DescribeServices, UpdateService), RDS (Describe*, Start*, Stop*, ModifyDBCluster). |
| 4 | `aws_lambda_function_url` + `aws_lambda_permission` para invocação pública |

Para atualizar: `npm update aws-env-control-lambda`, rebuild do zip e `terraform apply`.

## Licença

MIT
