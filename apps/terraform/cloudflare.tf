data "cloudflare_zone" "byulma-run" {
  filter = {
    name = "byulma.run"
  }
}

resource "cloudflare_r2_bucket" "media" {
  account_id = var.cloudflare_account_id
  name       = "media"
}

resource "cloudflare_r2_custom_domain" "media" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.media.name
  domain      = "cdn.byulma.run"
  zone_id     = data.cloudflare_zone.byulma-run.id
  enabled     = true
}

resource "infisical_secret" "cdn_domain" {
  name         = "CDN_DOMAIN"
  value        = "https://${cloudflare_r2_custom_domain.media.domain}"
  env_slug     = "prod"
  workspace_id = infisical_project.media.id
  folder_path  = "/"
}

resource "infisical_secret" "r2_endpoint" {
  name         = "R2_ENDPOINT"
  value        = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com"
  env_slug     = "prod"
  workspace_id = infisical_project.media.id
  folder_path  = "/"
}

resource "infisical_secret" "r2_bucket" {
  name         = "R2_BUCKET"
  value        = cloudflare_r2_bucket.media.name
  env_slug     = "prod"
  workspace_id = infisical_project.media.id
  folder_path  = "/"
}
