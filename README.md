# byulmaru media

Cloudflare Worker가 JPEG, PNG, WebP 이미지를 검증해 WebP로 정규화하고 R2에 저장하는 업로드 서비스입니다. API Worker는 `https://media-api.byulmaru.co`에서 signed upload를 담당하고, 저장된 원본은 `https://media.byulma.run`에 연결된 R2 bucket에서 직접 제공합니다.

이미지 변환에는 Cloudflare Images 대신 Worker-compatible 단일 스레드 WASM인 jSquash를 사용합니다.

## Architecture

1. 인증된 Kosmo backend가 `POST /v1/uploads`를 호출합니다.
2. Worker가 `u_<UUIDv4>` ID와 10분짜리 signed upload URL을 반환합니다.
3. 브라우저가 signed URL에 원본 이미지를 `PUT`합니다.
4. Worker가 이미지 제한을 검증하고 WebP로 변환해 `original/<id>.webp`에 한 번만 저장합니다.
5. 성공 응답의 `url`은 `https://media.byulma.run/original/<id>.webp`를 가리킵니다.
6. 이미지 GET과 HEAD는 Worker를 통하지 않고 R2 custom domain으로 전달됩니다.

Remote Media, thumbnail, Worker 이미지 조회 proxy와 KV는 v1 범위에 포함하지 않습니다.

## Infrastructure

[Terraform](./terraform/main.tf)은 다음 Cloudflare 리소스를 관리합니다.

- `byulmaru-media` R2 bucket
- `media.byulma.run` R2 custom domain
- 공개 GET/HEAD를 위한 R2 CORS

Worker 코드, `media-api.byulmaru.co` custom domain과 secret은 Wrangler가 담당합니다. secret 값을 Terraform state에 남기지 않기 위한 경계입니다.

Terraform plan/apply는 [GitHub Actions](./.github/workflows/terraform.yml)가 실행합니다. Pull request에서는 plan만 만들고, `main` push와 수동 실행에서는 새 saved plan을 생성해 그대로 적용합니다. State는 `byulmaru-terraform-state` S3 bucket의 `media/terraform.tfstate` key를 사용합니다.

Repository variables:

- `AWS_ROLE_ARN`: state bucket에 접근할 GitHub Actions OIDC role
- `CLOUDFLARE_ACCOUNT_ID`: media 리소스를 소유할 Cloudflare account ID
- `CLOUDFLARE_ZONE_ID`: `byulma.run` Cloudflare zone ID

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
  "mediaType": "image/webp",
  "thumbhash": "1QcSHQRnh493V4dIh4eXh1h4kJUI"
}
```

- immutable 원본이 저장됨: `200 OK`
- 아직 저장되지 않음: `404 Not Found`
- 잘못된 ID: `400 Bad Request`
- 모든 응답: `Cache-Control: no-store`

새 업로드는 WebP 변환에 사용한 RGBA pixels에서 ThumbHash를 함께 계산해 R2 custom metadata에
Base64 문자열로 저장합니다. ThumbHash 도입 전에 저장된 기존 객체는 `thumbhash: null`을 반환합니다.

이 endpoint 역시 소유권을 판단하지 않습니다. 호출자는 먼저 자신의 도메인 권한을 확인한 뒤
Media Storage Service가 소유한 공개 표현 정보만 조회해야 합니다.

## Security and limits

- source body: 최대 16 MiB
- 긴 변: 최대 8192px
- 총 pixels: 최대 8 MiPixels
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
