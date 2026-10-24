# byulmaru media

JPEG, PNG, WebP 이미지를 검증해 WebP로 정규화하고 Cloudflare R2에 저장하는 업로드 서비스입니다. 같은 API를 Cloudflare Worker와 Node.js 서버로 실행할 수 있습니다. 두 런타임은 같은 R2 bucket과 `original/<id>.webp` 객체 key를 사용하므로 트래픽을 단계적으로 전환할 수 있습니다. 공개 이미지는 `https://media.byulma.run`에서 제공합니다.

기본 v1 HTTP 업로드 경로는 Worker와 Node 서버에서 jSquash codec으로 이미지를 변환해 공개 R2에 저장합니다. Version 2 private staging의 HTTP `PUT`은 원본만 private bucket에 저장합니다. Temporal Workflow가 시작되면 source를 검증하고 Sharp로 WebP를 private staging에 준비한 뒤 게시 요청을 기다립니다. 게시 Activity는 준비된 WebP bytes를 공개 R2에 그대로 승격하므로 새 Workflow는 게시 중 재인코딩하지 않습니다. 배포 전에 시작되어 patch marker가 없는 Temporal history는 replay 호환성을 위해 기존 게시 Activity를 사용하며, 준비 객체가 없으면 그 경로에서 게시 시 인코딩할 수 있습니다. Sharp 내부 buffering은 계속 발생하며, Sharp pipeline 오류는 비재시도 `invalid_image` 검증 오류로 분류합니다.

## Architecture

1. 인증된 Kosmo backend가 `POST /v1/uploads`를 호출합니다.
2. API가 `u_<UUIDv4>` ID와 10분짜리 signed upload URL을 반환합니다.
3. 브라우저가 signed URL에 원본 이미지를 `PUT`합니다.
4. API가 이미지 제한을 검증하고 WebP로 변환해 `original/<id>.webp`에 한 번만 저장합니다.
5. 성공 응답의 `url`은 `https://media.byulma.run/original/<id>.webp`를 가리킵니다.
6. 이미지 GET과 HEAD는 API 런타임을 통하지 않고 R2 custom domain으로 전달됩니다.

### Temporal Nexus 비동기 업로드

Media API는 private staging upload URL을 발급하며, caller는 raw object를 저장한 뒤 원하는 시점에 Temporal Workflow를 시작할 수 있습니다. 다른 호출자는 staging bucket에 직접 저장할 수도 있습니다. Nexus에는 object key와 이미지 제한만 전달합니다. 원본 bytes와 signed URL은 Nexus request나 Temporal history에 넣지 않습니다. Source key는 `uploads/<id>/<source-uuid>` 형식이고, `id`는 `u_<UUIDv4>`입니다.

Worker는 raw source metadata에서 `LastModified`를 확인하고 그 시각부터 24시간의 게시 기한을 계산합니다. 새 Workflow는 source를 검증하고 WebP를 private staging에 준비한 뒤, 호출 측이 게시를 요청할 때까지 durable condition으로 기다립니다. 게시 Activity는 준비한 WebP stream을 재인코딩 없이 `original/<id>.webp`에 한 번만 저장합니다. 배포 전에 시작된 markerless history만 replay 호환성을 위해 기존 게시 경로를 사용하며, 이 legacy 경로는 준비 객체가 없는 경우 게시 시점에 인코딩할 수 있습니다. 새 Workflow는 기다리기 전에 준비를 마치며 게시 중 재인코딩하지 않습니다. Nexus의 `startUpload`에는 25시간 `scheduleToCloseTimeout`을 지정하며, 실제 게시 기한은 raw source의 `LastModified`부터 24시간입니다.

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

호출 측은 사용자의 게시 요청을 workflow signal로 기록한 뒤 `publishUpload`를 실행합니다. 게시 대기 중 만료나 처리 실패가 먼저 발생할 수 있어 `startUpload` 결과와 signal을 함께 기다립니다. 호출 측 Workflow는 Nexus 취소 handler가 대상 `startUpload` 취소를 수락할 때까지 열려 있습니다. Raw source와 prepared WebP 정리는 비동기라 호출 측 종료 시 완료됐다고 보장되지 않습니다. `{ id }` acknowledgement는 게시 명령이 접수됐다는 뜻이며 이미지 공개 완료를 뜻하지 않습니다. 공개 저장이 끝난 `{ id, url, mediaType }` 결과를 사용하기 전에 `startUpload` operation의 `result()`를 기다립니다. 24시간 안에 게시하지 않거나 workflow가 취소되거나 처리가 최종 실패하면 Worker가 prepared WebP를 먼저 지우고 raw source를 정리합니다. Prepared WebP 삭제가 실패하면 raw source를 보존한 채 정리 Activity를 재시도하며, 재시도 후에도 실패하면 Worker는 업로드 ID를 포함해 경고를 남기고 48시간 lifecycle 만료에 맡깁니다. 정리 실패는 게시 결과를 덮어쓰거나 원래 Workflow 오류를 대체하지 않습니다. 게시 명령으로 처리가 시작된 뒤에는 취소나 회수 요청이 진행 중인 공개 저장을 막거나 이미 공개된 이미지를 되돌린다고 보장하지 않습니다.

