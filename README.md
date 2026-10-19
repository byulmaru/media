# byulmaru media

JPEG, PNG, WebP 이미지를 검증해 WebP로 정규화하고 Cloudflare R2에 저장하는 업로드 서비스입니다. 같은 API를 Cloudflare Worker와 Node.js 서버로 실행할 수 있습니다. 두 런타임은 같은 R2 bucket과 `original/<id>.webp` 객체 key를 사용하므로 트래픽을 단계적으로 전환할 수 있습니다. 공개 이미지는 `https://media.byulma.run`에서 제공합니다.

이미지 변환에는 Cloudflare Images 대신 단일 스레드 WASM인 jSquash를 사용합니다.

## Architecture

1. 인증된 Kosmo backend가 `POST /v1/uploads`를 호출합니다.
2. API가 `u_<UUIDv4>` ID와 10분짜리 signed upload URL을 반환합니다.
3. 브라우저가 signed URL에 원본 이미지를 `PUT`합니다.
4. API가 이미지 제한을 검증하고 WebP로 변환해 `original/<id>.webp`에 한 번만 저장합니다.
5. 성공 응답의 `url`은 `https://media.byulma.run/original/<id>.webp`를 가리킵니다.
6. 이미지 GET과 HEAD는 API 런타임을 통하지 않고 R2 custom domain으로 전달됩니다.

Worker는 Wrangler `MEDIA` R2 binding으로 저장하고 Node.js 서버는 R2 S3 API로 저장합니다. 두 런타임은 같은 encoder와 객체 형식, metadata를 사용합니다. 점진적으로 전환할 때는 두 런타임의 `API_KEY`, `UPLOAD_SIGNING_SECRET`, `ALLOWED_ORIGINS`, `PUBLIC_BASE_URL`을 맞추고, Node의 `R2_BUCKET_NAME`은 Worker의 `MEDIA` binding과 같은 `byulmaru-media` bucket을 가리키도록 설정합니다. Worker의 `pnpm dev`, `pnpm deploy`, `pnpm dry-run` 명령은 계속 사용할 수 있습니다.

Node.js 서버는 처음에 별도 API hostname으로 열고, Worker의 기존 custom domain은 유지한 채 호출자의 API base URL을 독립적으로 바꿀 수 있습니다. 두 런타임이 같은 bucket을 사용하므로 기존 Worker hostname과 발급된 upload ticket은 유효 기간이 끝나고 요청이 빠질 때까지 유지한 뒤 전환을 마칩니다. 서버용 hostname과 ingress는 배포 환경에서 별도로 설정합니다.

Remote Media, thumbnail, Worker 이미지 조회 proxy와 KV는 v1 범위에 포함하지 않습니다.

## Infrastructure

[Terraform](./terraform/main.tf)은 다음 Cloudflare 리소스를 관리합니다.

- `byulmaru-media` R2 bucket
- `media.byulma.run` R2 custom domain
- 공개 GET/HEAD를 위한 R2 CORS

Worker 코드, `media-api.byulmaru.co` custom domain과 Worker secret은 Wrangler가 담당합니다. Node.js 서버의 환경 변수는 실행 환경에서 주입합니다. R2 S3 access key는 서버의 secret store에 보관하고 이미지로 복사하지 않습니다.

Terraform plan/apply는 [GitHub Actions](./.github/workflows/terraform.yml)가 실행합니다. Pull request에서는 plan만 만들고, `main` push와 수동 실행에서는 새 saved plan을 생성해 그대로 적용합니다. State는 `byulmaru-terraform-state` S3 bucket의 `media/terraform.tfstate` key를 사용합니다.

Repository variables:

- `AWS_ROLE_ARN`: state bucket에 접근할 GitHub Actions OIDC role
- `CLOUDFLARE_ACCOUNT_ID`: media 리소스를 소유할 Cloudflare account ID
- `CLOUDFLARE_ZONE_ID`: `byulma.run` Cloudflare zone ID
- `TAILSCALE_OAUTH_CLIENT_ID`, `TAILSCALE_AUDIENCE`: GitHub Actions가 private Argo CD에 접근할 Tailscale workload identity 값. Media repository의 GitHub OIDC identity도 Tailscale 외부 workload identity 정책에서 허용해야 합니다.

Repository secrets:

- `CLOUDFLARE_API_TOKEN`: R2 bucket, custom domain과 CORS를 관리할 Terraform token

Cloudflare API token에는 `Workers R2 Storage Read`와 `Workers R2 Storage Write` 권한이 필요합니다.

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
- `PUBLIC_API_BASE_URL`: 클라이언트가 호출하는 서버의 HTTPS public API origin. 로컬 개발에서는 `http://localhost`, `http://127.0.0.1`, `http://[::1]` origin도 허용합니다. 별도 hostname으로 공존하는 동안에는 그 hostname을 사용하고, 기존 `media-api.byulmaru.co`는 ingress 전환 후에 사용합니다.

