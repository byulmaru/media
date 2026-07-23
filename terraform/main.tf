resource "cloudflare_r2_bucket" "media" {
  account_id    = var.cloudflare_account_id
  name          = "byulmaru-media"
  storage_class = "Standard"
}

resource "cloudflare_r2_custom_domain" "media" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.media.name
  domain      = var.public_media_domain
  enabled     = true
  zone_id     = var.cloudflare_zone_id
  min_tls     = "1.2"
}

resource "cloudflare_r2_bucket_cors" "media" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.media.name
  rules = [{
    id = "public-read"
    allowed = {
      methods = ["GET", "HEAD"]
      origins = ["*"]
    }
    expose_headers  = ["Content-Length", "Content-Type", "ETag"]
    max_age_seconds = 86400
  }]
}