Worker는 Wrangler `MEDIA`와 `STAGING` R2 binding으로 저장하고 Node.js 서버는 R2 S3 API로 저장합니다. 두 런타임은 같은 object key, MIME type, metadata contract를 따르지만 upload path별 codec은 다릅니다. 점진적으로 전환할 때는 두 런타임의 `API_KEY`, `UPLOAD_SIGNING_SECRET`, `ALLOWED_ORIGINS`, `PUBLIC_BASE_URL`을 맞추고, Node의 `R2_BUCKET_NAME`과 `R2_STAGING_BUCKET_NAME`은 Worker의 각 binding과 같은 bucket을 가리키도록 설정합니다. Worker의 `pnpm dev`, `pnpm deploy`, `pnpm dry-run` 명령은 계속 사용할 수 있습니다.

Production API는 `media-api.byulmaru.co`에서 제공하며 Kubernetes ingress가 이 hostname을 처리합니다. Cloudflare Worker 코드와 배포는 남아 있지만, API route와 `workers.dev` endpoint는 비활성화합니다. 전환 뒤 최대 10분 동안 기존 Worker가 발급한 upload ticket이 Node.js 서버에서 실패할 수 있습니다.

Kosmo의 staging metadata 확인을 출시할 때는 새 Media API를 모든 인스턴스에 먼저 배포한 뒤 Kosmo API와 Worker를 배포합니다. 롤백할 때는 Kosmo를 먼저 되돌립니다. 이전 Media API는 `staging=true`를 무시하므로 게시 전 private object를 찾지 못해 `404`를 반환할 수 있습니다.

Remote Media, thumbnail, Worker 이미지 조회 proxy와 KV는 v1 범위에 포함하지 않습니다.

### 선택적 Hope 보호

Media의 Nexus 계약은 새 upload Workflow에서만 비동기 `applyHope({ id, hope })` 요청을 받습니다. 기존 upload Workflow에는 적용되지 않으므로 Hope를 쓰려면 새 upload를 시작해야 합니다. `algorithm`은 `noise`, `glaze`, `nightshade` 중 하나이며 `iterations`는 각각 최대 500, 600, 750입니다. `intensity`는 선택 사항이며 기본값은 `0.3`입니다. `hope: null`은 Media Workflow 안에서 Hope 선택을 지우고 원본으로 준비한 기본 WebP를 선택합니다. 이 동작은 Hope Activity를 호출하지 않습니다. 호출자는 `applyHope` operation의 `result()`가 성공한 뒤 `publishUpload`를 호출해야 합니다. 실패한 Hope 요청 뒤에는 게시가 자동으로 진행되지 않으므로 보호 처리를 재시도하거나 `hope: null`로 초기화한 뒤 게시합니다. `applyHope` operation 취소는 요청과 결과 대기만 취소하며, 이미 수락된 처리 작업은 계속될 수 있습니다. 처리를 취소하고 Workflow cleanup을 시작하려면 원래 `startUpload` session을 취소해야 합니다.

Media가 정의한 Activity 계약은 `prepareHopeUpload(input): Promise<void>`이며, `id`, immutable raw source의 `sourceKey`, `contentType`, `maxBytes`, `maxDimension`, `requestId`, 정규화된 `hope` 옵션, `maxEdge: 1024`를 받습니다. Temporal에는 이미지 payload를 넣지 않고 private R2 객체 참조만 전달합니다. 별도 배포하는 `hope-re` Worker가 입력과 raw source를 검증하고, 1024px cap에 맞춰 입력을 줄여 추론한 다음 유효한 WebP를 private staging의 `${sourceKey}.hope/${requestId}.webp`에 조건부 저장하고 `void`로 완료해야 합니다. 이 Worker가 동작하려면 raw source를 변경하거나 지우지 않고 결과 객체를 기록해야 합니다. 실패는 generic `HopeProcessingError`로 전달합니다. caller는 성공 응답을 받은 뒤 별도로 게시를 요청하며, Media는 선택한 WebP를 공개 bucket으로 승격합니다.

