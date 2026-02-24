data "cloudflare_account" "byulmaru-coop" {}

data "cloudflare_zone" "byulma-run" {
  filter = {
    name = "byulma.run"
  }
}

resource "cloudflare_r2_bucket" "media" {
  account_id = data.cloudflare_account.byulmaru-coop.id
  name       = "media"
}

resource "cloudflare_r2_custom_domain" "media" {
  account_id  = data.cloudflare_account.byulmaru-coop.id
  bucket_name = cloudflare_r2_bucket.media.name
  domain      = "cdn.byulma.run"
  zone_id     = data.cloudflare_zone.byulma-run.id
  enabled     = true
}

resource "infisical_project" "media" {
  name = "media"
  slug = "media"
}

resource "infisical_secret" "r2_endpoint" {
  name         = "R2_ENDPOINT"
  value        = "https://${cloudflare_r2_custom_domain.media.domain}"
  env_slug     = "prod"
  workspace_id = infisical_project.media.id
  folder_path  = "/"
}
