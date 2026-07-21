# byulmaru media

Cloudflare Workers에서 JPEG, PNG, WebP 이미지를 WebP로 정규화해 R2에 저장하고 공개 조회하는 미디어 서비스입니다. 직접 업로드 원본은 영구 보관하며, 직접 업로드와 리모트 이미지의 800px 썸네일은 R2 lifecycle로 30일간 캐시합니다.

이미지 변환은 Cloudflare Images가 아니라 Worker-compatible 단일 스레드 WASM인 jSquash를 사용합니다. Sharp의 WASM 빌드는 Web Worker 기반 multi-threaded WASM을 요구하므로 Cloudflare Workers isolate에서는 사용할 수 없습니다.

## Setup

R2 버킷, KV namespace, `cache/` prefix의 30일 lifecycle은 [Terraform](./terraform/main.tf)이 관리합니다. Worker 코드 배포와 secret은 Wrangler가 담당합니다. secret 값을 Terraform state에 남기지 않기 위한 경계입니다.

Terraform plan/apply는 [GitHub Actions](./.github/workflows/terraform.yml)가 관리합니다. Pull request는 plan만 생성하고, `main` push와 수동 실행은 새 plan을 생성한 뒤 같은 실행에서 저장한 `tfplan`을 그대로 적용합니다. State는 기존 `byulmaru-terraform-state` S3 bucket의 `media/terraform.tfstate` key를 사용합니다.

Repository variables:

- `AWS_ROLE_ARN`: state bucket에 접근할 GitHub Actions OIDC role
- `CLOUDFLARE_ACCOUNT_ID`: media 리소스를 소유할 Cloudflare account ID

Repository secrets:

- `CLOUDFLARE_API_TOKEN`: R2 bucket, lifecycle, Workers KV namespace를 관리할 Terraform token

1. 로컬에서는 backend와 실제 리소스에 연결하지 않고 구성을 검증합니다. Plan과 apply는 GitHub Actions에서 원격 state를 사용해 실행합니다.

   ```sh
   terraform -chdir=terraform init -backend=false
   terraform -chdir=terraform fmt -check
   terraform -chdir=terraform validate
   ```

2. Terraform 변경 pull request에서 plan artifact와 job summary를 검토합니다. `main`에 병합하면 같은 workflow 실행에서 생성된 saved plan이 적용됩니다.

3. 적용 후 workflow summary의 `wrangler_bindings` output이 [wrangler.jsonc](./wrangler.jsonc)의 binding과 일치하는지 확인합니다.

4. Worker에 secret을 등록합니다.

   ```sh
   pnpm exec wrangler secret put API_KEY
   pnpm exec wrangler secret put UPLOAD_SIGNING_SECRET
   ```

5. 단일 Worker가 `https://kos.moe`, `https://dev.kos.moe`, `http://localhost:5173`, `http://localhost:5174`를 허용합니다.
6. 로컬 개발에서는 `.dev.vars`에 `API_KEY`와 32바이트 이상의 `UPLOAD_SIGNING_SECRET`을 넣고 `pnpm dev`를 실행합니다.

배포 전에는 정적 구성과 실제 KV/secret 구성을 모두 검사합니다.

```sh
pnpm config:validate
pnpm deployment:validate
```

## API

### Create a browser upload

```http
POST /v1/uploads
Authorization: Bearer <API_KEY>
Content-Type: application/json

{"maxBytes":16777216,"maxDimension":8192}
```

The response contains a preallocated `u_` ID and a single-success upload URL valid for ten minutes. The browser sends the source bytes directly:

```http
PUT <uploadUrl>
Origin: https://allowed.example
Content-Type: image/png

<raw image bytes>
```

Failed validation or encoding does not consume the URL. After the first successful R2 write, reuse returns `409`.

### Register a remote image

```http
POST /v1/remotes
Authorization: Bearer <API_KEY>
Content-Type: application/json

{"url":"https://images.example.com/avatar.png"}
```

The URL is stored in KV under a new `r_` ID. KV is eventually consistent, so a first read from another Cloudflare location can briefly return `404` immediately after registration.

### Read images

- `GET /images/<u_id>`: permanent uploaded original encoded as WebP.
- `GET /images/<u_id>/thumbnail`: uploaded image thumbnail, long edge at most 800px.
- `GET /images/<r_id>/thumbnail`: remote thumbnail fetched and generated on demand.
- `GET /images/<r_id>`: always `404`; remote originals are neither stored nor exposed.

All successful image responses support ETag/`If-None-Match`. Uploaded variants are immutable and public-cacheable for 30 days. Remote thumbnails are refreshed after 30 days and therefore omit `immutable`.

## Security and limits

- Source bodies are capped at 16 MiB, 8192px on the long edge, and 8 MiPixels. Callers may request stricter byte and long-edge limits.
- Magic bytes and dimensions are checked before full decode; JPEG, PNG, and WebP are supported. Animated PNG/WebP and all other formats are rejected.
- Remote URLs must use public HTTPS on port 443. Credentials, IP literals, local/reserved hostnames, redirects to unsafe hosts, and DNS results containing private/reserved addresses are rejected.
- Remote reads use a 10-second timeout, at most three redirects, and bounded streaming even when `Content-Length` is absent.

## Development

```sh
pnpm typecheck
pnpm test
pnpm dry-run
pnpm infra:fmt
pnpm infra:validate
```

The integration suite runs in `workerd` with local R2, KV, Cache API, and real jSquash WASM codecs. `pnpm dry-run` prints the exact Worker bundle and must remain below the Paid Worker upload limit.
