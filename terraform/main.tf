resource "cloudflare_r2_bucket" "media" {
  for_each = var.environments

  account_id    = var.cloudflare_account_id
  name          = each.value.r2_bucket_name
  location      = each.value.r2_location
  storage_class = "Standard"
}

resource "cloudflare_workers_kv_namespace" "remote_images" {
  for_each = var.environments

  account_id = var.cloudflare_account_id
  title      = each.value.kv_title
}

resource "cloudflare_r2_bucket_lifecycle" "media_cache" {
  for_each = var.environments

  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.media[each.key].name
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
