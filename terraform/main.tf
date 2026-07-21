resource "cloudflare_r2_bucket" "media" {
  account_id    = var.cloudflare_account_id
  name          = "byulmaru-media"
  storage_class = "Standard"
}

resource "cloudflare_workers_kv_namespace" "remote_images" {
  account_id = var.cloudflare_account_id
  title      = "byulmaru-media-remote-images"
}

resource "cloudflare_r2_bucket_lifecycle" "media_cache" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.media.name
  rules = [{
    id = "expire-media-cache"
    conditions = {
      prefix = "cache/"
    }
    enabled = true
    delete_objects_transition = {
      condition = {
        max_age = var.cache_retention_seconds
        type    = "Age"
      }
    }
  }]
}

moved {
  from = cloudflare_r2_bucket.media["production"]
  to   = cloudflare_r2_bucket.media
}

moved {
  from = cloudflare_workers_kv_namespace.remote_images["production"]
  to   = cloudflare_workers_kv_namespace.remote_images
}

moved {
  from = cloudflare_r2_bucket_lifecycle.media_cache["production"]
  to   = cloudflare_r2_bucket_lifecycle.media_cache
}
