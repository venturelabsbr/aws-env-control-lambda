# aws-env-control-lambda

Lambda para AWS que liga/desliga ambiente (ECS + Aurora Serverless v2 ou RDS) com página HTML e API JSON. Suporta App, API (opcional), Worker (opcional) e banco Aurora ou RDS.

## Variáveis de ambiente (Lambda)

| Variável | Obrigatório | Descrição |
|----------|-------------|-----------|
| `HML_CLUSTER` | Sim | Nome do cluster ECS |
| `HML_SERVICE_APP` | Sim | Nome do serviço ECS do app |
| `HML_SERVICE_API` | Não | Nome do serviço ECS da API (se existir serviço separado) |
| `HML_SERVICE_WORKER` | Não | Nome do serviço ECS do worker |
| `HML_DB_CLUSTER` | Aurora | ID do cluster Aurora (escala 0 = desligado) |
| `HML_DB_INSTANCE` | RDS | ID da instância RDS (Start/Stop) |
| `HML_CONTROL_TOKEN` | Não | Token para POST (vazio = sem proteção) |
| `HML_PROJECT_NAME` | Não | Nome exibido na UI |

Use **Aurora** (`HML_DB_CLUSTER` preenchido) ou **RDS** (`HML_DB_INSTANCE` preenchido), não os dois.

## API

- **GET** — Página HTML com status e botões Ligar/Desligar.
- **GET ?format=json** ou **Accept: application/json** — JSON com `{ allOn, allOff, items: [{ label, on }] }`.
- **POST** — Ação `on` ou `off`. Body: form-urlencoded ou JSON `{ "action": "on"|"off", "token": "..." }`. Resposta JSON (quando Accept/format=json): `{ allOn, allOff, items, message }` ou `{ error: "..." }`.

## Instalação no projeto (Terraform + Lambda)

### 1. Instalar como dependência (npm)

No repositório do seu projeto (ex.: meeting-transcriber, real-time-call-with-ai):

```bash
npm install github:venturelabsbr/aws-env-control-lambda --save
```

Isso coloca o código em `node_modules/aws-env-control-lambda/`.

### 2. Terraform: apontar o módulo env-control para o pacote

No Terraform que já usa o [módulo env-control](https://github.com/your-org/meeting-transcriber/tree/main/terraform/modules/env-control), defina o `source_path` para o pacote instalado:

```hcl
module "env_control" {
  source   = "./modules/env-control"
  app_name = var.app_name

  # Código instalado via npm install github:venturelabsbr/aws-env-control-lambda
  source_path = "${path.root}/node_modules/aws-env-control-lambda"

  ecs_cluster_name   = aws_ecs_cluster.main.name
  ecs_service_app    = aws_ecs_service.app.name
  ecs_service_worker = aws_ecs_service.worker.name
  ecs_service_api    = ""  # opcional: nome do serviço API se existir
  use_aurora         = true
  db_cluster_id      = "meu-app-db"
  db_instance_id     = ""
  token              = var.env_control_token
  project_name       = var.env_control_project_name
}
```

O módulo Terraform deve aceitar `ecs_service_api` e repassar como `HML_SERVICE_API`; se o seu módulo ainda não tiver, adicione a variável e a env.

### 3. Atualizar a Lambda

Sempre que atualizar o pacote no projeto:

```bash
npm update aws-env-control-lambda
terraform apply
```

Ou fixar versão por tag (quando existir): `"aws-env-control-lambda": "github:venturelabsbr/aws-env-control-lambda#v1.0.0"`.

## Build local do zip (para deploy manual)

```bash
git clone https://github.com/venturelabsbr/aws-env-control-lambda.git
cd aws-env-control-lambda
npm ci --omit=dev
zip -rq env-control.zip .
# Fazer upload de env-control.zip para a função Lambda no console ou via AWS CLI.
```

## Licença

MIT
