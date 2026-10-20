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

### Temporal Nexus 비동기 업로드

호출자가 비공개 staging bucket에 원본 object를 먼저 저장한 다음, 호출 측 Temporal Workflow에서 `mediaService.startUpload`를 시작합니다. 호출 측이 upload URL이나 credentials를 관리하며, Nexus에는 object key와 이미지 제한만 전달합니다. 원본 bytes와 signed URL은 Nexus request나 Temporal history에 넣지 않습니다. Source key는 `uploads/<id>/<source-uuid>` 형식이고, `id`는 `u_<UUIDv4>`입니다.

Worker는 object metadata에서 `LastModified`를 확인하고 그 시각부터 24시간의 게시 기한을 계산합니다. Workflow는 호출 측이 게시를 요청할 때까지 durable condition으로 기다린 뒤, private object를 읽고 검증·변환하여 `original/<id>.webp`에 한 번만 저장합니다. Nexus의 `startUpload`에는 25시간 `scheduleToCloseTimeout`을 지정하며, 실제 게시 기한은 object의 `LastModified`부터 24시간입니다.

```ts
import {
  CancellationScope,
  condition,
  createNexusServiceClient,
  defineSignal,
  isCancellation,
  setHandler,
} from "@temporalio/workflow";
import type { ProcessUploadInput } from "../src/temporal/types";
import { mediaService } from "../src/temporal/service";

const publishSignal = defineSignal("publishMediaUpload");

async function rethrowAfterUploadCancellation(
  error: unknown,
  resultPromise: Promise<unknown>,
): Promise<never> {
  if (!isCancellation(error)) throw error;
  await CancellationScope.nonCancellable(async () => {
    try {
      await resultPromise;
    } catch (resultError) {
      if (!isCancellation(resultError)) throw resultError;
    }
  });
  throw error;
}

export async function callerWorkflow(input: ProcessUploadInput) {
  const client = createNexusServiceClient({ service: mediaService, endpoint: "media-upload" });
  let publishRequested = false;
  setHandler(publishSignal, () => { publishRequested = true; });

  const upload = await client.startOperation("startUpload", input, {
    scheduleToCloseTimeout: "25 hours",
  });
  const resultPromise = upload.result();
  try {
    await Promise.race([
      condition(() => publishRequested),
      resultPromise,
    ]);
    const acknowledgement = await client.executeOperation("publishUpload", { id: input.id }, {
      scheduleToCloseTimeout: "5 seconds",
    });
    const result = await resultPromise;
    return { acknowledgement, result };
  } catch (error) {
    return await rethrowAfterUploadCancellation(error, resultPromise);
  }
}
```

호출 측은 사용자의 게시 요청을 workflow signal로 기록한 뒤 `publishUpload`를 실행합니다. 게시 대기 중 만료나 처리 실패가 먼저 발생할 수 있어 `startUpload` 결과와 signal을 함께 기다립니다. 호출 측 Workflow는 Nexus 취소 handler가 대상 `startUpload` 취소를 수락할 때까지 열려 있습니다. Source 정리는 비동기라 호출 측 종료 시 완료됐다고 보장되지 않습니다. `{ id }` acknowledgement는 게시 명령이 접수됐다는 뜻이며 이미지 공개 완료를 뜻하지 않습니다. 공개 저장이 끝난 `{ id, url, mediaType }` 결과를 사용하기 전에 `startUpload` operation의 `result()`를 기다립니다. 24시간 안에 게시하지 않거나 workflow가 취소되거나 처리가 최종 실패하면 Worker가 private source를 정리합니다. 게시 명령으로 처리가 시작된 뒤에는 취소나 회수 요청이 진행 중인 공개 저장을 막거나 이미 공개된 이미지를 되돌린다고 보장하지 않습니다.

Worker는 Wrangler `MEDIA` R2 binding으로 저장하고 Node.js 서버는 R2 S3 API로 저장합니다. 두 런타임은 같은 encoder와 객체 형식, metadata를 사용합니다. 점진적으로 전환할 때는 두 런타임의 `API_KEY`, `UPLOAD_SIGNING_SECRET`, `ALLOWED_ORIGINS`, `PUBLIC_BASE_URL`을 맞추고, Node의 `R2_BUCKET_NAME`은 Worker의 `MEDIA` binding과 같은 `byulmaru-media` bucket을 가리키도록 설정합니다. Worker의 `pnpm dev`, `pnpm deploy`, `pnpm dry-run` 명령은 계속 사용할 수 있습니다.

Production API는 `media-api.byulmaru.co`에서 제공하며 Kubernetes ingress가 이 hostname을 처리합니다. Cloudflare Worker 코드와 배포는 남아 있지만, API route와 `workers.dev` endpoint는 비활성화합니다. 전환 뒤 최대 10분 동안 기존 Worker가 발급한 upload ticket이 Node.js 서버에서 실패할 수 있습니다.