`hope-re`의 Temporal Worker 구현은 후속 작업이며 현재 저장소는 호출 계약만 제공합니다. 후속 Worker는 Media Worker와 같은 Temporal namespace의 고정 `media-hope` task queue에서 실행해야 합니다. 배포는 rollout 중에도 단일 active instance를 보장하고 Activity 동시 실행을 1로 제한해야 합니다. 이 저장소의 Helm chart는 Hope Activity Worker를 배포하지 않으며, 기본값 `hope.enabled: true`는 기존 Media Worker의 Hope Nexus operation만 활성화합니다. 외부 Worker가 없으면 Activity는 원본 업로드의 24시간 게시 기한까지 queue에서 대기한 뒤 만료 처리됩니다. Nexus caller는 더 짧은 timeout으로 먼저 실패할 수 있습니다. 실제 요청 전에 외부 `hope-re` Worker를 준비해야 합니다. Activity 구현은 5초 이내 간격으로 heartbeat해야 합니다. Media는 30초 heartbeat timeout과 cancellation 완료 대기를 사용하므로, 취소 시 진행 중인 객체 쓰기가 끝난 다음 Workflow cleanup이 이어집니다. 원본 업로드 제한은 최대 16 MiB, 긴 변 8192px, 총 16 MiPixels이며, staging 객체는 게시 또는 cleanup으로 정리하고 48시간 lifecycle 규칙이 남은 객체를 정리하는 backstop입니다.

