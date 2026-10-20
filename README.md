# byulmaru media

JPEG, PNG, WebP 이미지를 검증하고 WebP로 저장하는 업로드 서비스입니다. 기존 `/v1`은 요청 안에서 변환을 끝내고, `/v2`는 비공개 R2 staging에 저장한 원본을 Temporal Worker가 비동기 처리하며 API는 처리가 끝날 때까지 HTTP 요청을 기다립니다. 두 경로의 결과는 기존 공개 bucket의 `original/<id>.webp`에 저장되며 `https://media.byulma.run`에서 제공합니다.

이미지 변환에는 Cloudflare Images 대신 단일 스레드 WASM인 jSquash를 사용합니다.

## Architecture

### v1: 기존 inline 업로드

1. 인증된 Kosmo backend가 `POST /v1/uploads`를 호출합니다.
2. API가 `u_<UUIDv4>` ID와 10분짜리 signed upload URL을 반환합니다.
3. 브라우저가 signed URL에 원본 이미지를 `PUT`합니다.
4. 같은 API 요청이 이미지 제한을 검증하고 WebP로 변환해 `original/<id>.webp`에 저장합니다.
5. 성공 응답의 `url`은 `https://media.byulma.run/original/<id>.webp`를 가리킵니다.

### v2: Temporal 업로드

1. 인증된 backend가 같은 API host의 `POST /v2/uploads`를 호출합니다. API는 v1과 같은 ticket 필드(`id`, `uploadUrl`, `expiresAt`)로 `201`을 반환합니다.
2. 브라우저가 signed URL에 원본 bytes를 `PUT`하면 API가 검증 후 private `byulmaru-media-staging` bucket에 저장하고 Temporal Workflow 처리를 기다립니다.
3. `media-upload` task queue의 별도 `media-worker` Deployment가 원본을 WebP로 변환해 기존 공개 bucket의 `original/<id>.webp`에 저장한 뒤 staging object를 삭제합니다.
4. 처리가 끝나면 PUT은 v1과 같은 `{ "id", "url" }` 응답으로 `201`을 반환합니다. `/v2/uploads/<id>`의 GET/HEAD 조회도 v1과 같은 저장 표현을 사용합니다.

API와 Worker는 같은 image digest를 사용하지만 별도 Deployment입니다. Temporal Worker가 중단되어도 `/v1`은 inline으로 계속 동작하며, `/v2` 처리에만 영향을 줍니다. Temporal 설정이나 staging credentials가 없으면 `/v2`는 `503`을 반환하고 `/v1`은 시작 및 동작을 계속합니다. Temporal namespace는 `media`, task queue는 `media-upload`입니다.

Worker는 Wrangler `MEDIA` R2 binding으로 저장하고 Node.js 서버는 R2 S3 API로 저장합니다. `/v1` Worker와 Node 서버는 같은 encoder와 객체 형식, metadata를 사용합니다. Worker의 `pnpm dev`, `pnpm deploy`, `pnpm dry-run` 명령은 계속 사용할 수 있습니다.

Production API는 `media-api.byulmaru.co`에서 제공하며 Kubernetes ingress가 이 hostname을 처리합니다. Cloudflare Worker 코드와 배포는 남아 있지만 API route와 `workers.dev` endpoint는 비활성화합니다.

Remote Media, thumbnail, Worker 이미지 조회 proxy와 KV는 v1 범위에 포함하지 않습니다.

## Infrastructure

[Terraform](./terraform/main.tf)은 다음 Cloudflare 리소스를 관리합니다.

- 공개 `byulmaru-media` R2 bucket, `media.byulma.run` custom domain, 공개 GET/HEAD CORS
- 비공개 `byulmaru-media-staging` R2 bucket과 `uploads/` object의 24시간 lifecycle 만료