Remote Media, thumbnail, Worker 이미지 조회 proxy와 KV는 v1 범위에 포함하지 않습니다.

### Hope 변환 연동 (계획)

아직 구현되지 않은 후속 계획입니다. 현재 media Nexus 업로드 수명주기는 그대로 유지됩니다.

Hope Activity Worker는 같은 Temporal namespace `media`에서 실행하고, media Worker와 다른 전용 Task Queue를 사용합니다.

한 번에 하나씩 처리하려면 Worker별 `maxConcurrentActivityTaskExecutions`를 1로 설정하고, 롤아웃 중을 포함해 Hope Worker와 Hope HTTP instance를 각각 하나만 활성화합니다. Worker가 없을 때 대기 중인 Activity는 Temporal queue에 남습니다. Hope HTTP의 기존 semaphore 1은 인스턴스별로 timeout 뒤에도 계속되는 계산을 제한하는 guard로 유지합니다.

media Workflow는 Hope queue에 변환 Activity를 예약합니다. Activity는 private R2의 source를 읽어 기존 Hope HTTP `POST /protect`를 호출하고, 반환된 WebP를 private R2에 쓴 뒤 object key/reference만 Workflow에 돌려줍니다. Hope HTTP endpoint는 R2에 쓰지 않습니다. Workflow는 결과 reference를 채택한 뒤 명시적 게시 요청을 다시 기다리며, 최종 public R2 저장은 media가 소유합니다.

## Infrastructure

[Terraform](./terraform/main.tf)은 다음 Cloudflare 리소스를 관리합니다.

- `byulmaru-media` R2 bucket
- `media.byulma.run` R2 custom domain
- 공개 GET/HEAD를 위한 R2 CORS
- 비공개 `byulmaru-media-staging` R2 bucket. `uploads/` object는 48시간 lifecycle 만료를 backstop으로 사용하고, 미완료 multipart upload는 24시간 뒤 abort합니다.

Staging bucket에는 custom domain, public CORS, `r2.dev` URL을 설정하지 않습니다. Workflow의 게시 기한은 원본 object의 `LastModified`부터 24시간입니다. Lifecycle 만료는 남은 object를 정리하는 backstop입니다. Cloudflare는 만료 뒤 보통 24시간 이내에 object를 삭제하지만, 이는 보장된 최대 지연 시간이 아닙니다.

Cloudflare Worker 코드와 secret은 Wrangler가 담당합니다. API hostname과 HTTPRoute는 Helm chart에서 Kubernetes ingress로 설정합니다. Node.js 서버의 환경 변수는 실행 환경에서 주입합니다. R2 S3 access key는 서버의 secret store에 보관하고 이미지로 복사하지 않습니다. Staging key는 비공개 bucket의 object read/write만 허용합니다.

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
- `PUBLIC_API_BASE_URL`: 클라이언트가 호출하는 서버의 HTTPS public API origin. 로컬 개발에서는 `http://localhost`, `http://127.0.0.1`, `http://[::1]` origin도 허용합니다. Production에서는 Helm의 `host` 값이 이 origin을 정합니다.

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

## Temporal Worker

Worker는 별도 Deployment에서 `node dist/worker.js`로 실행되며 API와 같은 image digest를 사용합니다. 필요한 환경 변수는 다음과 같습니다.

- Temporal: `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`
- Bucket 설정: `PUBLIC_BASE_URL`, `R2_ENDPOINT`, `R2_BUCKET_NAME`, `R2_STAGING_BUCKET_NAME`
- R2 credentials: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `R2_STAGING_ACCESS_KEY_ID`, `R2_STAGING_SECRET_ACCESS_KEY`