`PUBLIC_API_BASE_URL`은 Node가 signed upload URL에 넣는 외부 API origin입니다. reverse proxy의 내부 주소가 아니라 클라이언트가 호출하는 HTTPS public origin을 사용하며, 외부 HTTP origin은 거부합니다. Worker는 이 변수를 사용하지 않고 요청 URL을 사용합니다. S3 region은 `auto`로 고정합니다. R2 S3 access key는 이 bucket에 대한 읽기와 쓰기만 허용하도록 만들고 실행 환경의 secret store에 보관합니다. `PORT`는 선택 사항이며 기본값은 `3000`입니다. 서버는 `0.0.0.0`에서 listen합니다.

Production image를 로컬에서 빌드하고 실행할 수 있습니다. `/path/to/runtime.env`는 위 환경 변수의 실제 값을 담은 실행 환경 파일입니다.

```sh
docker build -t byulmaru-media .
docker run --rm -p 3000:3000 --env-file /path/to/runtime.env byulmaru-media
```

`main`의 검증과 네이티브 ARM64 이미지 빌드가 성공하면 GitHub Actions가 `ghcr.io/byulmaru/media:latest`와 전체 source commit SHA 태그를 게시합니다. GHCR package는 공개입니다.

```sh
docker pull ghcr.io/byulmaru/media:latest
docker run --rm -p 3000:3000 --env-file /path/to/runtime.env ghcr.io/byulmaru/media:latest
```

## API

### Create a browser upload

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

1. 위 Tailscale 변수와 외부 workload identity 정책을 준비한 뒤 Kubernetes repository의 Terraform 변경을 적용해 Media GitHub OIDC identity에 Argo CD `media` project 접근 권한을 줍니다. 이어서 이 repository의 Terraform을 적용해 `helm/` chart를 `media` namespace에 배포하는 `media` Application을 만듭니다. 처음에는 자동 동기화가 꺼져 있습니다.
2. Cluster에는 Vault Secrets Operator와 `vso-kubernetes-sync` Kubernetes auth role이 필요합니다. KV v2의 `secret/kubernetes/media`에 `API_KEY`, `UPLOAD_SIGNING_SECRET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`를 저장하고, Worker와 공존하는 동안 첫 두 값은 Worker와 맞춥니다. R2 key는 Helm values에 넣지 않습니다.
3. Chart의 기본 API host는 임시 주소 `media-api-k8s.byulmaru.co`이며 `host` 값이 HTTPRoute hostname과 `PUBLIC_API_BASE_URL`을 함께 정합니다. HTTPRoute는 `gateway/public` Gateway를 사용합니다. Cloudflare에 이 host의 proxied A record를 public Gateway EIP (`aws_eip.public_gateway_nlb.public_ip` in Kubernetes Terraform)로 한 번 추가해야 합니다. 이 repository는 DNS를 관리하지 않으며 공개 이미지 URL `media.byulma.run`은 그대로 사용합니다.
4. Main CI는 검증 후 네이티브 ARM64 runner에서 image를 빌드하고 게시합니다. Terraform이 처음 만든 Application은 수동 동기화 상태이며, 첫 성공한 ARM64 게시 후 CI가 source SHA, `version`, `imageDigest`를 함께 설정하고 자동 동기화, prune, self-heal을 켭니다. Chart의 기본 image reference는 기존 AMD64 seed이므로 첫 게시 전에는 수동 sync하지 마세요. CI는 Application의 목표 SHA/version/digest와 관찰된 sync SHA가 맞고 sync가 `Synced`, health가 `Healthy`일 때 성공합니다.
5. Workload는 포트 3000에서 실행되고 영속 볼륨 없이 기존 R2 bucket을 사용합니다. TCP startup probe와 Gateway request timeout은 최대 120초를 허용합니다. CPU 100m / memory 256Mi 요청과 CPU 1 / memory 1Gi 제한은 측정 전 초기값이며, 서버는 SIGTERM 때 요청을 drain하지 않아 pod 교체가 진행 중 업로드를 끊을 수 있습니다.
6. 먼저 호출자의 API base URL을 임시 host로 바꿔 기존 Worker가 새 ticket을 발급하지 않도록 합니다. 이미 발급한 최대 10분 ticket과 진행 중 업로드를 처리하도록 `media-api.byulmaru.co`의 Worker를 계속 유지하고, 모두 끝난 뒤 기존 host를 EKS ingress로 전환합니다. 공개 이미지 hostname은 계속 `media.byulma.run`입니다.