Staging bucket에는 custom domain, public CORS, `r2.dev` 공개 URL을 설정하지 않습니다. Cloudflare R2 bucket은 기본적으로 비공개이며 인터넷 공개에는 명시적 설정이 필요합니다. Lifecycle 만료는 staging 원본을 복구하는 보장이 아니라 worker가 처리하지 못한 object를 정리하는 backstop입니다. Cloudflare는 만료 시점 뒤 object를 보통 24시간 안에 삭제합니다. 자세한 내용은 [R2 public bucket 정책](https://developers.cloudflare.com/r2/buckets/public-buckets/)과 [object lifecycle 동작](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)을 참고하세요.

Cloudflare Worker 코드와 secret은 Wrangler가 담당합니다. API hostname과 HTTPRoute는 Helm chart에서 Kubernetes ingress로 설정합니다. Node.js API와 Worker의 환경 변수는 실행 환경에서 주입합니다. 공개 bucket 자격 증명은 `byulmaru-media`에 필요한 권한만, staging 자격 증명은 `byulmaru-media-staging` object read/write 권한만 주도록 각각 분리해 Vault에 보관합니다. 어떤 R2 secret도 Helm values나 image에 넣지 않습니다.

Terraform plan/apply는 [GitHub Actions](./.github/workflows/terraform.yml)가 실행합니다. Pull request에서는 plan만 만들고 `main` push와 수동 실행에서는 새 saved plan을 적용합니다. State는 `byulmaru-terraform-state` S3 bucket의 `media/terraform.tfstate` key를 사용합니다.

Repository variables:

- `AWS_ROLE_ARN`: state bucket에 접근할 GitHub Actions OIDC role
- `CLOUDFLARE_ACCOUNT_ID`: media 리소스를 소유할 Cloudflare account ID
- `CLOUDFLARE_ZONE_ID`: `byulma.run` Cloudflare zone ID
- `TAILSCALE_OAUTH_CLIENT_ID`, `TAILSCALE_AUDIENCE`: GitHub Actions가 private Argo CD에 접근할 Tailscale workload identity 값. Media repository의 GitHub OIDC identity도 Tailscale 외부 workload identity 정책에서 허용해야 합니다.

Repository secrets:

- `CLOUDFLARE_API_TOKEN`: R2 bucket, custom domain, CORS와 lifecycle을 관리할 Terraform token

Cloudflare Terraform API token에는 `Workers R2 Storage Read`와 `Workers R2 Storage Write` 권한이 필요합니다.

로컬에서는 실제 backend에 연결하지 않고 구성을 검증합니다.

```sh
terraform -chdir=terraform init -backend=false
pnpm infra:fmt
pnpm infra:validate
```

Worker secret을 등록합니다.

```sh
pnpm exec wrangler secret put API_KEY
pnpm exec wrangler secret put UPLOAD_SIGNING_SECRET
```

단일 Worker는 `https://kos.moe`, `https://dev.kos.moe`, `http://localhost:5173`, `http://localhost:5174`의 브라우저 PUT을 허용합니다. 로컬 개발에서는 `.dev.vars`에 `API_KEY`와 32바이트 이상의 `UPLOAD_SIGNING_SECRET`을 넣고 `pnpm dev`를 실행합니다.

## Node.js server

Node.js 24 서버는 같은 HTTP API와 R2 bucket을 사용합니다. R2 S3 API endpoint, bucket name, API secrets를 실행 환경 변수로 전달합니다.

```sh
pnpm build:server
pnpm start:server
```

필수 환경 변수:

- `API_KEY`
- `UPLOAD_SIGNING_SECRET`
- `ALLOWED_ORIGINS`
- `PUBLIC_BASE_URL`
- `R2_ENDPOINT`: Cloudflare account의 R2 S3 API endpoint
- `R2_BUCKET_NAME`: 기존 Worker와 같은 `byulmaru-media` bucket
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `PUBLIC_API_BASE_URL`: 클라이언트가 호출하는 서버의 HTTPS public API origin. 로컬 개발에서는 `http://localhost`, `http://127.0.0.1`, `http://[::1]` origin도 허용합니다. Production에서는 Helm의 `host` 값이 이 origin을 정합니다.
- `/v2`용 `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`, `R2_STAGING_BUCKET_NAME`, `R2_STAGING_ACCESS_KEY_ID`, `R2_STAGING_SECRET_ACCESS_KEY`. Production namespace는 `media`, task queue는 `media-upload`입니다. 앞의 네 값은 Helm의 안전한 설정이고 staging access key/secret은 Vault에서 주입합니다.

Temporal `/v2` 설정은 선택 사항입니다. 설정 또는 staging credentials가 없으면 `/v2`는 `503`을 반환하고 기존 `/v1` 경로는 계속 실행됩니다.

`PUBLIC_API_BASE_URL`은 Node가 signed upload URL에 넣는 외부 API origin입니다. reverse proxy의 내부 주소가 아니라 클라이언트가 호출하는 HTTPS public origin을 사용하며, 외부 HTTP origin은 거부합니다. Worker는 이 변수를 사용하지 않고 요청 URL을 사용합니다. S3 region은 `auto`로 고정합니다. R2 S3 access key는 이 bucket에 대한 읽기와 쓰기만 허용하도록 만들고 실행 환경의 secret store에 보관합니다. `PORT`는 선택 사항이며 기본값은 `3000`입니다. 서버는 `0.0.0.0`에서 listen합니다.

Production image를 로컬에서 빌드하고 실행할 수 있습니다. `/path/to/runtime.env`는 위 환경 변수의 실제 값을 담은 실행 환경 파일입니다.

```sh
docker build -t byulmaru-media .
docker run --rm -p 3000:3000 --env-file /path/to/runtime.env byulmaru-media
```

`main`에 push되면 GitHub Actions가 해당 commit의 image를 네이티브 ARM64 runner에서 빌드해 `ghcr.io/byulmaru/media:latest`와 전체 source commit SHA 태그로 게시합니다. GHCR package는 공개입니다.

```sh
docker pull ghcr.io/byulmaru/media:latest
docker run --rm -p 3000:3000 --env-file /path/to/runtime.env ghcr.io/byulmaru/media:latest
```

## API

### Create a v2 browser upload

```http
POST /v2/uploads
Authorization: Bearer <API_KEY>
Content-Type: application/json

{"maxBytes":16777216,"maxDimension":8192}
```

`201 Created` ticket는 v1과 같은 필드를 사용합니다.

```json
{
  "id": "u_...",
  "uploadUrl": "https://media-api.byulmaru.co/v2/uploads/<signed-token>",
  "expiresAt": "..."
}
```

브라우저는 원본 bytes를 ticket의 `uploadUrl`에 `PUT`합니다. API가 검증을 마치면 private staging에 저장하고 Temporal Workflow가 처리를 완료할 때까지 응답을 기다립니다. 성공 시 v1과 같은 결과를 돌려줍니다.

```json
{
  "id": "u_...",
  "url": "https://media.byulma.run/original/u_....webp"
}
```

브라우저의 `PUT` 요청은 Temporal Workflow가 끝날 때까지 최대 100초 기다립니다. 시간이 지나면 `503` (`processing_pending`)을 반환하지만 Workflow는 계속 실행되며, 인증된 `GET` 또는 `HEAD /v2/uploads/<id>`는 객체가 준비되기 전 `404`, 준비된 뒤 `GET 200` 또는 `HEAD 204`를 반환합니다. 실행 중이거나 완료된 upload ticket을 재사용하면 `409`를 반환합니다.

v2 요청은 Temporal worker나 staging 설정이 없는 경우 `503`을 반환합니다. 이 설정은 `/v1`의 inline 업로드 경로를 차단하지 않습니다.

### Create a v1 browser upload

```http
POST /v1/uploads
Authorization: Bearer <API_KEY>
Content-Type: application/json

{"maxBytes":16777216,"maxDimension":8192}
```

```json
{
  "id": "u_...",
  "uploadUrl": "https://.../v1/uploads/<signed-token>",
  "expiresAt": "..."
}
```

브라우저가 원본 bytes를 직접 전송합니다.

```http
PUT <uploadUrl>
Origin: https://kos.moe
Content-Type: image/png

<raw image bytes>
```

```json
{
  "id": "u_...",
  "url": "https://media.byulma.run/original/u_....webp"
}
```

검증이나 인코딩 실패는 URL을 소비하지 않습니다. 최초 R2 저장 성공 후 같은 URL을 다시 사용하면 `409`를 반환합니다.

### Check upload completion and resolve its representation

Kosmo backend는 실제 소비 시점에 이미지 본문이나 공개 CDN을 거치지 않고 저장 완료를 확인합니다.

```http
HEAD /v1/uploads/u_...
Authorization: Bearer <API_KEY>
```

- immutable 원본이 저장됨: `204 No Content`
- 아직 저장되지 않음: `404 Not Found`
- 잘못된 ID: `400 Bad Request`
- 모든 응답: `Cache-Control: no-store`, body 없음

이 endpoint는 R2 binding의 object metadata만 확인하며 Account/Profile 소유권을 판단하지 않습니다.

Kosmo backend가 저장소 내부 규칙을 알지 않고 ActivityPub 표현을 만들 수 있도록, 같은 ID를
인증된 `GET`으로 조회하면 공개 URL과 실제 저장 객체의 MIME type을 반환합니다.

```http
GET /v1/uploads/u_...
Authorization: Bearer <API_KEY>
```

```json
{
  "url": "https://media.byulma.run/original/u_....webp",
  "mediaType": "image/webp"
}
```

- immutable 원본이 저장됨: `200 OK`
- 아직 저장되지 않음: `404 Not Found`
- 잘못된 ID: `400 Bad Request`
- 모든 응답: `Cache-Control: no-store`

이 endpoint 역시 소유권을 판단하지 않습니다. 호출자는 먼저 자신의 도메인 권한을 확인한 뒤
Media Storage Service가 소유한 공개 표현 정보만 조회해야 합니다.

## Security and limits

- source body: 최대 16 MiB
- 긴 변: 최대 8192px
- 총 pixels: 최대 16 MiPixels
- 지원 형식: JPEG, PNG, WebP
- 출력: metadata가 제거된 WebP 품질 80
- animation과 지원하지 않는 형식은 거부
- MIME 주장이 아니라 magic bytes와 이미지 header를 검증
- 원본 object는 `If-None-Match: *` 조건으로 한 번만 저장
- 공개 원본은 UUID 기반의 추측하기 어려운 URL을 사용하지만 ID나 URL 자체를 Kosmo 권한으로 취급하지 않음

## Development

```sh
pnpm config:validate
pnpm typecheck
pnpm test
pnpm dry-run
pnpm infra:fmt
pnpm infra:validate
```

## Kubernetes 배포 (Argo CD)

1. Kubernetes repository의 Terraform이 Media GitHub OIDC identity에 Argo CD `media` project 접근 권한을 주고, 이 repository의 Terraform이 `helm/` chart를 `media` namespace에 배포하는 `media` Application을 만듭니다. 처음에는 자동 동기화가 꺼져 있습니다.
2. `/v2`를 배포하기 전에 Kubernetes Temporal NetworkPolicy 변경을 적용해 `media` namespace만 Temporal frontend의 TCP 7233 ingress를 사용할 수 있게 합니다. Namespace 전체 허용이나 다른 namespace 접근은 추가하지 않습니다.
3. 별도 storage 준비 변경으로 `byulmaru-media-staging` bucket과 lifecycle rule을 적용한 뒤 완료를 확인합니다. Terraform workflow와 media Deploy workflow는 서로 다른 workflow라 같은 main push에서 실행 순서가 보장되지 않습니다.
4. Vault Secrets Operator와 `vso-kubernetes-sync` Kubernetes auth role이 필요합니다. KV v2 `secret/kubernetes/media`에 기존 `API_KEY`, `UPLOAD_SIGNING_SECRET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`와 함께 staging 전용 `R2_STAGING_ACCESS_KEY_ID`, `R2_STAGING_SECRET_ACCESS_KEY`를 저장합니다. Staging key에는 private `byulmaru-media-staging` bucket의 object read/write 권한만 부여하고 Git, Helm values, image에 저장하지 않습니다.
5. Chart의 PreSync Job은 `media` Temporal namespace를 30일 retention으로 create/update한 뒤 worker Deployment를 동기화합니다. Temporal CLI는 현재 cluster server와 같은 `1.31.2` admin-tools digest를 쓰며 TLS와 config file/env 설정을 끕니다. NetworkPolicy를 먼저 적용해야 합니다.
6. Chart의 기본 API host는 `media-api.byulmaru.co`이며 `host`가 HTTPRoute hostname과 `PUBLIC_API_BASE_URL`을 함께 정합니다. HTTPRoute는 `gateway/public` Gateway를 사용합니다. 이 repository는 DNS를 관리하지 않으며 공개 이미지 URL `media.byulma.run`은 그대로 둡니다.
7. `main`에 push되면 Deploy workflow가 source SHA, `version`, `imageDigest`를 설정해 API와 별도 worker를 함께 동기화합니다. 두 Deployment는 같은 ARM64 image digest를 쓰며 worker는 HTTP port나 Service를 노출하지 않습니다. Deployment 전에는 storage apply와 Vault staging key 준비가 끝나 있어야 합니다.
8. API는 기존 `/v1` inline 경로를 유지하고 Temporal 설정이 있을 때 `/v2`를 활성화합니다. Worker 장애는 `/v2` 처리에만 영향을 줍니다. API와 worker는 요청 CPU 100m / memory 256Mi, 제한 CPU 1 / memory 1Gi를 사용합니다. Staging은 영속 볼륨을 쓰지 않으며 Workflow가 Temporal 재시도로 cleanup activity를 실행하고, 남은 원본은 `uploads/` 24시간 lifecycle rule이 backstop으로 정리합니다.