`AWS_*` pair는 공개 bucket에, `R2_STAGING_*` pair는 private staging bucket에만 접근하도록 제한합니다. Helm chart는 non-secret 설정을 values에서, 네 credentials를 Vault secret에서 Worker에 전달합니다.

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
2. Worker 배포 전에 Kubernetes repository의 PR 145 NetworkPolicy 변경을 적용합니다. 이 network rule은 `media` namespace에서 Temporal frontend의 TCP 7233으로 연결할 수 있게 합니다. 이는 frontend network reachability만 허용하며 Temporal namespace authorization을 설정하지 않습니다. 다른 namespace나 port 허용은 추가하지 않습니다.
3. Chart의 PreSync Job은 `media` Temporal namespace를 30일 retention으로 생성하거나 조정합니다. Temporal CLI는 cluster server와 같은 `1.31.2` admin-tools image를 사용하고 TLS와 config file/env 설정을 끕니다. NetworkPolicy를 먼저 적용해야 합니다.
4. PR 13 storage 변경을 적용해 private `byulmaru-media-staging` bucket과 `uploads/` prefix의 48시간 lifecycle backstop, 미완료 multipart upload의 24시간 abort rule을 준비합니다. Terraform workflow와 Media Deploy workflow는 별개라 같은 push에서 실행 순서가 보장되지 않습니다. Vault Secrets Operator와 `vso-kubernetes-sync` Kubernetes auth role을 준비하고 KV v2 `secret/kubernetes/media`에 `API_KEY`, `UPLOAD_SIGNING_SECRET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `R2_STAGING_ACCESS_KEY_ID`, `R2_STAGING_SECRET_ACCESS_KEY`를 저장합니다. `API_KEY`는 호출자가 사용하는 값이어야 합니다. staging key에는 private bucket의 object read/write 권한만 주고 Helm values나 image에는 credentials를 넣지 않습니다.
5. Chart의 기본 API host는 `media-api.byulmaru.co`이며 `host` 값이 HTTPRoute hostname과 `PUBLIC_API_BASE_URL`을 함께 정합니다. HTTPRoute는 `gateway/public` Gateway를 사용합니다. Cloudflare에 이 host의 proxied A record를 public Gateway EIP (`aws_eip.public_gateway_nlb.public_ip` in Kubernetes Terraform)로 한 번 추가해야 합니다. 이 repository는 DNS를 관리하지 않으며 공개 이미지 URL `media.byulma.run`은 그대로 사용합니다.
6. 첫 성공한 ARM64 게시 후 Deploy workflow가 source SHA, `version`, `imageDigest`를 함께 설정하고 자동 동기화, prune, self-heal을 켭니다. 이 첫 sync에서 위 PreSync Job이 `media` Temporal namespace를 준비합니다. Chart의 기본 image reference는 기존 AMD64 seed이므로 첫 ARM64 게시 전에는 수동 sync하지 않습니다. Deploy workflow는 Application의 목표 SHA/version/digest와 관찰된 sync SHA가 맞고 sync가 `Synced`, health가 `Healthy`일 때 성공합니다. API와 Worker는 같은 ARM64 image digest를 사용하며 Worker는 HTTP port나 Service를 노출하지 않습니다.
7. Nexus endpoint 이름 `media-upload`는 cluster-global registry에 운영자가 한 번 등록합니다. Chart는 endpoint를 자동 생성하거나 수정하지 않습니다. 첫 sync가 완료되고 `media` Temporal namespace가 준비된 뒤 endpoint를 설정합니다. Endpoint는 namespace `media`, task queue `media-upload`를 가리켜야 합니다. Temporal frontend에 연결 가능한 권한 있는 host에서 먼저 확인합니다.

   ```sh
   temporal operator nexus endpoint get \
     --name media-upload \
     --address temporal-frontend.temporal.svc.cluster.local:7233 \
     --tls=false \
     --disable-config-env \
     --disable-config-file \
     --client-connect-timeout 10s \
     --command-timeout 20s
   ```

   위 조회가 명시적으로 `NOT FOUND`를 반환한 경우에만 생성합니다. 연결, TLS, 권한 오류는 endpoint 부재를 뜻하지 않으므로 접근 문제를 먼저 해결합니다.

   ```sh
   temporal operator nexus endpoint create \
     --name media-upload \
     --target-namespace media \
     --target-task-queue media-upload \
     --address temporal-frontend.temporal.svc.cluster.local:7233 \
     --tls=false \
     --disable-config-env \
     --disable-config-file \
     --client-connect-timeout 10s \
     --command-timeout 20s
   ```

   기존 endpoint가 이 target과 같으면 그대로 둡니다. 다른 곳을 가리키면 소유자와 조율하고 이 배포에서 retarget하지 않습니다.
8. endpoint 등록 뒤 caller Workflow에서 `mediaService.startUpload`와 `publishUpload`를 사용할 수 있습니다. API는 기존 `/v1` inline 경로를 유지하고 Worker는 `media-upload` task queue에서 Nexus operation을 처리합니다. 두 Deployment는 영속 볼륨 없이 기존 R2 bucket을 사용합니다. Staging workflow는 원본 `LastModified`부터 24시간 안에 게시를 기다리고, 남은 `uploads/` 원본은 48시간 lifecycle rule이 backstop으로 정리합니다. API와 Worker는 CPU 100m / memory 256Mi를 요청하고 CPU 1 / memory 1Gi로 제한합니다. 서버는 SIGTERM 때 요청을 drain하지 않아 pod 교체가 진행 중인 upload를 끊을 수 있습니다.