브라우저 crop/rotate 편집과 Hope 사용 여부에 관계없이 적용할 일반 최종 출력 크기 상한은 [PROD-1192](https://linear.app/byulmaru/issue/PROD-1192/원본-기반-이미지-편집과-hope-처리-제한을-구현한다)의 후속 작업입니다.

## Infrastructure

[Terraform](./terraform/main.tf)은 다음 Cloudflare 리소스를 관리합니다.

- `byulmaru-media` R2 bucket
- `media.byulma.run` R2 custom domain
- 공개 GET/HEAD를 위한 R2 CORS
- `byulmaru-media-staging` private R2 bucket. 시작된 Nexus Workflow는 raw source의 `LastModified`부터 24시간 게시 기한을 강제하고, 게시 또는 terminal cleanup에서 staging 객체를 정리합니다. Workflow가 시작되지 않았거나 정리에 실패해 남은 `uploads/` 객체는 48시간 age threshold lifecycle backstop에 맡깁니다. Cloudflare는 lifecycle 만료 뒤 보통 24시간 이내에 object를 삭제하지만, 물리 삭제까지의 최대 시간 보장은 아닙니다. 미완료 multipart upload는 24시간 age threshold에 중단됩니다.

Staging bucket에는 public read, custom domain, `r2.dev` URL을 설정하지 않고, 브라우저 PUT CORS는 `https://kos.moe`, `https://dev.kos.moe`, `http://localhost:5173` origin에만 허용합니다.

Cloudflare Worker 코드와 secret은 Wrangler가 담당합니다. API hostname과 HTTPRoute는 Helm chart에서 Kubernetes ingress로 설정합니다. Node.js 서버의 환경 변수는 실행 환경에서 주입합니다. `AWS_ACCESS_KEY_ID`와 `AWS_SECRET_ACCESS_KEY`는 `byulmaru-media`와 `byulmaru-media-staging` bucket의 object read/write만 허용하고, 서버의 secret store에 보관하며 이미지로 복사하지 않습니다. API와 Media Worker는 같은 credentials를 사용하므로 API pod에도 private staging bucket의 read/write 권한이 있습니다.

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

Node.js 24 서버는 같은 HTTP API와 R2 buckets를 사용합니다. R2 S3 API endpoint, public/private bucket name, API secrets를 실행 환경 변수로 전달합니다.

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
- `R2_STAGING_BUCKET_NAME`: 기존 private `byulmaru-media-staging` bucket
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `PUBLIC_API_BASE_URL`: 클라이언트가 호출하는 서버의 HTTPS public API origin. 로컬 개발에서는 `http://localhost`, `http://127.0.0.1`, `http://[::1]` origin도 허용합니다. Production에서는 Helm의 `host` 값이 이 origin을 정합니다.

`PUBLIC_API_BASE_URL`은 Node가 signed upload URL에 넣는 외부 API origin입니다. reverse proxy의 내부 주소가 아니라 클라이언트가 호출하는 HTTPS public origin을 사용하며, 외부 HTTP origin은 거부합니다. Worker는 이 변수를 사용하지 않고 요청 URL을 사용합니다. S3 region은 `auto`로 고정합니다. credentials는 실행 환경의 secret store에 보관합니다. `PORT`는 선택 사항이며 기본값은 `3000`입니다. 서버는 `0.0.0.0`에서 listen합니다.

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

Media Worker는 별도 Deployment에서 `node dist/worker.js`로 실행되며 API와 같은 image digest를 사용합니다. 준비 Activity는 Sharp로 source를 검증하고 WebP를 private staging에 인코딩합니다. 게시 Activity는 준비된 객체를 알려진 길이로 공개 bucket에 stream하며 인코딩하지 않습니다. 필요한 환경 변수는 다음과 같습니다.

- Temporal: `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`
- Hope feature gate: `HOPE_ENABLED` (Helm의 `hope.enabled` chart 기본값은 `true`; application에서 변수가 unset이면 기본값은 `false`)
- Bucket 설정: `PUBLIC_BASE_URL`, `R2_ENDPOINT`, `R2_BUCKET_NAME`, `R2_STAGING_BUCKET_NAME`
- R2 credentials: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`

`AWS_*` pair는 `byulmaru-media`와 `byulmaru-media-staging`의 object read/write에 사용합니다. Helm chart는 non-secret 설정을 values에서, 이 pair를 Vault secret에서 API와 Media Worker에 전달합니다. `hope.enabled`는 Media Worker의 Nexus feature gate만 제어합니다. 실제 Hope 처리를 받으려면 같은 Temporal namespace에서 `media-hope` task queue를 처리하는 외부 `hope-re` Worker를 먼저 배포해야 합니다.

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

### Create a private staging upload for Nexus

Kosmo backend가 공개 저장을 시작하기 전에 원본을 private staging bucket에 저장하려면 같은 endpoint에 opt-in합니다.

```http
POST /v1/uploads
Authorization: Bearer <API_KEY>
Content-Type: application/json

{"staging":true}
```

응답은 기본 upload와 같은 `{id, uploadUrl, expiresAt}`이며, 이 요청에는 크기 제한을 지정할 수 없습니다. `PUT`은 허용된 Content-Type과 실제 request body 크기를 확인해 최대 16 MiB의 raw source만 private staging에 저장한 뒤 `{ "id": "u_..." }`를 반환합니다. 원본 이미지의 유효성 검증과 WebP 준비는 Temporal Workflow가 시작된 직후 수행합니다. 원본 key와 metadata는 기존처럼 `HEAD`에서 확인할 수 있습니다. private source 또는 공개 output이 이미 있으면 같은 upload URL의 추가 사용은 `409`입니다. 이 경로는 공개 bucket에 쓰지 않습니다.

Kosmo PR #1240에서 제안한 composer 흐름은 사용자가 이미지를 선택할 때 raw source를 업로드합니다. 성공한 v2 `PUT`은 raw source만 private 상태로 저장하며, 기존 raw source `HEAD` 계약은 그대로입니다. 별도의 prepare API 호출은 필요하지 않습니다. 글 등록 제출 시 `completeMediaUpload`가 `mediaService.startUpload`를 시작하고 `publishUpload`를 요청한 뒤 결과를 기다립니다. Media 상태가 READY로 바뀐 다음 게시글을 생성합니다. 프로필 이미지 흐름은 `PUT` 직후 완료 요청을 계속 실행합니다. 이 내용은 Kosmo PR #1240이 제안하는 클라이언트 계약을 설명하며, 해당 PR이 이미 배포되었다는 뜻은 아닙니다. Kosmo 서버는 `uploads/<id>/<id의 UUID>` source key와 Content-Type, `maxBytes: 16777216`, `maxDimension: 8192`를 Nexus에 전달합니다. 새 Nexus Workflow는 시작 직후 원본을 검증하고 prepared WebP를 private staging에 만든 뒤 공개 확정 요청까지 보관해 승격합니다. 기본 `GET`과 `HEAD /v1/uploads/<id>`는 공개 표현만 반환하므로 공개 확정 요청 전에는 `404`입니다. Version 2 signed token은 version 1과 분리되어 기존 upload URL 동작을 유지합니다.

Kosmo는 Media API 인증 키로 staging source metadata를 확인할 수 있습니다.

```http
HEAD /v1/uploads/u_...?staging=true
Authorization: Bearer <API_KEY>
```

- staging object 저장됨: `200 OK`와 metadata 헤더
- staging object 없음: `404 Not Found`
- `STAGING` 설정 없음: `503 Service Unavailable`
- `GET`에 `staging=true` 지정: `405 Method Not Allowed`, body 없음

성공 응답은 `Cache-Control: no-store`를 사용하고, 저장된 object에서 사용할 수 있는 `Content-Length`, `Content-Type`, `Last-Modified`만 보냅니다. metadata가 없거나 유효하지 않은 값이면 해당 헤더를 생략합니다. Kosmo는 필수 metadata가 없는 응답을 terminal validation error로 처리합니다.

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

- 원본 업로드/검증: 최대 16 MiB, 긴 변 8192px, 총 16 MiPixels
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
4. PR 13 storage 변경을 적용해 private `byulmaru-media-staging` bucket과 `uploads/` prefix의 48시간 lifecycle backstop, 미완료 multipart upload의 24시간 abort rule을 준비합니다. Terraform workflow와 Media Deploy workflow는 별개라 같은 push에서 실행 순서가 보장되지 않습니다. Vault Secrets Operator와 `vso-kubernetes-sync` Kubernetes auth role을 준비하고 KV v2 `secret/kubernetes/media`에 `API_KEY`, `UPLOAD_SIGNING_SECRET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`를 저장합니다. `API_KEY`는 호출자가 사용하는 값이어야 합니다. AWS pair에는 두 bucket의 object read/write 권한만 주고 Helm values나 image에는 credentials를 넣지 않습니다.
5. Chart의 기본 API host는 `media-api.byulmaru.co`이며 `host` 값이 HTTPRoute hostname과 `PUBLIC_API_BASE_URL`을 함께 정합니다. HTTPRoute는 `gateway/public` Gateway를 사용합니다. Cloudflare에 이 host의 proxied A record를 public Gateway EIP (`aws_eip.public_gateway_nlb.public_ip` in Kubernetes Terraform)로 한 번 추가해야 합니다. 이 repository는 DNS를 관리하지 않으며 공개 이미지 URL `media.byulma.run`은 그대로 사용합니다.
6. 첫 성공한 ARM64 게시 후 Deploy workflow가 source SHA, `version`, `imageDigest`를 함께 설정하고 자동 동기화, prune, self-heal을 켭니다. 이 첫 sync에서 위 PreSync Job이 `media` Temporal namespace를 준비합니다. Chart의 기본 image reference는 기존 AMD64 seed이므로 첫 ARM64 게시 전에는 수동 sync하지 않습니다. Deploy workflow는 Application의 목표 SHA/version/digest와 관찰된 sync SHA가 맞고 sync가 `Synced`, health가 `Healthy`일 때 성공합니다. API와 Media Worker는 같은 ARM64 image digest를 사용하며 Worker는 HTTP port나 Service를 노출하지 않습니다. Chart는 `hope.enabled: true`를 기본 적용하지만 외부 `hope-re` Worker를 배포하지 않습니다. 실제 Hope 요청 전에 Worker가 같은 `media` namespace의 `media-hope` task queue를 처리하는지 확인합니다.
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
8. endpoint 등록 뒤 caller Workflow에서 `mediaService.startUpload`, 선택적 `applyHope`, `publishUpload`를 사용할 수 있습니다. API는 기존 `/v1` inline 경로를 유지하고 Media Worker는 `media-upload` task queue에서 Nexus operation을 처리합니다. Hope 처리는 외부 `hope-re` Worker가 같은 namespace의 `media-hope` task queue에서 수행합니다. API와 Media Worker는 영속 볼륨 없이 기존 R2 bucket을 사용합니다. Staging workflow는 원본 `LastModified`부터 24시간 안에 게시를 기다리고, 남은 `uploads/` 원본은 48시간 lifecycle rule이 backstop으로 정리합니다. API와 Media Worker는 CPU 100m / memory 256Mi를 요청하고 CPU 1 / memory 1Gi로 제한합니다. 서버는 SIGTERM 때 요청을 drain하지 않아 pod 교체가 진행 중인 upload를 끊을 수 있습니다.
